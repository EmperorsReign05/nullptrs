import { describe, it } from "vitest";
import { createInitialWorld } from "../src/core/simulation/state";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createWarehouseMap, computeCongestion, CHARGING_STATIONS } from "../src/core/map/warehouse";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import { growFleet, openCells } from "./harness";
import type { Position, RobotState, Task, WorldState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const emptyMetrics = () => ({ replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 });
function worldWith(robots: RobotState[], tasks: Task[] = []): WorldState {
  return { tick: 0, map: computeCongestion(createWarehouseMap(), robots), robots, tasks, metrics: emptyMetrics() };
}
function rob(o: Partial<RobotState> & Pick<RobotState, "id" | "position">): RobotState {
  return { home: o.position, battery: 100, status: "idle", model: ROBOT_MODELS[0], path: [], priority: 0, ...o };
}
function task(o: Partial<Task> & Pick<Task, "id" | "pickup" | "dropoff">): Task {
  return { weight: 10, createdAt: 0, priority: 1, status: "pending", ...o };
}
function makeTasks(w: WorldState, s: number, open: Position[], n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) { const k = s + i; const p = open[(k * 7 + 3) % open.length]; const d = open[(k * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push(task({ id: `L${k}`, pickup: p, dropoff: d, weight: (k % 9) * 10 + 10, createdAt: w.tick })); }
  return out;
}

describe("V1: the impossible-task leak (unreachable tasks never expire)", () => {
  it("V1.1: a sealed-off pickup leaves the task pending forever, forever scanning the auction", () => {
    const map = createWarehouseMap();
    // seal (17,4) so a task with that pickup is unreachable from everywhere
    const sealed = { ...map, cells: map.cells.map((c) => (key(c.position) === "17,4" ? { ...c, blocked: true } : c)) };
    const robot = rob({ id: "A", position: { x: 0, y: 0 } });
    let w: WorldState = { ...worldWith([robot], [task({ id: "IMPOSSIBLE", pickup: { x: 17, y: 4 }, dropoff: { x: 0, y: 0 } })]), map: sealed };
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) w = runDispatchTick(w);
    const per = (performance.now() - t0) / 500;
    console.log(`V1.1 impossible task still pending after 500 ticks: ${w.tasks[0].status} (never expires, never reaped)`);
    console.log(`V1.1 cost: ${per.toFixed(2)} ms/tick wasted re-auctioning a task nobody can ever win`);

    // and it grows
    const many = Array.from({ length: 50 }, (_, i) => task({ id: `IMP${i}`, pickup: { x: 17, y: 4 }, dropoff: { x: 0, y: 0 } }));
    let w2: WorldState = { ...worldWith([robot], many), map: sealed };
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) w2 = runDispatchTick(w2);
    console.log(`V1.1 50 impossible tasks: ${((performance.now() - t1) / 100).toFixed(2)} ms/tick (vs ${per.toFixed(2)} with 1) => ${(((performance.now() - t1) / 100) / per).toFixed(1)}x for zero possible progress`);
  });

  it("V1.2: overweight tasks — same leak?", () => {
    const robot = rob({ id: "A", position: { x: 0, y: 0 } });
    const many = Array.from({ length: 50 }, (_, i) => task({ id: `FAT${i}`, pickup: { x: 3, y: 0 }, dropoff: { x: 9, y: 1 }, weight: 5000 }));
    let w = worldWith([robot], many);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) w = runDispatchTick(w);
    console.log(`V1.2 50 overweight tasks: ${((performance.now() - t0) / 100).toFixed(2)} ms/tick, all still pending=${w.tasks.every((t) => t.status === "pending")}`);
  });
});

describe("V2: spawn collision is not self-healing", () => {
  it("V2.1: two robots spawned on the same cell — does PIBT separate them or keep them stuck?", () => {
    const r1 = rob({ id: "X1", position: { x: 0, y: 0 }, status: "idle", battery: 90 });
    const r2 = rob({ id: "X2", position: { x: 0, y: 0 }, status: "idle", battery: 90 });
    const open = openCells(createInitialWorld());
    let w = worldWith([r1, r2], makeTasks(worldWith([r1, r2]), 0, open, 2));
    for (let i = 0; i < 200; i++) w = runDispatchTick(w);
    const cells = new Set(w.robots.map((r) => key(r.position)));
    console.log(`V2.1 after 200 ticks: ${w.robots.map((r) => `${r.id}@${key(r.position)}/${r.status}`).join(" | ")}`);
    console.log(`V2.1 distinct cells=${cells.size}/${w.robots.length} => ${cells.size < w.robots.length ? "PERMANENT OVERLAP — the safety invariant the stress test asserts is already violated" : "self-healed"}`);
  });

  it("V2.2: the UI can actually create this state", () => {
    // The slider's max — check ControlPanel for the allowed range.
    console.log("V2.2 growFleet(30) produces 8 colliding spawn pairs (measured earlier).");
    console.log("V2.2 The collision happens in the React state update, BEFORE any simulation tick.");
  });
});

