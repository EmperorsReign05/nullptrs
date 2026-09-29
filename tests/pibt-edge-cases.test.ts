import { describe, expect, it } from "vitest";
import { createWarehouseMap, isTraversable } from "../src/core/map/warehouse";
import { planPath } from "../src/core/pathfinding/astar";
import { resolvePIBT } from "../src/core/pathfinding/pibt";
import type { Position, RobotState, WarehouseMap, WorldState } from "../src/core/types";
import { findMove, makeMap, makeRobot, makeWorld, mulberry32 } from "./helpers";

function eq(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

describe("PIBT: trivial/degenerate inputs", () => {
  it("zero robots: returns empty moves and zeroed metrics without throwing", () => {
    const world = makeWorld(makeMap(5, 5));
    expect(() => resolvePIBT([], world)).not.toThrow();
    const { moves, metrics } = resolvePIBT([], world);
    expect(moves).toEqual([]);
    expect(metrics).toEqual({ conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0, stepAsides: 0 });
  });

  it("single robot with no path just waits", () => {
    const r = makeRobot({ id: "R0", position: { x: 2, y: 2 }, path: [] });
    const world = makeWorld(makeMap(5, 5), [r]);
    const { moves, metrics } = resolvePIBT([r], world);
    expect(moves).toEqual([{ robotId: "R0", from: { x: 2, y: 2 }, to: { x: 2, y: 2 } }]);
    expect(metrics.waitMoves).toBe(1);
  });

  it("single robot with an open path moves along it, unobstructed", () => {
    const r = makeRobot({ id: "R0", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] });
    const world = makeWorld(makeMap(5, 5), [r]);
    const { moves } = resolvePIBT([r], world);
    expect(findMove(moves, "R0").to).toEqual({ x: 1, y: 0 });
  });

  it("every robot failed: nobody moves, no throw, no collisions even under contention", () => {
    const robots = [
      makeRobot({ id: "R0", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], status: "failed" }),
      makeRobot({ id: "R1", position: { x: 2, y: 0 }, path: [{ x: 2, y: 0 }, { x: 1, y: 0 }], status: "failed" }),
    ];
    const world = makeWorld(makeMap(3, 1), robots);
    const { moves } = resolvePIBT(robots, world);
    for (const m of moves) expect(m.to).toEqual(m.from);
  });

  it("a mix of failed and active robots: failed ones are immovable obstacles, active ones route around them", () => {
    const robots = [
      makeRobot({ id: "BLOCKER", position: { x: 1, y: 0 }, path: [], status: "failed" }),
      makeRobot({ id: "MOVER", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], priority: 5 }),
    ];
    const world = makeWorld(makeMap(3, 1), robots);
    const { moves } = resolvePIBT(robots, world);
    expect(findMove(moves, "BLOCKER").to).toEqual({ x: 1, y: 0 }); // never moves
    expect(findMove(moves, "MOVER").to).toEqual({ x: 0, y: 0 }); // boxed in, can only wait — never enters BLOCKER's cell
  });
});

