import { describe, it, expect, vi } from 'vitest';
import { MotionPlayer, NOMINAL_TICK_MS as TICK_MS, type MotionFrame } from '../src/components/dashboard/motion';
import { getRobotColor } from '../src/components/dashboard/types';
import { FleetRuntime } from '../src/core/distributed/runtime';
import type { Position, RobotState } from '../src/core/types';

const robot = (id: string, x: number, y: number, path: Position[] = []): RobotState =>
  ({ id, position: { x, y }, path, status: 'moving' } as unknown as RobotState);

/** A robot driving a 40-cell loop at one cell per tick, with turns at every corner. */
const loop = (t: number): Position => {
  const s = ((t % 40) + 40) % 40, leg = Math.floor(s / 10), o = s % 10;
  return leg === 0 ? { x: o, y: 0 } : leg === 1 ? { x: 10, y: o } : leg === 2 ? { x: 10 - o, y: 10 } : { x: 0, y: 10 - o };
};
const history = (tick: number, at: (t: number) => Position): MotionFrame[] =>
  Array.from({ length: 9 }, (_, i) => tick - 8 + i).filter(t => t >= 0).map(t => ({ tick: t, positions: { A: at(t) } }));

/**
 * Drives a player with a server ticking every `periodMs` and a poller every
 * 250 ms with the given round-trip times, painting at 120 Hz. Returns the
 * painted positions after a warm-up.
 */
function play(periodMs: number, rtt: (i: number) => number, seconds = 30) {
  const p = new MotionPlayer();
  const arrivals: { at: number; tick: number }[] = [];
  for (let t = 0, i = 0; t < seconds * 1000; i++) {
    const r = rtt(i);
    arrivals.push({ at: t + r, tick: Math.floor((t + r / 2) / periodMs) });
    t += Math.max(250, r);
  }
  arrivals.sort((a, b) => a.at - b.at);
  const painted: { now: number; at: Position }[] = [];
  let next = 0;
  for (let now = 0; now < seconds * 1000; now += 1000 / 120) {
    while (next < arrivals.length && arrivals[next].at <= now) {
      const { tick } = arrivals[next++];
      const at = loop(tick);
      p.ingest({ robots: [robot('A', at.x, at.y, [at, loop(tick + 1), loop(tick + 2)])], tick, history: history(tick, loop), runtimeId: 'r' }, now);
    }
    painted.push({ now, at: { ...p.sample(now).A } });
  }
  return { player: p, painted: painted.filter(f => f.now > 4000) };
}

const stepsOf = (painted: { at: Position }[]) =>
  painted.slice(1).map((f, i) => Math.abs(f.at.x - painted[i].at.x) + Math.abs(f.at.y - painted[i].at.y));

