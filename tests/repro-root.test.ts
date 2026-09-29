import { describe, it } from "vitest";
import { createWarehouseMap, computeCongestion, CHARGING_STATIONS } from "../src/core/map/warehouse";
import { stepSimulation } from "../src/core/simulation/engine";
import { ADDVERB_DYNAMO_100 } from "../src/core/simulation/robotModels";
import type { RobotState, Task, WorldState } from "../src/core/types";

function worldWith(robots: RobotState[], tasks: Task[] = []): WorldState {
  const map = computeCongestion(createWarehouseMap(), robots);
  return { tick: 0, map, robots, tasks, metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
}
function robot(o: Partial<RobotState> & Pick<RobotState, "id" | "position">): RobotState {
  return { home: o.position, battery: 100, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: 0, ...o };
}

describe("root causes", () => {
  it("A: robot drains to 0 mid-task and keeps driving forever on a dead battery", () => {
    const task: Task = { id: "T1", pickup: { x: 17, y: 0 }, dropoff: { x: 1, y: 0 }, weight: 5, createdAt: 0, priority: 0, status: "in_progress", assignedRobotId: "R0" };
    let world = worldWith([robot({ id: "R0", position: { x: 17, y: 0 }, home: { x: 17, y: 0 }, status: "assigned", currentTaskId: "T1", battery: 4 })], [task]);
    let firstZero = -1;
    for (let i = 0; i < 200; i++) {
      world = stepSimulation(world);
      if (world.robots[0].battery === 0 && firstZero === -1) firstZero = world.tick;
    }
    const r = world.robots[0];
    console.log(`A: battery hit 0 at t=${firstZero}; after 200 ticks battery=${r.battery} status=${r.status} task=${r.currentTaskId ?? "none"} taskStatus=${world.tasks[0].status}`);
  });

  it("B: charging robot gets PIBT-pushed off the station mid-charge", () => {
    const c1 = CHARGING_STATIONS[0].position;
    let world = worldWith([
      robot({ id: "RA", position: { x: 1, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
      robot({ id: "RB", position: { x: 2, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
    ]);
    const occupancy: Record<string, string[]> = {};
    for (let i = 0; i < 40; i++) {
      world = stepSimulation(world);
      for (const r of world.robots) {
        const k = `${r.position.x},${r.position.y}`;
        (occupancy[k] ??= []).push(r.id);
      }
    }
    console.log("B: 40 ticks, both still charging?", world.robots.map((r) => `${r.id}:${r.status}@${r.position.x},${r.position.y} b=${r.battery}`).join(" | "));
    console.log("B: cells visited by BOTH robots (contention):");
    for (const [cell, ids] of Object.entries(occupancy)) {
      if (ids.includes("RA") && ids.includes("RB")) {
        const at = CHARGING_STATIONS.find((s) => s.position.x === Number(cell.split(",")[0]) && s.position.y === Number(cell.split(",")[1]));
        console.log(`   ${cell}${at ? " <- " + at.id : ""}`);
      }
    }
    console.log("B: metrics", JSON.stringify(world.metrics));
  });

  it("C: both robots independently pick the same nearest station (no reservation)", () => {
    let world = worldWith([
      robot({ id: "RA", position: { x: 1, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
      robot({ id: "RB", position: { x: 2, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
    ]);
    world = stepSimulation(world);
    console.log("C: RA goal", JSON.stringify(world.robots[0].path.at(-1)), " RB goal", JSON.stringify(world.robots[1].path.at(-1)));
    console.log("C: stations", CHARGING_STATIONS.map((s) => `${s.id}=(${s.position.x},${s.position.y})`).join(" "));
  });
});
