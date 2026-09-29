// Multi-seed benchmark. A single seed is a single number; the brief's
// criterion is a percentage improvement, so the number has to hold across
// a distribution or it is not a result, it is an anecdote.
//
// Every seed varies the ROBOT START POSITIONS and TASK ASSIGNMENT order
// only. The map geometry, the planner, the tick rate, and the policy
// under test are held constant — varying those would be measuring
// something else, and would reintroduce exactly the "the comparison is
// rigged" objection this whole file exists to close.

import { describe, it } from "vitest";
import { runExperiment } from "../src/core/bench/stopwait";
import { scenarioChokePoint, scenarioTJunction, scenarioOpenFloor, CHOKE_BAYS, T_BAYS } from "../src/core/bench/scenarios";
import { WAITING_ZONE_CELLS, isTraversable } from "../src/core/map/warehouse";
import type { Position, RobotState, Task, WarehouseMap } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

// Deterministic PRNG so a reported result can be reproduced exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freeCells(map: WarehouseMap): Position[] {
  return map.cells.filter((c) => !c.blocked).map((c) => c.position);
}

/**
 * Re-randomise a scenario: shuffle which robot starts where and which task
 * it gets. Route geometry and the choke point itself are untouched.
 */
function variant(
  base: { map: WarehouseMap; robots: RobotState[]; tasks: Task[] },
  seed: number
): { map: WarehouseMap; robots: RobotState[]; tasks: Task[] } {
  const rand = mulberry32(seed);
  const cells = freeCells(base.map);
  const shuffled = [...cells];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const positions: Position[] = [];
  const used = new Set<string>();
  for (const c of shuffled) {
    if (used.has(key(c))) continue;
    used.add(key(c));
    positions.push(c);
    if (positions.length >= base.robots.length) break;
  }

  const robots = base.robots.map((r, i) => ({ ...r, position: { ...positions[i] }, home: { ...positions[i] }, path: [] as Position[] }));
  const tasks = base.tasks.map((t) => ({ ...t }));
  return { map: base.map, robots, tasks };
}

type Row = {
  seed: number;
  baseMakespan: number | null;
  baseCompleted: number;
  pibtMakespan: number | null;
  pibtCompleted: number;
  improvement: number | null;
};

function runSuite(
  name: string,
  build: () => { map: WarehouseMap; robots: RobotState[]; tasks: Task[] },
  bays: ReadonlySet<string>,
  seeds: number,
  maxTicks: number
): Row[] {
  const rows: Row[] = [];
  const base = build();
  for (let s = 1; s <= seeds; s++) {
    const v = variant(base, s);
    const b = runExperiment(v.map, v.robots, v.tasks, "stop-and-wait", maxTicks);
    const t = runExperiment(v.map, v.robots, v.tasks, "pibt", maxTicks, bays);
    let improvement: number | null = null;
    if (b.makespan !== null && t.makespan !== null) improvement = ((b.makespan - t.makespan) / b.makespan) * 100;
    rows.push({
      seed: s,
      baseMakespan: b.makespan,
      baseCompleted: b.completed,
      pibtMakespan: t.makespan,
      pibtCompleted: t.completed,
      improvement,
    });
  }
  return rows;
}

function summarise(name: string, rows: Row[], total: number) {
  const baseFinished = rows.filter((r) => r.baseMakespan !== null).length;
  const pibtFinished = rows.filter((r) => r.pibtMakespan !== null).length;
  const baseAll = rows.filter((r) => r.baseCompleted === total).length;
  const pibtAll = rows.filter((r) => r.pibtCompleted === total).length;
  const imp = rows.map((r) => r.improvement).filter((x): x is number => x !== null);

  console.log(`\n=== ${name} (${rows.length} seeds, ${total} tasks each) ===`);
  console.log(`  baseline completed ALL ${total} tasks : ${baseAll}/${rows.length}`);
  console.log(`  pibt     completed ALL ${total} tasks : ${pibtAll}/${rows.length}`);
  console.log(`  baseline produced a makespan at all    : ${baseFinished}/${rows.length}`);
  console.log(`  pibt     produced a makespan at all    : ${pibtFinished}/${rows.length}`);
  if (imp.length > 0) {
    const mean = imp.reduce((a, b) => a + b, 0) / imp.length;
    const sorted = [...imp].sort((a, b) => a - b);
    console.log(`  makespan improvement where BOTH finished: mean ${mean.toFixed(1)}%, median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}%, range ${sorted[0].toFixed(1)}%..${sorted[sorted.length - 1].toFixed(1)}%  (n=${imp.length})`);
  } else {
    console.log(`  makespan improvement: NOT COMPUTABLE — no seed where both finished`);
  }
  const wins = rows.filter((r) => r.pibtCompleted > r.baseCompleted).length;
  const losses = rows.filter((r) => r.pibtCompleted < r.baseCompleted).length;
  console.log(`  per-seed task count: pibt better on ${wins}, worse on ${losses}, tied on ${rows.length - wins - losses}`);
  return { baseAll, pibtAll, rows: rows.length };
}

describe("SIH26123 multi-seed benchmark", () => {
  it("M1: choke point across 20 seeds", () => {
    const rows = runSuite("choke-point", scenarioChokePoint, CHOKE_BAYS, 20, 600);
    console.log("  seed | baseline        | pibt            | impr");
    for (const r of rows) {
      console.log(
        `  ${String(r.seed).padStart(4)} | ${String(r.baseMakespan ?? "DEADLOCK").padStart(9)} (${r.baseCompleted}/3) | ` +
        `${String(r.pibtMakespan ?? "DEADLOCK").padStart(9)} (${r.pibtCompleted}/3) | ${r.improvement === null ? "  n/a" : r.improvement.toFixed(1).padStart(5) + "%"}`
      );
    }
    summarise("choke-point", rows, 3);
  }, 300000);

  it("M2: open floor across 20 seeds", () => {
    const rows = runSuite("open-floor", scenarioOpenFloor, WAITING_ZONE_CELLS, 20, 600);
    console.log("  seed | baseline        | pibt            | impr");
    for (const r of rows) {
      console.log(
        `  ${String(r.seed).padStart(4)} | ${String(r.baseMakespan ?? "DEADLOCK").padStart(9)} (${r.baseCompleted}/6) | ` +
        `${String(r.pibtMakespan ?? "DEADLOCK").padStart(9)} (${r.pibtCompleted}/6) | ${r.improvement === null ? "  n/a" : r.improvement.toFixed(1).padStart(5) + "%"}`
      );
    }
    summarise("open-floor", rows, 6);
  }, 300000);

  it("M3: t-junction across 20 seeds (known gap)", () => {
    const rows = runSuite("t-junction", scenarioTJunction, T_BAYS, 20, 600);
    summarise("t-junction", rows, 3);
  }, 300000);
});
