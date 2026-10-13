import { CHARGING_STATIONS } from "../map/warehouse";
import { planPath } from "../pathfinding/astar";
import { assessBidEnergy } from "../ml/bidfeatures";
import { BATTERY_PERCENT_PER_CELL, CHARGE_PERCENT_PER_TICK, MIN_BATTERY_TO_BID_PERCENT, RECHARGE_TARGET_PERCENT, needsToCharge } from "../simulation/robotModels";
import type { Position, RobotState, Task, WorldState } from "../types";

export const CHARGING_RESERVE_PERCENT = 15;
/**
 * Expected cost, in cells of travel, of each robot already at or heading to a
 * charger. Roughly one top-up: ~15 ticks from the bid floor to the recharge
 * target at CHARGE_PERCENT_PER_TICK.
 */
export const CHARGER_QUEUE_PENALTY_CELLS = 15;
/** How many peers this robot has heard of at, or routing to, a station. */
export type StationLoad = (station: Position) => number;
/** Whether a single-occupancy station is already claimed by a peer this robot has heard. */
export type StationTaken = (station: Position) => boolean;
/**
 * Dense-fleet charging aids. Every field is optional and absent means the
 * original behaviour, so benchmark runs are unchanged unless they opt in.
 */
export type ChargingTraffic = {
  /** Prefer chargers fewer heard peers are using (see CHARGER_QUEUE_PENALTY_CELLS). */
  stationLoad?: StationLoad;
  /** Give up a dead-end charger a peer is known to hold. */
  stationTaken?: StationTaken;
  /**
   * Battery slack, above job + charger + reserve, required before starting a
   * job, and added to the charge trigger. Robots used to run down to the 20%
   * trigger against a 15% reserve, so a robot carrying cargo or driving to a
   * charger could not afford a single side-step around traffic: the move gate
   * refused it, and the robot stood in the aisle with the queue behind it.
   */
  marginPercent?: number;
  /** A carrier whose every step is refused tops up with its cargo on board. */
  cargoTopUp?: boolean;
  /**
   * When no charger is reachable with the full reserve, head for the nearest one
   * reachable above this floor instead of holding. Detours around traffic on the
   * way to charge drained robots below the reserve the route check demands,
   * and they then stood mid-floor for good: stranded, and in someone's way.
   */
  strandedFloorPercent?: number;
};
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
export type ChargingDecision = { mode: "work" | "transit" | "charging" | "hold"; goal: Position | undefined; hold: boolean; reason: string };

/** Certify one job before executing it. Queued jobs are retained, and each is
 * certified in turn with an opportunity to recharge BETWEEN jobs. Only callers
 * that install the charging lifecycle may use this in place of the all-queue gate.
 */
export function activeTaskEnergy(robot: RobotState, task: Task, world: WorldState) {
  const remaining = task.status === "in_progress" ? { ...task, pickup: robot.position } : task;
  return assessBidEnergy({ ...robot, status: "assigned", battery: 100,
    currentTaskId: undefined, queuedTaskIds: [] }, remaining, world);
}
export function activeTaskAffordable(robot: RobotState, task: Task, world: WorldState): boolean {
  const energy = activeTaskEnergy(robot, task, world);
  return Number.isFinite(robot.battery) && robot.battery >= (task.status === "in_progress" ? CHARGING_RESERVE_PERCENT : MIN_BATTERY_TO_BID_PERCENT) &&
    energy.admitted && robot.battery >= energy.requiredEnergy;
}

/** Local lifecycle; never changes ownership, task status, active ID or queue.
 * Navigation and shared-station collision exclusion remain the normal motion
 * layer's responsibility. No global charger reservation or peer-private state.
 */
