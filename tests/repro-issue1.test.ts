import { describe, it } from "vitest";
import { createWarehouseMap, computeCongestion } from "../src/core/map/warehouse";
import { stepSimulation } from "../src/core/simulation/engine";
import { ADDVERB_DYNAMO_100, MIN_BATTERY_TO_BID_PERCENT } from "../src/core/simulation/robotModels";
import type { RobotState, Task, WorldState } from "../src/core/types";

function worldWith(robots: RobotState[], tasks: Task[] = []): WorldState {
  const map = computeCongestion(createWarehouseMap(), robots);
  return {
    tick: 0,
    map,
    robots,
    tasks,
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
}

function robot(o: Partial<RobotState> & Pick<RobotState, "id" | "position">): RobotState {
  return { home: o.position, battery: 100, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: 0, ...o };
}

describe("ISSUE 1 sharp", () => {
  it("mid-task robot below the floor never diverts to charge; drains to 0 while still holding the payload", () => {
    // Long haul: pickup already done (in_progress), dropoff is the far side
    // of the map. Battery starts just under the hard bidding floor.
    const task: Task = {
      id: "T1",
      pickup: { x: 1, y: 0 },
      dropoff: { x: 17, y: 0 },
      weight: 5,
      createdAt: 0,
      priority: 0,
      status: "in_progress",
      assignedRobotId: "R0",
    };
    let world = worldWith(
      [robot({ id: "R0", position: { x: 1, y: 0 }, home: { x: 1, y: 0 }, status: "assigned", currentTaskId: "T1", battery: MIN_BATTERY_TO_BID_PERCENT - 2, lowBatteryStreak: 99 })],
      [task]
    );

    let chargedWhileCarrying = false;
    for (let i = 0; i < 120; i++) {
      world = stepSimulation(world);
      const r = world.robots[0];
      if (r.status === "charging" && r.currentTaskId) chargedWhileCarrying = true;
      if (i % 20 === 0 || r.battery === 0) {
        console.log(`t=${world.tick} b=${r.battery} status=${r.status} task=${r.currentTaskId ?? "-"} pos=${r.position.x},${r.position.y}`);
      }
      if (r.battery === 0) break;
    }
    const r = world.robots[0];
    console.log("=> charged while carrying?", chargedWhileCarrying, "| final battery", r.battery, "| task", r.currentTaskId ?? "none", "| status", r.status);
  });

  it("robot is stranded at 0% battery: can never bid, never charges while holding a task", () => {
    const task: Task = {
      id: "T1",
      pickup: { x: 17, y: 0 },
      dropoff: { x: 1, y: 0 },
      weight: 5,
      createdAt: 0,
      priority: 0,
      status: "assigned",
      assignedRobotId: "R0",
    };
    // Starts at 0% — physically dead but still holding an unstarted task.
    let world = worldWith(
      [robot({ id: "R0", position: { x: 17, y: 0 }, home: { x: 17, y: 0 }, status: "assigned", currentTaskId: "T1", battery: 0, lowBatteryStreak: 0 })],
      [task]
    );
    for (let i = 0; i < 40; i++) world = stepSimulation(world);
    const r = world.robots[0];
    console.log(`=> stranded: status=${r.status} battery=${r.battery} task=${r.currentTaskId} pos=${r.position.x},${r.position.y}`);
  });
});
