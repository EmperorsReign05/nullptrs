import { describe, it, expect, vi } from 'vitest';
import { advanceSmooth, initialSmooth, sampleSmooth, TICK_MS } from '../src/components/dashboard/useSmoothRobots';
import { getRobotColor } from '../src/components/dashboard/types';
import { FleetRuntime } from '../src/core/distributed/runtime';
import type { RobotState } from '../src/core/types';

const robots = (x: number, y: number): RobotState[] => [{ id: 'AMR-01', position: { x, y } } as RobotState];
const positions = (x: number, y: number) => ({ 'AMR-01': { x, y } });

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

  it('follows committed turns and waits across skipped polls', () => {
    const s = advanceSmooth(initialSmooth(robots(1, 1), 0), robots(2, 2), 3, 0, 100, [
      { tick: 1, positions: positions(2, 1) },
      { tick: 2, positions: positions(2, 1) },
      { tick: 3, positions: positions(2, 2) },
    ]);
    expect(s.durationMs).toBe(3 * TICK_MS);
    expect(sampleSmooth(s, 225)['AMR-01']).toEqual({ x: 1.5, y: 1 });
    expect(sampleSmooth(s, 475)['AMR-01']).toEqual({ x: 2, y: 1 });
    expect(sampleSmooth(s, 725)['AMR-01']).toEqual({ x: 2, y: 1.5 });
    expect(sampleSmooth(s, 1000)['AMR-01']).toEqual({ x: 2, y: 2 });
  });

  it('finishes an in-flight segment before turning on a new snapshot', () => {
    const s = advanceSmooth(initialSmooth(robots(1, 1), 0), robots(2, 1), 1, 0, 0);
    const next = advanceSmooth(s, robots(2, 2), 2, 1, 125, [{ tick: 2, positions: positions(2, 2) }]);
    expect(sampleSmooth(next, 125)['AMR-01']).toEqual({ x: 1.5, y: 1 });
    expect(sampleSmooth(next, 200)['AMR-01'].y).toBe(1);
    expect(sampleSmooth(next, 375)['AMR-01']).toEqual({ x: 2, y: 1.5 });
  });

  it('resynchronizes resets, long stalls and missing routes without flying', () => {
    const s = initialSmooth(robots(18, 12), 0);
    for (const [tick, prev] of [[0, 40], [400, 0], [1, 0]]) {
      const next = advanceSmooth(s, robots(1, 0), tick, prev, 10);
      expect(sampleSmooth(next, 10)['AMR-01']).toEqual({ x: 1, y: 0 });
      expect(next.durationMs).toBe(0);
    }
  });

  it('holds duplicate packets and incorporates a changed pose at the same tick', () => {
    const s = initialSmooth(robots(1, 1), 0);
    expect(advanceSmooth(s, robots(1, 1), 1, 1, 100)).toBe(s);
    expect(sampleSmooth(advanceSmooth(s, robots(2, 1), 1, 1, 100), 225)['AMR-01'].x).toBe(1.5);
  });

  it('reports bounded, immutable motion history and a new identity on restart', () => {
    const rt = new FleetRuntime();
    const first = rt.snapshot();
    for (let i = 0; i < 12; i++) rt.step();
    const next = rt.snapshot();
    expect(first.motionHistory).toHaveLength(1);
    expect(next.motionHistory).toHaveLength(9);
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
});
