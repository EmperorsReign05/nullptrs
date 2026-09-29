// Dump the exact tick of a cell overlap: who moved where, and what each side
// believed at decide time.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const n = Number(process.argv[2] ?? 8);
const seed = Number(process.argv[3] ?? 17);
const watch = Number(process.argv[4] ?? 2);
const from = Number(process.argv[5] ?? 0);

const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });
for (let t = 0; t <= watch; t++) {
  console.log(`\n=== tick ${t} ===`);
  for (const r of f.getRobots()) {
    const t2 = tasks.find((x) => x.id === r.currentTaskId);
    const a = f.getAgent(r.id)!;
    console.log(`  ${r.id} pos=${key(r.position)} path=[${a.getLocal().path.map(key).join(" ")}] goal=${t2 ? (t2.status === "in_progress" ? key(t2.dropoff) : key(t2.pickup)) : "-"} task=${t2?.status ?? "-"}`);
  }
  f["replanAll"](t);
  f["step"](t);
  for (const agent of f["agents"].values()) {
    const d = agent.getLastDecision()!;
    const peers = agent.getPeers().map((p) => `${p.id}@${key(p.position)}${p.intent ? "->" + key(p.intent) : ""}`).join(" ");
    console.log(`    ${agent.id} ${d.reason.padEnd(13)} ${key(d.from)}->${key(d.to)}   peers: ${peers}`);
  }
  f["applyMoves"](t);
  const cells = f.getRobots().map((r) => `${r.id}@${key(r.position)}`);
  const dup = cells.length !== new Set(cells.map((c) => c.split("@")[1])).size;
  console.log(`    AFTER: ${cells.join(" ")}${dup ? "   <<<< OVERLAP" : ""}`);
  if (dup && t >= watch) break;
}
