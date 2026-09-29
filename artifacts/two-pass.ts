// Print BOTH decide() passes for one tick of one seed, to see whether
// commit-time arbitration is judging the same move that gets executed.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const n = Number(process.argv[2] ?? 8);
const seed = Number(process.argv[3] ?? 17);
const watch = Number(process.argv[4] ?? 2);

const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });

let passes: string[][] = [];
for (const agent of f["agents"].values()) {
  const orig = agent.decide.bind(agent);
  agent.decide = (tick: number) => {
    const d = orig(tick);
    if (passes.length < 64) passes.push([`${agent.id} ${d.reason} ${key(d.from)}->${key(d.to)}`]);
    return d;
  };
}

for (let t = 0; t <= watch; t++) {
  passes = [];
  f["replanAll"](t);
  f["step"](t);
  if (t === watch) {
    const byPass: Map<string, string[]> = new Map();
    for (const p of passes) {
      const id = p[0].split(" ")[0];
      byPass.set(id, [...(byPass.get(id) ?? []), p[0]]);
    }
    console.log(`tick ${t}: decide() invocations per agent = ${passes.length} for ${f["agents"].size} agents`);
    for (const [id, rows] of byPass) {
      const uniq = [...new Set(rows)];
      console.log(`  ${id}: ${rows.length} calls`);
      for (const r of rows) console.log(`      ${r}`);
      if (uniq.length > 1) console.log(`      ^^ DIVERGES between passes`);
    }
  }
  f["applyMoves"](t);
  const cells = f.getRobots().map((r) => `${r.id}@${key(r.position)}`);
  const dup = cells.length !== new Set(cells.map((c) => c.split("@")[1])).size;
  console.log(`  after t=${t}: ${cells.join(" ")}${dup ? "  <<<< OVERLAP" : ""}`);
}
