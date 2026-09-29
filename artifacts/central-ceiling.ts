// Reference ceiling: the repo's own centralised PIBT resolver, run on the
// exact same lattice scenarios with the same A* and task lifecycle as the
// distributed fleet. Isolates the RESOLVER, so if this also livelocks, the
// scenario is the binding constraint rather than the decentralisation.
import { resolvePIBT } from "../src/core/pathfinding/pibt";
import { planPath } from "../src/core/pathfinding/astar";
import { computeCongestion } from "../src/core/map/warehouse";
import { positionsEqual } from "../src/core/map/graph";
import { latticeScenario, ALL_BAYS } from "../tests/ml-scenarios";
import type { Position, RobotState, Task, WorldState, WarehouseMap } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function emptyMetrics() {
  return { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 };
}

export function runCentral(n: number, seed: number, maxTicks: number, bays: boolean, priorityOrder: boolean) {
  const sc = latticeScenario(1, n, seed, 7);
  const map: WarehouseMap = sc.map;
  const robots: RobotState[] = JSON.parse(JSON.stringify(sc.robots));
  const tasks: Task[] = JSON.parse(JSON.stringify(sc.tasks));
  const goalOf = (r: RobotState): Position | null => {
    if (!r.currentTaskId) return null;
    const t = tasks.find((x) => x.id === r.currentTaskId);
    if (!t) return null;
    return t.status === "in_progress" ? t.dropoff : t.pickup;
  };
  let overlap = 0;
  let completed = 0;
  for (let t = 0; t < maxTicks; t++) {
    // A* per robot, with congestion from the full fleet (the centralised
    // version is allowed omniscience; that is the point of the comparison).
    const wm: WorldState = { tick: t, map: computeCongestion(map, robots), robots, tasks: [], metrics: emptyMetrics() };
    for (const r of robots) {
      const g = goalOf(r);
      if (!g) { r.path = []; continue; }
      const res = planPath(r.position, g, wm);
      r.path = res.found ? res.path : [];
    }
    if (priorityOrder) robots.forEach((r, i) => (r.priority = (n - i) % 3));
    const world: WorldState = { ...wm, map: computeCongestion(map, robots) };
    const res = resolvePIBT(robots, world, { bays: bays ? ALL_BAYS : undefined });
    for (const m of res.moves) {
      const r = robots.find((x) => x.id === m.robotId)!;
      r.position = { ...m.to };
      if (r.path.length > 1) {
        if (positionsEqual(r.path[1], r.position)) r.path = r.path.slice(1);
        else {
          const g = goalOf(r);
          const rr = planPath(r.position, g ?? r.position, world);
          r.path = rr.found ? rr.path : [{ ...r.position }];
        }
      }
    }
    for (const r of robots) {
      if (!r.currentTaskId) continue;
      const t2 = tasks.find((x) => x.id === r.currentTaskId);
      if (!t2) continue;
      if (t2.status !== "in_progress" && positionsEqual(r.position, t2.pickup)) t2.status = "in_progress";
      if (t2.status === "in_progress" && positionsEqual(r.position, t2.dropoff)) {
        t2.status = "completed";
        r.currentTaskId = undefined;
      }
    }
    const cells = robots.map((r) => key(r.position));
    if (new Set(cells).size !== cells.length) overlap++;
    completed = tasks.filter((x) => x.status === "completed").length;
    if (completed === tasks.length) return { completed, overlap, ticks: t + 1, done: true };
  }
  return { completed, overlap, ticks: maxTicks, done: false };
}

if (process.argv[2]) {
  const seeds = Number(process.argv[2] ?? 20);
  const maxTicks = Number(process.argv[3] ?? 400);
  const ns = (process.argv[4] ?? "2,4,6,8,10").split(",").map(Number);
  for (const bays of [false, true]) {
    for (const n of ns) {
      let full = 0, comp = 0, ov = 0, tk = 0;
      const ms: number[] = [];
      for (let s = 1; s <= seeds; s++) {
        const r = runCentral(n, s, maxTicks, bays, true);
        if (r.done) { full++; ms.push(r.ticks); }
        comp += r.completed; ov += r.overlap; tk += r.ticks;
      }
      ms.sort((a, b) => a - b);
      console.log(
        `PIBT bays=${bays} n=${String(n).padStart(2)}: completed ${comp}/${seeds * n}  fullRuns ${full}/${seeds}  medMakespan ${ms.length ? ms[Math.floor(ms.length / 2)] : -1}  overlap ${((ov / tk) * 100).toFixed(2)}%`
      );
    }
  }
}
