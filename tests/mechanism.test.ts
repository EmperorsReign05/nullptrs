import { describe, it, expect } from "vitest";
import { createWarehouseMap } from "../src/core/map/warehouse";
import { planPath } from "../src/core/pathfinding/astar";
import { resolvePIBT } from "../src/core/pathfinding/pibt";
import { stepSimulation } from "../src/core/simulation/engine";
import { openCells, makeLoadTasks, growFleet } from "./harness";
import { createInitialWorld } from "../src/core/simulation/state";
import type { WorldState, RobotState, Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

describe("E: rule out harness artifact — is my task generator biased?", () => {
  it("E0: distribution of generated pickups/dropoffs across the grid", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    console.log(`E0 open cells: ${open.length}`);
    const all = makeLoadTasks(world, 0, 300, open);
    const byCol = new Map<number, number>();
    for (const t of all) { byCol.set(t.pickup.x, (byCol.get(t.pickup.x) ?? 0) + 1); }
    console.log("E0 pickups by column:", [...byCol.entries()].sort((a, b) => a[0] - b[0]).map(([x, n]) => `x=${x}:${n}`).join(" "));
    const byColD = new Map<number, number>();
    for (const t of all) { byColD.set(t.dropoff.x, (byColD.get(t.dropoff.x) ?? 0) + 1); }
    console.log("E0 dropoffs by column:", [...byColD.entries()].sort((a, b) => a[0] - b[0]).map(([x, n]) => `x=${x}:${n}`).join(" "));
    console.log(`E0 distinct cells used: ${new Set(all.map((t) => key(t.pickup))).size} pickups, ${new Set(all.map((t) => key(t.dropoff))).size} dropoffs`);
  });

  it("E1: use a UNIFORM random task generator instead — does the collapse persist?", () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) {
        const fresh = [];
        for (let j = 0; j < 3; j++) {
          const p = open[Math.floor(rand() * open.length)];
          const d = open[Math.floor(rand() * open.length)];
          if (p.x === d.x && p.y === d.y) continue;
          fresh.push({ id: `R${n++}`, pickup: p, dropoff: d, weight: 50, createdAt: world.tick, priority: 1, status: "pending" as const });
        }
        world = { ...world, tasks: [...world.tasks, ...fresh] };
      }
      world = runDispatchTickSafe(world);
    }
    const done = world.tasks.filter((t) => t.status === "completed").length;
    const waiting = world.robots.filter((r) => r.status === "waiting").length;
    const moving = world.robots.filter((r) => r.status === "moving").length;
    console.log(`E1 UNIFORM tasks, 20 AMRs, 3000 ticks: completed=${done}/${world.tasks.length} waiting=${waiting} moving=${moving} charging=${world.robots.filter((r) => r.status === "charging").length} replans=${world.metrics.replans} conflicts=${world.metrics.conflictCount}`);
  });
});

import { runDispatchTick } from "../src/core/simulation/dispatch";
function runDispatchTickSafe(w: WorldState) { return runDispatchTick(w); }

