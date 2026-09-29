// PROTOTYPE engine: same structure as simulation/engine.ts, but with the
// three invariants enforced. Everything else (A*, congestion, auction,
// task lifecycle) is unchanged so the comparison is apples-to-apples.
import type { Position, RobotState, RobotStatus, Task, WorldState } from "../types";
import { CHARGING_STATIONS, WAITING_ZONES, computeCongestion, isTraversable } from "../map/warehouse";
import { manhattanDistance, positionsEqual } from "../map/graph";
import { planPath } from "../pathfinding/astar";
import { resolvePIBT } from "../pathfinding/pibt2";
import { isLegalStop, energyToNearestDock, routeDistance } from "../pathfinding/pibt2";
import {
  BATTERY_PERCENT_PER_CELL,
  CHARGE_PERCENT_PER_TICK,
  RECHARGE_TARGET_PERCENT,
  needsToCharge,
} from "./robotModels";

const BASE_PRIORITY_RESET = 0;

// I2 parameters. RESERVE is the energy a robot must be able to keep in hand
// to still reach SOME charger from wherever it ends up. Deriving the
// threshold from this (rather than hardcoding 20) is what makes starvation
// unreachable instead of merely tuned-away.
const ENERGY_RESERVE_PERCENT = 15;
const MAX_DOCK_DISTANCE_CELLS = 40; // worst-case grid distance to any dock

function nearestChargingStation(position: Position): Position {
  let best = CHARGING_STATIONS[0].position;
  let bestDist = manhattanDistance(position, best);
  for (const s of CHARGING_STATIONS.slice(1)) {
    const d = manhattanDistance(position, s.position);
    if (d < bestDist) { bestDist = d; best = s.position; }
  }
  return best;
}
function isAtChargingStation(position: Position): boolean {
  return CHARGING_STATIONS.some((s) => positionsEqual(s.position, position));
}

// I2: the energy a robot must have RIGHT NOW to be allowed to keep working.
// It is exactly enough to reach the furthest dock it could ever need, plus
// the reserve. A robot above this can always get to a charger no matter
// where its work takes it, so "stranded with a payload" is unreachable.
function energyFloorPercent(): number {
  return MAX_DOCK_DISTANCE_CELLS * BATTERY_PERCENT_PER_CELL + ENERGY_RESERVE_PERCENT;
}

// Dock reservation. Without this every robot independently picks its own
// "nearest" dock and they all converge on one cell — measured 18 robots
// wanting a dock while 1 was using one. Reservation is a matching, not a
// distance function: each dock is claimed by at most one robot, and a robot
// with no free dock is sent to a legal waiting cell to QUEUE, not to loiter
// in an aisle and not to join a scrum on an occupied dock.
type DockPlan = { dockFor: Map<string, string>; queueFor: Map<string, Position | null> };

function planDocks(robots: RobotState[]): DockPlan {
  const dockFor = new Map<string, string>();
  const queueFor = new Map<string, Position | null>();
  const claimed = new Set<string>();
  const occupiedCells = new Set(robots.map((r) => `${r.position.x},${r.position.y}`));

  const wanting = robots
    .filter((r) => r.status !== "failed" && r.battery < energyFloorPercent())
    .sort((a, b) => a.battery - b.battery); // most depleted gets first pick

  // Robots already parked on a dock keep it.
  for (const r of robots) {
    const here = CHARGING_STATIONS.find((s) => positionsEqual(s.position, r.position));
    if (here && r.status === "charging") { dockFor.set(r.id, here.id); claimed.add(here.id); }
  }

  for (const r of wanting) {
    if (dockFor.has(r.id)) continue;
    const free = CHARGING_STATIONS.filter((s) => !claimed.has(s.id)).sort(
      (a, b) => manhattanDistance(r.position, a.position) - manhattanDistance(r.position, b.position)
    )[0];
    if (free) { dockFor.set(r.id, free.id); claimed.add(free.id); queueFor.set(r.id, null); continue; }
    // No dock free: queue at the nearest legal waiting cell that is free.
    const spots = WAITING_ZONES.flatMap((z) => {
      const out: Position[] = [];
      for (let dx = 0; dx < z.width; dx++) for (let dy = 0; dy < z.height; dy++) out.push({ x: z.x + dx, y: z.y + dy });
      return out;
    }).filter((p) => !occupiedCells.has(`${p.x},${p.y}`));
    spots.sort((a, b) => manhattanDistance(r.position, a) - manhattanDistance(r.position, b));
    queueFor.set(r.id, spots[0] ?? null);
  }
  return { dockFor, queueFor };
}

