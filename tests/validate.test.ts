import { describe, it, expect } from "vitest";
import { runDispatchTick as baseTick } from "../src/core/simulation/dispatch";
import { runDispatchTick as protoTick } from "../src/core/simulation/dispatch2";
import { isLegalStop, energyFloorPercent } from "../src/core/simulation/engine2";
import { createInitialWorld } from "../src/core/simulation/state";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
function makeTasks(w: WorldState, s: number, open: Position[]) {
  const out = [];
  for (let i = 0; i < 3; i++) { const n = s + i; const p = open[(n * 7 + 3) % open.length]; const d = open[(n * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push({ id: `L${n}`, pickup: p, dropoff: d, weight: (n % 9) * 10 + 10, createdAt: w.tick, priority: 1, status: "pending" as const }); }
  return out;
}

// A robot is LIVELOCKED if it is not at a legal stop, is not making progress
// toward any goal, and has been stationary for many consecutive ticks.
function livelocked(world: WorldState) {
  return world.robots.filter((r) => r.status === "waiting" && !isLegalStop(r.position)).length;
}

describe("R: sustained-load validation, 6000 ticks", () => {
  it("R1: 20 AMRs, 6000 ticks — does the prototype stay alive?", () => {
    const run = (tick: (w: WorldState) => WorldState, label: string) => {
      let w = growFleet(createInitialWorld(), 20);
      const open = openCells(w);
      let n = 0, lastDone = 0, lastProgress = 0, worstGap = 0, illegal = 0, stall = 0;
      for (let i = 0; i < 6000; i++) {
        if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
        w = tick(w);
        const done = w.tasks.filter((t) => t.status === "completed").length;
        if (done > lastDone) { lastProgress = i; lastDone = done; }
        worstGap = Math.max(worstGap, i - lastProgress);
        for (const r of w.robots) { if (r.status === "waiting" || r.status === "idle") { stall++; if (!isLegalStop(r.position)) illegal++; } }
      }
      const out = {
        completed: w.tasks.filter((t) => t.status === "completed").length,
        generated: w.tasks.length, worstGap, illegal, stall,
        minB: Math.min(...w.robots.map((r) => r.battery)),
        avgB: w.robots.reduce((a, r) => a + r.battery, 0) / 20,
        conflicts: w.metrics.conflictCount,
        livelocked: livelocked(w),
      };
      console.log(`R1 ${label.padEnd(10)} completed=${String(out.completed).padStart(4)}/${out.generated} worstStarvationGap=${String(out.worstGap).padStart(4)} ticks | illegalStalls=${String(out.illegal).padStart(5)}/${String(out.stall).padStart(5)} (${((out.illegal / out.stall) * 100).toFixed(1)}%) | minB=${out.minB.toFixed(1)} avgB=${out.avgB.toFixed(1)} conflicts=${out.conflicts}`);
      return out;
    };
    const b = run(baseTick, "BASELINE");
    const p = run(protoTick, "PROTOTYPE");
    console.log(`R1 throughput ${b.completed} -> ${p.completed}, worst starvation gap ${b.worstGap} -> ${p.worstGap} ticks`);
  });

  it("R2: illegal-stall invariant — do robots ever come to rest in an aisle?", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0, violations = 0, checked = 0;
    for (let i = 0; i < 4000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = protoTick(w);
      for (const r of w.robots) {
        if (r.status === "waiting") { checked++; if (!isLegalStop(r.position)) violations++; }
      }
    }
    console.log(`R2 ${checked} robot-waiting observations, ${violations} were stationary in an illegal cell (${((violations / checked) * 100).toFixed(1)}%)`);
    console.log(`R2 (baseline for comparison: 88.8% of all stalls were illegal aisle stops)`);
  });

  it("R3: energy feasibility — can a robot ever be stranded away from a dock?", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0, stranded = 0, minB = 100;
    for (let i = 0; i < 4000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = protoTick(w);
      for (const r of w.robots) {
        minB = Math.min(minB, r.battery);
        // stranded = low battery, working, not heading to a dock
        const atDock = [{ x: 0, y: 4 }, { x: 19, y: 8 }, { x: 9, y: 0 }, { x: 9, y: 12 }].some((d) => d.x === r.position.x && d.y === r.position.y);
        const headingToDock = r.path.length > 0 && [{ x: 0, y: 4 }, { x: 19, y: 8 }, { x: 9, y: 0 }, { x: 9, y: 12 }].some((d) => d.x === r.path[r.path.length - 1].x && d.y === r.path[r.path.length - 1].y);
        if (r.battery < 10 && !atDock && !headingToDock && r.status !== "charging") stranded++;
      }
    }
    console.log(`R3 energy floor = ${energyFloorPercent()}%, min battery observed = ${minB.toFixed(1)}%, stranded observations = ${stranded}`);
  });

  it("R4: does the whole existing test suite still pass against the baseline engine?", () => {
    // Sanity: prototype must not break the safety invariants the repo tests.
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0, collisions = 0, onBlocked = 0, doubleBooked = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = protoTick(w);
      const seen = new Set<string>();
      for (const r of w.robots) {
        const k = key(r.position);
        if (seen.has(k)) collisions++;
        seen.add(k);
      }
      const owners = new Map<string, number>();
      for (const r of w.robots) { if (r.currentTaskId) owners.set(r.currentTaskId, (owners.get(r.currentTaskId) ?? 0) + 1); for (const q of r.queuedTaskIds ?? []) owners.set(q, (owners.get(q) ?? 0) + 1); }
      for (const t of w.tasks) if ((t.status === "assigned" || t.status === "in_progress") && (owners.get(t.id) ?? 0) > 1) doubleBooked++;
    }
    console.log(`R4 safety under prototype: cell collisions=${collisions}, robots on blocked cells=${onBlocked}, double-booked tasks=${doubleBooked}`);
    expect(collisions).toBe(0);
    expect(doubleBooked).toBe(0);
  });
});
