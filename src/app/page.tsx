'use client';

// The polished dashboard, driven by the DISTRIBUTED fleet runtime.
//
// This page used to run a central PIBT simulation inside the browser via
// `runDispatchTick`, and the fleet integration replaced it wholesale with a
// new, much plainer screen. That was the wrong trade: the whole point was to
// put the new backend BEHIND the dashboard people had already signed off on,
// not to replace the dashboard too.
//
// So the presentation layer here is the original one, unchanged — same
// WarehouseMap, ControlPanel, MetricsBar, ActiveTasks, EventLog, FleetStatus,
// same layout, same copy. Only the data source moved:
//
//   before: an in-process central simulation, stepped by setInterval
//   after:  a Node-hosted fleet runtime (src/server/fleet-http.ts), polled
//
// The two talk the same shape. The runtime's `world` is a WorldState — the
// same { tick, map, robots, tasks, metrics } the components already take — so
// nothing in the view layer had to change, which is the strongest evidence
// that this was always the intended shape.
//
// The central simulator is still here, at /simulator. It is a genuinely
// different backend and it is the fair baseline for the stop-and-wait
// comparison, so it keeps its own route rather than being deleted.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Position, Task, WorldState } from '@/core/types';
import {
  Header,
  JudgeTutorial,
  WarehouseMap,
  ControlPanel,
  MetricsBar,
  FleetStatus,
  ActiveTasks,
  EventLog,
  type LogEntry,
  type MapTooltip
} from '@/components/dashboard';

type FleetSnapshot = {
  world: WorldState;
  running: boolean;
  aiEnabled: boolean;
  events: { tick: number; text: string }[];
  safety: { overlaps: number; swaps: number; blockedCells: number; zeroBatteryWork: number; queueOverflow: number; payloadViolations: number };
  metrics: {
    aiBidAttempts: number; nonzeroCorrections: number; disabledFallbacks: number;
    failedModelFallbacks: number; moves: number; reroutes: number; energyHolds: number;
  };
};

// x=9, rows 5-7: a true single-file stretch, so blocking it forces a real
// detour rather than a sidestep.
const AISLE_BLOCK_CELLS: Position[] = [
  { x: 9, y: 5 },
  { x: 9, y: 6 },
  { x: 9, y: 7 },
];

const TOOLTIP_LIFETIME_MS = 2200;
const POLL_MS = 500;

