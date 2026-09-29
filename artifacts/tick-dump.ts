// Deep diagnostic: dump every agent's path, sensor scan, and decision inputs
// on a single tick of a livelocked run.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";

const n = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 8);
const watch = Number(process.argv[4] ?? 390);
const from = Number(process.argv[5] ?? 380);
const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });
const k = (p: any) => `${p.x},${p.y}`;
for (let t = 0; t <= watch; t++) {
  f["replanAll"](t);
  if (t < from) { f["step"](t); f["applyMoves"](); continue; }
  console.log(`\n===== tick ${t} =====`);
  for (const agent of f["agents"].values()) {
    const l = agent.getLocal();
    const r = f.getRobots().find((x) => x.id === agent.id)!;
    const t2 = tasks.find((x) => x.id === r.currentTaskId);
    const goal = t2 ? (t2.status === "in_progress" ? t2.dropoff : t2.pickup) : null;
    console.log(`  ${agent.id} pos=${k(l.position)} path=[${l.path.map(k).join(" ")}] goal=${goal ? k(goal) : "-"}`);
  }
  f["step"](t);
  for (const agent of f["agents"].values()) {
    const l = agent.getLocal();
    const s = agent.getScan();
    const d = agent.getLastDecision()!;
    console.log(
      `    ${agent.id} contacts=[${s.contacts.map((c) => k(c.position)).join(" ")}] forbidden=[${[...s.forbidden].join(" ")}] -> ${d.reason} to ${k(d.to)}`
    );
  }
  f["applyMoves"]();
}
console.log(`completed ${tasks.filter((x) => x.status === "completed").length}/${tasks.length}`);
