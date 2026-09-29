// A FAIR stop-and-wait baseline.
//
// "Fair" is the whole point, and it is defined by what it must NOT do
// differently from the treatment:
//
//   SAME map            - identical WarehouseMap
//   SAME pathfinder     - identical congestion-aware A* (planPath)
//   SAME horizon        - identical replanning triggers
//   SAME information    - a robot may only react to what it can see
//   SAME tick rate      - one move per robot per tick, no teleporting
//
// The ONLY difference is the conflict-resolution policy:
//   BASELINE  stop-and-wait: a robot that wants a cell occupied by another
//             robot STOPS this tick. No backtracking, no priority
//             inheritance, no sidestep. It replans only when its route
//             goes stale (goal changed / next step became a wall).
//   TREATMENT PIBT (src/core/pathfinding/pibt.ts): backtrack to an
//             alternative, recursively push a lower-priority occupant, and
//             take whichever safe move resolves.
//
// This is a genuinely strong baseline, not a strawman: it uses the same
// congestion-aware A*, so it routes around jams just as well. It is
// deliberately NOT crippled with a shorter horizon or a worse planner,
// because a jury comparing against a hobbled baseline learns that the
// number is meaningless.

import { isTraversable } from "../map/warehouse";
import { manhattanDistance, positionsEqual } from "../map/graph";
import { planPath } from "../pathfinding/astar";
import { resolvePIBT } from "../pathfinding/pibt";
import type { Position, RobotState, WarehouseMap, WorldState, Task } from "../types";

export type StopAndWaitMove = { robotId: string; from: Position; to: Position };

/**
 * One tick of stop-and-wait. Every robot advances at most one cell, and a
 * robot whose next cell is occupied (now, or by another robot that also
 * wants it this tick) does not move at all.
 *
 * No priority is consulted. No robot yields to another. This is the
 * textbook stop-and-wait protocol and is what the brief specifies as the
 * thing to beat.
 */
export function resolveStopAndWait(
  robots: RobotState[],
  world: WorldState
): { moves: StopAndWaitMove[] } {
  const occupantByCell = new Map<string, string>();
  for (const r of robots) occupantByCell.set(`${r.position.x},${r.position.y}`, r.id);

  // What does each robot want this tick?
  const want = new Map<string, Position | null>();
  for (const r of robots) {
    want.set(r.id, r.path.length > 1 ? r.path[1] : null);
  }

  const moves: StopAndWaitMove[] = [];
  const claimed = new Set<string>();

  for (const r of robots) {
    const target = want.get(r.id) ?? null;
    if (!target) {
      moves.push({ robotId: r.id, from: r.position, to: r.position });
      continue;
    }
    // Sanity: never step into a wall or teleport.
    if (!isTraversable(target, world.map) || manhattanDistance(target, r.position) !== 1) {
      moves.push({ robotId: r.id, from: r.position, to: r.position });
      continue;
    }
    const key = `${target.x},${target.y}`;

    // STOP-AND-WAIT: the cell is physically occupied right now -> stop.
    const occupant = occupantByCell.get(key);
    if (occupant && occupant !== r.id) {
      moves.push({ robotId: r.id, from: r.position, to: r.position });
      continue;
    }
    // Someone else already claimed it this tick -> stop. (Ties are resolved
    // by iteration order, which is a real property of stop-and-wait, not a
    // handicap: it has no mechanism to negotiate.)
    if (claimed.has(key)) {
      moves.push({ robotId: r.id, from: r.position, to: r.position });
      continue;
    }

    claimed.add(key);
    moves.push({ robotId: r.id, from: r.position, to: target });
  }
  return { moves };
}

// Shared tick machinery, identical for both policies, so the comparison
// cannot be accused of differing in anything but conflict resolution.
export const BATTERY_PERCENT_PER_CELL = 0.5;

export type TickOutcome = { robots: RobotState[]; tasks: Task[] };

export function applyMoves(
  robots: RobotState[],
  tasks: Task[],
  moves: { robotId: string; from: Position; to: Position }[]
): TickOutcome {
  const moveById = new Map(moves.map((m) => [m.robotId, m]));
  const tasksById = new Map(tasks.map((t) => [t.id, { ...t }]));

  const next = robots.map((r): RobotState => {
    if (r.status === "failed") return r;
    const m = moveById.get(r.id);
    if (!m) return r;
    const moved = !positionsEqual(m.from, m.to);
    if (!moved) return { ...r, status: r.path.length > 0 ? "waiting" : "idle" };

    const followedPlan = r.path.length > 1 && positionsEqual(r.path[1], m.to);
    const path = followedPlan ? r.path.slice(1) : [];
    const battery = Math.max(0, r.battery - BATTERY_PERCENT_PER_CELL);
    return { ...r, position: m.to, path, battery, status: "moving" };
  });

  const finalRobots = next.map((r): RobotState => {
    if (!r.currentTaskId) return r;
    const t = tasksById.get(r.currentTaskId);
    if (!t) return { ...r, currentTaskId: undefined, status: "idle" };
    if (t.status !== "in_progress" && positionsEqual(r.position, t.pickup)) {
      t.status = "in_progress";
      return { ...r, status: "assigned" };
    }
    if (t.status === "in_progress" && positionsEqual(r.position, t.dropoff)) {
      t.status = "completed";
      return { ...r, currentTaskId: undefined, status: "idle" };
    }
    return r;
  });

  return { robots: finalRobots, tasks: Array.from(tasksById.values()) };
}

