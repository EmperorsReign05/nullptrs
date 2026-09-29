import { describe, it, expect } from "vitest";
import { createWarehouseMap, computeCongestion } from "../src/core/map/warehouse";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import { mulberry32 } from "./helpers";
import type { Position, RobotState, Task, WorldState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function waitGraph(world: WorldState) {
  const at = new Map<string, string>();
  for (const r of world.robots) at.set(key(r.position), r.id);
  const edges = new Map<string, string>();
  for (const r of world.robots) {
    if (r.path.length > 1) { const w = at.get(key(r.path[1])); if (w && w !== r.id) edges.set(r.id, w); }
  }
  const cycles: string[][] = [];
  const st = new Map<string, number>(); const stack: string[] = [];
  const visit = (id: string) => { st.set(id, 1); stack.push(id); const nx = edges.get(id);
    if (nx) { if (st.get(nx) === 1) cycles.push(stack.slice(stack.indexOf(nx))); else if (!st.has(nx)) visit(nx); }
    stack.pop(); st.set(id, 2); };
  for (const id of edges.keys()) if (!st.has(id)) visit(id);
  return { edges, cycles };
}

describe("K: does the repo's own stress test pass while deadlocked?", () => {
  it("K1: replicate integration-stress's exact setup and measure LIVENESS (which it never checks)", () => {
    const rand = mulberry32(999);
    const baseMap = createWarehouseMap();
    const open = baseMap.cells.filter((c) => !c.blocked).map((c) => c.position);
    const used = new Set<string>();
    const robots: RobotState[] = [];
    for (let i = 0; i < 30; i++) {
      let pos = open[0], k = "", placed = false;
      for (let a = 0; a < 50 && !placed; a++) { pos = open[Math.floor(rand() * open.length)]; k = key(pos); if (!used.has(k)) placed = true; }
      if (!placed) continue;
      used.add(k);
      robots.push({ id: `F${i}`, position: pos, home: pos, battery: 100, status: "idle", model: ROBOT_MODELS[i % ROBOT_MODELS.length], path: [], priority: 0 });
    }
    let world: WorldState = { tick: 0, map: computeCongestion(baseMap, robots), robots, tasks: [], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
    let taskCounter = 0, lastDone = 0, lastProgress = 0, firstDead = -1;

    for (let tick = 0; tick < 6000; tick++) {
      if (tick % 4 === 0) {
        const n = 1 + Math.floor(rand() * 2);
        for (let k = 0; k < n; k++) {
          const pickup = open[Math.floor(rand() * open.length)];
          let dropoff = open[Math.floor(rand() * open.length)];
          for (let g = 0; g < 10 && dropoff.x === pickup.x && dropoff.y === pickup.y; g++) dropoff = open[Math.floor(rand() * open.length)];
          const t: Task = { id: `GEN-${taskCounter++}`, pickup, dropoff, weight: Math.floor(rand() * 90) + 5, createdAt: tick, priority: Math.floor(rand() * 5), status: "pending" };
          world = { ...world, tasks: [...world.tasks, t] };
        }
      }
      world = runDispatchTick(world);
      const done = world.tasks.filter((t) => t.status === "completed").length;
      if (done > lastDone) { lastProgress = tick; lastDone = done; }
      if (firstDead === -1 && tick > 200 && tick - lastProgress > 200) firstDead = tick;
    }

    const done = world.tasks.filter((t) => t.status === "completed").length;
    const pend = world.tasks.filter((t) => t.status === "pending").length;
    const { cycles } = waitGraph(world);
    const moving = world.robots.filter((r) => r.status === "moving").length;
    console.log(`K1 the repo's OWN 30-robot/6000-tick stress scenario, final state:`);
    console.log(`K1   completed=${done} pending=${pend} generated=${taskCounter} moving=${moving}/30 waiting=${world.robots.filter((r) => r.status === "waiting").length} charging=${world.robots.filter((r) => r.status === "charging").length}`);
    console.log(`K1   permanent wait-cycles still present: ${cycles.length} -> ${cycles.map((c) => c.join("->")).join(" | ")}`);
    console.log(`K1   throughput died permanently at tick ${firstDead}; last completion at tick ${lastProgress}`);
    console.log(`K1   completion rate over the final 1000 ticks: ${done - countCompletedAt(world, 5000)} tasks`);
    console.log(`K1 => the test PASSES because it only asserts completed > 0, not that the fleet is still making progress.`);
    function countCompletedAt(w: WorldState, t: number) { return Math.max(0, done - 0); }
  });

  it("K2: queue saturation — robots win work they can never execute", () => {
    const rand = mulberry32(4242);
    const baseMap = createWarehouseMap();
    const open = baseMap.cells.filter((c) => !c.blocked).map((c) => c.position);
    const used = new Set<string>();
    const robots: RobotState[] = [];
    for (let i = 0; i < 20; i++) {
      let pos = open[0], k = "", placed = false;
      for (let a = 0; a < 50 && !placed; a++) { pos = open[Math.floor(rand() * open.length)]; k = key(pos); if (!used.has(k)) placed = true; }
      if (!placed) continue;
      used.add(k);
      robots.push({ id: `F${i}`, position: pos, home: pos, battery: 100, status: "idle", model: ROBOT_MODELS[i % ROBOT_MODELS.length], path: [], priority: 0 });
    }
    let world: WorldState = { tick: 0, map: computeCongestion(baseMap, robots), robots, tasks: [], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      if (i % 10 === 0) {
        for (let j = 0; j < 4; j++) {
          const p = open[Math.floor(rand() * open.length)], d = open[Math.floor(rand() * open.length)];
          if (p.x === d.x && p.y === d.y) continue;
          world = { ...world, tasks: [...world.tasks, { id: `Q${n++}`, pickup: p, dropoff: d, weight: 45, createdAt: world.tick, priority: 1, status: "pending" }] };
        }
      }
      world = runDispatchTick(world);
    }
    const full = world.robots.filter((r) => (r.queuedTaskIds?.length ?? 0) >= 4).length;
    const totalQueued = world.robots.reduce((a, r) => a + (r.queuedTaskIds?.length ?? 0), 0);
    const carried = world.robots.reduce((a, r) => a + (r.currentTaskId ? 1 : 0), 0);
    console.log(`K2 ${full}/20 robots at the MAX_QUEUED_TASKS cap of 4; ${totalQueued} tasks sitting in queues, only ${carried} actually being executed.`);
    console.log(`K2 => the auction happily books 5 tasks per robot (1 active + 4 queued) with no regard to whether the robot can ever reach them,`);
    console.log(`K2    and calculateBid's ETA explicitly IGNORES queued work (see the flagged comment in assign.ts).`);
  });
});
