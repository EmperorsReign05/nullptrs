// Measure main's committed distributed/ state against the original and the
// finished fix, on identical seeds.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { DistributedFleetOrig } from "./fleetOrig";
import { DistributedFleetMain } from "./fleetMain";
import { DistributedFleetMainFixed } from "./fleetMainFixed";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const impls = [
  { name: "ORIGINAL ", Impl: DistributedFleetOrig, tick: false },
  { name: "MAIN NOW ", Impl: DistributedFleetMain, tick: false },
  { name: "MAIN-NOEX", Impl: DistributedFleetMainFixed, tick: false },
  { name: "FINISHED  ", Impl: DistributedFleet, tick: true },
];
const seeds = Number(process.argv[2] ?? 40);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "8,10,12").split(",").map(Number);

const tot: Record<string, { comp: number; full: number; ov: number; tk: number }> = {};
for (const { name, Impl, tick } of impls) {
  tot[name] = { comp: 0, full: 0, ov: 0, tk: 0 };
  for (const n of ns) {
    for (let s = 1; s <= seeds; s++) {
      const sc = latticeScenario(1, n, s, 7);
      const f: any = new (Impl as any)(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), { commRange: 6 });
      for (let t = 0; t < maxTicks; t++) {
        f["replanAll"](t); f["step"](t);
        if (tick) f["applyMoves"](t); else f["applyMoves"]();
        const cells = f.getRobots().map((r: any) => key(r.position));
        if (new Set(cells).size !== cells.length) tot[name].ov++;
        tot[name].tk++;
        if (f.getTasks().every((x: any) => x.status === "completed")) { tot[name].full++; tot[name].comp += f.getTasks().length; break; }
      }
      tot[name].comp += f.getTasks().filter((x: any) => x.status === "completed").length - (tot[name].comp % 1) * 0;
    }
  }
}
console.log(`main's committed state vs original vs finished — seeds=${seeds} ticks=${maxTicks} n=${ns.join(",")}`);
for (const { name } of impls) {
  const t = tot[name];
  console.log(`  ${name} fully-completed runs ${String(t.full).padStart(4)}/${seeds * ns.length}   overlap ${t.ov}/${t.tk} = ${((t.ov / t.tk) * 100).toFixed(3)}%`);
}
