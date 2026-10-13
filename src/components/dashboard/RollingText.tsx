'use client';

import { useEffect, useRef, useState } from 'react';
import Scritto from '@scritto/react';

// Every changing value on the dashboard goes through here, so numbers and
// status words roll only the characters that changed instead of snapping.
//
// Scritto never cancels an outgoing glyph, so a value updated faster than its
// roll stacks overlapping ghosts, and a counter rolling four times a second
// reads as jitter rather than motion. Values that change on every tick (the
// tick counter, per-tick metrics, a moving robot's cell) use `sampled`: the
// shown value is refreshed once a second and rolls once. Everything else rolls
// when it actually changes.
const TRANSITION = { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
const SAMPLE_MS = 1000;

function useSampled<T>(value: T, enabled: boolean): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setShown(latest.current), SAMPLE_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return enabled ? shown : value;
}

export function RollingText({ value, pace = 'calm', className }: {
  value: string | number;
  pace?: 'calm' | 'sampled';
  className?: string;
}) {
  const shown = useSampled(value, pace === 'sampled');
  return <Scritto value={shown} transition={TRANSITION} className={className} />;
}

/** Battery as a whole percent. The runtime drains in half-percent steps, and
 *  showing them made every robot's battery flicker on every cell it moved. */
export const formatBattery = (battery: number) => `${Math.round(battery)}%`;
