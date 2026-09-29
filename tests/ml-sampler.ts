import {
  applyMoves, replanAll, resolveStopAndWait, withCongestion, WAIT_REPLAN_THRESHOLD,
} from "../src/core/bench/stopwait";
import { manhattanDistance, positionsEqual } from "../src/core/map/graph";
import { extractFeatures, type FeatureContext } from "../src/core/ml/features";
import type { Sample } from "../src/core/ml/predictor";
import type { WorldState, RobotState, Task, WarehouseMap } from "../src/core/types";
import { ALL_BAYS } from "./ml-scenarios";

// Fixed before training/evaluation. Confirmation spans two stall-replan windows.
export const HORIZON = 3;
export const CONFIRM_TICKS = 2 * WAIT_REPLAN_THRESHOLD;
export const COMM_RANGE = 3;

/** Offline labels may use the future; feature vectors must not. */
export function labelFutureSamples(
  rows: Omit<Sample, "y">[], onset: number | null, observedTicks: number, completed: boolean,
): Sample[] {
  return rows
    // Already-deadlocked states are detection, not prediction. Unobserved
    // futures at a timeout are censored, never silently labelled negative.
    .filter((s) => onset !== null ? s.tick < onset : completed || s.tick + HORIZON + CONFIRM_TICKS <= observedTicks)
    .map((s) => ({ ...s, y: onset !== null && onset > s.tick && onset <= s.tick + HORIZON ? 1 : 0 }));
}

export function collectRun(
  scenario: { map: WarehouseMap; robots: RobotState[]; tasks: Task[] },
  seed: number, maxTicks = 100,
  options: { bays?: ReadonlySet<string>; observe?: (ctx: FeatureContext) => number[] } = {},
) {
  let state: WorldState = {
    tick: 0, map: withCongestion(scenario.map, scenario.robots),
    robots: structuredClone(scenario.robots), tasks: structuredClone(scenario.tasks),
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
  const stalled = new Map<string, number>();
  const rows: Omit<Sample, "y">[] = [];
  let frozen = 0;
  let onset: number | null = null;
  let observedTicks = 0;
  for (let tick = 0; tick < maxTicks; tick++) {
    const routed = replanAll(state, state.robots, state.tasks, stalled);
    state = { ...state, robots: routed };
    // Fresh, range-limited peer broadcasts containing position and ONE intent.
    // No peer routes, future states, or global counters enter the features.
    for (const r of routed) {
      if (!r.currentTaskId || r.path.length < 2) continue;
      const peers = routed.filter((p) => p.id !== r.id && manhattanDistance(r.position, p.position) <= COMM_RANGE)
        .map((p) => ({ id: p.id, position: p.position, intent: p.path[1] ?? null,
          priority: p.priority, docked: false, seq: tick, lastSeenTick: tick }));
      const local = { id: r.id, position: r.position, path: r.path, priority: r.priority, docked: false, seq: tick };
      const ctx = { local, peers, map: state.map,
        bays: options.bays ?? ALL_BAYS, lastStepAsideTick: -1, currentTick: tick };
      rows.push({ seed, tick, x: options.observe ? options.observe(ctx) : extractFeatures(ctx) });
    }
    const { moves } = resolveStopAndWait(routed, state);
    for (const m of moves) {
      stalled.set(m.robotId, positionsEqual(m.from, m.to) ? (stalled.get(m.robotId) ?? 0) + 1 : 0);
    }
    const next = applyMoves(routed, state.tasks, moves);
    // Pickup/completion transitions are progress too: the pickup-only first
    // tick must never be mistaken for the beginning of a deadlock.
    const taskProgress = next.tasks.some((t, i) => t.status !== state.tasks[i].status);
    const moved = moves.some((m) => !positionsEqual(m.from, m.to));
    const completed = next.tasks.every((t) => t.status === "completed");
    frozen = !completed && !taskProgress && !moved ? frozen + 1 : 0;
    state = { ...state, ...next, tick: tick + 1, map: withCongestion(state.map, next.robots) };
    observedTicks = tick + 1;
    if (frozen >= CONFIRM_TICKS) {
      onset = tick - CONFIRM_TICKS + 1;
      break;
    }
    if (completed) break;
  }
  const completed = state.tasks.filter((t) => t.status === "completed").length;
  return {
    samples: labelFutureSamples(rows, onset, observedTicks, completed === state.tasks.length),
    onset, observedTicks, completed, total: state.tasks.length,
  };
}
