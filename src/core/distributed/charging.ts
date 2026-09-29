import { CHARGING_STATIONS } from "../map/warehouse";
import { planPath } from "../pathfinding/astar";
import { assessBidEnergy } from "../ml/bidfeatures";
import { BATTERY_PERCENT_PER_CELL, CHARGE_PERCENT_PER_TICK, MIN_BATTERY_TO_BID_PERCENT, RECHARGE_TARGET_PERCENT, needsToCharge } from "../simulation/robotModels";
import type { Position, RobotState, Task, WorldState } from "../types";

export const CHARGING_RESERVE_PERCENT = 15;
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
  private decision: ChargingDecision = { mode: "work", goal: undefined, hold: false, reason: "ready" };
  get active() { return this.decision.mode !== "work"; }
  get goal() { return this.decision.goal; }
  get state(): ChargingDecision { return { ...this.decision, goal: this.goal && { ...this.goal } }; }

  prepare(robot: RobotState, world: WorldState, tick: number): ChargingDecision {
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
    if (task?.status === "in_progress") {
      this.station = undefined;
      return activeTaskAffordable(robot, task, world) ? result("work", "deliver-cargo") : result("hold", "cargo-recovery-required");
    }
    const affordable = !task || activeTaskAffordable(robot, task, world);
    if (!this.active && affordable && !needsToCharge(robot)) return result("work", "ready");
    if (this.active && robot.battery >= RECHARGE_TARGET_PERCENT && affordable) {
      this.station = undefined; robot.lowBatteryStreak = 0;
      robot.status = task ? "assigned" : "idle";
      return result("work", "recharged");
    }
    if (robot.battery >= 100 && !affordable) return result("hold", "task-not-feasible-at-full-charge");
    // Sticky destination prevents thrashing between equidistant stations. A
    // changed static map invalidates it and triggers deterministic reselection.
    if (this.station && !this.routeAffordable(robot, this.station, world)) this.station = undefined;
    if (!this.station) {
      const routes = CHARGING_STATIONS.map(s => ({ position: s.position, route: planPath(robot.position, s.position, world) }))
        .filter(s => world.map.cells.some(c => !c.blocked && same(c.position, s.position)) && s.route.found && (s.route.distance === 0 || robot.battery >= s.route.distance * BATTERY_PERCENT_PER_CELL + CHARGING_RESERVE_PERCENT))
        .sort((a, b) => a.route.distance - b.route.distance || a.position.y - b.position.y || a.position.x - b.position.x);
      this.station = routes[0]?.position;
    }
    if (!this.station) return result("hold", "no-charger-reachable-with-reserve");
    return same(robot.position, this.station) ? result("charging", "at-charger", this.station) : result("transit", "charging-required", this.station);
  }

  private routeAffordable(robot: RobotState, station: Position, world: WorldState) {
    const route = planPath(robot.position, station, world);
    return world.map.cells.some(c => !c.blocked && same(c.position, station)) && route.found && Number.isFinite(robot.battery) &&
      (route.distance === 0 || robot.battery >= route.distance * BATTERY_PERCENT_PER_CELL + CHARGING_RESERVE_PERCENT);
  }

  allowsMove(robot: RobotState, to: Position, world: WorldState): boolean {
    if (robot.status === "failed" || !Number.isFinite(robot.battery)) return false;
    if (same(robot.position, to)) return true;
    if (this.decision.mode !== "transit" || !this.station ||
        Math.abs(robot.position.x - to.x) + Math.abs(robot.position.y - to.y) !== 1 ||
        !world.map.cells.some(c => !c.blocked && same(c.position, to))) return false;
    return robot.battery - BATTERY_PERCENT_PER_CELL >= CHARGING_RESERVE_PERCENT &&
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