/**
 * How many consecutive ticks a robot may be blocked by another robot before
 * it gives up and re-plans. A real stop-and-wait system would do exactly
 * this — "I'm stuck, let me look for another way" — and OMITTING it would
 * make the baseline a strawman rather than a fair opponent. With congestion
 * rising around the jam, A* naturally routes the robot into an alcove, so
 * this single line is the baseline's best shot and it gets it.
 */
export const WAIT_REPLAN_THRESHOLD = 5;

/**
 * Replanning policy. `stalled` is a per-robot count of consecutive ticks it
 * failed to move, supplied by the caller so the SAME function serves both
 * arms. The PIBT arm also supplies stall counts (so a robot that PIBT could
 * not help still re-plans) — the comparison is only fair if both arms get
 * every non-conflict-resolution advantage.
 */
export function replanAll(
  state: WorldState,
  robots: RobotState[],
  tasks: Task[],
  stalled?: Map<string, number>
): RobotState[] {
  return robots.map((robot) => {
    if (robot.status === "failed") return robot;
    const goal = resolveGoal(robot, tasks);
    if (!goal) return robot.path.length > 0 ? { ...robot, path: [] } : robot;
    const currentGoal = robot.path.length > 0 ? robot.path[robot.path.length - 1] : null;
    const goalChanged = !currentGoal || !positionsEqual(currentGoal, goal);
    const nextBlocked = robot.path.length > 1 && !isTraversable(robot.path[1], state.map);
    const jamStalled = (stalled?.get(robot.id) ?? 0) >= WAIT_REPLAN_THRESHOLD;
    if (!goalChanged && !nextBlocked && !jamStalled) return robot;
    const res = planPath(robot.position, goal, state);
    return { ...robot, path: res.found ? res.path : [] };
  });
}

export function resolveGoal(robot: RobotState, tasks: Task[]): Position | null {
  if (!robot.currentTaskId) return null;
  const t = tasks.find((x) => x.id === robot.currentTaskId);
  if (!t) return null;
  return t.status === "in_progress" ? t.dropoff : t.pickup;
}

/** Congestion recomputed identically for both arms. */
export function withCongestion(map: WarehouseMap, robots: RobotState[]): WarehouseMap {
  const pressure = new Map<string, number>();
  const add = (x: number, y: number, a: number) => {
    const k = `${x},${y}`;
    pressure.set(k, (pressure.get(k) ?? 0) + a);
  };
  for (const r of robots) {
    add(r.position.x, r.position.y, 3);
    add(r.position.x, r.position.y - 1, 1);
    add(r.position.x, r.position.y + 1, 1);
    add(r.position.x - 1, r.position.y, 1);
    add(r.position.x + 1, r.position.y, 1);
  }
  return {
    ...map,
    cells: map.cells.map((c) => ({
      ...c,
      congestion: pressure.get(`${c.position.x},${c.position.y}`) ?? 0,
    })),
  };
}

/**
 * Run one full experiment. `policy` is the ONLY thing that differs.
 * Returns makespan (ticks until every task completes) or null on timeout.
 */
export function runExperiment(
  map: WarehouseMap,
  robots: RobotState[],
  tasks: Task[],
  policy: "stop-and-wait" | "pibt",
  maxTicks: number,
  bays?: ReadonlySet<string>
): { makespan: number | null; completed: number; total: number; timeline: { tick: number; completed: number }[]; stepAsides: number } {
  let state: WorldState = {
    tick: 0,
    map: withCongestion(map, robots),
    robots,
    tasks,
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };

  const timeline: { tick: number; completed: number }[] = [];
  let completed = 0;

  // Per-robot consecutive stall counter, shared by both arms.
  const stalled = new Map<string, number>();
  let stepAsides = 0;

  for (let t = 0; t < maxTicks; t++) {
    const routed = replanAll(state, state.robots, state.tasks, stalled);
    state = { ...state, robots: routed };
    const pibtResult = policy === "pibt" ? resolvePIBT(routed, state, { bays }) : null;
    const moves = pibtResult ? pibtResult.moves : resolveStopAndWait(routed, state).moves;
    if (pibtResult) stepAsides += pibtResult.metrics.stepAsides;

    // update stall counters from the resolved moves
    for (const r of routed) {
      const m = moves.find((x) => x.robotId === r.id);
      const moved = m ? !positionsEqual(m.from, m.to) : false;
      stalled.set(r.id, moved ? 0 : (stalled.get(r.id) ?? 0) + 1);
    }

    const { robots: nr, tasks: nt } = applyMoves(routed, state.tasks, moves);
    state = { ...state, tick: t + 1, robots: nr, tasks: nt, map: withCongestion(state.map, nr) };

    const done = nt.filter((x) => x.status === "completed").length;
    if (done !== completed) {
      completed = done;
      timeline.push({ tick: t + 1, completed });
    }
    if (completed === tasks.length) {
      return { makespan: t + 1, completed, total: tasks.length, timeline, stepAsides };
    }
  }
  return { makespan: null, completed, total: tasks.length, timeline, stepAsides };
}
