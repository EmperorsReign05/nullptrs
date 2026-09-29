// Arbitration path (my measured fix) vs localCommit path (what runtime.ts
// executes), on identical seeds. 200-seed overlap audit already showed both at
// 0.000%; this compares what each one costs in throughput.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";
const key = (p: Position) => `${p.x},${p.y}`;
const seeds = Number(process.argv[2] ?? 80);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "4,6,8,10,12").split(",").map(Number);

function run(n: number, localCommit: boolean) {
  let full = 0, completed = 0, overlap = 0, ticks = 0, held = 0, live = 0, ms: number[] = [];
  for (let s = 1; s <= seeds; s++) {
    const sc = latticeScenario(1, n, s, 7);
    const f = new DistributedFleet(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), { commRange: 6, localCommit });
    const prev = new Map(f.getRobots().map(r => [r.id, key(r.position)]));
    let mk: number | null = null;
    for (let t = 0; t < maxTicks; t++) {
      f["replanAll"](t); f["step"](t); f["applyMoves"](t);
      ticks++;
      for (const r of f.getRobots()) {
        const k = key(r.position);
        if (r.currentTaskId) { live++; if (k === prev.get(r.id)) held++; }
        prev.set(r.id, k);
      }
      const cells = f.getRobots().map(r => key(r.position));
      if (new Set(cells).size !== cells.length) overlap++;
      if (f.getTasks().every(x => x.status === "completed")) { mk = t + 1; break; }
    }
    if (mk !== null) { full++; ms.push(mk); }
    completed += f.getTasks().filter(x => x.status === "completed").length;
  }
  ms.sort((a, b) => a - b);
  return { full, completed, overlap, ticks, stall: live ? (held / live) * 100 : 0, med: ms.length ? ms[Math.floor(ms.length / 2)] : -1 };
}

console.log(`path comparison: seeds=${seeds} maxTicks=${maxTicks}`);
console.log("n    path          overlap%   completed     fullRuns   medMakespan  liveStall%");
for (const n of ns) {
  for (const [label, lc] of [["arbitration", false], ["localCommit", true]] as [string, boolean][]) {
    const r = run(n, lc);
    console.log(`${String(n).padEnd(4)} ${label.padEnd(13)} ${((r.overlap / r.ticks) * 100).toFixed(3).padEnd(10)} ${(r.completed + "/" + seeds * n).padEnd(13)} ${(r.full + "/" + seeds).padEnd(10)} ${String(r.med).padEnd(13)} ${r.stall.toFixed(1)}`);
  }
}
