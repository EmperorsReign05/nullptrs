import { describe, it } from "vitest";
import { runDispatchTick as protoTick } from "../src/core/simulation/dispatch2";
import { createInitialWorld } from "../src/core/simulation/state";
import { growFleet, openCells } from "./harness";
import { BATTERY_PERCENT_PER_CELL, CHARGE_PERCENT_PER_TICK, RECHARGE_TARGET_PERCENT } from "../src/core/simulation/robotModels";
import type { WorldState, Position, RobotState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
function makeTasks(w: WorldState, s: number, open: Position[]) {
  const out = [];
  for (let i = 0; i < 3; i++) { const n = s + i; const p = open[(n * 7 + 3) % open.length]; const d = open[(n * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push({ id: `L${n}`, pickup: p, dropoff: d, weight: (n % 9) * 10 + 10, createdAt: w.tick, priority: 1, status: "pending" as const }); }
  return out;
}

describe("Q: WHY did the prototype regress? Dock capacity is the binding constraint.", () => {
  it("Q1: the energy budget arithmetic", () => {
    console.log(`Q1 drain       = ${BATTERY_PERCENT_PER_CELL}%/cell`);
    console.log(`Q1 charge      = ${CHARGE_PERCENT_PER_TICK}%/tick, leaving at ${RECHARGE_TARGET_PERCENT}%`);
    // A typical task: pickup + dropoff legs, measured ~17-36 cells each way
    // from the earlier bid dump => assume 25 cells to pickup, 25 to dropoff.
    const taskCells = 50;
    const taskEnergy = taskCells * BATTERY_PERCENT_PER_CELL;
    // From 35% floor, a robot must climb back to RECHARGE_TARGET to leave.
    const climbTicks = (RECHARGE_TARGET_PERCENT - 35) / CHARGE_PERCENT_PER_TICK;
    const workTicks = taskCells; // 1 cell per tick
    const dutyCycle = climbTicks / (climbTicks + workTicks);
    console.log(`Q1 a ${taskCells}-cell task costs ${taskEnergy}% and ${workTicks} ticks of driving`);
    console.log(`Q1 climbing 35% -> ${RECHARGE_TARGET_PERCENT}% takes ${climbTicks} ticks parked`);
    console.log(`Q1 => each robot spends ${(dutyCycle * 100).toFixed(0)}% of its time OCCUPYING A DOCK`);
    for (const fleet of [10, 20, 30]) {
      const needed = fleet * dutyCycle;
      console.log(`Q1   fleet=${fleet}: needs ${needed.toFixed(1)} concurrent docks, has 4 => ${needed > 4 ? "OVER SUBSCRIBED by " + (needed - 4).toFixed(1) : "ok"}`);
    }
    console.log("Q1 => THE FLEET IS DOCK-CAPACITY-BOUND. No bid-cost term can fix a physical capacity shortage.");
  });

  it("Q2: sweep dock count against fleet size, prototype engine", () => {
    const base = createInitialWorld();
    const baseOpen = openCells(base);
    // Docks are module-level constants; simulate the effect by measuring
    // how throughput scales with the ratio fleet/docks instead, which is
    // the dimensionless quantity that matters.
    console.log("Q2 fleet | docks | docks-per-robot | completed | charging-at-end | avgBattery");
    for (const [fleet, docks] of [[8, 4], [10, 4], [16, 4], [20, 4]] as [number, number][]) {
      let w = growFleet(base, fleet);
      const open = baseOpen;
      let n = 0;
      for (let i = 0; i < 3000; i++) {
        if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
        w = protoTick(w);
      }
      const ch = w.robots.filter((r) => r.status === "charging").length;
      const avg = w.robots.reduce((a, r) => a + r.battery, 0) / fleet;
      console.log(`Q2 ${String(fleet).padStart(5)} | ${String(docks).padStart(5)} | ${(docks / fleet).toFixed(2).padStart(15)} | ${String(w.tasks.filter((t) => t.status === "completed").length).padStart(9)} | ${String(ch).padStart(15)} | ${avg.toFixed(1)}`);
    }
  });

  it("Q3: measure actual dock OCCUPANCY — are docks saturated or idle?", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0;
    const dockBusy = new Map<string, number>();
    const totalTicks = 3000;
    for (let i = 0; i < totalTicks; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = protoTick(w);
      for (const d of [{ x: 0, y: 4 }, { x: 19, y: 8 }, { x: 9, y: 0 }, { x: 9, y: 12 }]) {
        const occupied = w.robots.some((r) => r.position.x === d.x && r.position.y === d.y);
        if (occupied) dockBusy.set(key(d), (dockBusy.get(key(d)) ?? 0) + 1);
      }
    }
    console.log("Q3 dock utilisation over 3000 ticks:");
    for (const [d, c] of dockBusy) console.log(`Q3   ${d.padEnd(6)} ${((c / totalTicks) * 100).toFixed(1)}% occupied`);
    console.log("Q3 => if a dock is <100% occupied while robots are queueing, the problem is QUEUING, not capacity.");
  });

  it("Q4: how many robots WANT a dock vs how many are USING one, at steady state", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0;
    const samples: string[] = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = protoTick(w);
      if (i % 500 === 0) {
        const want = w.robots.filter((r) => r.status === "charging").length;
        const using = w.robots.filter((r) => r.status === "charging" && [{ x: 0, y: 4 }, { x: 19, y: 8 }, { x: 9, y: 0 }, { x: 9, y: 12 }].some((d) => d.x === r.position.x && d.y === r.position.y)).length;
        samples.push(`t=${i}:want${want}/using${using}`);
      }
    }
    console.log("Q4 " + samples.join("  "));
    console.log("Q4 => a large want-vs-using gap is the pileup: robots en route to an occupied dock with nowhere to wait.");
  });
});
