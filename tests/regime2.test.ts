// Locate a regime where a defensible MAKESPAN improvement is measurable.
//
// What the 20-seed and fleet-size sweeps established:
//   - On a wide open floor the baseline rarely conflicts, so there is
//     almost nothing to win (mean 2.6% at 3 robots).
//   - On a single-file corridor the baseline gridlocks outright and
//     "total completion time" is undefined (0/20 finished).
//
// The measurable regime needs contention WITHOUT irreducibility. The
// controlling variable is PASSABILITY: if two robots can always get around
// each other, the baseline merely wastes ticks waiting; if they cannot, it
// deadlocks. Pillars on a regular lattice give corridors of a controllable
// width, and corridor width is exactly the passability knob.
//
//   width 1  -> single file -> baseline deadlocks      (no percentage)
//   width 2  -> tight       -> maximum wasted waiting (target regime)
//   width 3+ -> loose       -> baseline near-optimal   (nothing to win)
//
// Robot density and crossing distance are the other two knobs.

import { describe, it } from "vitest";
import { runExperiment } from "../src/core/bench/stopwait";
import { mapFromOpen } from "../src/core/bench/scenarios";
import { WAITING_ZONE_CELLS } from "../src/core/map/warehouse";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import { WAREHOUSE_WIDTH, WAREHOUSE_HEIGHT } from "../src/core/map/warehouse";
import type { Position, RobotState, Task, WarehouseMap } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rectangular plaza of `width`-wide corridors formed by a regular pillar
 * lattice. Every corridor is `width` cells across, so two robots meeting in
 * one can pass iff width >= 2.
 */
export function latticeMap(width: number): WarehouseMap {
  const open: Position[] = [];
  const period = width + 1;
  for (let y = 0; y < WAREHOUSE_HEIGHT; y++) {
    for (let x = 0; x < WAREHOUSE_WIDTH; x++) {
      const isPillar = x % period === 0 && y % period === 0 && x !== 0 && y !== 0;
      if (!isPillar) open.push({ x, y });
    }
  }
  return mapFromOpen(open);
}

function makeScenario(width: number, n: number, seed: number) {
  const map = latticeMap(width);
  const open = map.cells.filter((c) => !c.blocked).map((c) => c.position);
  const rand = mulberry(seed);

  // Start robots on one side, send them to the far side: every task crosses
  // the whole plaza, so every pair of routes contends.
  const shuffled = [...open];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const used = new Set<string>();
  const starts: Position[] = [];
  for (const c of shuffled) {
    if (used.has(key(c))) continue;
    used.add(key(c));
    starts.push(c);
    if (starts.length >= n * 2) break;
  }

  const robots: RobotState[] = [];
  const tasks: Task[] = [];
  // Destinations MUST be distinct. An earlier version of this generator let
  // several robots pick the same "furthest" cell; one cell holds one robot,
  // so the later arrival could never complete and the run looked like an
  // algorithmic failure when it was a scenario defect. Caught by the S0
  // audit below, exactly as the choke-point scenario was.
  const takenDropoffs = new Set<string>();
  const dropoffPool = starts.slice(n);
  for (let i = 0; i < n; i++) {
    const s = starts[i];
    // Furthest still-unclaimed cell from the start: long, mutually crossing
    // routes, and a distinct goal for every robot.
    let best: Position | null = null;
    let bestD = -1;
    for (const c of dropoffPool) {
      if (takenDropoffs.has(key(c))) continue;
      const d = Math.abs(c.x - s.x) + Math.abs(c.y - s.y);
      if (d > bestD) { bestD = d; best = c; }
    }
    if (!best) best = { x: s.x, y: s.y };
    takenDropoffs.add(key(best));
    const id = `AMR-${String(i + 1).padStart(2, "0")}`;
    robots.push({ id, position: { ...s }, home: { ...s }, battery: 100, status: "assigned", model: ROBOT_MODELS[0], currentTaskId: `T${i + 1}`, path: [], priority: 0 });
    tasks.push({ id: `T${i + 1}`, pickup: { ...s }, dropoff: { ...(best as Position) }, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: id });
  }
  return { map, robots, tasks };
}