describe('dashboard robot identity and movement', () => {
  it('spreads adjacent AMR ids across distinct hues and keeps identity stable', () => {
    const hues = Array.from({ length: 20 }, (_, i) => Number(getRobotColor(`AMR-${String(i + 1).padStart(2, '0')}`).match(/\d+/)![0]));
    expect(new Set(hues).size).toBe(20);
    for (let i = 1; i < hues.length; i++) {
      const gap = Math.abs(hues[i] - hues[i - 1]);
      expect(Math.min(gap, 360 - gap)).toBeGreaterThan(100);
    }
    expect(getRobotColor('AMR-01')).toBe(getRobotColor('AMR-01'));
  });

  it('never stops between cells when the server ticks slower than nominal', () => {
    // The old player animated each cell in exactly 250 ms and then waited. The
    // server was measured at ~260 ms, which froze the robot ~2.7 times a second.
    for (const period of [250, 263, 300]) {
      const { player, painted } = play(period, () => 15);
      const steps = stepsOf(painted);
      expect(steps.filter(d => d < 1e-6)).toHaveLength(0);
      expect(player.tickPeriodMs).toBeGreaterThan(period * 0.97);
      expect(player.tickPeriodMs).toBeLessThan(period * 1.03);
      // Constant speed: no frame moves more than 1.5x the ideal per-frame step.
      expect(Math.max(...steps)).toBeLessThan(1.5 * (1000 / 120) / period);
    }
  });

  it('absorbs WAN jitter without freezing or jumping', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const { painted } = play(TICK_MS, () => 150 + (rnd() * 2 - 1) * 100);
    const steps = stepsOf(painted);
    expect(steps.filter(d => d < 1e-6)).toHaveLength(0);
    expect(Math.max(...steps)).toBeLessThan(0.06);
  });

  it('eases to a stop through a multi-second stall and replays it without a jump', () => {
    // Two consecutive 2 s round trips: a 4 s hole, 16 ticks, inside the server's
    // 24-tick history. The robot eases to a stop, then fast-forwards every cell.
    const { painted } = play(TICK_MS, i => (i >= 100 && i < 102 ? 2000 : 30), 40);
    expect(Math.max(...stepsOf(painted))).toBeLessThan(0.12);
  });

  it('follows committed turns instead of cutting across racks', () => {
    // An L-shaped committed route: the painted robot must stay near the two
    // legs, never on the diagonal between (0,0) and (1,1).
    const at = (t: number) => (t <= 1 ? { x: t, y: 0 } : { x: 1, y: Math.min(t - 1, 1) });
    const p = new MotionPlayer();
    p.ingest({ robots: [robot('A', 0, 0)], tick: 0, runtimeId: 'r' }, 0);
    p.ingest({ robots: [robot('A', 1, 1)], tick: 2, history: history(2, at), runtimeId: 'r' }, 500);
    for (let now = 500; now < 2500; now += 8) {
      const q = p.sample(now).A;
      // The follower rounds the corner by a fraction of a cell, inside the turn cell.
      expect(Math.min(Math.abs(q.y), Math.abs(q.x - 1))).toBeLessThan(0.25);
    }
    expect(p.sample(2600).A).toEqual({ x: 1, y: 1 });
  });

  it('cuts to a new world instead of flying, and ignores stale frames', () => {
    const p = new MotionPlayer();
    p.ingest({ robots: [robot('A', 18, 12)], tick: 400, runtimeId: 'old' }, 0);
    p.sample(0);
    p.ingest({ robots: [robot('A', 1, 0)], tick: 0, runtimeId: 'new' }, 10);
    expect(p.sample(26).A).toEqual({ x: 1, y: 0 });
    expect(p.resets).toBe(1);
    // An older answer of the same runtime arriving late must not rewind it.
    p.ingest({ robots: [robot('A', 2, 0)], tick: 5, runtimeId: 'new' }, 1300);
    p.ingest({ robots: [robot('A', 1, 0)], tick: 3, runtimeId: 'new' }, 1310);
    expect(p.resets).toBe(1);
    for (let now = 1310; now < 4000; now += 16) p.sample(now);
    expect(p.sample(4000).A).toEqual({ x: 2, y: 0 });
  });

  it('predicts briefly along a free route, never into an occupied or blocked cell', () => {
    const p = new MotionPlayer();
    const world = (tick: number) => [
      robot('A', 2, 0, [{ x: 2, y: 0 }, { x: 3, y: 0 }]),   // free cell ahead
      robot('B', 5, 0, [{ x: 5, y: 0 }, { x: 6, y: 0 }]),   // ahead is occupied by C
      robot('C', 6, 0, []),
      robot('D', 8, 0, [{ x: 8, y: 0 }, { x: 8, y: 1 }]),   // ahead is blocked
    ].map(r => ({ ...r, tick }));
    p.ingest({ robots: world(0), tick: 0, runtimeId: 'r', blocked: new Set(['8,1']) }, 0);
    for (let now = 0; now <= 3000; now += 16) p.sample(now);
    const at = p.sample(3016);
    expect(at.A.x).toBeGreaterThan(2.3);
    expect(at.A.x).toBeLessThan(2.6);
    expect(at.B).toEqual({ x: 5, y: 0 });
    expect(at.D).toEqual({ x: 8, y: 0 });
  });

  it('does not predict while paused or disconnected', () => {
    const p = new MotionPlayer();
    p.ingest({ robots: [robot('A', 2, 0, [{ x: 2, y: 0 }, { x: 3, y: 0 }])], tick: 7, runtimeId: 'r', running: false }, 0);
    for (let now = 0; now <= 2000; now += 16) p.sample(now);
    expect(p.sample(2016).A).toEqual({ x: 2, y: 0 });
  });

  it('reports bounded, immutable motion history and a new identity on restart', () => {
    const rt = new FleetRuntime();
    const first = rt.snapshot();
    for (let i = 0; i < 40; i++) rt.step();
    const next = rt.snapshot();
    expect(first.motionHistory).toHaveLength(1);
    expect(next.motionHistory).toHaveLength(25);
    expect(next.motionHistory.at(-1)?.tick).toBe(next.world.tick);
    expect(next.motionHistory.at(-1)?.positions).toEqual(Object.fromEntries(next.world.robots.map(r => [r.id, r.position])));
    expect(new FleetRuntime().runtimeId).not.toBe(rt.runtimeId);
  });

  it('API reads cannot add extra ticks alongside the interval', async () => {
    vi.useFakeTimers();
    const { fleetService, stepIfDue } = await import('../src/server/fleet-service');
    const rt = fleetService();
    const initial = rt.world.tick;
    try {
      await vi.advanceTimersByTimeAsync(TICK_MS);
      stepIfDue();
      expect(rt.world.tick).toBe(initial + 1);
      await vi.advanceTimersByTimeAsync(100);
      stepIfDue();
      expect(rt.world.tick).toBe(initial + 1);
      await vi.advanceTimersByTimeAsync(150);
      stepIfDue();
      expect(rt.world.tick).toBe(initial + 2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps an exact 250 ms schedule and catches up a suspended host within the history window', async () => {
    vi.useFakeTimers();
    const { fleetService, reconfigureFleet, stepIfDue } = await import('../src/server/fleet-service');
    // A fresh runtime, so its interval is created under fake timers.
    reconfigureFleet({ robots: 3 });
    const rt = fleetService();
    try {
      const start = rt.world.tick;
      await vi.advanceTimersByTimeAsync(TICK_MS * 40);
      expect(rt.world.tick - start).toBe(40);
      // A frozen serverless instance: no timers ran for ten seconds.
      vi.setSystemTime(Date.now() + 10_000);
      const before = rt.world.tick;
      stepIfDue();
      expect(rt.world.tick - before).toBe(24);
      expect(rt.snapshot().motionHistory).toHaveLength(25);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