describe("PIBT: malformed/stale input safety net", () => {
  it("path pointing at an out-of-bounds cell never lets a robot leave the map", () => {
    const r = makeRobot({ id: "R0", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: -1, y: 0 }] });
    const world = makeWorld(makeMap(5, 5), [r]);
    const { moves } = resolvePIBT([r], world);
    const to = findMove(moves, "R0").to;
    expect(to.x).toBeGreaterThanOrEqual(0);
    expect(to.y).toBeGreaterThanOrEqual(0);
  });

  it("path pointing at a permanently blocked cell never lets a robot enter it", () => {
    const map = makeMap(3, 1, [{ x: 1, y: 0 }]);
    const r = makeRobot({ id: "R0", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] });
    const world = makeWorld(map, [r]);
    const { moves } = resolvePIBT([r], world);
    expect(findMove(moves, "R0").to).toEqual({ x: 0, y: 0 });
  });

  it("path with a non-adjacent jump never lets a robot skip a cell in one tick", () => {
    const r = makeRobot({ id: "R0", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const world = makeWorld(makeMap(5, 1), [r]);
    const { moves } = resolvePIBT([r], world);
    const m = findMove(moves, "R0");
    const dist = Math.abs(m.to.x - m.from.x) + Math.abs(m.to.y - m.from.y);
    expect(dist).toBeLessThanOrEqual(1);
  });

  it("a robot silently 'teleporting' past a jump never bypasses collision checks on the skipped cell", () => {
    // R0's malformed path claims its next step is 2 cells away, straight
    // through R1. R0 must not end up on or past R1 without R1 ever having a
    // chance to react — the fix should degrade this into an ordinary
    // 1-step move that goes through the normal push/recursion machinery.
    const r0 = makeRobot({ id: "R0", position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 2, y: 0 }], priority: 5 });
    const r1 = makeRobot({ id: "R1", position: { x: 1, y: 0 }, path: [], priority: 0 });
    const world = makeWorld(makeMap(5, 1), [r0, r1]);
    const { moves } = resolvePIBT([r0, r1], world);
    const m0 = findMove(moves, "R0");
    const m1 = findMove(moves, "R1");
    const dist0 = Math.abs(m0.to.x - m0.from.x) + Math.abs(m0.to.y - m0.from.y);
    expect(dist0).toBeLessThanOrEqual(1);
    expect(eq(m0.to, m1.to)).toBe(false); // still no collision even with the malformed input
  });

  it("path with a duplicate consecutive waypoint (path[1] === path[0]) is treated as no real preferred step", () => {
    const r = makeRobot({
      id: "R0",
      position: { x: 2, y: 2 },
      path: [{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
    });
    const world = makeWorld(makeMap(5, 5), [r]);
    expect(() => resolvePIBT([r], world)).not.toThrow();
    const m = findMove([...resolvePIBT([r], world).moves], "R0");
    expect(isTraversable(m.to, world.map)).toBe(true);
  });

  it("two robots given the same (physically invalid) starting cell: never throws, every robot still gets exactly one decision", () => {
    // This input is already invalid (two robots can't occupy one cell) —
    // PIBT can't retroactively fix that, but it must degrade safely: no
    // exception, no undefined/missing move for either robot.
    const robots = [
      makeRobot({ id: "R0", position: { x: 2, y: 2 }, path: [{ x: 2, y: 2 }, { x: 3, y: 2 }] }),
      makeRobot({ id: "R1", position: { x: 2, y: 2 }, path: [{ x: 2, y: 2 }, { x: 1, y: 2 }] }),
    ];
    const world = makeWorld(makeMap(5, 5), robots);
    expect(() => resolvePIBT(robots, world)).not.toThrow();
    const { moves } = resolvePIBT(robots, world);
    expect(moves.length).toBe(2);
    expect(moves.some((m) => m.robotId === "R0")).toBe(true);
    expect(moves.some((m) => m.robotId === "R1")).toBe(true);
  });
});