function mulberry(seed: number) { return mulberry32(seed); }

describe("S0: audit the generator", () => {
  it("are the generated scenarios even valid?", () => {
    for (const [w, n, s] of [[3, 3, 1], [3, 3, 2], [2, 4, 1], [1, 3, 1]] as [number, number, number][]) {
      const sc = makeScenario(w, n, s);
      const open = new Set(sc.map.cells.filter((c) => !c.blocked).map((c) => key(c.position)));
      const robotBad = sc.robots.filter((r) => !open.has(key(r.position)));
      const taskBad = sc.tasks.filter((t) => !open.has(key(t.pickup)) || !open.has(key(t.dropoff)));
      const zeroLen = sc.tasks.filter((t) => t.pickup.x === t.dropoff.x && t.pickup.y === t.dropoff.y);
      const dupDrops = sc.tasks.length - new Set(sc.tasks.map((t) => key(t.dropoff))).size;
      console.log(`S0 w=${w} n=${n} seed=${s}: openCells=${open.size} robotsOffMap=${robotBad.length} tasksOffMap=${taskBad.length} zeroLengthTasks=${zeroLen.length} duplicateDropoffs=${dupDrops}`);
      console.log(`S0   robots: ${sc.robots.map((r) => r.id + "@" + key(r.position)).join(" ")}`);
      console.log(`S0   tasks : ${sc.tasks.map((t) => t.id + " " + key(t.pickup) + "->" + key(t.dropoff)).join(" | ")}`);
    }
  });
});

describe("S: locate the measurable regime (corridor width x fleet size)", () => {
  it("S1: sweep", () => {
    console.log("width n | both | baseFin pibtFin | baseMs  pibtMs | mean%  med%   min%   max%  | pass20%");
    for (const width of [1, 2, 3]) {
      for (const n of [3, 4, 5, 6, 8]) {
        const N = 40;
        const bm: number[] = [];
        const pm: number[] = [];
        let baseFin = 0, pibtFin = 0;
        for (let s = 1; s <= N; s++) {
          const sc = makeScenario(width, n, s);
          const b = runExperiment(sc.map, sc.robots, sc.tasks, "stop-and-wait", 900);
          const t = runExperiment(sc.map, sc.robots, sc.tasks, "pibt", 900, WAITING_ZONE_CELLS);
          if (b.makespan !== null) baseFin++;
          if (t.makespan !== null) pibtFin++;
          if (b.makespan !== null && t.makespan !== null) { bm.push(b.makespan); pm.push(t.makespan); }
        }
        const imps = bm.map((v, i) => ((v - pm[i]) / v) * 100).sort((a, b) => a - b);
        const mean = imps.length ? imps.reduce((a, b) => a + b, 0) / imps.length : NaN;
        const med = imps.length ? imps[Math.floor(imps.length / 2)] : NaN;
        const frac = (f: number | undefined) => (f === undefined || Number.isNaN(f) ? "  n/a" : f.toFixed(1).padStart(5));
        const pass = imps.filter((x) => x >= 20).length;
        console.log(
          `${String(width).padStart(5)} ${String(n).padStart(1)} | ${String(bm.length).padStart(4)} | ${String(baseFin).padStart(7)} ${String(pibtFin).padStart(7)} | ` +
          `${(bm.length ? bm.reduce((a, b) => a + b, 0) / bm.length : NaN).toFixed(1).padStart(6)} ${(pm.length ? pm.reduce((a, b) => a + b, 0) / pm.length : NaN).toFixed(1).padStart(6)} | ` +
          `${frac(mean)} ${frac(med)} ${frac(imps[0])} ${frac(imps[imps.length - 1])} | ${String(pass).padStart(3)}/${String(imps.length).padStart(2)}`
        );
      }
    }
  }, 900000);
});
