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
  return assessBidEnergy(candidate, remaining, world).admitted;
}
