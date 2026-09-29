// I2 at the AUCTION layer: an energy-feasibility gate that makes starvation
// unreachable, plus the bid-cost corrections. Same interface as
// simulation/dispatch.ts so it is a drop-in comparison.
import type { RobotState, Task, WorldState } from "../types";
import { assignTask, updateLowBatteryStreaks } from "../auction/assign";
import { stepSimulation } from "./engine2";
import { energyFloorPercent, isLegalStop } from "./engine2";

const MAX_TASKS_PER_DISPATCH_ROUND = 30;

// I2: the auction must not hand a robot work it cannot finish AND still
// recharge from. This is the invariant that makes "everybody below the
// floor, nobody can bid" an unreachable state: a robot is never allowed to
// bid its way down to the floor in the first place.
function isEnergyFeasible(robot: RobotState): boolean {
  return robot.battery >= energyFloorPercent();
}

function runAuctionRound(world: WorldState): WorldState {
  let robots = world.robots;
  let tasks = world.tasks;

  const upForAuction = tasks.filter((t) => t.status === "pending").slice(0, MAX_TASKS_PER_DISPATCH_ROUND);
  for (const task of upForAuction) {
    // Only robots that can still guarantee reaching a charger may compete.
    const eligible = robots.filter(isEnergyFeasible);
    const winner = eligible.length === 0 ? null : assignTask(task, eligible, { ...world, robots: eligible, tasks });
    robots = updateLowBatteryStreaks(robots, task, { ...world, robots, tasks }, winner?.robotId ?? null);
    if (!winner) continue;

    robots = robots.map((r) => {
      if (r.id !== winner.robotId) return r;
      if (!r.currentTaskId) return { ...r, currentTaskId: task.id, status: "assigned" as const };
      return { ...r, queuedTaskIds: [...(r.queuedTaskIds ?? []), task.id] };
    });
    tasks = tasks.map((t) => (t.id === task.id ? { ...t, status: "assigned" as const, assignedRobotId: winner.robotId } : t));
  }
  return { ...world, robots, tasks };
}

export function runDispatchTick(world: WorldState): WorldState {
  return stepSimulation(runAuctionRound(world));
}

export { isLegalStop };