function resolveIdleWork(robots: RobotState[], world: WorldState): RobotState[] {
  const floor = energyFloorPercent();
  const { dockFor, queueFor } = planDocks(robots);
  return robots.map((robot) => {
    if (robot.status === "failed") return robot;

    // I2, part 1: charge while HOLDING a payload. The old code refused to
    // interrupt a task, which is what stranded robots mid-aisle. We keep
    // currentTaskId intact and simply retarget to a dock; the task resumes
    // when the charge is done.
    if (robot.battery < floor || needsToCharge(robot)) {
      return { ...robot, status: "charging" as RobotStatus };
    }

    if (robot.status === "charging") return robot;
    if (robot.currentTaskId) return robot;

    const queue = robot.queuedTaskIds ?? [];
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      return { ...robot, currentTaskId: next, queuedTaskIds: rest, status: "assigned" as const };
    }
    return robot;
  });
}

function resolveGoal(robot: RobotState, tasks: Task[], dockFor: Map<string, string>, queueFor: Map<string, Position | null>): Position | null {
  if (robot.status === "charging") {
    if (isAtChargingStation(robot.position)) return null;
    const assigned = dockFor.get(robot.id);
    if (assigned) {
      const d = CHARGING_STATIONS.find((s) => s.id === assigned);
      if (d) return d.position;
    }
    const q = queueFor.get(robot.id);
    if (q) return q; // no dock free: hold at a legal waiting cell
    return null;
  }
  if (!robot.currentTaskId) {
    return positionsEqual(robot.position, robot.home) ? null : robot.home;
  }
  const task = tasks.find((t) => t.id === robot.currentTaskId);
  if (!task) return null;
  return task.status === "in_progress" ? task.dropoff : task.pickup;
}

function pathGoal(path: Position[]): Position | null {
  return path.length > 0 ? path[path.length - 1] : null;
}

function needsReplan(robot: RobotState, goal: Position, world: WorldState): boolean {
  const currentGoal = pathGoal(robot.path);
  if (!currentGoal || !positionsEqual(currentGoal, goal)) return true;
  if (robot.path.length > 1 && !isTraversable(robot.path[1], world.map)) return true;
  return false;
}

function planRoutes(state: WorldState, dockFor: Map<string, string>, queueFor: Map<string, Position | null>): { robots: RobotState[]; replans: number } {
  let replans = 0;
  const robots = state.robots.map((robot) => {
    if (robot.status === "failed") return robot;
    const goal = resolveGoal(robot, state.tasks, dockFor, queueFor);
    if (!goal) return robot.path.length > 0 ? { ...robot, path: [] } : robot;
    if (!needsReplan(robot, goal, state)) return robot;
    const result = planPath(robot.position, goal, state);
    replans += 1;
    return { ...robot, path: result.found ? result.path : [] };
  });
  return { robots, replans };
}

function deriveIdleOrTravelingStatus(atGoal: boolean, moved: boolean): RobotStatus {
  if (atGoal) return "idle";
  return moved ? "moving" : "waiting";
}

