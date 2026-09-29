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
