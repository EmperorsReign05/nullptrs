import { describe, expect, it } from "vitest";
import { createWarehouseMap, computeCongestion, CHARGING_STATIONS } from "../src/core/map/warehouse";
import { stepSimulation } from "../src/core/simulation/engine";
import {
  ADDVERB_DYNAMO_100,
  LOW_BATTERY_STREAK_THRESHOLD,
  MIN_BATTERY_TO_BID_PERCENT,
} from "../src/core/simulation/robotModels";
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
  return {
    home: o.position,
    battery: 100,
    status: "idle",
    model: ADDVERB_DYNAMO_100,
    path: [],
    priority: 0,
    ...o,
  };
}

describe("ISSUE 1: robot holding a pickup that also needs to charge", () => {
  it("a robot mid-task (carrying a payload) below the battery floor never charges", () => {
    // Robot is IN_PROGRESS on a task: it already picked up the payload and
    // is heading to the dropoff. Battery is below the hard bidding floor.
    const task: Task = {
      id: "T1",
      pickup: { x: 1, y: 0 },
      dropoff: { x: 14, y: 0 },
      weight: 5,
      createdAt: 0,
      priority: 0,
      status: "in_progress",
      assignedRobotId: "R0",
    };
    let world = worldWith(
      [robot({ id: "R0", position: { x: 3, y: 0 }, status: "assigned", currentTaskId: "T1", battery: MIN_BATTERY_TO_BID_PERCENT - 5, lowBatteryStreak: LOW_BATTERY_STREAK_THRESHOLD + 10 })],
      [task]
    );

    let everCharged = false;
    let minBattery = 100;
    for (let i = 0; i < 60; i++) {
      world = stepSimulation(world);
      const r = world.robots[0];
      if (r.status === "charging") everCharged = true;
      minBattery = Math.min(minBattery, r.battery);
    }

    console.log("ISSUE1 everCharged =", everCharged, "minBattery =", minBattery, "finalBattery =", world.robots[0].battery);
    expect(everCharged).toBe(true);
  });

  it("a robot that finishes a task at near-zero battery is stuck carrying nothing but cannot recharge", () => {
    // Completes its task, drops the payload, then... what? It has a huge
    // low-battery streak but it will only be considered for charging if
    // currentTaskId is empty. It is empty here, so this should work.
    const task: Task = {
      id: "T1",
      pickup: { x: 1, y: 0 },
      dropoff: { x: 3, y: 0 },
      weight: 5,
      createdAt: 0,
      priority: 0,
      status: "in_progress",
      assignedRobotId: "R0",
    };
    let world = worldWith(
      [robot({ id: "R0", position: { x: 3, y: 0 }, status: "assigned", currentTaskId: "T1", battery: 3, lowBatteryStreak: 9 })],
      [task]
    );
    for (let i = 0; i < 10; i++) world = stepSimulation(world);
    console.log("ISSUE1b after 10 ticks:", JSON.stringify(world.robots[0]));
  });
});

describe("ISSUE 2: two robots contending for the same charging station", () => {
  it("two low-battery robots near C1 both target C1 and thrash", () => {
    const c1 = CHARGING_STATIONS[0].position;
    let world = worldWith([
      robot({ id: "RA", position: { x: 1, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
      robot({ id: "RB", position: { x: 2, y: 4 }, battery: 10, lowBatteryStreak: 5 }),
    ]);

    for (let i = 0; i < 6; i++) {
      world = stepSimulation(world);
      console.log(
        `ISSUE2 t=${world.tick}`,
        world.robots.map((r) => `${r.id}@${r.position.x},${r.position.y} ${r.status} b=${r.battery.toFixed(1)}`).join(" | ")
      );
    }
    console.log("ISSUE2 metrics:", JSON.stringify(world.metrics), "stations:", CHARGING_STATIONS.map((s) => `${s.id}@${s.position.x},${s.position.y}`).join(" "));
    console.log("ISSUE2 both targeting c1?", world.robots.map((r) => JSON.stringify(r.path[r.path.length - 1])).join(" "));
    expect(world.robots.some((r) => r.path.length === 0)).toBe(true);
  });
});
