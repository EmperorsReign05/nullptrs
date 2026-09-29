import { describe, it, expect } from "vitest";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { mapFromOpen } from "../src/core/bench/scenarios";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import { latticeScenario } from "./ml-scenarios";
import { positionsEqual } from "../src/core/map/graph";
import type { Position, RobotState, Task } from "../src/core/types";

// Regression guards for two liveness defects and the safety defect they
// shared. Each of these was green-everywhere and globally fatal, which is why
// they are asserted directly rather than inferred from task completion.

const key = (p: Position) => `${p.x},${p.y}`;

function robot(id: string, at: Position, taskId?: string): RobotState {
  return {
    id, position: { ...at }, home: { ...at }, battery: 100, status: "assigned",
    model: ROBOT_MODELS[0], currentTaskId: taskId, path: [], priority: 0,
  };
}

function task(id: string, pickup: Position, dropoff: Position): Task {
  return { id, pickup: { ...pickup }, dropoff: { ...dropoff }, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: id };
}

/**
 * A single-file corridor with a parallel passing row, and one robot parked in
 * the middle of the corridor for the whole run.
 *
 * Congestion in this codebase is a SOFT A* cost — an occupied cell costs 4
 * against 1 for a free cell — so on a one-cell-wide corridor A* will happily
 * route straight through a stationary robot: going round costs more than the
 * 3-step penalty. The route it produces is then impossible, and no trigger in
 * replanAll notices (the goal has not moved, no cell in the route is a static
 * wall, the path is not a stub), so it is re-derived identically every tick and
 * the robot shuffles against the obstruction for the rest of the run.
 */
function corridorWithParkedRobot() {
  // Row 4 is the corridor. Row 2 is the only way round, reached via column 0
  // and column 6, so the detour is 4 cells longer than going through (3,4).
  const open: Position[] = [];
  for (let x = 0; x <= 6; x++) open.push({ x, y: 4 });
  for (let x = 0; x <= 6; x++) open.push({ x, y: 2 });
  open.push({ x: 0, y: 3 }, { x: 6, y: 3 });
  const map = mapFromOpen(open);
  const robots = [robot("AMR-01", { x: 1, y: 4 }, "T1"), robot("AMR-02", { x: 3, y: 4 })];
  const tasks = [task("T1", { x: 1, y: 4 }, { x: 5, y: 4 })];
  return { map, robots, tasks, parked: { x: 3, y: 4 }, goal: { x: 5, y: 4 } };
}

describe("DISTRIBUTED LIVENESS: the invariants that catch a stuck fleet", () => {
  it("routes around a robot that has parked in a single-file corridor", () => {
    const { map, robots, tasks, parked, goal } = corridorWithParkedRobot();
    const f = new DistributedFleet(map, robots, tasks, { commRange: 6 });
    let routeEverAvoidedParkedCell = false;
    for (let t = 0; t < 120; t++) {
      f["replanAll"](t);
      f["step"](t);
      f["applyMoves"](t);
      const path = f.getAgent("AMR-01")!.getLocal().path;
      if (path.length > 1 && !path.some((c) => positionsEqual(c, parked))) routeEverAvoidedParkedCell = true;
      if (tasks[0].status === "completed") break;
    }
    // The parked robot's cell must eventually be treated as impassable by the
    // mover's own planner. Before the fix this never happened and AMR-01 spent
    // the whole run oscillating between (1,4) and (2,4).
    expect(routeEverAvoidedParkedCell).toBe(true);
    expect(tasks[0].status).toBe("completed");
    expect(key(f.getRobots().find((r) => r.id === "AMR-01")!.position)).toBe(key(goal));
  }, 60000);

  it("decides exactly once per agent per tick, so arbitration judges the executed move", () => {
    // step() used to call decide() and then Agent.tick(), which called
    // decide() AGAIN. The second pass drained an already-drained inbox and so
    // read a peer set that earlier-iterated agents had already updated this
    // tick, which made the outcome depend on iteration order and let an agent
    // execute a move that commit-time arbitration had never seen. That was the
    // entire residual cell overlap.
    const sc = latticeScenario(1, 8, 17, 7);
    const f = new DistributedFleet(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), { commRange: 6 });
    const counts = new Map<string, number>();
    for (const agent of f["agents"].values()) {
      const orig = agent.decide.bind(agent);
      agent.decide = (tick: number) => {
        counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
        return orig(tick);
      };
    }
    f["replanAll"](0);
    f["step"](0);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    expect(counts.size).toBe(8);
  }, 60000);

  it("keeps path[0] equal to the agent's own cell on every tick, moved or not", () => {
    // This invariant was violated once already — the path was only sliced when
    // the agent moved, so after one stall path[0] stopped being the current
    // position and the fleet froze in a mutual standoff. Asserted per tick.
    for (const n of [4, 6, 8]) {
      const sc = latticeScenario(1, n, 3, 7);
      const f = new DistributedFleet(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), { commRange: 6 });
      for (let t = 0; t < 200; t++) {
        f["replanAll"](t);
        f["step"](t);
        f["applyMoves"](t);
        for (const r of f.getRobots()) {
          const l = f.getAgent(r.id)!.getLocal();
          expect(positionsEqual(l.path[0] ?? l.position, r.position)).toBe(true);
        }
      }
    }
  }, 600000);

  it("refuses to enter a cell a robot is physically standing on, on any candidate", () => {
    // The sensor gate only ever tested the PREFERRED cell, so an alternate
    // could be a cell a robot was standing on. Nothing downstream caught it:
    // the claim map only handles two agents both MOVING into one cell, and the
    // incumbent rule only defers when the incumbent is itself moving. Measured
    // at n=12 seed 60 as two robots stuck together on (3,2) for six ticks.
    // The seed range here deliberately extends well past the 8 seeds the safety
    // suite used: the original code was clean on seeds 1-8 and collided from
    // seed 9 onward.
    for (const n of [8, 10, 12, 14]) {
      let overlapTicks = 0;
      let ticks = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const sc = latticeScenario(1, n, seed, 7);
        const f = new DistributedFleet(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), { commRange: 6 });
        for (let t = 0; t < 400; t++) {
          f["replanAll"](t);
          f["step"](t);
          f["applyMoves"](t);
          ticks++;
          const cells = f.getRobots().map((r) => key(r.position));
          if (new Set(cells).size !== cells.length) overlapTicks++;
          if (f.getTasks().every((x) => x.status === "completed")) break;
        }
      }
      console.log(`n=${n}: overlap ${overlapTicks}/${ticks} over 40 seeds`);
      expect(overlapTicks).toBe(0);
    }
  }, 900000);
});