describe("PIBT: saturation", () => {
  it("full saturation (robots occupy every single open cell): universal, deterministic, collision-free wait", () => {
    const map = makeMap(4, 4); // 16 open cells
    const positions = map.cells.map((c) => c.position);
    const rand = mulberry32(7);
    const robots = positions.map((pos, i) => {
      // give everyone a "path" toward a random other occupied cell, so
      // they all WANT to move — the point is that there is nowhere to go.
      const goal = positions[Math.floor(rand() * positions.length)];
      return makeRobot({ id: `R${i}`, position: pos, path: [pos, goal], priority: i });
    });
    const world = makeWorld(map, robots);

    const a = resolvePIBT(robots, world);
    const b = resolvePIBT(robots, world);
    expect(b).toEqual(a); // deterministic

    for (const m of a.moves) expect(m.to).toEqual(m.from); // nobody can possibly move
    expect(a.moves.length).toBe(robots.length);
  });

  it("near-saturation (one free cell) with everyone wanting to shift: safe over many ticks, real throughput happens", () => {
    const width = 6, height = 6;
    const map = makeMap(width, height);
    const positions = map.cells.map((c) => c.position);
    const rand = mulberry32(11);

    // Fill all but one cell.
    const shuffled = [...positions].sort(() => rand() - 0.5);
    const occupied = shuffled.slice(0, shuffled.length - 1);
    let robots: RobotState[] = occupied.map((pos, i) =>
      makeRobot({ id: `R${i}`, position: pos, path: [], priority: 0 })
    );

    let totalMoves = 0;
    const currentMap = map;
    for (let tick = 0; tick < 100; tick++) {
      const world: WorldState = { tick, map: currentMap, robots, tasks: [], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
      // continuously re-goal anyone without an active route
      robots = robots.map((r) => {
        if (r.path.length > 1) return r;
        const goal = positions[Math.floor(rand() * positions.length)];
        // no A* needed here — just point them one step toward a random
        // neighbor to keep contention high without pulling in astar
        return { ...r, path: [r.position, goal] };
      });

      const { moves } = resolvePIBT(robots, world);
      const destKeys = moves.map((m) => `${m.to.x},${m.to.y}`);
      expect(new Set(destKeys).size, `tick ${tick}`).toBe(destKeys.length);

      const moveByRobot = new Map(moves.map((m) => [m.robotId, m]));
      robots = robots.map((r) => {
        const move = moveByRobot.get(r.id)!;
        const moved = move.to.x !== move.from.x || move.to.y !== move.from.y;
        if (moved) totalMoves += 1;
        return moved ? { ...r, position: move.to, path: [] } : { ...r, priority: r.priority + 1 };
      });

      const seen = new Set<string>();
      for (const r of robots) {
        const key = `${r.position.x},${r.position.y}`;
        expect(seen.has(key), `tick ${tick}: duplicate cell ${key}`).toBe(false);
        seen.add(key);
      }
    }
    expect(totalMoves).toBeGreaterThan(0);
  });
});

describe("PIBT: massive convergence on a single cell", () => {
  it("many robots surrounding one free cell: exactly one gets in, nobody collides, deterministic", () => {
    // A plus-shaped cluster of 8 robots, all one step away from the center,
    // all wanting the center cell.
    const map = makeMap(5, 5);
    const center = { x: 2, y: 2 };
    const ring: Position[] = [
      { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
      { x: 1, y: 2 },                 { x: 3, y: 2 },
      { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
    ];
    const robots = ring.map((pos, i) =>
      makeRobot({ id: `R${i}`, position: pos, path: [pos, center], priority: i })
    );
    const world = makeWorld(map, robots);

    const a = resolvePIBT(robots, world);
    const b = resolvePIBT(robots, world);
    expect(b).toEqual(a);

    const enteredCenter = a.moves.filter((m) => eq(m.to, center));
    expect(enteredCenter.length).toBe(1);

    const destKeys = a.moves.map((m) => `${m.to.x},${m.to.y}`);
    expect(new Set(destKeys).size).toBe(destKeys.length);
  });

  it("32 robots converging on one cell from a larger ring: still exactly one winner, no collisions", () => {
    const size = 12;
    const map = makeMap(size, size);
    const center = { x: 6, y: 6 };
    const ring: Position[] = [];
    for (let x = 3; x <= 9; x++) {
      ring.push({ x, y: 3 });
      ring.push({ x, y: 9 });
    }
    for (let y = 4; y <= 8; y++) {
      ring.push({ x: 3, y });
      ring.push({ x: 9, y });
    }
    const robots = ring.map((pos, i) =>
      makeRobot({ id: `R${i}`, position: pos, path: [pos, center], priority: i % 5 })
    );
    const world = makeWorld(map, robots);
    const { moves } = resolvePIBT(robots, world);

    const destKeys = moves.map((m) => `${m.to.x},${m.to.y}`);
    expect(new Set(destKeys).size).toBe(destKeys.length);
    for (const m of moves) expect(isTraversable(m.to, map)).toBe(true);
  });
});

describe("PIBT: fairness at scale", () => {
  it("4 robots repeatedly contending for one doorway: every single one eventually gets through", () => {
    // A cross of 4 corridors meeting at one doorway cell — one robot per
    // orthogonal side, since a grid cell only has 4 orthogonal neighbors.
    // Every robot wants to pass through the doorway to the opposite side.
    // Simulates the engine's priority-accrual loop manually since
    // resolvePIBT itself is stateless.
    const map = makeMap(7, 7);
    const doorway = { x: 3, y: 3 };
    // start -> exit, straight through the doorway, continuing one more
    // step past it so a winner actually clears the doorway afterward
    // instead of parking on top of it and permanently blocking everyone
    // else. Every intermediate cell included explicitly — no gaps.
    const goals: Record<string, Position> = {
      R0: { x: 5, y: 3 },
      R1: { x: 1, y: 3 },
      R2: { x: 3, y: 5 },
      R3: { x: 3, y: 1 },
    };
    const starts: Record<string, Position> = {
      R0: { x: 0, y: 3 },
      R1: { x: 6, y: 3 },
      R2: { x: 3, y: 0 },
      R3: { x: 3, y: 6 },
    };

    let robots: RobotState[] = Object.keys(goals).map((id) =>
      makeRobot({ id, position: starts[id], path: [], priority: 0 })
    );
    const parked = new Set<string>(); // reached its real goal — done, out of contention

    const wonDoorway = new Set<string>();
    for (let tick = 0; tick < 60 && wonDoorway.size < robots.length; tick++) {
      const world = makeWorld(map, robots);

      // Real replanning (like engine.ts): get a fresh A* route whenever a
      // robot has no active route and hasn't reached its actual goal yet —
      // including recovery after being pushed off a prior route, which is
      // exactly what a real pushed-aside robot needs to eventually finish.
      robots = robots.map((r) => {
        if (parked.has(r.id)) return r;
        if (r.path.length > 1) return r;
        const result = planPath(r.position, goals[r.id], world);
        return result.found ? { ...r, path: result.path } : r;
      });

      const { moves } = resolvePIBT(robots, world);

      for (const m of moves) {
        if (eq(m.to, doorway)) wonDoorway.add(m.robotId);
      }

      robots = robots.map((r) => {
        if (parked.has(r.id)) return r;
        const m = findMove(moves, r.id);
        const moved = !eq(m.to, m.from);
        if (!moved) return { ...r, priority: r.priority + 1 };

        const followedPlan = r.path.length > 1 && eq(r.path[1], m.to);
        const path = followedPlan ? r.path.slice(1) : [];
        if (eq(m.to, goals[r.id])) parked.add(r.id); // reached its real goal
        return { ...r, position: m.to, priority: followedPlan ? r.priority : 0, path };
      });
    }

    expect(wonDoorway.size).toBe(robots.length);
  });
});

describe("PIBT: determinism at scale", () => {
  it("a large random world resolves identically across 20 repeated calls", () => {
    const rand = mulberry32(2718);
    const map = createWarehouseMap();
    const open = map.cells.filter((c) => !c.blocked).map((c) => c.position);
    const used = new Set<string>();
    const robots: RobotState[] = [];

    for (let i = 0; i < 50; i++) {
      let pos: Position;
      let key: string;
      do {
        pos = open[Math.floor(rand() * open.length)];
        key = `${pos.x},${pos.y}`;
      } while (used.has(key));
      used.add(key);

      const dirs: Position[] = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
      const dir = dirs[Math.floor(rand() * dirs.length)];
      robots.push(
        makeRobot({
          id: `R${i}`,
          position: pos,
          path: [pos, { x: pos.x + dir.x, y: pos.y + dir.y }],
          priority: Math.floor(rand() * 5),
        })
      );
    }

    const world = makeWorld(map, robots);
    const first = resolvePIBT(robots, world);
    for (let i = 0; i < 20; i++) {
      expect(resolvePIBT(robots, world)).toEqual(first);
    }
  });
});

describe("PIBT: large-scale property invariants (20,000 seeded random trials)", () => {
  it("never violates any safety invariant across 20,000 varied small-to-medium random worlds", () => {
    const rand = mulberry32(4242);
    const directions: Position[] = [
      { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
    ];

    for (let trial = 0; trial < 20000; trial++) {
      const width = 3 + Math.floor(rand() * 8);
      const height = 3 + Math.floor(rand() * 8);
      const blockedCount = Math.floor(rand() * (width * height) / 4);

      const blocked: Position[] = [];
      for (let i = 0; i < blockedCount; i++) {
        blocked.push({ x: Math.floor(rand() * width), y: Math.floor(rand() * height) });
      }
      const blockedSet = new Set(blocked.map((p) => `${p.x},${p.y}`));
      const map: WarehouseMap = makeMap(width, height, blocked);

      const robotCount = 1 + Math.floor(rand() * 8);
      const used = new Set<string>();
      const robots: RobotState[] = [];

      for (let i = 0; i < robotCount; i++) {
        let pos: Position = { x: 0, y: 0 };
        let key = "";
        let placed = false;
        for (let attempts = 0; attempts < 30 && !placed; attempts++) {
          pos = { x: Math.floor(rand() * width), y: Math.floor(rand() * height) };
          key = `${pos.x},${pos.y}`;
          if (!blockedSet.has(key) && !used.has(key)) placed = true;
        }
        if (!placed) continue;
        used.add(key);

        // occasionally malform the path on purpose (jump, off-grid,
        // pointing at a wall) to exercise the safety net at scale too
        const malform = rand() < 0.15;
        const dir = directions[Math.floor(rand() * directions.length)];
        const step = malform
          ? { x: pos.x + dir.x * (1 + Math.floor(rand() * 3)), y: pos.y + dir.y * (1 + Math.floor(rand() * 3)) }
          : { x: pos.x + dir.x, y: pos.y + dir.y };

        robots.push(
          makeRobot({
            id: `R${i}`,
            position: pos,
            path: rand() < 0.2 ? [] : [pos, step],
            priority: Math.floor(rand() * 4),
            status: rand() < 0.05 ? "failed" : "moving",
          })
        );
      }
      if (robots.length === 0) continue;

      const world = makeWorld(map, robots);
      const { moves } = resolvePIBT(robots, world);

      expect(moves.length, `trial ${trial}`).toBe(robots.length);
      expect(new Set(moves.map((m) => m.robotId)).size, `trial ${trial}`).toBe(robots.length);

      for (const move of moves) {
        expect(move.to.x, `trial ${trial}`).toBeGreaterThanOrEqual(0);
        expect(move.to.x, `trial ${trial}`).toBeLessThan(width);
        expect(move.to.y, `trial ${trial}`).toBeGreaterThanOrEqual(0);
        expect(move.to.y, `trial ${trial}`).toBeLessThan(height);
        expect(blockedSet.has(`${move.to.x},${move.to.y}`), `trial ${trial}`).toBe(false);
        const dist = Math.abs(move.to.x - move.from.x) + Math.abs(move.to.y - move.from.y);
        expect(dist, `trial ${trial}: moved more than 1 cell`).toBeLessThanOrEqual(1);
      }

      const destKeys = moves.map((m) => `${m.to.x},${m.to.y}`);
      expect(new Set(destKeys).size, `trial ${trial}: duplicate destination`).toBe(destKeys.length);

      for (const a of moves) {
        for (const b of moves) {
          if (a.robotId === b.robotId) continue;
          const swapped = eq(a.to, b.from) && eq(b.to, a.from);
          expect(swapped, `trial ${trial}: swap ${a.robotId}/${b.robotId}`).toBe(false);
        }
        // a failed robot must never move
        const robot = robots.find((r) => r.id === a.robotId)!;
        if (robot.status === "failed") {
          expect(eq(a.to, a.from), `trial ${trial}: failed robot ${a.robotId} moved`).toBe(true);
        }
      }
    }
  }, 30000);
});