export class DistributedCharging {
  private station: Position | undefined;
  private lastChargeTick = -1;
  /** Recharging with cargo still on board, until RECHARGE_TARGET_PERCENT. */
  private cargoTopUp = false;
  /** Reserve the current charger trip is certified against. */
  private reserve = CHARGING_RESERVE_PERCENT;
  private decision: ChargingDecision = { mode: "work", goal: undefined, hold: false, reason: "ready" };
  get active() { return this.decision.mode !== "work"; }
  get goal() { return this.decision.goal; }
  get state(): ChargingDecision { return { ...this.decision, goal: this.goal && { ...this.goal } }; }

  prepare(robot: RobotState, world: WorldState, tick: number, commitmentsAffordable = true, traffic: ChargingTraffic = {}): ChargingDecision {
    if (!Number.isInteger(tick) || tick < 0) throw new Error("Invalid charging tick");
    const task = world.tasks.find(t => t.id === robot.currentTaskId && t.status !== "completed");
    const result = (mode: ChargingDecision["mode"], reason: string, goal?: Position) => {
      this.decision = { mode, reason, goal, hold: mode === "hold" || mode === "charging" };
      if (mode !== "work" && robot.status !== "failed") robot.status = "charging";
      if (mode === "work" && robot.status === "charging") robot.status = task ? "assigned" : "idle";
      return this.state;
    };
    if (robot.status === "failed" || !Number.isFinite(robot.battery) || robot.battery < 0)
      return result("hold", "invalid-or-failed-robot");
    // Cargo remains in custody: finish a certified delivery; otherwise stop for
    // explicit recovery. Never turn a carried job back into an auction candidate.
    //
    // The exception is a carrier that traffic has forced onto a detour it cannot
    // afford: every step is refused, so it would stand in the aisle with its load
    // for good, and the robots queued behind it with it. When the runtime reports
    // its commitments unaffordable it tops up first, keeping custody of the
    // cargo, and resumes the delivery once recharged.
    const cargo = task?.status === "in_progress";
    if (!cargo || robot.battery >= RECHARGE_TARGET_PERCENT) this.cargoTopUp = false;
    // Same when the delivery itself has become unaffordable: holding for
    // recovery left a loaded robot parked, sometimes on the very charger the
    // queue around it was waiting for.
    if (cargo && traffic.cargoTopUp && robot.battery < RECHARGE_TARGET_PERCENT &&
        (!commitmentsAffordable || !activeTaskAffordable(robot, task, world))) this.cargoTopUp = true;
    if (cargo && !this.cargoTopUp) {
      this.station = undefined;
      return activeTaskAffordable(robot, task, world) ? result("work", "deliver-cargo") : result("hold", "cargo-recovery-required");
    }
    const margin = Math.min(traffic.marginPercent ?? 0, 100 - robot.battery);
    const affordable = (!task || activeTaskAffordable({ ...robot, battery: robot.battery - margin }, task, world)) && commitmentsAffordable;
    if (!cargo && !this.active && affordable && !needsToCharge(robot) && robot.battery >= MIN_BATTERY_TO_BID_PERCENT + margin) return result("work", "ready");
    if (!cargo && this.active && robot.battery >= RECHARGE_TARGET_PERCENT && affordable) {
      this.station = undefined; robot.lowBatteryStreak = 0;
      robot.status = task ? "assigned" : "idle";
      return result("work", "recharged");
    }
    if (!cargo && robot.battery >= 100 && !affordable) return result("hold", "task-not-feasible-at-full-charge");
    // Sticky destination prevents thrashing between equidistant stations. A
    // changed static map invalidates it and triggers deterministic reselection.
    if (this.station && !this.routeAffordable(robot, this.station, world)) this.station = undefined;
    // A charger with one way in is one robot's at a time. When several headed for
    // the dead-end charger C2 together, the charged robot inside could not leave
    // past the queue in its only approach, and the queue could not enter: the
    // fleet froze around it for good. Give it up once a peer is known to hold it.
    if (this.station && !same(robot.position, this.station) && traffic.stationTaken?.(this.station)) this.station = undefined;
    if (!this.station) {
      this.reserve = CHARGING_RESERVE_PERCENT;
      this.station = this.selectStation(robot, world, traffic);
      if (!this.station && traffic.strandedFloorPercent !== undefined) {
        this.reserve = traffic.strandedFloorPercent;
        this.station = this.selectStation(robot, world, traffic);
      }
    }
    if (!this.station) return result("hold", "no-charger-reachable-with-reserve");
    return same(robot.position, this.station) ? result("charging", "at-charger", this.station) : result("transit", "charging-required", this.station);
  }

