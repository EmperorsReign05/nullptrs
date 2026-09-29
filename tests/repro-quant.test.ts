import { describe, it } from "vitest";
import { createWarehouseMap, computeCongestion, CHARGING_STATIONS } from "../src/core/map/warehouse";
import { stepSimulation } from "../src/core/simulation/engine";
import { ADDVERB_DYNAMO_100, CHARGE_PERCENT_PER_TICK, BATTERY_PERCENT_PER_CELL } from "../src/core/simulation/robotModels";
import type { RobotState, WorldState } from "../src/core/types";

function worldWith(robots: RobotState[]): WorldState {
  const map = computeCongestion(createWarehouseMap(), robots);
  return { tick: 0, map, robots, tasks: [], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
}
function robot(o: Partial<RobotState> & Pick<RobotState, "id" | "position">): RobotState {
  return { home: o.position, battery: 100, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: 0, ...o };
}
const c1 = CHARGING_STATIONS[0].position;

describe("quantify", () => {
  it("Q2: how often is a charging robot shoved off the station, and what does it cost", () => {
    let world = worldWith([
      robot({ id: "RA", position: { x: 1, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
      robot({ id: "RB", position: { x: 2, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
    ]);
    let displaced = 0, chargingTicks = 0, atStationTicks = 0;
    const prev = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 60; i++) {
      world = stepSimulation(world);
      for (const r of world.robots) {
        if (r.status === "charging") {
          chargingTicks++;
          const p = r.position;
          if (p.x === c1.x && p.y === c1.y) atStationTicks++;
          const before = prev.get(r.id);
          if (before && (before.x !== p.x || before.y !== p.y)) displaced++;
        }
        prev.set(r.id, { ...r.position });
      }
    }
    console.log(`Q2 over 60 ticks: charging-ticks=${chargingTicks}, of which parked ON C1=${atStationTicks}, displaced-while-charging=${displaced}`);
    console.log(`Q2 each displacement drains ${BATTERY_PERCENT_PER_CELL}% instead of gaining ${CHARGE_PERCENT_PER_TICK}% => net -${(CHARGE_PERCENT_PER_TICK + BATTERY_PERCENT_PER_CELL).toFixed(2)}%/tick of progress`);
    console.log(`Q2 final: ${world.robots.map((r) => `${r.id} b=${r.battery} ${r.status}`).join(" | ")}`);
    console.log(`Q2 metrics: ${JSON.stringify(world.metrics)}`);
  });

  it("Q1: mid-task robot below the floor keeps draining until the battery is empty", () => {
    const map = createWarehouseMap();
    const task = { id: "T1", pickup: { x: 17, y: 0 }, dropoff: { x: 1, y: 0 }, weight: 5, createdAt: 0, priority: 0, status: "in_progress" as const, assignedRobotId: "R0" };
    let world: WorldState = {
      tick: 0, map, tasks: [task],
      robots: [robot({ id: "R0", position: { x: 17, y: 0 }, home: { x: 17, y: 0 }, status: "assigned", currentTaskId: "T1", battery: 15 })],
      metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    };
    for (let i = 0; i < 25; i++) {
      world = stepSimulation(world);
      const r = world.robots[0];
      if (r.battery < 12) console.log(`Q1 t=${world.tick} battery=${r.battery} status=${r.status} holding=${r.currentTaskId}`);
    }
  });
});
