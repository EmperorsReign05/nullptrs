// Robot motion playback for the dashboard.
//
// WHY THIS IS NOT "INTERPOLATE BETWEEN THE LAST TWO SNAPSHOTS".
// The previous player animated every committed cell in exactly 250 ms and then
// waited for the next tick. The server's real cadence is never exactly 250 ms
// (it was measured at 257-263 ms), so every cell ended in a stop: about three
// visible hitches a second at constant fleet speed, before any network jitter.
//
// This player treats telemetry the way a game client treats server snapshots:
//
//   * A PLAYBACK CLOCK runs a small, adaptive delay behind the newest tick, so
//     there is normally already a committed frame on both sides of the painted
//     instant. The delay grows with measured arrival jitter.
//   * The clock's RATE is steered gently toward its target instead of being
//     snapped, and the tick period is measured from arrivals rather than
//     assumed, so a server that runs at 260 ms is played at 260 ms.
//   * When data is late anyway (slow server, WAN stall), robots PREDICT along
//     their planned route, at most part of one cell, decelerating as they go,
//     and never into a cell another robot holds or claims, or a blocked cell.
//     The planned route is intent, not a commitment, so prediction is kept
//     short and corrections are blended rather than snapped.
//   * Every painted position passes through a critically damped follower, so
//     starts, stops, turns and corrections have no velocity discontinuity.
//
// Status, battery, ownership and the safety counters are never predicted: only
// where a marker is drawn.

import type { Position, RobotState } from '@/core/types';

export const NOMINAL_TICK_MS = 250;
export type Pose = Record<string, Position>;
export type MotionFrame = { tick: number; positions: Pose };

export type MotionInput = {
  robots: readonly RobotState[];
  /** Server tick of `robots`. Omitted by callers without a tick (the central simulator). */
  tick?: number;
  /** Committed positions for recent ticks, so skipped polls replay every cell. */
  history?: readonly MotionFrame[];
  /** A different id is a different world: never animate between two worlds. */
  runtimeId?: string;
  /** False while paused or disconnected: play out what is known, then stop. */
  running?: boolean;
  /** Blocked cells as "x,y", which prediction must never enter. */
  blocked?: ReadonlySet<string>;
};

/** How many ticks of committed frames are retained for playback. */
const FRAME_RETENTION = 32;
/**
 * Beyond this playback error the clock is resynchronised (a cut) instead of
 * steered. Within it, a stall is played out fast-forwarded, every committed cell
 * shown, because the server retains 24 ticks of history.
 */
const RESYNC_TICKS = 20;
/** Prediction approaches, and never reaches, this fraction of a cell. */
const PREDICTION_HORIZON = 0.55;
/** Follower time constant. Small enough to read as direct, large enough to round a turn. */
const SMOOTH_SECONDS = 0.075;
/** A painted jump larger than this many cells is a teleport, not motion. */
const SNAP_CELLS = 2.5;

