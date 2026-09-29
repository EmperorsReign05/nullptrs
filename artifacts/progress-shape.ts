// What does progress look like? For each agent, sample distance-to-goal over
// the run, and count route-destroying events (displacement) and broken path
// invariants. Distinguishes three failure shapes: churn (oscillates around a
// fixed distance), blocked (flat), convoy (slow monotone decrease).
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import { manhattanDistance, positionsEqual } from "../src/core/map/graph";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const n = Number(process.argv[2] ?? 8);
const seed = Number(process.argv[3] ?? 1);
const maxTicks = Number(process.argv[4] ?? 400);

const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });
const goalOf = (id: string): Position | null => {
  const r = f.getRobots().find((x) => x.id === id)!;
  const t = tasks.find((x) => x.id === r.currentTaskId);
  if (!t) return null;
  return t.status === "in_progress" ? t.dropoff : t.pickup;
};

const distHist = new Map<string, number[]>();
for (const r of f.getRobots()) distHist.set(r.id, []);
let displaced = 0, moves = 0, held = 0;
let badPathAnchor = 0, badPathAdjacent = 0, pathResetToOne = 0;
let toward = 0, away = 0;

for (let t = 0; t < maxTicks; t++) {
  const before = new Map(f.getRobots().map((r) => [r.id, key(r.position)]));
  const beforeDist = new Map(f.getRobots().map((r) => [r.id, goalOf(r.id) ? manhattanDistance(r.position, goalOf(r.id)!) : -1]));
  f["replanAll"](t);
  f["step"](t);
  for (const agent of f["agents"].values()) {
    const d = agent.getLastDecision()!;
    if (positionsEqual(d.to, d.from)) { held++; continue; }
    moves++;
    if (d.reason === "sensor-yield" || d.reason === "step-aside" || d.reason === "occupied") displaced++;
    const g = goalOf(agent.id);
    if (g) {
      const nd = manhattanDistance(d.to, g);
      const od = beforeDist.get(agent.id)!;
      if (nd < od) toward++; else if (nd > od) away++;
    }
  }
  f["applyMoves"](t);
  for (const agent of f["agents"].values()) {
    const l = agent.getLocal();
    if (!positionsEqual(l.path[0] ?? l.position, l.position)) badPathAnchor++;
    if (l.path.length > 1 && manhattanDistance(l.path[0], l.path[1]) !== 1) badPathAdjacent++;
    if (l.path.length <= 1) pathResetToOne++;
    const g = goalOf(agent.id);
    distHist.get(agent.id)!.push(g ? manhattanDistance(l.position, g) : -1);
  }
}

console.log(`n=${n} seed=${seed} ticks=${maxTicks}  moves=${moves} held=${held} displaced=${displaced} (${((displaced / moves) * 100).toFixed(1)}% of moves)`);
console.log(`  moves toward goal ${toward}  away ${away}  lateral ${moves - toward - away}`);
console.log(`  path invariant violations: path[0]!=position ${badPathAnchor}   path[0]~path[1] not adjacent ${badPathAdjacent}`);
console.log(`  agent-ticks with pathLen<=1: ${pathResetToOne}`);
console.log("  distance-to-goal trace (every 40 ticks), -1 = no live task:");
for (const [id, h] of distHist) {
  const row: string[] = [];
  for (let i = 0; i < h.length; i += 40) row.push(String(h[i]).padStart(3));
  row.push(String(h[h.length - 1]).padStart(3));
  const live = h.filter((x) => x >= 0);
  const mn = live.length ? Math.min(...live) : -1;
  const mx = live.length ? Math.max(...live) : -1;
  console.log(`    ${id} ${row.join("").padEnd(30)} min=${String(mn).padStart(2)} max=${String(mx).padStart(2)} final=${String(h[h.length - 1]).padStart(3)}`);
}
console.log(`  completed ${tasks.filter((x) => x.status === "completed").length}/${tasks.length}`);