function applyArrivals(robots: RobotState[], tasks: Task[], movedById: Map<string, boolean>): { robots: RobotState[]; tasks: Task[] } {
  const tasksById = new Map(tasks.map((t) => [t.id, { ...t }]));
  const nextRobots = robots.map((robot): RobotState => {
    if (robot.status === "failed") return robot;

    if (robot.status === "charging") {
      if (!isAtChargingStation(robot.position)) {
        // Sitting in a waiting-zone queue: only start charging on arrival.
        return robot;
      }
      const battery = Math.min(100, robot.battery + CHARGE_PERCENT_PER_TICK);
      if (battery >= RECHARGE_TARGET_PERCENT) {
        // I2: only leave the dock if we can still guarantee reaching one
        // from wherever the next task takes us.
        const canWork = battery >= energyFloorPercent();
        return {
          ...robot,
          battery,
          status: canWork ? (robot.currentTaskId ? "assigned" : "idle") : "charging",
          lowBatteryStreak: 0,
        };
      }
      return { ...robot, battery };
    }

    const moved = movedById.get(robot.id) ?? false;
    if (!robot.currentTaskId) {
      const atHome = positionsEqual(robot.position, robot.home);
      return { ...robot, status: deriveIdleOrTravelingStatus(atHome, moved) };
    }
    const task = tasksById.get(robot.currentTaskId);
    if (!task) return { ...robot, currentTaskId: undefined, status: "idle" };

    if (task.status !== "in_progress" && positionsEqual(robot.position, task.pickup)) {
      task.status = "in_progress";
      return { ...robot, status: "assigned" };
    }
    if (task.status === "in_progress" && positionsEqual(robot.position, task.dropoff)) {
      task.status = "completed";
      return { ...robot, currentTaskId: undefined, status: "idle" };
    }
    return { ...robot, status: moved ? "moving" : "waiting" };
  });
  return { robots: nextRobots, tasks: Array.from(tasksById.values()) };
}

export function stepSimulation(state: WorldState): WorldState {
  const preRouteState: WorldState = { ...state, robots: resolveIdleWork(state.robots, state) };
  const { dockFor, queueFor } = planDocks(preRouteState.robots);
  const { robots: routedRobots, replans } = planRoutes(preRouteState, dockFor, queueFor);
  const worldForPibt: WorldState = { ...preRouteState, robots: routedRobots };
  const { moves, metrics: tickMetrics } = resolvePIBT(routedRobots, worldForPibt);
  const moveByRobot = new Map(moves.map((m) => [m.robotId, m]));
  const movedById = new Map(moves.map((m) => [m.robotId, !positionsEqual(m.from, m.to)]));

  const movedRobots = routedRobots.map((robot): RobotState => {
    const move = moveByRobot.get(robot.id);
    if (!move) return robot;
    const moved = !positionsEqual(move.from, move.to);
    if (!moved) {
      const priority = robot.status !== "failed" && robot.path.length > 1 ? robot.priority + 1 : robot.priority;
      return { ...robot, priority };
    }
    const followedPlan = robot.path.length > 1 && positionsEqual(robot.path[1], move.to);
    const path = followedPlan ? robot.path.slice(1) : [];
    const priority = path.length <= 1 ? BASE_PRIORITY_RESET : robot.priority;
    const battery = Math.max(0, robot.battery - BATTERY_PERCENT_PER_CELL);
    return { ...robot, position: move.to, path, priority, battery };
  });

  const { robots, tasks } = applyArrivals(movedRobots, state.tasks, movedById);
  const map = computeCongestion(state.map, robots);
  return {
    ...state,
    tick: state.tick + 1,
    map,
    robots,
    tasks,
    metrics: {
      replans: state.metrics.replans + replans,
      conflictCount: state.metrics.conflictCount + tickMetrics.conflictCount,
      waitMoves: state.metrics.waitMoves + tickMetrics.waitMoves,
      inheritedPriorities: state.metrics.inheritedPriorities + tickMetrics.inheritedPriorities,
      backtracks: state.metrics.backtracks + tickMetrics.backtracks,
    },
  };
}

export { energyFloorPercent, isLegalStop, energyToNearestDock, routeDistance };
