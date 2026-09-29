import { describe, expect, it } from "vitest";
import { resolvePIBT } from "../src/core/pathfinding/pibt2";
import { runDispatchTick } from "../src/core/simulation/dispatch2";
import { growFleet, openCells, makeLoadTasks } from "./harness";
import { createInitialWorld } from "../src/core/simulation/state";
import { positionsEqual, manhattanDistance } from "../src/core/map/graph";
import type { Position, RobotState, WorldState } from "../src/core/types";

const p = (x: number, y: number): Position => ({ x, y });
function scenario(open: Position[], specs: { id: string; at: Position; next: Position; priority: number; status?: RobotState["status"]; battery?: number }[]): WorldState {
  const initial = createInitialWorld();
  return { ...initial, tasks: [], map: { ...initial.map, cells: initial.map.cells.map(cell => ({ ...cell,
    blocked: !open.some(position => positionsEqual(position, cell.position)) })) },
    robots: specs.map(spec => ({ ...initial.robots[0], id: spec.id, position: spec.at, home: spec.at,
      priority: spec.priority, status: spec.status ?? "waiting", battery: spec.battery ?? 100,
      path: [spec.at, spec.next], currentTaskId: undefined, queuedTaskIds: [] })) };
}
function assertSafe(world: WorldState, moves: ReturnType<typeof resolvePIBT>["moves"]) {
  const destinations = new Set(moves.map(move => `${move.to.x},${move.to.y}`));
  expect(destinations.size).toBe(moves.length);
  for (const move of moves) {
    expect(manhattanDistance(move.from, move.to)).toBeLessThanOrEqual(1);
    expect(world.map.cells.find(cell => positionsEqual(cell.position, move.to))?.blocked).toBe(false);
    for (const other of moves) if (other.robotId !== move.robotId) {
      expect(positionsEqual(move.from, other.to) && positionsEqual(move.to, other.from)).toBe(false);
    }
  }
}

function boxedCycle(status?: RobotState["status"], battery = 100) {
  return scenario([p(1,5), p(2,5), p(3,5), p(1,6)], [
    {id:"A",at:p(3,5),next:p(2,5),priority:20},
    {id:"B",at:p(2,5),next:p(3,5),priority:10},
    {id:"C",at:p(1,5),next:p(2,5),priority:100,status,battery},
  ]);
}

describe("prototype stationary-cycle repair", () => {
  it("shifts a stationary blocker chain when no cycle member has a free neighbor", () => {
    const world = boxedCycle();
    const result = resolvePIBT(world.robots, world);
    expect(result.metrics.cyclesBroken).toBe(1);
    expect(result.moves.find(m=>m.robotId==="B")?.to).toEqual(p(1,5));
    expect(result.moves.find(m=>m.robotId==="C")?.to).toEqual(p(1,6));
    expect(result.metrics.waitMoves).toBe(1);
    assertSafe(world, result.moves);
  });

  for (const condition of ["failed", "exhausted"] as const) {
    it(`does not escape through a ${condition} stationary blocker`, () => {
      const world = boxedCycle(condition === "failed" ? "failed" : undefined, condition === "exhausted" ? 0 : 100);
      const result = resolvePIBT(world.robots, world);
      expect(result.metrics.cyclesBroken).toBe(0);
      expect(result.moves.every(move=>positionsEqual(move.from,move.to))).toBe(true);
      assertSafe(world, result.moves);
    });
  }

  it("does not rewrite already-safe moving head-on resolution as a wait cycle", () => {
    const world = scenario([p(2,5),p(3,5),p(2,6),p(3,6)], [
      {id:"A",at:p(2,5),next:p(3,5),priority:20},
      {id:"B",at:p(3,5),next:p(2,5),priority:10},
    ]);
    const result = resolvePIBT(world.robots, world);
    expect(result.metrics.cyclesBroken).toBe(0);
    expect(result.moves.find(m=>m.robotId==="A")?.to).toEqual(p(3,5));
    expect(result.moves.find(m=>m.robotId==="B")?.to).toEqual(p(3,6));
    assertSafe(world, result.moves);
  });
});


it("preserves occupancy, edge-swap and blocked-cell safety during the original sustained workloads", () => {
  for (const count of [10, 20]) {
    let world = growFleet(createInitialWorld(), count);
    const open = openCells(world);
    let taskIndex = 0;
    const violations = { overlap: 0, swap: 0, blocked: 0, nonAdjacent: 0 };
    for (let tick = 0; tick < 3200; tick++) {
      if (tick < 3000 && tick % 20 === 0) {
        world = { ...world, tasks: [...world.tasks, ...makeLoadTasks(world, taskIndex, 3, open)] };
        taskIndex += 3;
      }
      const before = world;
      world = runDispatchTick(world);
      const occupied = new Set<string>();
      for (const robot of world.robots) {
        const key = `${robot.position.x},${robot.position.y}`;
        if (occupied.has(key)) violations.overlap++;
        occupied.add(key);
        if (world.map.cells.find(cell => positionsEqual(cell.position,robot.position))?.blocked) violations.blocked++;
        const previous = before.robots.find(r=>r.id===robot.id)!;
        if (manhattanDistance(previous.position,robot.position)>1) violations.nonAdjacent++;
        for (const other of world.robots) {
          if (other.id >= robot.id) continue;
          const oldOther = before.robots.find(r=>r.id===other.id)!;
          if (positionsEqual(previous.position,other.position) && positionsEqual(oldOther.position,robot.position)) violations.swap++;
        }
      }
    }
    expect(violations, `${count} AMRs`).toEqual({ overlap: 0, swap: 0, blocked: 0, nonAdjacent: 0 });
  }
}, 30000);
