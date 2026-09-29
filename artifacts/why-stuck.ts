// Why do agents hold still? Classify every held tick by reason, and for the
// dominant reason, classify the BLOCKER: is it standing still, is it moving
// away, and how long has it been stuck?
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const n = Number(process.argv[2] ?? 8);
const seed = Number(process.argv[3] ?? 1);
const maxTicks = Number(process.argv[4] ?? 400);
const bays = process.argv.includes("bays");

const sc = latticeScenario(1, n, seed, 7);
const robots = JSON.parse(JSON.stringify(sc.robots));
const tasks = JSON.parse(JSON.stringify(sc.tasks));
const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6, bays: bays ? ALL_BAYS : undefined });
const prev: Record<string, string> = {};
for (const r of f.getRobots()) prev[r.id] = key(r.position);

const holdReasons = new Map<string, number>();
const blockState = new Map<string, number>();
const holdByTickFrac = new Map<string, number>();
let held = 0, moved = 0;

for (let t = 0; t < maxTicks; t++) {
  f["replanAll"](t);
  f["step"](t);
  for (const agent of f["agents"].values()) {
    const d = agent.getLastDecision()!;
    const l = agent.getLocal();
    const isHold = d.to.x === d.from.x && d.to.y === d.from.y;
    if (!isHold) { moved++; continue; }
    held++;
    holdReasons.set(d.reason, (holdReasons.get(d.reason) ?? 0) + 1);
    // Who is standing on the cell I want next?
    const want = l.path.length > 1 ? l.path[1] : null;
    if (!want) { blockState.set("no-path", (blockState.get("no-path") ?? 0) + 1); continue; }
    const blocker = f.getRobots().find((r) => r.id !== agent.id && r.position.x === want.x && r.position.y === want.y);
    if (!blocker) { blockState.set("blocked-by-nobody", (blockState.get("blocked-by-nobody") ?? 0) + 1); continue; }
    const bo = f.getAgent(blocker.id)!;
    const bl = bo.getLocal();
    const bd = bo.getLastDecision();
    const blockerMoving = bd && (bd.to.x !== bd.from.x || bd.to.y !== bd.from.y);
    const towardMe = bd && (bd.to.x === agent.getLocal().position.x && bd.to.y === agent.getLocal().position.y);
    const tag = blockerMoving ? (towardMe ? "head-on(swap)" : "convoy(moving away)") : `stalled(${bo.getStallTicks()})`;
    blockState.set(tag, (blockState.get(tag) ?? 0) + 1);
  }
  f["applyMoves"](t);
  for (const r of f.getRobots()) prev[r.id] = key(r.position);
}

console.log(`n=${n} seed=${seed} ticks=${maxTicks} bays=${bays}`);
console.log(`  held ${held}  moved ${moved}  heldPct ${((held / (held + moved)) * 100).toFixed(1)}%`);
console.log("  hold reasons:");
for (const [k, v] of [...holdReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)} (${((v / held) * 100).toFixed(1)}%)  ${k}`);
console.log("  blocker state when holding:");
for (const [k, v] of [...blockState.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)} (${((v / held) * 100).toFixed(1)}%)  ${k}`);
console.log(`  completed ${tasks.filter((x) => x.status === "completed").length}/${tasks.length}`);
