// Find the regime where a 20% MAKESPAN improvement is actually measurable.
//
// The 20-seed run showed the single-seed 20% I reported earlier does NOT
// hold: it was one lucky seed. Across seeds, on the open floor, the
// makespan improvement where BOTH policies finish is mean 3.1%, median
// 0.0%.
//
// The reason is structural, and it is fixable:
//   - Too sparse  -> the baseline almost never conflicts, so it is already
//                    near-optimal and there is nothing to win.
//   - Too dense   -> the baseline deadlocks outright, so "total completion
//                    time" is undefined and a percentage cannot be quoted.
//
// The measurable regime is in between: enough contention that the baseline
// completes but wastes ticks waiting it did not need to, and not so much
// that it deadlocks. This sweep locates it by varying fleet size on the
// open floor.

import { describe, it } from "vitest";
import { runExperiment } from "../src/core/bench/stopwait";
import { scenarioOpenFloor } from "../src/core/bench/scenarios";
import { WAITING_ZONE_CELLS } from "../src/core/map/warehouse";
import type { Position, RobotState, Task, WarehouseMap } from "../src/core/types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function subset(
  base: { map: WarehouseMap; robots: RobotState[]; tasks: Task[] },
  n: number,
  seed: number
) {
  const rand = mulberry32(seed);
  const cells = base.map.cells.filter((c) => !c.blocked).map((c) => c.position);
  const shuffled = [...cells];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const used = new Set<string>();
  const pos: Position[] = [];
  for (const c of shuffled) {
    const k = `${c.x},${c.y}`;
    if (used.has(k)) continue;
    used.add(k);
    pos.push(c);
    if (pos.length >= n) break;
  }
  return {
    map: base.map,
    robots: base.robots.slice(0, n).map((r, i) => ({ ...r, position: { ...pos[i] }, home: { ...pos[i] }, path: [] as Position[] })),
    tasks: base.tasks.slice(0, n),
  };
}

describe("locate the measurable regime", () => {
  it("R: sweep fleet size x seeds, report where BOTH policies complete", () => {
    const base = scenarioOpenFloor();
    console.log("n | seeds bothFinished | baseMean pibtMean | meanImpr | minImpr | medianImpr | maxImpr");
    for (const n of [3, 4, 5, 6]) {
      const both: number[] = [];
      const bm: number[] = [];
      const pm: number[] = [];
      let baseFinished = 0;
      let pibtFinished = 0;
      const N = 40;
      for (let s = 1; s <= N; s++) {
        const v = subset(base, n, s);
        const b = runExperiment(v.map, v.robots, v.tasks, "stop-and-wait", 800);
        const t = runExperiment(v.map, v.robots, v.tasks, "pibt", 800, WAITING_ZONE_CELLS);
        if (b.makespan !== null) baseFinished++;
        if (t.makespan !== null) pibtFinished++;
        if (b.makespan !== null && t.makespan !== null) {
          both.push(s);
          bm.push(b.makespan);
          pm.push(t.makespan);
        }
      }
      const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
      const imps = both.map((_, i) => ((bm[i] - pm[i]) / bm[i]) * 100).sort((a, b) => a - b);
      const med = imps.length ? imps[Math.floor(imps.length / 2)] : NaN;
      console.log(
        `${n} | ${String(both.length).padStart(13)} | ${mean(bm).toFixed(1).padStart(8)} ${mean(pm).toFixed(1).padStart(8)} | ` +
        `${(imps.length ? imps.reduce((a, b) => a + b, 0) / imps.length : NaN).toFixed(1).padStart(8)} | ` +
        `${(imps.length ? imps[0] : NaN).toFixed(1).padStart(7)} | ${med.toFixed(1).padStart(11)} | ${(imps.length ? imps[imps.length - 1] : NaN).toFixed(1).padStart(7)}  ` +
        `(baseFinished ${baseFinished}/${N}, pibtFinished ${pibtFinished}/${N})`
      );
    }
  }, 600000);
});
