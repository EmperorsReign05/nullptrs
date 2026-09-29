// Final measurement instrument. Compares the FROZEN ORIGINAL distributed fleet
// (artifacts/fleetOrig.ts + artifacts/agentOrig.ts, a byte-for-byte
// reconstruction of the pre-change code) against the current one, on
// identical seeds.
//
// Makespan is reported PAIRED: median over runs that completed under BOTH
// implementations. An unpaired median is dominated by composition — adding
// slow-but-eventually-finishing runs moves the median without any robot being
// slower — and that distinction is the whole question here.
//
// Usage: npx vite-node artifacts/ab.ts -- <seeds> <maxTicks> <n1,n2,...> [bays]
import { DistributedFleet } from "../src/core/distributed/fleet";
import { DistributedFleetOrig } from "./fleetOrig";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

type Run = {
  completed: number;
  overlap: number;
  ticks: number;
  makespan: number | null;
  /** distinct cells visited per agent, summed */
  visited: number;
  /** agent-ticks with a live task where the agent did not move */
  liveHeld: number;
  liveTotal: number;
};

function runOne(Impl: any, n: number, seed: number, maxTicks: number, bays: boolean, passTick: boolean): Run {
  const sc = latticeScenario(1, n, seed, 7);
  const robots = JSON.parse(JSON.stringify(sc.robots));
  const tasks = JSON.parse(JSON.stringify(sc.tasks));
  const f = new Impl(sc.map, robots, tasks, { commRange: 6, bays: bays ? ALL_BAYS : undefined });
  const visited = new Map<string, Set<string>>();
  const prev = new Map<string, string>();
  for (const r of f.getRobots()) { visited.set(r.id, new Set([key(r.position)])); prev.set(r.id, key(r.position)); }
  let overlap = 0, ticks = 0, makespan: number | null = null;
  let liveHeld = 0, liveTotal = 0;
  for (let t = 0; t < maxTicks; t++) {
    f["replanAll"](t);
    f["step"](t);
    if (passTick) f["applyMoves"](t); else f["applyMoves"]();
    ticks++;
    for (const r of f.getRobots()) {
      const k = key(r.position);
      const didMove = k !== prev.get(r.id);
      if (didMove) visited.get(r.id)!.add(k);
      if (r.currentTaskId) { liveTotal++; if (!didMove) liveHeld++; }
      prev.set(r.id, k);
    }
    const cells = f.getRobots().map((r) => key(r.position));
    if (new Set(cells).size !== cells.length) overlap++;
    if (tasks.every((x) => x.status === "completed")) { makespan = t + 1; break; }
  }
  let vis = 0;
  for (const s of visited.values()) vis += s.size;
  return { completed: tasks.filter((x) => x.status === "completed").length, overlap, ticks, makespan, visited: vis, liveHeld, liveTotal };
}

const seeds = Number(process.argv[2] ?? 40);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "2,4,6,8,10").split(",").map(Number);
const bays = process.argv.includes("bays");

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : -1; };

console.log(`ORIG vs NEW   seeds=${seeds} maxTicks=${maxTicks} bays=${bays}`);
const hdr = ["n", "impl", "overlap%", "completed", "fullRuns", "medMs(all)", "medMs(paired)", "cells/agent", "liveStall%"];
console.log(hdr.map((h) => h.padEnd(13)).join(""));

const totals: Record<string, { comp: number; full: number; ov: number; tk: number }> = { ORIG: { comp: 0, full: 0, ov: 0, tk: 0 }, NEW: { comp: 0, full: 0, ov: 0, tk: 0 } };

for (const n of ns) {
  const impls = [
    { name: "ORIG", Impl: DistributedFleetOrig, passTick: false },
    { name: "NEW", Impl: DistributedFleet, passTick: true },
  ];
  const results: Record<string, Run[]> = {};
  for (const im of impls) {
    const runs: Run[] = [];
    for (let s = 1; s <= seeds; s++) runs.push(runOne(im.Impl, n, s, maxTicks, bays, im.passTick));
    results[im.name] = runs;
    const ov = runs.reduce((a, r) => a + r.overlap, 0);
    const tk = runs.reduce((a, r) => a + r.ticks, 0);
    const comp = runs.reduce((a, r) => a + r.completed, 0);
    const full = runs.filter((r) => r.makespan !== null).length;
    const t = totals[im.name];
    t.comp += comp; t.full += full; t.ov += ov; t.tk += tk;
  }
  const paired: number[] = [];
  for (let i = 0; i < seeds; i++) {
    const a = results.NEW[i].makespan;
    const b = results.ORIG[i].makespan;
    if (a !== null && b !== null) paired.push(a - b);
  }
  // Makespan on the seeds ORIG completed: the honest "did existing successes
  // get slower" question, rather than a median over a set whose membership the
  // change itself altered.
  const origDoneIdx = results.ORIG.map((r, i) => (r.makespan !== null ? i : -1)).filter((i) => i >= 0);
  const msOrig = origDoneIdx.map((i) => results.ORIG[i].makespan!);
  const msNew = origDoneIdx.map((i) => results.NEW[i].makespan!).filter((x): x is number => x !== null);
  for (const im of impls) {
    const runs = results[im.name];
    const ov = runs.reduce((a, r) => a + r.overlap, 0);
    const tk = runs.reduce((a, r) => a + r.ticks, 0);
    const comp = runs.reduce((a, r) => a + r.completed, 0);
    const full = runs.filter((r) => r.makespan !== null).length;
    const cells = runs.reduce((a, r) => a + r.visited, 0) / (seeds * n);
    const lh = runs.reduce((a, r) => a + r.liveHeld, 0);
    const lt = runs.reduce((a, r) => a + r.liveTotal, 0);
    const pmed = im.name === "NEW" ? med(paired) : -med(paired);
    console.log(
      [String(n), im.name, ((ov / tk) * 100).toFixed(3), `${comp}/${seeds * n}`, `${full}/${seeds}`,
       String(med(runs.map((r) => r.makespan ?? -1).filter((x) => x > 0))), String(im.name === "NEW" ? pmed : -pmed),
       cells.toFixed(1), (lt ? (lh / lt) * 100 : 0).toFixed(1)]
        .map((h) => h.padEnd(13)).join("")
    );
  }
  const o = results.ORIG.filter((r) => r.makespan !== null).length;
  const nw = results.NEW.filter((r) => r.makespan !== null).length;
  console.log(`  ${"".padEnd(11)} paired delta on ${paired.length} runs completing under BOTH: median ${med(paired) >= 0 ? "+" : ""}${med(paired)}, mean ${paired.length ? (paired.reduce((a, b) => a + b, 0) / paired.length).toFixed(1) : "n/a"}`);
  console.log(`  ${"".padEnd(11)} makespan on the ${origDoneIdx.length} seeds ORIG completed: ORIG median ${med(msOrig)} mean ${(msOrig.reduce((a, b) => a + b, 0) / (msOrig.length || 1)).toFixed(1)} | NEW median ${med(msNew)} mean ${(msNew.reduce((a, b) => a + b, 0) / (msNew.length || 1)).toFixed(1)} (NEW finished ${msNew.length}/${origDoneIdx.length} of them)`);
}
console.log("\nTOTALS over all sizes:");
for (const k of ["ORIG", "NEW"] as const) {
  const t = totals[k];
  console.log(`  ${k}: completed ${t.comp}, fullRuns ${t.full}, overlap ${t.ov}/${t.tk} = ${((t.ov / t.tk) * 100).toFixed(3)}%`);
}
