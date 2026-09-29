import type { Position, RobotState, Task, WorldState } from "../types";
import { planPath } from "../pathfinding/astar";
import { manhattanDistance } from "../map/graph";
import { BATTERY_PERCENT_PER_CELL } from "../simulation/robotModels";

// A robot's bid: one scalar totalCost the auction minimizes, plus the
// individual factors that produced it (kept on the bid for
// debugging/dashboard display, not just internal working state).
export type RobotBid = {
  robotId: string;
  taskId: string;

  // Ticks until the task would be fully complete — includes the delay of
  // finishing the robot's current task first, not just travel time.
  eta: number;

  travelCost: number; // pure A* distance, pickup leg + dropoff leg
  congestionCost: number; // congestion-weighted extra cost from A*, both legs
  batteryCost: number; // penalty for finishing with less charge to spare
  workloadCost: number; // load-balancing penalty (see computeWorkloadCost)
  urgencyCost: number; // grows as deadline slack shrinks or goes negative
  payloadCost: number; // "right-sizing" penalty — see computePayloadCost

  totalCost: number;

  // false = hard-excluded: unreachable, would drop below the battery
  // safety reserve, or the task's weight exceeds the robot's
  // RobotModel.payloadCapacity outright. assignTask/getBiddingRobots
  // filter these out.
  feasible: boolean;

  // Why feasible is false, or null when feasible. Exists specifically so
  // callers never have to reverse-engineer "which cost field is Infinity"
  // to figure out the reason — that pattern caused a real bug (see
  // updateLowBatteryStreaks in assign.ts): batteryCost used to get set to
  // Infinity in the payload/unreachable branches too, as a generic
  // "everything's infinite when infeasible" filler, which made a battery
  // reason indistinguishable from an unrelated one.
  infeasibleReason: "overweight" | "unreachable" | "battery" | null;
};

/** Experimental scorers only replace soft cost, never hard feasibility.
 * World-scoped metadata survives dispatcher object spreads without changing
 * WorldState or installing a process-global override. Default stays WEIGHTS.
 */
export type BidScorer = (
  robot: RobotState, task: Task, world: WorldState,
  baseline: Readonly<RobotBid>, route: readonly Position[],
) => number;
const BID_SCORER = Symbol("auction.bidScorer");
type ScoredWorld = WorldState & { [BID_SCORER]?: BidScorer };
export function withBidScorer(world: WorldState, scorer?: BidScorer): WorldState {
  return { ...world, [BID_SCORER]: scorer } as ScoredWorld;
}

// ---- Tunable weights ---------------------------------------------------
// Combined into one scalar so assignTask can just pick the lowest
// totalCost. A documented starting point, not the result of any tuning
// pass — expect these to move once there's real fleet data to validate
// against.
const WEIGHTS = {
  travel: 1,
  congestion: 1.5,
  battery: 4,
  workload: 1,
  urgency: 3,
  payload: 0.5,
} as const;


// Hard safety floor: never accept a bid that would leave a robot below
// this charge. This is an eligibility cutoff, not a soft preference.
export const BATTERY_SAFETY_RESERVE_PERCENT = 15;

// How much a task's own priority amplifies urgency sensitivity. Priority
// 0 leaves urgency cost unscaled; higher priority makes the auction weight
// ETA differences between robots more heavily as the deadline approaches.
const PRIORITY_URGENCY_SCALE = 0.5;

// Urgency cost shape: inside this many ticks of slack, cost ramps from 0
// up toward URGENCY_TIGHT_WINDOW; past the deadline, cost jumps by
// URGENCY_MISS_PENALTY plus a further penalty per tick late. Missing a
// deadline is a heavy SOFT penalty, not a hard exclusion — if every robot
// is going to be late, the auction should still pick the least-late one
// rather than leaving the task with zero bidders.
const URGENCY_TIGHT_WINDOW = 50;
const URGENCY_MISS_PENALTY = 200;
const URGENCY_MISS_SLOPE = 5;

function computeBatteryCost(
  robot: RobotState,
  totalDistance: number
): { cost: number; feasible: boolean } {
  const projectedBattery = robot.battery - totalDistance * BATTERY_PERCENT_PER_CELL;
  if (projectedBattery < BATTERY_SAFETY_RESERVE_PERCENT) {
    return { cost: Infinity, feasible: false };
  }
  // Lower remaining charge after the task -> higher cost, so the auction
  // prefers robots that stay well-charged over ones that would end up
  // running close to empty.
  return { cost: 100 - projectedBattery, feasible: true };
}

