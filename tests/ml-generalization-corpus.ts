import { mapFromOpen } from "../src/core/bench/scenarios";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import { LocalHistory } from "../src/core/ml/temporal";
import type { Position, RobotState, Task } from "../src/core/types";
import { collectRun } from "./ml-sampler";
import { randomSource, type Family } from "./ml-corpus";

const key = (p: Position) => `${p.x},${p.y}`;
function line(x: number, y: number, dx: number, dy: number, length: number): Position[] {
  return Array.from({ length }, (_, i) => ({ x: x + i * dx, y: y + i * dy }));
}
export function layout(index: number) {
  const paths = [
    line(6, 0, 0, 1, 13),
    line(0, 6, 1, 0, 20),
    [...line(2, 1, 0, 1, 10), ...line(3, 10, 1, 0, 16)],
    [...line(1, 1, 1, 0, 9), ...line(9, 2, 0, 1, 8), ...line(10, 9, 1, 0, 9)],
    [...line(2, 1, 0, 1, 10), ...line(3, 10, 1, 0, 15), ...line(17, 9, 0, -1, 9)],
    [...line(2, 1, 1, 0, 16), ...line(17, 2, 0, 1, 9), ...line(16, 10, -1, 0, 7)],
    [...line(1, 4, 1, 0, 18), ...line(18, 5, 0, 1, 6), ...line(17, 10, -1, 0, 16)],
  ];
  if (!paths[index]) throw new Error("unknown layout");
  const path = paths[index];
  const main = new Set(path.map(key));
  const extras: Position[] = [];
  for (let i = 2; i < path.length - 2; i += 4) {
    const here = path[i], next = path[i + 1];
    const dx = next.x - here.x, dy = next.y - here.y;
    const bay = { x: here.x - dy, y: here.y + dx };
    if (bay.x < 0 || bay.x >= 20 || bay.y < 0 || bay.y >= 13 || main.has(key(bay))) continue;
    const adjacent = path.filter((p) => Math.abs(p.x - bay.x) + Math.abs(p.y - bay.y) === 1);
    if (adjacent.length === 1) extras.push(bay);
  }
  // Final-only topology includes an actual passing loop, not just a rotated aisle.
  if (index === 6) extras.push(...line(6, 3, 1, 0, 5));
  return { path, map: mapFromOpen([...path, ...extras]), bays: new Set(extras.map(key)) };
}

export function generalizationScenario(seed: number, family: Family, layoutId: number, n: number) {
  const geometry = layout(layoutId), random = randomSource(seed);
  const length = geometry.path.length;
  const pick = (from: number, to: number, count: number) => {
    const values = Array.from({ length: to - from }, (_, i) => i + from);
    if (count > values.length) throw new Error("fleet does not fit this layout");
    for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
    return values.slice(0, count);
  };
  let starts: number[], goals: number[];
  if (family === "head-on") {
    const left = pick(0, Math.floor(length * 0.4), Math.ceil(n / 2));
    const right = pick(Math.ceil(length * 0.6), length, Math.floor(n / 2));
    starts = Array.from({ length: n }, (_, i) => i % 2 === 0 ? left[Math.floor(i / 2)] : right[Math.floor(i / 2)]);
    goals = starts.map((i) => length - 1 - i);
  } else if (family === "convoy") {
    starts = pick(0, Math.floor(length / 2), n).sort((a, b) => a - b);
    goals = pick(Math.floor(length / 2), length, n).sort((a, b) => a - b);
    if (random() < 0.5) { starts = starts.map((i) => length - 1 - i); goals = goals.map((i) => length - 1 - i); }
  } else {
    starts = pick(0, length, n); goals = pick(0, length, n);
  }
  const robots: RobotState[] = [], tasks: Task[] = [];
  for (let i = 0; i < n; i++) {
    const id = `AMR-${i}`, taskId = `T-${i}`;
    const start = { ...geometry.path[starts[i]] }, goal = { ...geometry.path[goals[i]] };
    robots.push({ id, position: start, home: start, battery: 100, status: "assigned", model: ROBOT_MODELS[0], currentTaskId: taskId, path: [], priority: 0 });
    tasks.push({ id: taskId, pickup: start, dropoff: goal, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: id });
  }
  return { ...geometry, robots, tasks };
}

export type TemporalEpisode = ReturnType<typeof collectRun> & { seed: number; family: Family; layoutId: number; fleetSize: number };
export function temporalCorpus(start: number, layouts: number[], sizes: number[], perCell: number): TemporalEpisode[] {
  const out: TemporalEpisode[] = [];
  let seed = start;
  const seen = new Set<string>();
  for (const layoutId of layouts) for (const fleetSize of sizes) for (const family of ["head-on", "convoy", "mixed"] as const) {
    let accepted = 0;
    while (accepted < perCell) {
      const id = seed++;
      const sc = generalizationScenario(id, family, layoutId, fleetSize);
      const signature = JSON.stringify([layoutId, sc.robots.map((r, i) => [r.position, sc.tasks[i].dropoff])]);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const history = new LocalHistory();
      const run = collectRun(sc, id, 160, { bays: sc.bays, observe: (ctx) => history.observe(ctx) });
      out.push({ ...run, seed: id, family, layoutId, fleetSize });
      accepted++;
    }
  }
  return out;
}
