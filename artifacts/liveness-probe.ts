// Multi-seed liveness probe for the distributed fleet.
// NOT a test: a measurement instrument. Reports completion, overlap, and
// per-agent motion statistics across a seed sweep.
//
// Run: npx vite-node artifacts/liveness-probe.ts -- <seeds> <maxTicks>

import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

export type SeedResult = {
  n: number;
  seed: number;
  completed: number;
  total: number;
  overlapTicks: number;
  ticks: number;
  moves: number;
  /** cells visited more than once by the same agent (ping-pong signal) */
  revisits: number;
  /** agents that never moved after tick 2 */
  frozen: string[];
  /** cells occupied by a frozen agent at the end */
  endPathLens: Record<string, number>;
  goals: Record<string, string>;
  pos: Record<string, string>;
};

export function probeOne(n: number, seed: number, maxTicks: number, opts: { severed?: [string, string][]; bays?: boolean } = {}): SeedResult {
  const sc = latticeScenario(1, n, seed, 7);
  const robots = JSON.parse(JSON.stringify(sc.robots));
  const tasks = JSON.parse(JSON.stringify(sc.tasks));
  const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6, severed: opts.severed, bays: opts.bays ? ALL_BAYS : undefined });
  const seen = new Map<string, Set<string>>();
  const moves = new Map<string, number>();
  const lastPos = new Map<string, string>();
  for (const r of f.getRobots()) { seen.set(r.id, new Set([key(r.position)])); moves.set(r.id, 0); lastPos.set(r.id, key(r.position)); }
  let overlapTicks = 0;
  let ticks = 0;
  let completed = 0;
  for (let t = 0; t < maxTicks; t++) {
    const before = f.getRobots().map((r) => key(r.position));
    f["replanAll"](t);
    f["step"](t);
    f["applyMoves"]();
    ticks++;
    for (let i = 0; i < f.getRobots().length; i++) {
      const r = f.getRobots()[i];
      const k = key(r.position);
      if (k !== before[i]) moves.set(r.id, (moves.get(r.id) ?? 0) + 1);
      const s = seen.get(r.id)!;
      if (k !== lastPos.get(r.id)) s.add(k);
      lastPos.set(r.id, k);
    }
    const cells = f.getRobots().map((r) => key(r.position));
    if (new Set(cells).size !== cells.length) overlapTicks++;
    const done = tasks.filter((x) => x.status === "completed").length;
    if (done !== completed) completed = done;
    if (completed === tasks.length) break;
  }
  const revisits = [...seen.values()].reduce((a, s) => a + Math.max(0, s.size - 1), 0);
  const frozen = f.getRobots().filter((r) => (moves.get(r.id) ?? 0) <= 1).map((r) => r.id);
  const endPathLens: Record<string, number> = {};
  const goals: Record<string, string> = {};
  const pos: Record<string, string> = {};
  for (const r of f.getRobots()) {
    const a = f.getAgent(r.id)!;
    endPathLens[r.id] = a.getLocal().path.length;
    pos[r.id] = key(r.position);
    const t = tasks.find((x) => x.id === r.currentTaskId);
    goals[r.id] = t ? `${key(t.pickup)}${t.status === "in_progress" ? "->" : ""}${key(t.dropoff)} [${t.status}]` : "-";
  }
  return { n, seed, completed, total: tasks.length, overlapTicks, ticks, moves: [...moves.values()].reduce((a, b) => a + b, 0), revisits, frozen, endPathLens, goals, pos };
}

const seeds = Number(process.argv[2] ?? 8);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "2,4,6,8,10").split(",").map(Number);
const verbose = process.argv[5] === "v";

console.log(`seeds=${seeds} maxTicks=${maxTicks} sizes=${ns.join(",")}`);
const rows: SeedResult[] = [];
for (const n of ns) {
  for (let seed = 1; seed <= seeds; seed++) rows.push(probeOne(n, seed, maxTicks));
}
for (const n of ns) {
  const rs = rows.filter((r) => r.n === n);
  const totComp = rs.reduce((a, r) => a + r.completed, 0);
  const ov = rs.reduce((a, r) => a + r.overlapTicks, 0);
  const tk = rs.reduce((a, r) => a + r.ticks, 0);
  const full = rs.filter((r) => r.completed === r.total).length;
  const stuck = rs.filter((r) => r.completed < r.total).length;
  const rev = rs.reduce((a, r) => a + r.revisits, 0);
  const fz = rs.reduce((a, r) => a + r.frozen.length, 0);
  console.log(
    `n=${String(n).padStart(2)}: overlap ${((ov / tk) * 100).toFixed(2)}%  completed ${totComp}/${rs.length * n}  fullRuns ${full}/${seeds}  stuckRuns ${stuck}/${seeds}  revisits ${rev}  frozenAgents ${fz}`
  );
  if (verbose) for (const r of rs) console.log(`   seed=${r.seed} comp=${r.completed}/${r.total} ticks=${r.ticks} moves=${r.moves} revisit=${r.revisits} frozen=[${r.frozen.join(",")}] plen=${Object.values(r.endPathLens).join("/")}`);
}
const totOv = rows.reduce((a, r) => a + r.overlapTicks, 0);
const totTk = rows.reduce((a, r) => a + r.ticks, 0);
console.log(`TOTAL overlap ${((totOv / totTk) * 100).toFixed(3)}%  (${totOv}/${totTk})`);
if (rows.some((r) => r.completed < r.total) && verbose) {
  const bad = rows.filter((r) => r.completed < r.total).slice(0, 4);
  for (const b of bad) {
    console.log(`\n--- stuck n=${b.n} seed=${b.seed} comp=${b.completed}/${b.total} moves=${b.moves} revisit=${b.revisits}`);
    for (const [id, g] of Object.entries(b.goals)) console.log(`    ${id} at ${b.pos[id]} pathLen=${b.endPathLens[id]} goal=${g}`);
  }
}
