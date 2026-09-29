// Per-tick trace of a single agent (or all) in a distributed fleet run.
// Usage: npx vite-node artifacts/trace-agent.ts -- <n> <seed> <maxTicks> [agentIdSubstring] [fromTick]
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const n = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 1);
const maxTicks = Number(process.argv[4] ?? 80);
const who = process.argv[5] ?? "AMR";
const from = Number(process.argv[6] ?? 0);
const bays = process.argv[7] === "bays";

const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6, bays: bays ? ALL_BAYS : undefined });
const watched = f.getRobots().filter((r) => r.id.includes(who)).map((r) => r.id);
console.log(`n=${n} seed=${seed} watching=${watched.join(",")}`);
const prev = new Map<string, string>();
for (const r of f.getRobots()) prev.set(r.id, key(r.position));
for (let t = 0; t < maxTicks; t++) {
  f["replanAll"](t);
  f["step"](t);
  f["applyMoves"]();
  if (t >= from) {
    const cells = f.getRobots().map((r) => key(r.position));
    const ov = new Set(cells).size !== cells.length ? " OVERLAP" : "";
    for (const id of watched) {
      const a = f.getAgent(id)!;
      const l = a.getLocal();
      const d = a.getLastDecision();
      const r = f.getRobots().find((x) => x.id === id)!;
      const t2 = tasks.find((x) => x.id === r.currentTaskId);
      const goal = t2 ? (t2.status === "in_progress" ? t2.dropoff : t2.pickup) : null;
      const gp = goal ? key(goal) : "-";
      const step = l.path.length > 1 ? key(l.path[1]) : "-";
      const same = prev.get(id) === key(l.position);
      console.log(
        `t=${String(t).padStart(3)} ${id} pos=${key(l.position).padEnd(5)} d=${d ? `${key(d.from)}->${key(d.to)}` : "null".padEnd(9)} ${(d?.reason ?? "-").padEnd(13)} pathLen=${l.path.length} step=${step.padEnd(5)} goal=${gp} ${same ? "HOLD" : "move"}${ov}`
      );
      prev.set(id, key(l.position));
    }
  }
}
const done = tasks.filter((x) => x.status === "completed").length;
console.log(`completed ${done}/${tasks.length}`);