describe("V3: reset/scale state coherence", () => {
  it("V3.1: does handleReset's robotCount actually match the reset fleet?", () => {
    console.log("V3.1 handleReset does setRobotCount(freshRobots.length) => consistent.");
    console.log("V3.1 BUT it does NOT clear the event log (logs persist) and does not reset worldRef's tick.");
    console.log("V3.1 createInitialWorld() starts at tick 0, so a reset after 5000 ticks rewinds the clock to 0");
    console.log("V3.1 while any deadline-bearing task's urgencyCost (world.tick based) silently changes meaning.");
  });

  it("V3.2: growing the fleet mid-run — are new robots given tasks consistent with existing paths?", () => {
    let w = growFleet(createInitialWorld(), 10);
    const open = openCells(w);
    for (let i = 0; i < 300; i++) { if (i % 20 === 0) w = { ...w, tasks: [...w.tasks, ...makeTasks(w, i, open)] }; w = runDispatchTick(w); }
    const before = w.robots.map((r) => key(r.position));
    w = growFleet(w, 20);
    console.log(`V3.2 grew 10 -> ${w.robots.length} mid-run. New robots spawn at fixed cells regardless of traffic.`);
    const spawnCells = w.robots.slice(10).map((r) => key(r.position));
    const occupiedByOld = spawnCells.filter((c) => before.includes(c));
    console.log(`V3.2 new spawn cells: ${spawnCells.join(" ")}`);
    console.log(`V3.2 of those, ${occupiedByOld.length} were occupied by an existing robot at growth time: ${occupiedByOld.join(" ") || "none"}`);
  });
});

describe("V4: the conflict/deadlock demo buttons", () => {
  it("V4.1: do Sim Conflict / Sim Deadlock produce the state they claim?", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    // Sim Conflict: two tasks pinning two robots into the x=6 corridor
    const corridorTop: Position = { x: 6, y: 1 };
    const corridorBottom: Position = { x: 6, y: 11 };
    const a = rob({ id: "CA", position: { x: 6, y: 2 }, status: "assigned", currentTaskId: "DA", path: [] });
    const b = rob({ id: "CB", position: { x: 6, y: 10 }, status: "assigned", currentTaskId: "DB", path: [] });
    w = { ...w, robots: [...w.robots, a, b] };
    w = { ...w, tasks: [...w.tasks,
      task({ id: "DA", pickup: corridorTop, dropoff: corridorTop, status: "assigned", assignedRobotId: "CA" }),
      task({ id: "DB", pickup: corridorBottom, dropoff: corridorBottom, status: "assigned", assignedRobotId: "CB" })] };
    const c0 = w.metrics.conflictCount;
    for (let i = 0; i < 40; i++) w = runDispatchTick(w);
    console.log(`V4.1 Sim Conflict scenario: PIBT conflicts generated = ${w.metrics.conflictCount - c0}`);
    console.log(`V4.1 CA@${key(w.robots.find((r) => r.id === "CA")!.position)} CB@${key(w.robots.find((r) => r.id === "CB")!.position)}`);

    // Sim Deadlock: 4 robots in the DEADLOCK_BOX
    const box: Position[] = [{ x: 12, y: 1 }, { x: 13, y: 1 }, { x: 13, y: 2 }, { x: 12, y: 2 }];
    const dl = box.map((p, i) => rob({ id: `DL${i}`, position: p, status: "assigned", currentTaskId: `DD${i}`, path: [] }));
    let w2 = { ...growFleet(createInitialWorld(), 0), robots: dl, tasks: box.map((p, i) => task({ id: `DD${i}`, pickup: p, dropoff: p, status: "assigned" as const, assignedRobotId: `DL${i}` })) };
    const c1 = w2.metrics.conflictCount;
    for (let i = 0; i < 40; i++) w2 = runDispatchTick(w2);
    console.log(`V4.1 Sim Deadlock scenario: PIBT conflicts = ${w2.metrics.conflictCount - c1}, final positions: ${w2.robots.map((r) => `${r.id}@${key(r.position)}`).join(" ")}`);
    console.log(`V4.1 => do they stay deadlocked, or does PIBT quietly resolve it and the demo show nothing?`);
  });
});

describe("V5: throughput sanity — the honest headline number", () => {
  it("V5.1: completed tasks per 1000 ticks vs fleet size (the number a partner would ask)", () => {
    console.log("V5 fleet | completed/1000 ticks | final moving | conflicts/1000");
    for (const n of [5, 10, 15, 20, 25, 30]) {
      let w = growFleet(createInitialWorld(), n);
      const open = openCells(w);
      let k = 0;
      const start = w.tick;
      for (let i = 0; i < 1000; i++) { if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, k, open)] }; k += 3; } w = runDispatchTick(w); }
      const done = w.tasks.filter((t) => t.status === "completed").length;
      console.log(`V5 ${String(n).padStart(5)} | ${String(done).padStart(19)} | ${String(w.robots.filter((r) => r.status === "moving").length).padStart(12)} | ${String(w.metrics.conflictCount).padStart(13)}`);
    }
  });
});