describe("F: the livelock mechanism, isolated", () => {
  it("F1: A* routes straight THROUGH an occupied cell, and a wait never invalidates the path", () => {
    // Three robots in a vertical line, the middle one in the way.
    const map = createWarehouseMap();
    const mk = (id: string, x: number, y: number, path: Position[]): RobotState => ({
      id, position: { x, y }, home: { x, y }, battery: 100, status: "moving",
      model: { model: "T", payloadCapacity: 100 }, path, priority: 0,
    });
    let world: WorldState = {
      tick: 0,
      map: { ...map, cells: map.cells.map((c) => ({ ...c, congestion: c.position.x === 6 && c.position.y >= 2 && c.position.y <= 4 ? 9 : 0 })) },
      robots: [],
      tasks: [],
      metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    };
    // Blocker sits at (6,3) and will NEVER move (no path, idle, not pushed).
    const blocker = mk("BLOCKER", 6, 3, []);
    // R0 wants to go from (6,1) down to (6,6) — straight through the blocker.
    const r0 = mk("R0", 6, 1, planPath({ x: 6, y: 1 }, { x: 6, y: 6 }, world).path);
    console.log(`F1 A* path for R0: ${r0.path.map(key).join(" -> ")}`);
    console.log(`F1 it plans THROUGH the occupied cell ${key(blocker.position)}: ${r0.path.some((p) => p.x === 6 && p.y === 3)}`);

    const res = resolvePIBT([r0, blocker], world);
    console.log(`F1 R0 move: ${key(res.moves[0].from)} -> ${key(res.moves[0].to)}`);
    console.log(`F1 R0 path after resolution is UNCHANGED: ${r0.path.length} cells, next=${key(r0.path[1])}`);
    console.log("F1 => needsReplan() checks only (a) goal changed and (b) path[1] is BLOCKED (a wall).");
    console.log("F1 => An occupied-but-traversable next step never triggers a replan, so this is a permanent wait.");
  });

  it("F2: two robots facing each other in a corridor — do they ever resolve?", () => {
    const map = createWarehouseMap();
    const world: WorldState = {
      tick: 0, map, robots: [], tasks: [],
      metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    };
    const mk = (id: string, x: number, y: number, path: Position[]): RobotState => ({
      id, position: { x, y }, home: { x, y }, battery: 100, status: "moving",
      model: { model: "T", payloadCapacity: 100 }, path, priority: 0,
    });
    // x=3 column: shelves at x=1,2 and x=4,5 for y=1..3, so (3,1) is a
    // single-cell dead-end corridor. Put two robots nose to nose.
    const a = mk("A", 3, 1, [{ x: 3, y: 1 }, { x: 3, y: 2 }]);
    const b = mk("B", 3, 2, [{ x: 3, y: 2 }, { x: 3, y: 1 }]);
    const res = resolvePIBT([a, b], world);
    for (const m of res.moves) console.log(`F2 ${m.robotId}: ${key(m.from)} -> ${key(m.to)} ${m.from.x === m.to.x && m.from.y === m.to.y ? "(WAIT)" : ""}`);
    console.log(`F2 conflicts=${res.metrics.conflictCount} waitMoves=${res.metrics.waitMoves} backtracks=${res.metrics.backtracks}`);
  });

  it("F3: does a waiting robot's base priority escalate forever?", () => {
    const map = createWarehouseMap();
    const world: WorldState = { tick: 0, map, robots: [], tasks: [], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
    const mk = (id: string, x: number, y: number, path: Position[]): RobotState => ({
      id, position: { x, y }, home: { x, y }, battery: 100, status: "moving",
      model: { model: "T", payloadCapacity: 100 }, path, priority: 0,
    });
    const blocker = mk("BLOCKER", 6, 3, []);
    let r0 = mk("R0", 6, 1, planPath({ x: 6, y: 1 }, { x: 6, y: 6 }, world).path);
    let totalConflicts = 0;
    for (let t = 0; t < 12; t++) {
      const res = resolvePIBT([r0, blocker], world);
      totalConflicts += res.metrics.conflictCount;
      const m = res.moves[0];
      const followed = r0.path.length > 1 && m.to.x === r0.path[1].x && m.to.y === r0.path[1].y;
      const moved = !(m.from.x === m.to.x && m.from.y === m.to.y);
      // mirror engine.stepSimulation's accounting
      if (!moved) r0 = { ...r0, priority: r0.path.length > 1 ? r0.priority + 1 : r0.priority };
      else r0 = { ...r0, position: m.to, path: followed ? r0.path.slice(1) : [], priority: 0 };
    }
    console.log(`F3 after 12 ticks: R0 still at ${key(r0.position)} priority=${r0.priority} pathLen=${r0.path.length} totalConflicts=${totalConflicts}`);
    console.log(`F3 => base priority grows +1 per wait tick with no cap; observed 2500+ in the collapse.`);
  });
});
