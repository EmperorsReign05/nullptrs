// Split the "no path" holds by task status, and for agents WITH a live task,
// say exactly why they are not making progress.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import { planPath } from "../src/core/pathfinding/astar";
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

const buckets = new Map<string, number>();
let liveHolds = 0;
const lastSample = new Map<string, string>();
for (let t = 0; t < maxTicks; t++) {
  f["replanAll"](t);
  f["step"](t);
  for (const agent of f["agents"].values()) {
    const d = agent.getLastDecision()!;
    const l = agent.getLocal();
    const held = d.to.x === d.from.x && d.to.y === d.from.y;
    const r = f.getRobots().find((x) => x.id === agent.id)!;
    const task = tasks.find((x) => x.id === r.currentTaskId);
    if (!task) {
      if (held) buckets.set(`no-task parked (taskId=${r.currentTaskId ?? "undefined"})`, (buckets.get(`no-task parked (taskId=${r.currentTaskId ?? "undefined"})`) ?? 0) + 1);
      continue;
    }
    if (!held) continue;
    liveHolds++;
    const goal = task.status === "in_progress" ? task.dropoff : task.pickup;
    const onGoal = l.position.x === goal.x && l.position.y === goal.y;
    const tag = onGoal
      ? `ON GOAL ${key(goal)} but task ${task.status}`
      : `live task, pathLen=${l.path.length}, reason=${d.reason}`;
    buckets.set(tag, (buckets.get(tag) ?? 0) + 1);
    if (!onGoal && t > maxTicks - 3) {
      // Would A* even find a route from here?
      const res = planPath(l.position, goal, { tick: t, map: sc.map, robots: [], tasks: [], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } });
      lastSample.set(
        agent.id,
        `${agent.id} pos=${key(l.position)} goal=${key(goal)} task=${task.status} pathLen=${l.path.length} reason=${d.reason} astarFound=${res.found} astarLen=${res.found ? res.path.length : -1}`
      );
    }
  }
  f["applyMoves"](t);
}
console.log(`n=${n} seed=${seed} ticks=${maxTicks} bays=${bays}  liveTaskHolds=${liveHolds}  completed=${tasks.filter((x) => x.status === "completed").length}/${tasks.length}`);
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log("end state:");
for (const r of f.getRobots()) {
  const a = f.getAgent(r.id)!;
  const t2 = tasks.find((x) => x.id === r.currentTaskId);
  console.log(`  ${r.id} pos=${key(r.position)} pathLen=${a.getLocal().path.length} task=${t2 ? `${t2.status} ${key(t2.pickup)}->${key(t2.dropoff)}` : `none (currentTaskId=${r.currentTaskId})`}`);
}
for (const [, v] of lastSample) console.log(`  sample: ${v}`);