  private selectStation(robot: RobotState, world: WorldState, traffic: ChargingTraffic): Position | undefined {
    // Nearest charger by expected wait, not by drive alone. Choosing purely by
    // distance sent every nearby robot to the same station, and at 15-20 robots
    // they queued single-file through the main corridors, which is where the
    // fleet jammed. The load comes only from peers this robot has itself heard
    // (their heartbeats carry position and planned route), so there is still
    // no global charger reservation. Without a load function, behaviour is the
    // original nearest-station rule.
    const cost = (s: { position: Position; route: { distance: number } }) =>
      s.route.distance + CHARGER_QUEUE_PENALTY_CELLS * (traffic.stationLoad?.(s.position) ?? 0);
    const candidates = CHARGING_STATIONS.map(s => ({ position: s.position, route: planPath(robot.position, s.position, world) }))
      .filter(s => world.map.cells.some(c => !c.blocked && same(c.position, s.position)) && s.route.found && (s.route.distance === 0 || robot.battery >= s.route.distance * BATTERY_PERCENT_PER_CELL + this.reserve))
      .sort((a, b) => cost(a) - cost(b) || a.route.distance - b.route.distance || a.position.y - b.position.y || a.position.x - b.position.x);
    const free = candidates.filter(s => same(robot.position, s.position) || !traffic.stationTaken?.(s.position));
    return (free.length ? free : candidates)[0]?.position;
  }

  private routeAffordable(robot: RobotState, station: Position, world: WorldState) {
    const route = planPath(robot.position, station, world);
    return world.map.cells.some(c => !c.blocked && same(c.position, station)) && route.found && Number.isFinite(robot.battery) &&
      (route.distance === 0 || robot.battery >= route.distance * BATTERY_PERCENT_PER_CELL + this.reserve);
  }

  allowsMove(robot: RobotState, to: Position, world: WorldState): boolean {
    if (robot.status === "failed" || !Number.isFinite(robot.battery)) return false;
    if (same(robot.position, to)) return true;
    if (this.decision.mode !== "transit" || !this.station ||
        Math.abs(robot.position.x - to.x) + Math.abs(robot.position.y - to.y) !== 1 ||
        !world.map.cells.some(c => !c.blocked && same(c.position, to))) return false;
    return robot.battery - BATTERY_PERCENT_PER_CELL >= this.reserve &&
      this.routeAffordable({ ...robot, position: to, battery: robot.battery - BATTERY_PERCENT_PER_CELL }, this.station, world);
  }

  /** Once per committed physical tick, after movement drain. Calling twice or
   * replaying old ticks never creates extra energy. Merely intending to charge
   * cannot recharge a robot elsewhere, on a blocked cell, or while failed.
   */
  afterMotion(robot: RobotState, world: WorldState, tick: number): number {
    if (!Number.isInteger(tick) || tick < 0) throw new Error("Invalid charging tick");
    if (tick <= this.lastChargeTick) return 0;
    this.lastChargeTick = tick;
    if (!this.active || !this.station || robot.status === "failed" ||
        !Number.isFinite(robot.battery) || !same(robot.position, this.station) ||
        !world.map.cells.some(c => !c.blocked && same(c.position, this.station!))) return 0;
    const gained = Math.min(CHARGE_PERCENT_PER_TICK, 100 - robot.battery);
    robot.battery += Math.max(0, gained);
    return Math.max(0, gained);
  }
}
