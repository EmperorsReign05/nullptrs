// Overlap + throughput audit of the localCommit path — the one runtime.ts
// actually executes for the server and dashboard.
//
// tests/local-commit.test.ts asserts zero overlap on this path, but only at
// n=3 and n=6, 20 seeds, 100 ticks. The other path's residual collisions were
// invisible at exactly that scale: clean on seeds 1-8, colliding from seed 9
// and above n=8. So this repeats the audit at the scale that actually caught
// them.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function audit(n: number, seeds: number, maxTicks: number, localCommit: boolean, severed: boolean) {
  let overlap = 0, ticks = 0, full = 0, completed = 0, firstAt = "";
  for (let s = 1; s <= seeds; s++) {
    const sc = latticeScenario(1, n, s, 7);
    const f = new DistributedFleet(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), {
      commRange: 6, localCommit, severed: severed ? [["AMR-01", "AMR-02"]] : undefined,
    });
    let done = false;
    for (let t = 0; t < maxTicks; t++) {
      f["replanAll"](t);
      f["step"](t);
      f["applyMoves"](t);
      ticks++;
      const cells = f.getRobots().map((r) => key(r.position));
      if (new Set(cells).size !== cells.length) {
        overlap++;
        if (!firstAt) firstAt = `s${s}t${t}`;
      }
      if (f.getTasks().every((x) => x.status === "completed")) { done = true; break; }
    }
    if (done) full++;
    completed += f.getTasks().filter((x) => x.status === "completed").length;
  }
  return { overlap, ticks, full, completed, firstAt };
}

const seeds = Number(process.argv[2] ?? 200);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "4,6,8,10,12,14,16").split(",").map(Number);

console.log(`localCommit audit: seeds=${seeds} maxTicks=${maxTicks}`);
for (const n of ns) {
  const a = audit(n, seeds, maxTicks, true, false);
  console.log(`  n=${String(n).padStart(2)} localCommit=true : overlap ${String(a.overlap).padStart(4)}/${a.ticks} = ${((a.overlap / a.ticks) * 100).toFixed(3)}%   completed ${a.completed}/${seeds * n}  fullRuns ${a.full}/${seeds}  ${a.firstAt ? "first at " + a.firstAt : ""}`);
}
const s = audit(8, seeds, maxTicks, true, true);
console.log(`  n= 8 localCommit=true SEVERED link: overlap ${s.overlap}/${s.ticks} = ${((s.overlap / s.ticks) * 100).toFixed(3)}%   completed ${s.completed}/${seeds * 8}  ${s.firstAt ? "first at " + s.firstAt : ""}`);
