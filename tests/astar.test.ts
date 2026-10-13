import { describe, expect, it } from "vitest";
import { planPath } from "../src/core/pathfinding/astar";
import { getNeighbors } from "../src/core/map/graph";
import type { Position, WarehouseMap } from "../src/core/types";
import { makeMap, makeWorld, withCongestion } from "./helpers";

function bfsDistance(map: WarehouseMap, start: Position, goal: Position): number {
  const goalKey = `${goal.x},${goal.y}`;
  const visited = new Set([`${start.x},${start.y}`]);
  let frontier = [start];
  let distance = 0;

  while (frontier.length > 0) {
    if (frontier.some((p) => `${p.x},${p.y}` === goalKey)) return distance;

    const next: Position[] = [];
    for (const pos of frontier) {
      for (const neighbor of getNeighbors(pos, map)) {
        const key = `${neighbor.x},${neighbor.y}`;
        if (!visited.has(key)) {
          visited.add(key);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    distance += 1;
  }

  return Infinity;
}

describe("planPath (A*)", () => {
  it("finds the shortest route on an open straight line", () => {
    const world = makeWorld(makeMap(4, 1));
    const result = planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, world);

    expect(result.found).toBe(true);
    expect(result.distance).toBe(3);
    expect(result.path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it("routes around a blocking wall via the only gap", () => {
    // Wall down x=2 for y=0..1, gap at y=2.
    const map = makeMap(5, 3, [
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ]);
    const world = makeWorld(map);
    const result = planPath({ x: 0, y: 1 }, { x: 4, y: 1 }, world);

    expect(result.found).toBe(true);
    expect(result.distance).toBe(6);
    expect(result.path).not.toContainEqual({ x: 2, y: 0 });
    expect(result.path).not.toContainEqual({ x: 2, y: 1 });
    expect(result.path).toContainEqual({ x: 2, y: 2 });
  });

  it("returns found=false for an unreachable goal, without throwing", () => {
    // Goal (1,1) is fully enclosed by blocked cells.
    const map = makeMap(3, 3, [
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 0 },
      { x: 1, y: 2 },
    ]);
    const world = makeWorld(map);

    expect(() => planPath({ x: 0, y: 0 }, { x: 1, y: 1 }, world)).not.toThrow();
    const result = planPath({ x: 0, y: 0 }, { x: 1, y: 1 }, world);
    expect(result.found).toBe(false);
    expect(result.path).toEqual([]);
  });

  it("returns a zero-cost success when start equals goal", () => {
    const world = makeWorld(makeMap(3, 3));
    const result = planPath({ x: 1, y: 1 }, { x: 1, y: 1 }, world);

    expect(result).toEqual({
      found: true,
      path: [{ x: 1, y: 1 }],
      distance: 0,
      congestionCost: 0,
      totalCost: 0,
      eta: 0,
    });
  });

  it("prefers a longer empty route over a shorter heavily congested one", () => {
    const congested = withCongestion(makeMap(5, 3), {
      "1,1": 100,
      "2,1": 100,
      "3,1": 100,
    });
    const world = makeWorld(congested);
    const result = planPath({ x: 0, y: 1 }, { x: 4, y: 1 }, world);

    expect(result.found).toBe(true);
    expect(result.distance).toBeGreaterThan(4); // detoured around the congested row
    const wentThroughCongestion = result.path.some((p) => p.y === 1 && p.x > 0 && p.x < 4);
    expect(wentThroughCongestion).toBe(false);
  });

  it("is deterministic for identical input", () => {
    const map = makeMap(6, 4, [
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
    const world = makeWorld(map);
    const a = planPath({ x: 0, y: 0 }, { x: 5, y: 3 }, world);
    const b = planPath({ x: 0, y: 0 }, { x: 5, y: 3 }, world);

    expect(a).toEqual(b);
  });

  it("matches BFS shortest-path length when congestion is zero", () => {
    const map = makeMap(6, 5, [
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ]);
    const world = makeWorld(map);
    const start = { x: 0, y: 2 };
    const goal = { x: 5, y: 2 };

    const result = planPath(start, goal, world);
    const bfs = bfsDistance(map, start, goal);

    expect(result.found).toBe(true);
    expect(result.distance).toBe(bfs);
  });
});

describe("planPath result cache", () => {
  it("never hands two callers the same path, so mutating one cannot corrupt the next", () => {
    const world = makeWorld(makeMap(4, 1));
    const first = planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, world);
    first.path.reverse();
    first.path[0].x = 99;
    const second = planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, world);
    expect(second.path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  });

  it("follows a map mutated in place, as the block-aisle command does", () => {
    const map = makeMap(3, 2);
    const world = makeWorld(map);
    expect(planPath({ x: 0, y: 0 }, { x: 2, y: 0 }, world).distance).toBe(2);
    map.cells.find((c) => c.position.x === 1 && c.position.y === 0)!.blocked = true;
    const detour = planPath({ x: 0, y: 0 }, { x: 2, y: 0 }, world);
    expect(detour.distance).toBe(4);
    expect(detour.path.some((p) => p.x === 1 && p.y === 0)).toBe(false);
  });

  it("follows congestion changes rather than object identity", () => {
    const base = makeMap(3, 3);
    const open = planPath({ x: 0, y: 1 }, { x: 2, y: 1 }, makeWorld(base));
    expect(open.path).toContainEqual({ x: 1, y: 1 });
    const jammed = planPath({ x: 0, y: 1 }, { x: 2, y: 1 }, makeWorld(withCongestion(base, { "1,1": 50 })));
    expect(jammed.path).not.toContainEqual({ x: 1, y: 1 });
  });
});
