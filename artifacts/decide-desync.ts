// Diagnostic: is the decision that ARBITRATION sees the same as the decision
// that is EXECUTED? step() calls agent.decide(tick) and then agent.tick(tick),
// and Agent.tick() calls decide() again. If the two disagree, arbitration is
// resolving conflicts on a move nobody performs.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";

const n = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 1);
const maxTicks = Number(process.argv[4] ?? 200);
const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });

let mismatch = 0, total = 0;
const reasonPairs = new Map<string, number>();
for (let t = 0; t < maxTicks; t++) {
  // Patch decide to record the first (arbitrated) decision per agent.
  const first = new Map<string, string>();
  for (const agent of f["agents"].values() as any) {
    const orig = agent.decide.bind(agent);
    agent.decide = (tick: number) => {
      const d = orig(tick);
      if (!first.has(agent.id)) first.set(agent.id, `${d.to.x},${d.to.y}/${d.reason}`);
      return d;
    };
  }
  f["replanAll"](t);
  f["step"](t);
  for (const agent of f["agents"].values() as any) {
    const d = agent.getLastDecision()!;
    const got = `${d.to.x},${d.to.y}/${d.reason}`;
    const want = first.get(agent.id)!;
    total++;
    if (got !== want) {
      mismatch++;
      reasonPairs.set(`${want} -> ${got}`, (reasonPairs.get(`${want} -> ${got}`) ?? 0) + 1);
    }
  }
  f["applyMoves"]();
}
console.log(`n=${n} seed=${seed} ticks=${maxTicks}: arbitrated-vs-executed mismatches ${mismatch}/${total} (${((mismatch / total) * 100).toFixed(2)}%)`);
for (const [k, v] of [...reasonPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${v.toString().padStart(5)}x  ${k}`);
