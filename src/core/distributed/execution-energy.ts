import { activeTaskAffordable } from "./charging";
import { assessBidEnergy } from "../ml/bidfeatures";
import { BATTERY_PERCENT_PER_CELL } from "../simulation/robotModels";
import type { Position, RobotState, Task, WorldState } from "../types";

/** Re-certify the proposed move, not just the original auction. A detour may
 * spend only the surplus above remaining work + chosen charger + 15% reserve.
 * This prevents exhaustion; it does not promise recovery from a blocked route.
 * Same gate for baseline and treatment, with the frozen bid model untouched.
 */
export function executionEnergyAllowed(robot: RobotState, task: Task | undefined, to: Position, world: WorldState): boolean {
  if (to.x === robot.position.x && to.y === robot.position.y) return true;
  if (!task || robot.battery < BATTERY_PERCENT_PER_CELL) return false;
  const remaining = task.status === "in_progress" ? { ...task, pickup: to } : task;
  const candidate = { ...robot, position: to, battery: robot.battery - BATTERY_PERCENT_PER_CELL, currentTaskId: undefined };
  const queue = robot.queuedTaskIds ?? [];
  if (queue.length !== 4) return assessBidEnergy(candidate, remaining, world).admitted;
  // Bid admission rejects a full queue, but this is execution of EXISTING
  // commitments. Certify the active prefix, then all four queued jobs from
  // its endpoint and remaining battery. No job or charger reserve is omitted.
  const active = assessBidEnergy({ ...candidate, queuedTaskIds: [] }, remaining, world);
  const firstQueued = world.tasks.find(t => t.id === queue[0]);
  if (!active.admitted || !firstQueued || firstQueued.status === "completed") return false;
  return assessBidEnergy({ ...candidate, position: remaining.dropoff,
    battery: candidate.battery - active.committedDistance * BATTERY_PERCENT_PER_CELL,
    queuedTaskIds: queue.slice(1) }, firstQueued, world).admitted;
}

/** Charging-enabled runtime only: every queued job is recertified before its
 * pickup, with recharge allowed between jobs. The original all-queue gate above
 * remains unchanged for runtimes that do not implement this lifecycle. */
export function executionActiveTaskAllowed(robot: RobotState, task: Task | undefined, to: Position, world: WorldState): boolean {
  if (robot.status === "failed" || !Number.isFinite(robot.battery)) return false;
  if (to.x === robot.position.x && to.y === robot.position.y) return true;
  if (!task || Math.abs(to.x - robot.position.x) + Math.abs(to.y - robot.position.y) !== 1 ||
      !world.map.cells.some(c => !c.blocked && c.position.x === to.x && c.position.y === to.y)) return false;
  return activeTaskAffordable({ ...robot, position: to, battery: robot.battery - BATTERY_PERCENT_PER_CELL }, task, world);
}
