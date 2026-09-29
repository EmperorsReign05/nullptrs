import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { CHARGING_STATIONS, isTraversable } from "../src/core/map/warehouse";
import { MIN_BATTERY_TO_BID_PERCENT } from "../src/core/simulation/robotModels";
import { growFleet, openCells, makeLoadTasks, sample } from "./harness";
import type { WorldState } from "../src/core/types";

const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

function rollToCollapse(): WorldState {
  let world = growFleet(createInitialWorld(), 20);
  const open = openCells(world);
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeLoadTasks(world, n, 3, open)] }; n += 3; }
    world = runDispatchTick(world);
  }
  return world;
}

describe("dissect the collapse", () => {
  it("D1: freeze frame — where is everyone and what are they waiting for", () => {
    const w = rollToCollapse();
    const s = sample(w);
    console.log(`D1 tick=${w.tick} idle=${s.idle} waiting=${s.waiting} moving=${s.moving} charging=${s.charging} pending=${s.pending} completed=${s.completed}`);
    console.log("D1 per-robot:");
    for (const r of w.robots) {
      const goal = r.path.length ? key(r.path[r.path.length - 1]) : "-";
      const next = r.path.length > 1 ? key(r.path[1]) : "-";
      const atStation = CHARGING_STATIONS.find((c) => c.position.x === r.position.x && c.position.y === r.position.y);
      console.log(`   ${r.id} @${key(r.position).padEnd(6)} ${r.status.padEnd(9)} b=${r.battery.toFixed(1).padStart(5)} streak=${r.lowBatteryStreak ?? 0} prio=${r.priority} goal=${goal.padEnd(6)} next=${next.padEnd(6)}${atStation ? " @" + atStation.id : ""} task=${r.currentTaskId ?? "-"} q=${(r.queuedTaskIds ?? []).length}`);
    }
  });

  it("D2: charging pileup vs station count", () => {
    const w = rollToCollapse();
    const charging = w.robots.filter((r) => r.status === "charging");
    console.log(`D2 ${charging.length} robots in 'charging' status, but only ${CHARGING_STATIONS.length} stations exist`);
    const onStation = charging.filter((r) => CHARGING_STATIONS.some((c) => c.position.x === r.position.x && c.position.y === r.position.y));
    console.log(`D2 actually parked on a station: ${onStation.length}; en route to one: ${charging.length - onStation.length}`);
    const goals = new Map<string, string[]>();
    for (const r of charging) {
      const g = r.path.length ? key(r.path[r.path.length - 1]) : "none(at station)";
      goals.set(g, [...(goals.get(g) ?? []), r.id]);
    }
    for (const [g, ids] of goals) console.log(`   goal ${g}: ${ids.length} robots (${ids.join(",")})`);
  });

  it("D3: throughput — is anything still completing?", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    let last = 0;
    console.log("D3 tick completed delta");
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeLoadTasks(world, n, 3, open)] }; n += 3; }
      world = runDispatchTick(world);
      if (i % 200 === 0) {
        const done = world.tasks.filter((t) => t.status === "completed").length;
        console.log(`   t=${world.tick} completed=${done} (+${done - last}) replans=${world.metrics.replans}`);
        last = done;
      }
    }
  });

  it("D4: battery autopsy — how many robots are functionally dead", () => {
    const w = rollToCollapse();
    let dead = 0, belowFloor = 0, atZero = 0;
    for (const r of w.robots) {
      if (r.battery === 0) atZero++;
      if (r.battery < MIN_BATTERY_TO_BID_PERCENT) belowFloor++;
      if (r.battery === 0 && r.status !== "charging") dead++;
    }
    console.log(`D4 avgBattery=${(w.robots.reduce((a, r) => a + r.battery, 0) / w.robots.length).toFixed(1)} belowFloor=${belowFloor}/${w.robots.length} atZero=${atZero} atZeroButNotCharging=${dead}`);
    const streaks = w.robots.map((r) => r.lowBatteryStreak ?? 0);
    console.log(`D4 lowBatteryStreak max=${Math.max(...streaks)} (threshold is 3) — robots at/over threshold: ${streaks.filter((x) => x >= 3).length}`);
  });

  it("D5: replan counter frozen while conflicts explode", () => {
    const w = rollToCollapse();
    console.log(`D5 replans=${w.metrics.replans} conflicts=${w.metrics.conflictCount} waitMoves=${w.metrics.waitMoves} backtracks=${w.metrics.backtracks} inherited=${w.metrics.inheritedPriorities}`);
    console.log(`D5 over 3000 ticks: conflicts/robot = ${(w.metrics.conflictCount / w.robots.length).toFixed(1)}`);
  });
});