// Which robot to point a yield tooltip at — derived from a real state
// transition the runtime just made (a robot that only just became "waiting"),
// not a guess. Same rule the original dashboard used against the central sim.
function findYieldingRobots(prev: WorldState, next: WorldState): { robotId: string; position: Position }[] {
  const prevById = new Map(prev.robots.map((r) => [r.id, r]));
  const yielded: { robotId: string; position: Position }[] = [];
  for (const r of next.robots) {
    const prevR = prevById.get(r.id);
    if (prevR && prevR.status !== 'waiting' && r.status === 'waiting') {
      yielded.push({ robotId: r.id, position: r.position });
    }
  }
  return yielded;
}

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  /**
   * `connecting` = no answer yet, so there is nothing to report. `live` = the
   * last poll succeeded. `error` = the last poll actually failed. Kept apart
   * because only the third of those is a fault, and conflating the first with
   * the third is what flashed a connection error at a healthy runtime.
   */
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  /** Wall clock of the last snapshot that actually arrived, for the stale banner. */
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>(null);
  const [aisleBlocked, setAisleBlocked] = useState(false);
  const [severed, setSevered] = useState(false);
  const [conflictTooltips, setConflictTooltips] = useState<MapTooltip[]>([]);
  // The fleet size and shelf layout belong to the runtime, not the view, so
  // these are reported from telemetry rather than owned here. Kept as state
  // only so the ControlPanel sliders can render a truthful value.
  const [shelfColCount] = useState(6);
  const [robotCount, setRobotCount] = useState(0);

  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  /** True once a poll has actually failed. Derived once, here, so every
   *  consumer below reads the same value and none of them recomputes it. */
  const disconnected = status === 'error';
  /**
   * How long the visible frame has been frozen, while the runtime is
   * unreachable. Driven by a 1 Hz timer rather than `Date.now()` read during
   * render: a component that re-renders for an unrelated reason must not be able
   * to change what "frozen for Ns" claims, and reading the clock in render is
   * both impure and a lint error.
   */
  const [frozenFor, setFrozenFor] = useState<number | null>(null);
  const worldRef = useRef<WorldState | null>(null);

  // Judge tour. Same storage key and same ?tour / ?tutorial overrides as the
  // simulator page, so the onboarding behaves identically on both routes and a
  // judge who has already seen it is not interrupted again.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // The open decision is made in a callback rather than synchronously in the
    // effect body: setState directly in an effect body triggers a cascading
    // render, and this tripped `react-hooks/set-state-in-effect` (it did so in
    // the simulator page's copy of this effect too, as merged in PR #24).
    const id = setTimeout(() => {
      const searchParams = new URLSearchParams(window.location.search);
      const forceTour = searchParams.get('tour') === 'true' || searchParams.get('tutorial') === 'true';
      const hasCompleted = localStorage.getItem('amr_judge_tour_completed_v2');
      if (forceTour || !hasCompleted) setIsTutorialOpen(true);
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const addLog = useCallback((text: string, type: 'info' | 'warning' | 'error' = 'info') => {
    setLogs((prev) => [
      ...prev.slice(-60),
      { time: new Date().toLocaleTimeString('en-GB', { hour12: false }), text, type },
    ]);
  }, []);

  // ---- poll the runtime ----
  //
  // THREE CONNECTION STATES, NOT TWO. The previous version had one flag,
  // `error`, and rendered the "Fleet runtime not connected" card whenever
  // `snapshot` was null. `snapshot` is null on the very first render, before
  // the first fetch has resolved — so a perfectly healthy runtime produced an
  // amber "not connected" card for exactly as long as the first round trip took,
  // and then the dashboard popped in underneath it. On a warm local process that
  // is the "flash for a split second"; on a cold deployed link it is a visible
  // loading state dressed as a crash. The page conflated "I have not heard back
  // yet" with "I heard back and it was a failure", and only one of those is an
  // error.
  //
  // The effect also used to depend on `error`, so every error transition and
  // every recovery tore the poll loop down and rebuilt it — and because the
  // effect body was the only thing scheduling the next poll, each teardown also
  // silently opened a window with no poll in flight. The error is now read
  // through a ref, so the loop is created exactly once.
  const errorRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = new AbortController();

    const poll = async () => {
      try {
        const response = await fetch('/api/fleet', { cache: 'no-store', signal: abort.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          if (!disposed) {
            errorRef.current = body?.error ?? `Fleet runtime returned ${response.status}`;
            setStatus('error');
            setError(errorRef.current);
          }
        } else {
          const next = (await response.json()) as FleetSnapshot;
          if (!disposed) {
            // Detect the yield transitions between the two snapshots we have
            // seen and point a tooltip at the robot that actually yielded.
            // Done here, at the moment the snapshot lands, rather than in an
            // effect, so it fires exactly once per real poll.
            const prev = worldRef.current;
            worldRef.current = next.world;
            if (prev && next.world.metrics.conflictCount > prev.metrics.conflictCount) {
              for (const { robotId, position } of findYieldingRobots(prev, next.world)) {
                const id = `${robotId}-${next.world.tick}`;
                setConflictTooltips((t) => [...t, { id, robotId, text: `${robotId} yields — priority inherited`, position }]);
                setTimeout(() => setConflictTooltips((t) => t.filter((x) => x.id !== id)), TOOLTIP_LIFETIME_MS);
              }
            }
            errorRef.current = null;
            setSnapshot(next);
            setRobotCount(next.world.robots.length);
            setLastUpdateAt(Date.now());
            setError(null);
            setStatus('live');
          }
        }
      } catch (caught) {
        // An abort on unmount is not a failure and must not paint the page red.
        if (disposed || (caught as Error)?.name === 'AbortError') return;
        if (!disposed) {
          errorRef.current = 'Fleet runtime unreachable. Start it with: npm run fleet';
          setError(errorRef.current);
          setStatus('error');
        }
      }
      if (!disposed) timer = setTimeout(poll, POLL_MS);
    };

    // No `setStatus('connecting')` here on purpose. The state already starts as
    // 'connecting', the effect has empty dependencies so it runs exactly once,
    // and a remount re-initialises the state anyway — so a setState in the effect
    // body would be a pure cascading re-render, which is precisely what
    // `react-hooks/set-state-in-effect` flags (the same trap the judge-tour effect
    // above documents and works around with a deferred callback).
    void poll();
    return () => { disposed = true; abort.abort(); if (timer) clearTimeout(timer); };
  }, []);

  // 1 Hz staleness clock. Declared before the early returns so its effect is not
  // conditionally registered, and it contains no synchronous setState so it does
  // not trip `react-hooks/set-state-in-effect`.
  useEffect(() => {
    const update = () => setFrozenFor(
      disconnected && lastUpdateAt !== null
        ? Math.max(0, Math.floor((Date.now() - lastUpdateAt) / 1000))
        : null,
    );
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [disconnected, lastUpdateAt]);

  // ---- commands ----
  const send = useCallback(async (command: unknown, describe: (ok: boolean, detail?: string) => void) => {
    try {
      const response = await fetch('/api/fleet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        describe(false, body?.error ?? `command rejected (${response.status})`);
        return;
      }
      describe(true);
    } catch {
      describe(false, 'fleet runtime unreachable');
    }
  }, []);

  const handleToggleSimulation = () => {
    const next = !(snapshot?.running ?? false);
    void send({ kind: next ? 'run' : 'pause' }, (ok, detail) => {
      if (!ok) { addLog(`could not ${next ? 'start' : 'pause'} the fleet: ${detail}`, 'error'); return; }
      addLog(next ? 'fleet running — peer controllers stepping' : 'fleet paused', next ? 'info' : 'warning');
    });
  };

  const handleCreateTask = () => {
    const taskId = `T-${105 + (snapshot?.world.tasks.length ?? 0)}`;
    const pickups: Position[] = [{ x: 1, y: 0 }, { x: 14, y: 0 }, { x: 3, y: 9 }, { x: 9, y: 9 }];
    const dropoffs: Position[] = [{ x: 6, y: 12 }, { x: 17, y: 12 }, { x: 9, y: 1 }, { x: 13, y: 1 }];
    const n = snapshot?.world.tasks.length ?? 0;
    const task: Task = {
      id: taskId,
      pickup: pickups[n % pickups.length],
      dropoff: dropoffs[(n + 1) % dropoffs.length],
      weight: Math.floor(Math.random() * 80) + 10,
      createdAt: snapshot?.world.tick ?? 0,
      priority: 1,
      status: 'pending',
    };
    void send({ kind: 'task', task }, (ok, detail) => {
      if (!ok) { addLog(`task rejected: ${detail}`, 'error'); return; }
      addLog(`task ${taskId.toLowerCase()} announced — peers will bid for it`, 'info');
    });
  };

  const handleBlockAisle = () => {
    const next = !aisleBlocked;
    setAisleBlocked(next);
    for (const position of AISLE_BLOCK_CELLS) {
      void send({ kind: 'block', position, blocked: next }, (ok, detail) => {
        if (!ok) addLog(`block failed: ${detail}`, 'error');
      });
    }
    addLog(
      next ? 'aisle blocked at x=9 (rows 5-7) — routed traffic must replan around it'
           : 'aisle cleared at x=9',
      next ? 'warning' : 'info'
    );
  };

  const handleFailAMR = () => {
    const target = snapshot?.world.robots.find((r) => r.id === 'AMR-02') ?? snapshot?.world.robots[0];
    if (!target) return;
    void send({ kind: 'fail', robotId: target.id }, (ok, detail) => {
      if (!ok) { addLog(`failure injection rejected: ${detail}`, 'error'); return; }
      addLog(`${target.id.toLowerCase()} failure injected — surviving peers must recover its work`, 'error');
    });
  };

  const handleToggleLink = () => {
    const [a, b] = snapshot?.world.robots.slice(0, 2).map((r) => r.id) ?? [];
    if (!a || !b) return;
    const reachable = severed;
    setSevered(!reachable);
    void send({ kind: 'link', a, b, reachable }, (ok, detail) => {
      if (!ok) { addLog(`link change rejected: ${detail}`, 'error'); return; }
      addLog(
        reachable ? `link ${a.toLowerCase()}<->${b.toLowerCase()} healed` : `link ${a.toLowerCase()}<->${b.toLowerCase()} SEVERED — they can no longer hear each other`,
        reachable ? 'info' : 'warning'
      );
    });
  };

  const handleToggleBids = () => {
    const next = !(snapshot?.aiEnabled ?? true);
    void send({ kind: next ? 'ai-on' : 'ai-off' }, (ok, detail) => {
      if (!ok) { addLog(`could not change bid mode: ${detail}`, 'error'); return; }
      addLog(next ? 'learned bid cost enabled' : 'learned bid cost disabled — deterministic cost only', 'warning');
    });
  };

  // These two were hand-staged scenarios that mutated the central
  // simulation's world directly. The distributed runtime owns its world, so
  // there is nothing honest to do here but say so — rather than fake a
  // scenario that isn't happening. The central simulator still exists at
  // /simulator for anyone who wants to compare against it, but it is
  // deliberately not linked from the demo: one page, one story.
  const notOnFleet = (what: string) => () =>
    addLog(`${what} is a central-simulation scenario and is not available on the distributed runtime`, 'warning');

  const handleReset = () =>
    addLog('the fleet runtime cannot be reset in place — restart it with: npm run fleet', 'warning');

  const handleRobotCountChange = () =>
    addLog('fleet size is fixed by the runtime, not the dashboard', 'warning');

  // The runtime owns the authoritative event log, so the feed is derived from
  // it rather than mirrored into state — no chance of the two drifting.
  const eventFeed = React.useMemo<LogEntry[]>(
    () => (snapshot?.events ?? []).slice(-8).map((e) => ({ time: `tick ${e.tick}`, text: e.text, type: 'info' as const })),
    [snapshot]
  );

  // ---- connection chrome ----
  //
  // The dashboard must never LOOK live while it is not. The previous version
  // kept rendering the full dashboard after the runtime went away, with the
  // tick counter frozen and the status dot still pulsing — a stale view that is
  // indistinguishable from a working one. In front of a jury that is the worst
  // failure mode available: it does not look like a bug, it looks like a system
  // that has stalled. So disconnection is stated, with the age of the data.
  if (status === 'connecting' || (disconnected && !snapshot)) {
    const connecting = status === 'connecting';
    return (
      <div className="min-h-screen bg-[#09090b] text-[#fafafa] bg-[url('/bg.png')] bg-cover bg-fixed bg-center font-sans py-6 px-4 md:px-8 lg:px-12 flex justify-center items-start">
        <div className="w-full max-w-[1520px] bg-black/40 backdrop-blur-2xl rounded-2xl border border-zinc-800/80 shadow-[0_25px_70_-15px_rgba(0,0,0,0.85)] p-10">
          <Header onOpenTutorial={() => setIsTutorialOpen(true)} />
          <div className="mt-8 flex items-start gap-4">
            {connecting && (
              <span
                aria-hidden
                className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-zinc-600 border-t-[#C9F27D] animate-spin"
                style={{ animationDuration: '900ms' }}
              />
            )}
            <div className="min-w-0">
              <p className={connecting ? 'text-zinc-200 text-base mb-2' : 'text-amber-300 text-base mb-2'}>
                {connecting ? 'Connecting to the fleet runtime…' : 'Fleet runtime not connected.'}
              </p>
              <p className="text-zinc-400 mb-4 max-w-[68ch] leading-relaxed">
                {connecting
                  ? 'Opening a control channel to the distributed peer processes. The map renders as soon as the first telemetry frame lands.'
                  : error ?? 'The fleet runtime is not answering.'}
              </p>
              <p className="text-zinc-400 mb-4 max-w-[68ch] leading-relaxed">
                This dashboard is driven by the distributed fleet runtime, which runs as its own
                Node process — the same one-process-per-robot topology as the real deployment.
                Start it in a second terminal:
              </p>
              <pre className="font-mono text-[13px] text-emerald-300 bg-black/50 rounded p-3 mb-4 inline-block">npm run fleet</pre>
              <p className="text-zinc-500 text-xs">
                Then run <span className="text-zinc-300">npm run dev</span> for this page.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Unreachable in practice — the branch above returns for `connecting` and for an
  // error with no snapshot — but the type system cannot see that, and the honest
  // narrowing is better than a non-null assertion scattered through the JSX.
  if (!snapshot) return null;

  const { world, safety, metrics } = snapshot;


  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] bg-[url('/bg.png')] bg-cover bg-fixed bg-center font-sans py-6 px-4 md:px-8 lg:px-12 flex justify-center items-start selection:bg-[#C9F27D]/30">
      <div className="w-full max-w-[1520px] bg-black/40 backdrop-blur-2xl rounded-2xl border border-zinc-800/80 shadow-[0_25px_70_-15px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden">
        <Header onOpenTutorial={() => setIsTutorialOpen(true)} />

        {/* Status strip.
            The one number this project exists to defend is the collision count,
            so it gets the only badge on the page and a denominator beside it. A
            bare "0" is a coincidence; "0 collisions across 8,604 ticks" is a
            measurement. When the peer link is severed the badge says so, because
            that is the version of the claim worth making: safety holds while
            the network is cut, precisely because safety never depended on the
            network. If the count ever moves off zero the badge turns red — it is
            a live invariant, not decoration.

            CONTRAST. The first version of this strip was unreadable and the
            numbers were measured rather than eyeballed: at 11px it needs 4.5:1
            for WCAG AA, and four of its nine text elements were below that —
            the "/" separator at 1.89:1, "tick" and "swaps" at 2.56:1, the
            badge denominator at 3.66:1. Two causes: the strip was translucent
            over a textured page background, so contrast was not even a fixed
            quantity, and the dimmer tokens used alpha, which compounds with an
            already-dark backdrop. Fixed by making the strip opaque so the
            backdrop is deterministic, dropping the separator entirely, and
            using solid tokens that clear the bar with room to spare — worst
            case in this set is 7.52:1, i.e. AA and AAA. */}
        <div className="px-5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800/60 bg-[#0e0e12] text-[11px] font-mono">
          <span className="text-zinc-100 uppercase tracking-[0.16em] not-italic">Fleet runtime</span>
          <span className="text-zinc-300">node-hosted distributed peers</span>

          {disconnected ? (
            // A dead runtime must not be rendered as a running one. The dot stops
            // pulsing, the word changes, and the age of the frozen frame is given
            // so nobody has to guess whether the tick counter is moving.
            <span className="flex items-center gap-1.5 text-amber-300">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              reconnecting
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-zinc-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
              {snapshot.running ? 'running' : 'paused'}
            </span>
          )}
          <span className="text-zinc-400 tabular-nums">
            tick {world.tick.toLocaleString()}
            {disconnected && frozenFor !== null && (
              <span className="text-amber-300"> · frozen for {frozenFor}s</span>
            )}
          </span>
          <span className="text-zinc-400">
            swaps <span className={safety.swaps > 0 ? 'text-amber-300' : 'text-zinc-300'}>{safety.swaps}</span>
          </span>

          <div
            className={`ml-auto flex items-center gap-2 rounded-lg border px-3 py-1 ${
              safety.overlaps > 0
                ? 'border-red-400/40 bg-[#1f0f0f]'
                : 'border-emerald-300/30 bg-[#0b1f18]'
            }`}
          >
            {safety.overlaps > 0 ? (
              <>
                <span className="text-red-300">{safety.overlaps} collisions</span>
                <span className="text-red-300/80">safety invariant broken</span>
              </>
            ) : (
              <>
                <span className="text-emerald-200">0 collisions</span>
                <span className="text-emerald-300 tabular-nums">
                  across {world.tick.toLocaleString()} ticks
                </span>
                {severed && <span className="text-amber-300">· network partitioned</span>}
              </>
            )}
          </div>
        </div>

        <div className="p-4 flex gap-4">
          <div className="w-[72%] flex flex-col gap-4 min-w-0">
            <WarehouseMap
              robots={world.robots}
              selectedRobotId={selectedRobotId}
              onSelectRobot={setSelectedRobotId}
              shelfColCount={shelfColCount}
              map={world.map}
              tooltips={conflictTooltips}
            />

            <div className="shrink-0 flex flex-col gap-4">
              <ControlPanel
                isSimulating={snapshot.running}
                robotCount={robotCount}
                shelfColCount={shelfColCount}
                aisleBlocked={aisleBlocked}
                onCreateTask={handleCreateTask}
                onToggleSimulation={handleToggleSimulation}
                onSimulateConflict={notOnFleet('sim conflict')}
                onSimulateDeadlock={notOnFleet('sim deadlock')}
                onFailAMR={handleFailAMR}
                onBlockAisle={handleBlockAisle}
                onReset={handleReset}
                onRobotCountChange={handleRobotCountChange}
                onShelfColCountChange={() => addLog('shelf layout is fixed by the runtime', 'warning')}
              />

              {/* The two controls the central simulator has no equivalent for.
                  The severed link is the brief's central claim — collision
                  safety does not use the network — so it has to be reachable
                  from the dashboard or it cannot be demonstrated. */}
              <div className="flex flex-wrap items-center gap-2 px-1">
                <button
                  onClick={handleToggleLink}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 transition-colors"
                >
                  {severed ? 'Heal peer link' : 'Sever peer link'}
                </button>
                <button
                  onClick={handleToggleBids}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-600 text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  {snapshot.aiEnabled ? 'Disable learned bids' : 'Enable learned bids'}
                </button>
                <span className="text-[11px] font-mono text-zinc-400">
                  bids with AI: {metrics.aiBidAttempts} · nonzero corrections: {metrics.nonzeroCorrections} ·
                  deterministic fallbacks: {metrics.disabledFallbacks + metrics.failedModelFallbacks} ·
                  energy holds: {metrics.energyHolds}
                </span>
              </div>

              <MetricsBar tasks={world.tasks} robots={world.robots} metrics={world.metrics} />

              <div id="tour-tasks-and-logs" className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ActiveTasks tasks={world.tasks} robots={world.robots} />
                <EventLog logs={[...eventFeed, ...logs]} />
              </div>
            </div>
          </div>

          {/* No tour anchor on this wrapper, deliberately. The FleetStatus
              panel already carries the fleet-status tour anchor on its own
              root (added in PR #24), and when this column ALSO carried a
              duplicate the tour resolved the id to the COLUMN — so the
              spotlight drew a viewport-tall empty strip with three robots
              rattling about at the top, instead of the panel. One id, on the
              thing actually being pointed at. */}
          <div className="w-[28%] flex flex-col gap-4 min-w-0">
            <FleetStatus
              robots={world.robots}
              selectedRobotId={selectedRobotId}
              onSelectRobot={setSelectedRobotId}
            />
          </div>
        </div>
      </div>
      <JudgeTutorial isOpen={isTutorialOpen} onClose={() => setIsTutorialOpen(false)} />
    </div>
  );
}