const key = (p: Position) => `${p.x},${p.y}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const poseOf = (robots: readonly RobotState[]): Pose =>
  Object.fromEntries(robots.map(r => [r.id, { x: r.position.x, y: r.position.y }]));

export class MotionPlayer {
  private frames = new Map<number, Pose>();
  private lastTick: number | null = null;
  /**
   * A phase-locked estimate of the server's tick at a given instant:
   * clockTick at clockAt, advancing at one tick per period. Each arrival nudges
   * it by a fraction of its error instead of resetting it, so the sawtooth of
   * poll timing against server timing never reaches the playback speed.
   */
  private clockTick = 0;
  private clockAt = 0;
  private arrivals: { tick: number; at: number }[] = [];
  private periodMs = NOMINAL_TICK_MS;
  private jitterTicks = 0.3;
  private renderTick = 0;
  private lastNow: number | null = null;
  private runtimeId: string | undefined;
  private running = true;
  private ids: string[] = [];
  private paths: Record<string, Position[]> = {};
  /** The single cell each robot may be drawn creeping toward while data is late. */
  private predictTo: Record<string, Position | undefined> = {};
  private display: Pose = {};
  private velocity: Pose = {};
  private syntheticTick = 0;
  private lastRobots: readonly RobotState[] | null = null;
  /** Increments whenever the world was replaced; the view uses it to cross-fade. */
  resets = 0;

  /** Feed one telemetry frame. Idempotent for repeated or stale frames. */
  ingest(input: MotionInput, now: number): void {
    const robots = input.robots;
    // Callers without a server tick advance one tick per new robots array.
    let tick = input.tick;
    if (tick === undefined) {
      if (robots !== this.lastRobots) this.syntheticTick++;
      tick = this.syntheticTick;
    }
    this.lastRobots = robots;
    const running = input.running ?? true;
    if (running && !this.running) {
      // Resuming from a pause: the last arrival is stale, so re-anchor the clock
      // rather than let it read the pause as a huge backlog to catch up on.
      this.clockTick = this.lastTick ?? 0;
      this.clockAt = now;
      this.arrivals = this.lastTick === null ? [] : [{ tick: this.lastTick, at: now }];
    }
    this.running = running;

    const ids = robots.map(r => r.id);
    const sameWorld = this.lastTick !== null && input.runtimeId === this.runtimeId &&
      ids.length === this.ids.length && ids.every((id, i) => id === this.ids[i]);
    if (!sameWorld || (input.runtimeId === undefined && tick < this.lastTick!)) {
      this.reset(robots, tick, input.runtimeId, now);
    } else if (tick < this.lastTick!) {
      // An older answer that lost a race to a newer one. Nothing to learn.
      return;
    }

    const previousTick = this.lastTick!;
    for (const frame of input.history ?? []) {
      if (frame.tick > previousTick && frame.tick <= tick && ids.every(id => frame.positions[id])) {
        this.frames.set(frame.tick, frame.positions);
      }
    }
    this.frames.set(tick, poseOf(robots));
    if (tick > previousTick) this.observeArrival(previousTick, tick, now);
    for (const t of this.frames.keys()) if (t < tick - FRAME_RETENTION) this.frames.delete(t);

    this.paths = Object.fromEntries(robots.map(r => [r.id, r.path ?? []]));
    this.planPrediction(robots, input.blocked);
  }

  /** Advance the playback clock to `now` and return where to paint each robot. */
  sample(now: number): Pose {
    const dt = this.lastNow === null ? 0 : clamp(now - this.lastNow, 0, 250);
    this.lastNow = now;
    if (this.lastTick === null) return this.display;

    const delay = clamp(1 + 2.5 * this.jitterTicks, 1.15, 4.5);
    const ceiling = this.lastTick + 1.5;
    const target = this.running
      ? Math.min(ceiling, this.clockTick + (now - this.clockAt) / this.periodMs - delay)
      : this.lastTick;
    const error = target - this.renderTick;
    if (Math.abs(error) > RESYNC_TICKS) {
      this.renderTick = target;
    } else {
      const rate = clamp(1 + 0.35 * error, 0.75, 1.75);
      this.renderTick += (dt / this.periodMs) * rate;
      if (!this.running) this.renderTick = Math.min(this.renderTick, target);
      this.renderTick = Math.min(this.renderTick, ceiling);
    }

    const raw = this.rawPose(this.renderTick);
    const seconds = dt / 1000;
    for (const id of this.ids) {
      const goal = raw[id];
      if (!goal) continue;
      const at = this.display[id];
      if (!at || Math.abs(goal.x - at.x) + Math.abs(goal.y - at.y) > SNAP_CELLS) {
        this.display[id] = { ...goal };
        this.velocity[id] = { x: 0, y: 0 };
        continue;
      }
      const v = this.velocity[id] ?? { x: 0, y: 0 };
      const [x, vx] = follow(at.x, goal.x, v.x, seconds);
      const [y, vy] = follow(at.y, goal.y, v.y, seconds);
      this.display[id] = { x, y };
      this.velocity[id] = { x: vx, y: vy };
    }
    return this.display;
  }

  /** Painted velocity in cells per second, for the heading arrow. */
  velocityOf(id: string): Position { return this.velocity[id] ?? { x: 0, y: 0 }; }

  /**
   * The route still ahead of a painted robot: committed cells it has not been
   * drawn through yet, then its planned path. Drawing the path from the
   * server's position instead left it visibly detached from a marker that
   * plays slightly behind.
   */
  routeOf(id: string): Position[] {
    if (this.lastTick === null) return [];
    const points: Position[] = [];
    const push = (p: Position | undefined) => {
      const last = points.at(-1);
      if (p && (!last || last.x !== p.x || last.y !== p.y)) points.push(p);
    };
    for (let t = Math.floor(this.renderTick) + 1; t <= this.lastTick; t++) push(this.frames.get(t)?.[id]);
    const path = this.paths[id] ?? [];
    const current = this.frames.get(this.lastTick)?.[id];
    const start = current && path[0] && path[0].x === current.x && path[0].y === current.y ? 1 : 0;
    if (path.length > start) for (const p of path.slice(start)) push(p);
    return points;
  }

  /** Current measured tick period, exposed for diagnostics and tests. */
  get tickPeriodMs(): number { return this.periodMs; }
  get playbackTick(): number { return this.renderTick; }

  private reset(robots: readonly RobotState[], tick: number, runtimeId: string | undefined, now: number) {
    const hadWorld = this.lastTick !== null;
    this.frames.clear();
    this.arrivals = [{ tick, at: now }];
    this.lastTick = tick;
    this.clockTick = tick;
    this.clockAt = now;
    // Start just behind the newest frame, where playback normally runs.
    this.renderTick = tick - 1.15;
    this.runtimeId = runtimeId;
    this.ids = robots.map(r => r.id);
    this.display = poseOf(robots);
    this.velocity = {};
    if (hadWorld) this.resets++;
  }

  private observeArrival(previousTick: number, tick: number, now: number) {
    // Jitter: how far the newest tick landed from where the clock expected it.
    const expected = this.clockTick + (now - this.clockAt) / this.periodMs;
    const error = tick - expected;
    this.lastTick = tick;
    if (!this.running || Math.abs(error) > 4) {
      this.clockTick = tick;
    } else {
      this.jitterTicks += 0.1 * (Math.min(3, Math.abs(error)) - this.jitterTicks);
      this.clockTick = expected + 0.15 * error;
    }
    this.clockAt = now;
    // Period: a slope over a window of arrivals, which averages out the beat
    // between the poll clock and the server clock. A pause breaks the window.
    if (!this.running) { this.arrivals = [{ tick, at: now }]; return; }
    this.arrivals.push({ tick, at: now });
    if (this.arrivals.length > 16) this.arrivals.shift();
    const first = this.arrivals[0];
    const span = tick - first.tick;
    if (span >= 4) {
      const measured = clamp((now - first.at) / span, 60, 4000);
      this.periodMs += 0.25 * (measured - this.periodMs);
    }
  }

  private planPrediction(robots: readonly RobotState[], blocked?: ReadonlySet<string>) {
    const occupied = new Set(robots.map(r => key(r.position)));
    const claimed = new Set<string>();
    this.predictTo = {};
    for (const r of robots) {
      if (r.status === 'failed') continue;
      const path = r.path ?? [];
      const start = path[0] && path[0].x === r.position.x && path[0].y === r.position.y ? 1 : 0;
      const next = path[start];
      if (!next || Math.abs(next.x - r.position.x) + Math.abs(next.y - r.position.y) !== 1) continue;
      const k = key(next);
      if (occupied.has(k) || claimed.has(k) || blocked?.has(k)) continue;
      claimed.add(k);
      this.predictTo[r.id] = next;
    }
  }

  /**
   * The newest frame at or before `t`. Before the oldest retained frame that is
   * the OLDEST frame: falling back to the newest one drew a diagonal from the
   * future straight across the racks right after every reset.
   */
  private frameAtOrBefore(t: number): Pose {
    let best: number | null = null;
    let oldest = Infinity;
    for (const k of this.frames.keys()) {
      if (k <= t && (best === null || k > best)) best = k;
      if (k < oldest) oldest = k;
    }
    return this.frames.get(best ?? oldest)!;
  }

  private rawPose(at: number): Pose {
    const last = this.lastTick!;
    const latest = this.frames.get(last)!;
    if (at >= last) {
      const s = at - last;
      const reach = this.running ? PREDICTION_HORIZON * (1 - Math.exp(-s / PREDICTION_HORIZON)) : 0;
      return Object.fromEntries(this.ids.map(id => {
        const from = latest[id], to = this.predictTo[id];
        if (!to || reach <= 0) return [id, from];
        return [id, { x: from.x + (to.x - from.x) * reach, y: from.y + (to.y - from.y) * reach }];
      }));
    }
    const k = Math.floor(at);
    const a = this.frameAtOrBefore(k);
    const b = this.frames.get(k + 1) ?? this.frameAtOrBefore(k + 1);
    const f = at - k;
    return Object.fromEntries(this.ids.map(id => {
      const p = a[id] ?? latest[id], q = b[id] ?? latest[id];
      return [id, { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f }];
    }));
  }
}

/** Critically damped follower (the classic SmoothDamp). Returns [position, velocity]. */
function follow(current: number, target: number, velocity: number, dt: number): [number, number] {
  if (dt <= 0) return [current, velocity];
  const omega = 2 / SMOOTH_SECONDS;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  const v = (velocity - omega * temp) * decay;
  const out = target + (change + temp) * decay;
  if (Math.abs(out - target) < 1e-4 && Math.abs(v) < 1e-3) return [target, 0];
  return [out, v];
}
