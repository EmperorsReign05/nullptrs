// Are the idle, finished robots sealing the remaining workers in?
// For every stuck agent: is its goal reachable at all once the IDLE robots'
// cells are treated as walls (BFS on the static map minus those cells)?
// If yes, the fleet has walled itself in with its own finished robots and the
// planner cannot see it. If no, the blockage is something else.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import { isTraversable } from "../src/core/map/warehouse";
import { getNeighbors } from "../src/core/map/graph";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function reachable(from: Position, to: Position, map: any, blocked: Set<string>): boolean {
  if (!blocked.has(key(to))) return true;
  const seen = new Set<string>([key(from)]);
  const q = [from];
  let h = 0;
  while (h < q.length) {
    const p = q[h++];
    for (const nb of getNeighbors(p, map)) {
      const k = key(nb);
      if (seen.has(k)) continue;
      if (k === key(to)) return true;
      if (blocked.has(k)) continue;
      seen.add(k);
      q.push(nb);
    }
  }
  return false;
}

for (const n of [6, 8, 10]) {
  let walledIn = 0, freeToGo = 0, runs = 0;
  const detail: string[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const sc = latticeScenario(1, n, seed, 7);
    const robots = JSON.parse(JSON.stringify(sc.robots));
    const tasks = JSON.parse(JSON.stringify(sc.tasks));
    const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });
    for (let t = 0; t < 400; t++) { f["replanAll"](t); f["step"](t); f["applyMoves"](t); }
    runs++;
    const done = tasks.filter((x) => x.status === "completed").length;
    if (done === tasks.length) continue;
    // Cells occupied by robots with no live task = the parked furniture.
    const parked = new Set(f.getRobots().filter((r) => !r.currentTaskId).map((r) => key(r.position)));
    for (const r of f.getRobots()) {
      if (!r.currentTaskId) continue;
      const t2 = tasks.find((x) => x.id === r.currentTaskId)!;
      const goal = t2.status === "in_progress" ? t2.dropoff : t2.pickup;
      const ok = reachable(r.position, goal, sc.map, parked);
      if (ok) { freeToGo++; detail.push(`n=${n} s=${seed} ${r.id} pos=${key(r.position)} goal=${key(goal)} OPEN (parked=${parked.size})`); }
      else { walledIn++; detail.push(`n=${n} s=${seed} ${r.id} pos=${key(r.position)} goal=${key(goal)} WALLED IN by parked=${parked.size}`); }
    }
  }
  console.log(`n=${n}: unfinished-run agents: ${walledIn} walled in by idle robots, ${freeToGo} have an open route (over ${runs} seeds)`);
  for (const d of detail.slice(0, 4)) console.log(`    ${d}`);
}
