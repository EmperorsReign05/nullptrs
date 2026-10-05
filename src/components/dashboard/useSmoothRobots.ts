'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Position, RobotState } from '@/core/types';

export const TICK_MS = 250;
// The runtime retains eight complete movement intervals.
export const MAX_STEP_MS = TICK_MS * 8;
export type Pose = Record<string, Position>;
export type MotionFrame = { tick: number; positions: Pose };
export type SmoothState = {
  from: Pose;
  to: Pose;
  startedAt: number;
  durationMs: number;
  /** Actual committed cell positions, including waits and turns. */
  frames?: { at: number; pose: Pose }[];
};

export const poseOf = (robots: readonly RobotState[]): Pose =>
  Object.fromEntries(robots.map(r => [r.id, { ...r.position }]));

const samePose = (a: Pose, b: Pose) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(b).every(id => a[id]?.x === b[id].x && a[id]?.y === b[id].y);

export function initialSmooth(robots: readonly RobotState[], now: number): SmoothState {
  const pose = poseOf(robots);
  return { from: pose, to: pose, startedAt: now, durationMs: 0 };
}

export function advanceSmooth(
  state: SmoothState,
  robots: readonly RobotState[],
  tick: number,
  previousTick: number | null,
  now: number,
  history?: readonly MotionFrame[],
): SmoothState {
  const next = poseOf(robots);
  // A restart is a new world, not a physical trip back to the seed positions.
  if (previousTick === null || tick < previousTick ||
      Object.keys(next).some(id => !state.to[id]) ||
      Object.keys(next).length !== Object.keys(state.to).length) return initialSmooth(robots, now);
  const steps = tick - previousTick;
  if (samePose(state.to, next) && !history) return state;

  const committed = history?.filter(f => f.tick > previousTick && f.tick <= tick);
  let targets: Pose[];
  if (committed && committed.length === steps && committed.every((f, i) => f.tick === previousTick + i + 1)) {
    targets = committed.map(f => f.positions);
  } else {
    // Older runtimes have no movement history. Animate only a known adjacent
    // step; never invent a diagonal or a multi-cell shortcut through a rack.
    if (samePose(state.to, next)) return state;
    if (Object.keys(next).some(id => Math.abs(next[id].x - state.to[id].x) + Math.abs(next[id].y - state.to[id].y) > 1)) {
      return initialSmooth(robots, now);
    }
    targets = [next];
  }
  if (!targets.length) return state;
  // An idle fleet has nothing to animate, even though ticks keep arriving.
  if (samePose(state.to, next) && targets.every(pose => samePose(state.to, pose))) return state;
  // Finish the current segment before appending new steps. Restarting a line
  // from the painted position to a new endpoint used to cut every corner.
  const from = sampleSmooth(state, now);
  const frames = state.frames?.filter(f => f.at > now) ?? [];
  let at = frames.at(-1)?.at ?? now;
  let last = frames.at(-1)?.pose ?? from;
  for (const pose of targets) {
    const valid = Object.keys(next).every(id => pose[id] && last[id] &&
      Math.abs(pose[id].x - last[id].x) + Math.abs(pose[id].y - last[id].y) <= 1 + 1e-6);
    if (!valid) return initialSmooth(robots, now);
    at += TICK_MS;
    frames.push({ at, pose });
    last = pose;
  }
  return { from, to: next, startedAt: now, durationMs: at - now, frames };
}

export function sampleSmooth(state: SmoothState, now: number): Pose {
  let a = state.from;
  let start = state.startedAt;
  for (const frame of state.frames ?? [{ at: start + state.durationMs, pose: state.to }]) {
    if (now >= frame.at) { a = frame.pose; start = frame.at; continue; }
    const t = Math.max(0, Math.min(1, (now - start) / (frame.at - start)));
    return Object.fromEntries(Object.keys(frame.pose).map(id => {
      const from = a[id] ?? frame.pose[id], to = frame.pose[id];
      return [id, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }];
    }));
  }
  return state.to;
}

export function useSmoothRobots(robots: readonly RobotState[], tick: number, history?: readonly MotionFrame[], runtimeId?: string): Pose {
  const [pose, setPose] = useState<Pose>(() => poseOf(robots));
  const smooth = useRef<SmoothState | null>(null);
  const onScreenTick = useRef<number | null>(null);
  const onScreenRuntime = useRef<string | undefined>(undefined);
  const frame = useRef<number | null>(null);
  const latest = useRef({ robots, tick, history, runtimeId });
  const pending = useRef(true);

  const pump = useCallback(function step(): void {
    frame.current = null;
    const now = performance.now();
    const next = latest.current;
    if (pending.current) {
      if (!smooth.current || next.runtimeId !== onScreenRuntime.current) {
        smooth.current = initialSmooth(next.robots, now);
      } else {
        smooth.current = advanceSmooth(smooth.current, next.robots, next.tick, onScreenTick.current, now, next.history);
      }
      onScreenTick.current = next.tick;
      onScreenRuntime.current = next.runtimeId;
      pending.current = false;
    }
    if (!smooth.current) return;
    const painted = sampleSmooth(smooth.current, now);
    setPose(previous => samePose(previous, painted) ? previous : painted);
    if (now < smooth.current.startedAt + smooth.current.durationMs) frame.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    latest.current = { robots, tick, history, runtimeId };
    pending.current = true;
    if (frame.current === null) frame.current = requestAnimationFrame(pump);
  }, [robots, tick, history, runtimeId, pump]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  return pose;
}
