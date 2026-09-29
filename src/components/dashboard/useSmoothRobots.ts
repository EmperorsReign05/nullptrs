'use client';

// Smooth robot motion, decoupled from poll timing.
//
// THE DEFECT THIS FIXES
// The runtime steps at 250 ms per tick. The dashboard polled at 500 ms PLUS the
// round trip, and scheduled the next poll only AFTER the previous one settled,
// so the effective period drifted. Each robot marker carried a 650 ms CSS
// transition. So a move representing two ticks of simulation (500 ms of sim
// time) was given a 650 ms transition that the next poll interrupted before it
// finished: every frame was a partial move restarted from wherever the last one
// got to. It read as "sometimes fast, sometimes slow", and a late poll showed a
// robot jumping two cells at once. None of that jitter existed in the
// simulation — it was invented by the renderer.
//
// THE FIX
// Poll as often as is useful, then reconstruct the motion on a local clock. When
// a snapshot arrives we know the robot was at cell A at tick T0 and cell B at
// tick T1, and that a tick is TICK_MS of wall clock, so the move is animated over
// exactly (T1 - T0) * TICK_MS — the true duration, whatever the packet latency
// was. A requestAnimationFrame loop drives it, so the browser paints at its own
// refresh rate and each robot crosses its cells at a constant speed.
//
// A snapshot arriving mid-move restarts the interpolation FROM WHATEVER IS
// CURRENTLY PAINTED, so a late packet corrects the position instead of snapping.
// The loop stops scheduling frames the moment everything has settled, so an idle
// fleet costs no re-renders.
//
// The reducer and sampler are pure and unit-tested (tests/smooth-robots.test.ts);
// this file is only the rAF plumbing around them.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Position, RobotState } from '@/core/types';

/** Wall-clock duration of one runtime tick. Must match fleet-service.ts. */
export const TICK_MS = 250;

/** Upper clamp on the animation duration, so a long stall (a paused runtime, a
 *  frozen serverless instance, a laptop waking from sleep) cannot turn a
 *  one-cell move into a ten-second glide. The lower end needs no clamp: `steps`
 *  is always at least 1, so the duration is never below one tick. */
export const MAX_STEP_MS = TICK_MS * 4;

export type Pose = Record<string, Position>;

export type SmoothState = {
  /** Where each robot is when this interpolation started. */
  from: Pose;
  /** Where each robot is heading. */
  to: Pose;
  /** Wall-clock ms at which this interpolation started. */
  startedAt: number;
  /** How long the whole interpolation should take. */
  durationMs: number;
};

export const poseOf = (robots: readonly RobotState[]): Pose =>
  Object.fromEntries(robots.map((r) => [r.id, { x: r.position.x, y: r.position.y }]));

const samePose = (a: Pose, b: Pose) =>
  Object.keys(b).every((id) => a[id] && a[id].x === b[id].x && a[id].y === b[id].y);

export function initialSmooth(robots: readonly RobotState[], now: number): SmoothState {
  const pose = poseOf(robots);
  return { from: pose, to: pose, startedAt: now, durationMs: TICK_MS };
}

/**
 * Fold a freshly received snapshot into the animation.
 *
 * `previousTick` is the tick currently believed to be on screen. The duration is
 * derived from the TICK DIFFERENCE, not from the wall-clock gap between packets,
 * because the wall-clock gap includes poll latency and network jitter and the
 * simulation does not care about either.
 */
export function advanceSmooth(
  state: SmoothState,
  robots: readonly RobotState[],
  tick: number,
  previousTick: number | null,
  now: number,
): SmoothState {
  const next = poseOf(robots);
  // Nothing moved: a duplicate packet, a paused runtime, or a tick in which every
  // robot was blocked. Hold still rather than replaying the animation.
  if (samePose(state.to, next)) return state;
  const steps = previousTick === null ? 1 : Math.max(1, tick - previousTick);
  return {
    // From what is CURRENTLY PAINTED, not from the previous target. A snapshot
    // that arrives mid-move used to snap the robot to the old target and then
    // animate again, which is a visible jump; sampling the live pose makes a late
    // packet correct the position instead.
    from: sampleSmooth(state, now),
    to: next,
    startedAt: now,
    durationMs: Math.min(MAX_STEP_MS, steps * TICK_MS),
  };
}

/** Position of every robot at wall-clock `now`. Pure. */
export function sampleSmooth(state: SmoothState, now: number): Pose {
  const t = state.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - state.startedAt) / state.durationMs));
  const out: Pose = {};
  for (const id of Object.keys(state.to)) {
    const a = state.from[id] ?? state.to[id];
    const b = state.to[id];
    out[id] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return out;
}

export function useSmoothRobots(robots: readonly RobotState[], tick: number): Pose {
  const [pose, setPose] = useState<Pose>(() => poseOf(robots));
  const smooth = useRef<SmoothState | null>(null);
  const onScreenTick = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef<{ robots: readonly RobotState[]; tick: number }>({ robots, tick });

  // Declared before the effect that schedules it, so the compiler can see the
  // dependency is a stable function rather than a value captured before it
  // exists. It reads only refs, so the empty dependency list is honest.
  const pump = useCallback(function step(): void {
    frame.current = null;
    const now = performance.now();
    const { robots: latestRobots, tick: latestTick } = latest.current;
    if (!smooth.current) smooth.current = initialSmooth(latestRobots, now);
    else if (latestTick !== onScreenTick.current) {
      smooth.current = advanceSmooth(smooth.current, latestRobots, latestTick, onScreenTick.current, now);
      onScreenTick.current = latestTick;
    }
    setPose(sampleSmooth(smooth.current, now));
    // Only keep painting while something is still moving, so an idle fleet costs
    // nothing.
    const t = (performance.now() - smooth.current.startedAt) / smooth.current.durationMs;
    if (t < 1) frame.current = requestAnimationFrame(step);
  }, []);

  // A new snapshot both updates the target and restarts the loop if it had
  // already wound down. Declared before the mount effect so on a poll commit the
  // target is always current before any frame is scheduled.
  useEffect(() => {
    latest.current = { robots, tick };
    if (frame.current === null) frame.current = requestAnimationFrame(pump);
  }, [robots, tick, pump]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  return pose;
}
