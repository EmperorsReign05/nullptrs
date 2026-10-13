'use client';

import React from 'react';

/**
 * What a visitor sees before the first telemetry frame.
 *
 * The deployed fleet runtime is its own server and sleeps when nobody is
 * watching, so the first request after a quiet spell can take most of a minute
 * to answer. The page used to treat the very first failed poll as an outage and
 * show "Fleet runtime not connected" with `npm run fleet` instructions: to
 * anyone who is not running it locally, that reads as a broken site. A slow
 * first answer is the normal case, so it is presented as start-up, with honest
 * progress, and polling carries on underneath; the page switches to the live
 * warehouse by itself the moment a frame lands. Only a wait well past a normal
 * cold start is called a problem, and the setup instructions stay behind a
 * "running locally?" disclosure for the people who need them.
 */
export const SLOW_START_AFTER_S = 15;
export const GIVE_UP_AFTER_S = 120;

/** Map silhouette: rack blocks of the real 20 x 13 floor, drawn as a skeleton. */
const RACK_COLUMNS = [1, 4, 7, 10, 15, 18];
const RACK_ROWS: [number, number][] = [[1, 3], [5, 7], [9, 11]];

function MapSkeleton() {
  return (
    <svg viewBox="0 0 20 13" className="w-full h-full" aria-hidden>
      {RACK_COLUMNS.flatMap((x) =>
        // Column 1's middle block is the passing bay, not racking.
        RACK_ROWS.filter(([y0]) => !(x === 1 && y0 === 5)).map(([y0, y1]) => (
          <rect key={`${x}-${y0}`} x={x + 0.1} y={y0 + 0.1} width={1.8} height={y1 - y0 + 0.8} rx={0.15}
            className="fill-zinc-800/70" />
        )),
      )}
      {/* Three robots tracing the main aisles while the real ones boot. */}
      {[
        { color: '#C9F27D', path: 'M0.5,4.5 H19.5 V8.5 H0.5 Z', dur: '9s' },
        { color: '#7DD3FC', path: 'M3.5,0.5 V12.5 H13.5 V0.5 Z', dur: '11s' },
        { color: '#F9A8D4', path: 'M19.5,12.5 H0.5 V8.5 H19.5 Z', dur: '10s' },
      ].map(({ color, path, dur }) => (
        <circle key={color} r={0.32} fill={color} className="motion-reduce:hidden" style={{ filter: `drop-shadow(0 0 0.3px ${color})` }}>
          <animateMotion dur={dur} repeatCount="indefinite" path={path} />
        </circle>
      ))}
    </svg>
  );
}

export function StartupScreen({ waitedS, failed, onRetry }: {
  /** Seconds since the page started waiting for its first frame. */
  waitedS: number;
  /** True once a poll has actually failed, not merely not answered yet. */
  failed: boolean;
  onRetry: () => void;
}) {
  const stalled = waitedS >= GIVE_UP_AFTER_S;
  const waking = !stalled && (failed || waitedS >= SLOW_START_AFTER_S);
  // Eases toward full over a typical cold start and never claims to finish.
  const progress = stalled ? 1 : 1 - Math.exp(-waitedS / 25);
  const headline = stalled
    ? 'The fleet server is taking longer than usual'
    : waking ? 'Waking up the fleet server' : 'Connecting to the fleet';
  const detail = stalled
    ? 'Still trying in the background. The warehouse appears here on its own the moment the server answers, so you can leave this tab open.'
    : waking
      ? 'The robot simulation runs on its own server, which sleeps when nobody is watching. Starting it usually takes 20 to 60 seconds. This page switches to the live warehouse by itself.'
      : 'Opening a channel to the robots. The warehouse appears as soon as the first telemetry frame lands.';

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center" role="status" aria-live="polite">
      <div className="min-w-0">
        <div className="flex items-center gap-3 mb-3">
          {!stalled && (
            <span aria-hidden className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-zinc-700 border-t-[#C9F27D] animate-spin"
              style={{ animationDuration: '900ms' }} />
          )}
          <p className={`text-lg ${stalled ? 'text-amber-200' : 'text-zinc-100'}`}>{headline}</p>
        </div>
        <p className="text-zinc-400 max-w-[60ch] leading-relaxed mb-6">{detail}</p>

        <div className="max-w-[420px]">
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className={`h-full rounded-full transition-[width] duration-1000 ease-out ${stalled ? 'bg-amber-300/70' : 'bg-[#C9F27D]'}`}
              style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-zinc-500 font-mono tabular-nums">
            <span>{waking || stalled ? 'starting server' : 'connecting'}</span>
            <span>{waitedS}s</span>
          </div>
        </div>

        {stalled && (
          <button type="button" onClick={onRetry}
            className="mt-6 rounded-lg border border-zinc-700 bg-zinc-900/70 px-4 py-2 text-sm text-zinc-100 hover:border-[#C9F27D]/60 hover:text-[#C9F27D] transition-colors">
            Retry now
          </button>
        )}

        <details className="mt-8 text-sm text-zinc-500 max-w-[68ch]">
          <summary className="cursor-pointer select-none text-zinc-400 hover:text-zinc-200">Running this locally?</summary>
          <div className="mt-3 leading-relaxed">
            <p className="mb-3">
              The dashboard is driven by the distributed fleet runtime, which runs as its own Node process. Start it
              in a second terminal, then run <span className="text-zinc-300">npm run dev</span> for this page:
            </p>
            <pre className="font-mono text-[13px] text-emerald-300 bg-black/50 rounded p-3 mb-3 inline-block">npm run fleet</pre>
            <p className="text-xs">
              For a demo use a production build (<span className="text-zinc-300">npm run build &amp;&amp; npm start</span>):
              development mode re-renders slowly enough that the motion visibly stutters.
            </p>
          </div>
        </details>
      </div>

      <div className="relative aspect-[20/13] w-full rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent motion-safe:animate-pulse" aria-hidden />
        <MapSkeleton />
      </div>
    </div>
  );
}
