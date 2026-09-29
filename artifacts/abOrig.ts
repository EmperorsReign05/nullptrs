// A/B harness: runs two DistributedFleet implementations on identical seeds
// and reports the delta. Baseline is the pre-change fleet (artifacts/fleetBase.ts).
//
// Usage: npx vite-node artifacts/ab.ts -- <seeds> <maxTicks> <n1,n2,...> [--trace]
import { DistributedFleet } from "../src/core/distributed/fleet";
import { DistributedFleetBase } from "./fleetOrig";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

type Impl = { name: string; make: typeof DistributedFleet };
const impls: Impl[] = [
  { name: "ORIG", make: DistributedFleetBase as unknown as typeof DistributedFleet },
];

export type Run = {
  completed: number;
  total: number;
  overlap: number;
  ticks: number;
  makespan: number | null;
  /** per-agent: cells visited, moves made, ticks held still */
  visited: Record<string, number>;
  moves: Record<string, number>;
  held: Record<string, number>;
  done: boolean;
  liveHeld: number;
  liveTotal: number;
};

export function runOne(Impl_: Impl, n: number, seed: number, maxTicks: number, bays: boolean): Run {
  const sc = latticeScenario(1, n, seed, 7);
  const robots = JSON.parse(JSON.stringify(sc.robots));
  const tasks = JSON.parse(JSON.stringify(sc.tasks));
  const f = new Impl_.make(sc.map, robots, tasks, { commRange: 6, bays: bays ? ALL_BAYS : undefined });
  const visited: Record<string, Set<string>> = {};
  const moves: Record<string, number> = {};
  const held: Record<string, number> = {};
  const prev: Record<string, string> = {};
  for (const r of f.getRobots()) { visited[r.id] = new Set([key(r.position)]); moves[r.id] = 0; held[r.id] = 0; prev[r.id] = key(r.position); }
  let overlap = 0, ticks = 0, completed = 0, makespan: number | null = null;
  let liveHeld = 0, liveTotal = 0;
  for (let t = 0; t < maxTicks; t++) {
    f["replanAll"](t);
    f["step"](t);
    f["applyMoves"]();
    ticks++;
    for (const r of f.getRobots()) {
      const k = key(r.position);
      const didMove = k !== prev[r.id];
      if (didMove) { moves[r.id]++; visited[r.id].add(k); } else held[r.id]++;
      prev[r.id] = k;
      // Only agents with a LIVE task are evidence about liveness. A robot
      // that finished its one task and parked is idle, not stuck, and
      // counting it made `meanHeld` read as ~200 at n=8 when the true
      // live-task stall count was 14 ticks out of 3200.
      if (r.currentTaskId) { liveTotal++; if (!didMove) liveHeld++; }
    }
    const cells = f.getRobots().map((r) => key(r.position));
    if (new Set(cells).size !== cells.length) overlap++;
    completed = tasks.filter((x) => x.status === "completed").length;
    if (completed === tasks.length) { makespan = t + 1; break; }
  }
  const v: Record<string, number> = {};
  for (const k2 of Object.keys(visited)) v[k2] = visited[k2].size;
  return { completed, total: tasks.length, overlap, ticks, makespan, visited: v, moves, held, done: completed === tasks.length, liveHeld, liveTotal };
}

const seeds = Number(process.argv[2] ?? 20);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "2,4,6,8,10").split(",").map(Number);
const bays = process.argv.includes("bays");

console.log(`A/B  seeds=${seeds} maxTicks=${maxTicks} sizes=${ns.join(",")} bays=${bays}`);
const header = ["n", "impl", "overlap%", "completed", "fullRuns", "medMakespan", "meanVisited", "liveStall%", "meanMoves"];
console.log(header.map((h) => h.padEnd(13)).join(""));
for (const n of ns) {
  for (const impl of impls) {
    const runs: Run[] = [];
    for (let s = 1; s <= seeds; s++) runs.push(runOne(impl, n, s, maxTicks, bays));
    const ov = runs.reduce((a, r) => a + r.overlap, 0);
    const tk = runs.reduce((a, r) => a + r.ticks, 0);
    const comp = runs.reduce((a, r) => a + r.completed, 0);
    const full = runs.filter((r) => r.done).length;
    const ms = runs.filter((r) => r.makespan !== null).map((r) => r.makespan!).sort((a, b) => a - b);
    const med = ms.length ? ms[Math.floor(ms.length / 2)] : -1;
    const nv = runs.reduce((a, r) => a + Object.values(r.visited).reduce((x, y) => x + y, 0), 0);
    const lh = runs.reduce((a, r) => a + r.liveHeld, 0);
    const lt = runs.reduce((a, r) => a + r.liveTotal, 0);
    const nm = runs.reduce((a, r) => a + Object.values(r.moves).reduce((x, y) => x + y, 0), 0);
    const cells = runs.length * n;
    console.log(
      [String(n), impl.name, ((ov / tk) * 100).toFixed(2), `${comp}/${runs.length * n}`, `${full}/${seeds}`, String(med), (nv / cells).toFixed(1), (lt ? (lh / lt) * 100 : 0).toFixed(1), (nm / cells).toFixed(1)]
        .map((h) => h.padEnd(13)).join("")
    );
  }
}