function computeWorkloadCost(robot: RobotState): number {
  // How far into its "shift" a robot already is, approximated as distance
  // from home — a robot far from home has presumably been busy for a
  // while. Used purely for load-balancing: prefer a fresher robot over
  // one that's already deep into a run, all else being equal.
  //
  // This is a proxy given what RobotState currently tracks. A richer
  // signal (tasks completed, queue depth) would need a counter added to
  // RobotState — nothing in the contract tracks that history yet.
  return manhattanDistance(robot.position, robot.home);
}

// A robot that can only just barely carry the load is a better match than
// one with capacity to spare — sending a big robot to do a small robot's
// job ties up capacity that a genuinely heavy task might need later.
// Excess capacity (capacity - weight) is the penalty: 0 for a perfect fit,
// growing as the robot is more oversized for the task. Hard infeasibility
// (task heavier than the robot can carry at all) is checked separately in
// calculateBid, before routes are even planned.
function computePayloadCost(robot: RobotState, task: Task): number {
  return Math.max(0, robot.model.payloadCapacity - task.weight);
}

function computeUrgencyCost(task: Task, etaTicks: number, world: WorldState): number {
  if (task.deadline === undefined) return 0;

  const slack = task.deadline - (world.tick + etaTicks);
  const priorityScale = 1 + task.priority * PRIORITY_URGENCY_SCALE;

  if (slack < 0) {
    return (URGENCY_MISS_PENALTY + Math.abs(slack) * URGENCY_MISS_SLOPE) * priorityScale;
  }
  return Math.max(0, URGENCY_TIGHT_WINDOW - slack) * priorityScale;
}

// Route: robot -> task.pickup -> task.dropoff, via A*. Pure — never
// mutates world — so it's safe to call repeatedly across every candidate
// robot for a task without side effects.
export function calculateBid(robot: RobotState, task: Task, world: WorldState): RobotBid {
  const workloadCost = computeWorkloadCost(robot);
  const payloadCost = computePayloadCost(robot, task);

  // Cheapest check first: no point planning routes for a robot that
  // physically cannot carry this load at all.
  if (task.weight > robot.model.payloadCapacity) {
    return {
      robotId: robot.id,
      taskId: task.id,
      eta: Infinity,
      travelCost: Infinity,
      congestionCost: 0,
      batteryCost: 0, // NOT the reason — see infeasibleReason
      workloadCost,
      urgencyCost: 0,
      payloadCost: Infinity,
      totalCost: Infinity,
      feasible: false,
      infeasibleReason: "overweight",
    };
  }

  const toPickup = planPath(robot.position, task.pickup, world);
  const pickupToDropoff = planPath(task.pickup, task.dropoff, world);
  const reachable = toPickup.found && pickupToDropoff.found;

  if (!reachable) {
    return {
      robotId: robot.id,
      taskId: task.id,
      eta: Infinity,
      travelCost: Infinity,
      congestionCost: 0,
      batteryCost: 0, // NOT the reason — see infeasibleReason
      workloadCost,
      urgencyCost: 0,
      payloadCost,
      totalCost: Infinity,
      feasible: false,
      infeasibleReason: "unreachable",
    };
  }

  const travelCost = toPickup.distance + pickupToDropoff.distance;
  const congestionCost = toPickup.congestionCost + pickupToDropoff.congestionCost;

  // A robot mid-task can't start this one until it finishes its current
  // route. path[0] is the robot's current position (same convention as
  // everywhere else — see astar.ts/engine.ts), so remaining ticks is
  // path.length - 1. Idle robots (no currentTaskId) contribute nothing.
  const workloadDelay = robot.currentTaskId ? Math.max(0, robot.path.length - 1) : 0;
  const eta = workloadDelay + toPickup.eta + pickupToDropoff.eta;

  const battery = computeBatteryCost(robot, travelCost);
  const urgencyCost = computeUrgencyCost(task, eta, world);

  const totalCost = battery.feasible
    ? WEIGHTS.travel * travelCost +
      WEIGHTS.congestion * congestionCost +
      WEIGHTS.battery * battery.cost +
      WEIGHTS.workload * workloadCost +
      WEIGHTS.urgency * urgencyCost +
      WEIGHTS.payload * payloadCost
    : Infinity;

  const bid: RobotBid = {
    robotId: robot.id,
    taskId: task.id,
    eta,
    travelCost,
    congestionCost,
    batteryCost: battery.cost,
    workloadCost,
    urgencyCost,
    payloadCost,
    totalCost,
    feasible: battery.feasible,
    infeasibleReason: battery.feasible ? null : "battery",
  };
  const scorer = (world as ScoredWorld)[BID_SCORER];
  if (bid.feasible && scorer) {
    const score = scorer(robot, task, world, bid,
      [...toPickup.path, ...pickupToDropoff.path.slice(1)]);
    // Invalid predictions cannot poison deterministic auction comparisons.
    if (Number.isFinite(score)) return { ...bid, totalCost: score };
  }
  return bid;
}
