// Exact overlap accounting, per seed, base vs new. Safety outranks throughput,
// so this is checked first and at higher seed count than the throughput sweep.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { DistributedFleetBase } from "./fleetBase";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const impls = [
  { name: "base", make: DistributedFleetBase as unknown as typeof DistributedFleet },
  { name: "new ", make: DistributedFleet },
];

const seeds = Number(process.argv[2] ?? 40);
const maxTicks = Number(process.argv[4] ?? 400);
const ns = (process.argv[3] ?? "4,6,8,10,12").split(",").map(Number);

console.log(`overlap audit: seeds=${seeds} maxTicks=${maxTicks}`);
for (const n of ns) {
  const acc = impls.map(() => ({ ov: 0, tk: 0, bad: [] as string[] }));
  for (const impl of impls) {
    for (let s = 1; s <= seeds; s++) {
      const sc = latticeScenario(1, n, s, 7);
      const robots = JSON.parse(JSON.stringify(sc.robots));
      const tasks = JSON.parse(JSON.stringify(sc.tasks));
      const f = new impl.make(sc.map, robots, tasks, { commRange: 6 });
      for (let t = 0; t < maxTicks; t++) {
        f["replanAll"](t);
        f["step"](t);
        f["applyMoves"](t);
        acc[impls.indexOf(impl)].tk++;
        const cells = f.getRobots().map((r) => key(r.position));
        if (new Set(cells).size !== cells.length) {
          acc[impls.indexOf(impl)].ov++;
          if (acc[impls.indexOf(impl)].bad.length < 4) acc[impls.indexOf(impl)].bad.push(`s${s}t${t}`);
        }
        if (tasks.every((x) => x.status === "completed")) break;
      }
    }
  }
  impls.forEach((impl, i) => {
    const a = acc[i];
    console.log(`  n=${String(n).padStart(2)} ${impl.name}: ${a.ov}/${a.tk} = ${((a.ov / a.tk) * 100).toFixed(3)}%  at ${a.bad.join(",")}`);
  });
}
// Severed-link case, the brief's central claim.
console.log("severed link (AMR-01 <-> AMR-02), n=8:");
for (const impl of impls) {
  let ov = 0, tk = 0;
  for (let s = 1; s <= seeds; s++) {
    const sc = latticeScenario(1, 8, s, 7);
    const robots = JSON.parse(JSON.stringify(sc.robots));
    const tasks = JSON.parse(JSON.stringify(sc.tasks));
    const f = new impl.make(sc.map, robots, tasks, { commRange: 6, severed: [["AMR-01", "AMR-02"]] });
    for (let t = 0; t < maxTicks; t++) {
      f["replanAll"](t);
      f["step"](t);
      f["applyMoves"](t);
      tk++;
      const cells = f.getRobots().map((r) => key(r.position));
      if (new Set(cells).size !== cells.length) ov++;
      if (tasks.every((x) => x.status === "completed")) break;
    }
  }
  console.log(`  ${impl.name}: ${ov}/${tk} = ${((ov / tk) * 100).toFixed(3)}%`);
}
