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
  type MapTooltip,
  RollingText,
  StartupScreen,
  type MotionFrame
} from '@/components/dashboard';

type FleetSnapshot = {
  runtimeId?: string;
  motionHistory?: MotionFrame[];
  world: WorldState;
  running: boolean;
  aiEnabled: boolean;
  events: { tick: number; text: string }[];
  safety: { overlaps: number; swaps: number; blockedCells: number; zeroBatteryWork: number; queueOverflow: number; payloadViolations: number };
  metrics: {
    aiBidAttempts: number; nonzeroCorrections: number; disabledFallbacks: number;
    failedModelFallbacks: number; moves: number; reroutes: number; energyHolds: number;
  };
  /** Harness-level demand. Present only on the fleet runtime, not the simulator. */
  orderStream?: { announced: number; enabled: boolean; intervalTicks: number; held?: number };
  /** Exact task counts; `world.tasks` itself is trimmed to open and recent work. */
  taskTotals?: { total: number; completed: number };
  /** The shape the served runtime was built with, so the sliders show the truth. */
  layout?: { robots: number; shelfColumns: number; maxRobots: number };
  /**
   * Which runtime is actually serving this frame. Displayed, because claiming
   * one-process-per-robot while serving a single in-process fleet would be a lie
   * told to a judge, and this is the one thing the dashboard must not do.
   */
  topology?: "in-process" | "external";
};

// x=9, rows 5-7: a true single-file stretch, so blocking it forces a real
// detour rather than a sidestep.
const AISLE_BLOCK_CELLS: Position[] = [
  { x: 9, y: 5 },
  { x: 9, y: 6 },
  { x: 9, y: 7 },
];

const TOOLTIP_LIFETIME_MS = 2200;
const POLL_MS = 250;
/**
 * The last good frame, kept so a reload or a cold-starting runtime paints the
 * warehouse immediately instead of a blank "connecting" card. It is always
 * labelled as not live, and robots hold still until real telemetry arrives.
 */
const CACHE_KEY = 'amr_last_snapshot_v1';
const CACHE_MAX_AGE_MS = 30 * 60_000;
const CACHE_WRITE_MS = 2000;
/** Polls in a row from another runtime before the page accepts it as the world (~2 s). */
const ADOPT_AFTER_FRAMES = 8;
/** Retries for a command an instance refused as meant for another world. */
const WRONG_WORLD_RETRIES = 4;

function readCachedSnapshot(): FleetSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, snapshot } = JSON.parse(raw) as { at: number; snapshot: FleetSnapshot };
    return Date.now() - at < CACHE_MAX_AGE_MS && snapshot?.world?.robots ? snapshot : null;
  } catch {
    return null;
  }
}

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
  const [failurePending, setFailurePending] = useState(false);
  /**
   * `connecting` = no answer yet, so there is nothing to report. `live` = the
   * last poll succeeded. `error` = the last poll actually failed. Kept apart
   * because only the third of those is a fault, and conflating the first with
   * the third is what flashed a connection error at a healthy runtime.
   */
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');
  /** Wall clock of the last snapshot that actually arrived, for the stale banner. */
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>(null);
  /** Severed link, remembered per runtime: a restart heals every link. */
  const [severedIn, setSeveredIn] = useState<string | null>(null);
  const [aislePending, setAislePending] = useState(false);
  const [conflictTooltips, setConflictTooltips] = useState<MapTooltip[]>([]);
  /**
   * Task ids the operator just injected, so the ActiveTasks panel can show them
   * as "awaiting auction" immediately. The runtime's own snapshot does not change
   * for up to a full ownership epoch after an announcement, so without this the
   * click has literally no visible effect for ~30 seconds.
   */
  const [justAnnounced, setJustAnnounced] = useState<string[]>([]);
  // The fleet size and shelf layout belong to the runtime, so the sliders read
  // them from telemetry. The only local state is a value that was just
  // committed and has not been confirmed yet, so the slider does not jump back
  // for the length of one round trip.
  const [pendingLayout, setPendingLayout] = useState<{ robots?: number; shelfColumns?: number } | null>(null);
  const reconfigureSeq = useRef(0);
  const manualTaskSeq = useRef({ runtimeId: '', next: 0 });
  const cacheWrittenAt = useRef(0);

  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  const [simulationPending, setSimulationPending] = useState(false);
  const simulationCommand = useRef(false);
  const controlRevision = useRef(0);
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
  const runtimeRef = useRef<string | undefined>(undefined);

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
  // silently opened a window with no poll in flight. The loop is now created
  // exactly once. A failure before the first frame is shown as start-up (see
  // StartupScreen), because on the deployed site it nearly always is one.

  /** The runtime the network (not the cache) last confirmed this page is showing. */
  const liveRuntimeRef = useRef<string | undefined>(undefined);
  /** Consecutive frames from some other runtime than the one being shown. */
  const strayRef = useRef<{ id?: string; frames: number }>({ frames: 0 });

  /**
   * The one way a snapshot enters the page. A command response and a poll can
   * cross on the wire; an older frame of the same runtime arriving second must
   * not rewind the world (the motion player would read it as a restart).
   *
   * Nor may a frame from a different runtime replace a live one at once. On a
   * serverless host each instance runs its own world, and polls are spread
   * across them: the map cut between unrelated fleets every few hundred
   * milliseconds. A different world is adopted only when it persists for
   * ADOPT_AFTER_FRAMES polls in a row (a real restart or redeploy), or when a
   * command explicitly produced it (`adopt`, a reconfigure).
   */
  const accept = useCallback((next: FleetSnapshot, adopt = false): boolean => {
    const prev = worldRef.current;
    const prevRuntime = runtimeRef.current;
    if (prev && prevRuntime === next.runtimeId && next.world.tick < prev.tick) return false;
    if (!adopt && prev && next.runtimeId && prevRuntime !== next.runtimeId && liveRuntimeRef.current === prevRuntime) {
      const stray = strayRef.current;
      strayRef.current = stray.id === next.runtimeId ? { id: stray.id, frames: stray.frames + 1 } : { id: next.runtimeId, frames: 1 };
      if (strayRef.current.frames < ADOPT_AFTER_FRAMES) return false;
    }
    strayRef.current = { frames: 0 };
    liveRuntimeRef.current = next.runtimeId;
    worldRef.current = next.world;
    runtimeRef.current = next.runtimeId;
    if (prev && prevRuntime === next.runtimeId && next.world.metrics.conflictCount > prev.metrics.conflictCount) {
      // Detect the yield transitions between the two snapshots we have seen and
      // point a tooltip at the robot that actually yielded, exactly once per
      // real transition.
      for (const { robotId, position } of findYieldingRobots(prev, next.world)) {
        const id = `${robotId}-${next.world.tick}`;
        setConflictTooltips((t) => [...t, { id, robotId, text: `${robotId} yields — priority inherited`, position }]);
        setTimeout(() => setConflictTooltips((t) => t.filter((x) => x.id !== id)), TOOLTIP_LIFETIME_MS);
      }
    }
    setSnapshot(next);
    setLastUpdateAt(Date.now());
    if (Date.now() - cacheWrittenAt.current > CACHE_WRITE_MS) {
      cacheWrittenAt.current = Date.now();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), snapshot: next })); } catch { /* quota or privacy mode */ }
    }
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = new AbortController();

    const poll = async () => {
      const startedAt = performance.now();
      const revision = controlRevision.current;
      try {
        const response = await fetch('/api/fleet', { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) {
          if (!disposed) setStatus('error');
        } else {
          const next = (await response.json()) as FleetSnapshot;
          if (!disposed && revision === controlRevision.current) {
            accept(next);
            setStatus('live');
          }
        }
      } catch (caught) {
        // An abort on unmount is not a failure and must not paint the page red.
        if (disposed || (caught as Error)?.name === 'AbortError') return;
        if (!disposed) setStatus('error');
      }
      if (!disposed) timer = setTimeout(poll, Math.max(0, POLL_MS - (performance.now() - startedAt)));
    };

    // No `setStatus('connecting')` here on purpose. The state already starts as
    // 'connecting', the effect has empty dependencies so it runs exactly once,
    // and a remount re-initialises the state anyway — so a setState in the effect
    // body would be a pure cascading re-render, which is precisely what
    // `react-hooks/set-state-in-effect` flags (the same trap the judge-tour effect
    // above documents and works around with a deferred callback).
    // Paint the last known frame while the first poll is in flight (a cold
    // start can take seconds). It is shown as connecting, never as live.
    // Deferred for the same reason as the judge tour above: no setState in the
    // effect body. A poll that has already landed always wins.
    const restore = setTimeout(() => {
      const cached = readCachedSnapshot();
      if (cached && !disposed && !worldRef.current) {
        worldRef.current = cached.world;
        runtimeRef.current = cached.runtimeId;
        setSnapshot(cached);
      }
    }, 0);
    void poll();
    return () => { disposed = true; abort.abort(); clearTimeout(restore); if (timer) clearTimeout(timer); };
  }, [accept]);

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

  // Seconds spent waiting for the first frame, for the start-up screen. Same
  // 1 Hz pattern: no clock reads in render, no synchronous setState here.
  const [waitedS, setWaitedS] = useState(0);
  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    if (hasSnapshot) return;
    const start = Date.now();
    const id = setInterval(() => setWaitedS(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [hasSnapshot]);

  // ---- commands ----
  const send = useCallback(async (command: unknown, describe: (ok: boolean, detail?: string) => void) => {
    const kind = (command as { kind?: string }).kind;
    const seq = kind === 'reconfigure' ? ++reconfigureSeq.current : 0;
    try {
      // Every command names the world it was issued against. An instance running
      // a different world refuses it with 409 instead of applying it somewhere
      // nobody is looking, and it is retried, which on a multi-instance host
      // lands it on the instance that owns this world.
      const post = () => fetch('/api/fleet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(command as object), expectRuntime: liveRuntimeRef.current }),
        signal: AbortSignal.timeout(10_000),
      });
      let response = await post();
      for (let attempt = 0; response.status === 409 && attempt < WRONG_WORLD_RETRIES; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
        response = await post();
      }
      if (response.status === 409) {
        describe(false, 'the fleet server restarted; the page is switching to the new fleet, try again in a moment');
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        describe(false, body?.error ?? `command rejected (${response.status})`);
        return;
      }
      const confirmed = await response.json() as FleetSnapshot;
      // Every acknowledgement carries the state after the command, so it is
      // applied at once and any GET started before it is discarded. A superseded
      // reconfigure is not: its world was already replaced by a later one.
      if (kind !== 'reconfigure' || seq === reconfigureSeq.current) {
        controlRevision.current++;
        accept(confirmed, kind === 'reconfigure');
      }
      describe(true);
    } catch {
      describe(false, 'fleet runtime unreachable');
    }
  }, [accept]);

  const handleToggleSimulation = () => {
    if (simulationCommand.current) return;
    simulationCommand.current = true;
    setSimulationPending(true);
    const next = !(snapshot?.running ?? false);
    void send({ kind: next ? 'run' : 'pause' }, (ok, detail) => {
      simulationCommand.current = false;
      setSimulationPending(false);
      if (!ok) { addLog(`could not ${next ? 'start' : 'pause'} the fleet: ${detail}`, 'error'); return; }
      addLog(next ? 'fleet running — peer controllers stepping' : 'fleet paused', next ? 'info' : 'warning');
    });
  };

  // Manual task injection.
  //
  // Two things were wrong here. The weight came from Math.random, so every click
  // produced a different job and a demo could not be rehearsed or repeated. And
  // the success log fired on the HTTP 200 alone — which only means the runtime
  // ACCEPTED the announcement, not that anything happened — so a job whose
  // auction could not start for another 32 ticks produced one cheerful line and
  // then thirty seconds of silence that looked identical to a dead button.
  //
  // Now the id and endpoints are deterministic, the weight is chosen from a fixed
  // ladder (including a 60 kg job that only the Addverb can carry, so the payload
  // gate is visible), and the log states what is actually true at that instant:
  // announced, awaiting an ownership round.
  const handleCreateTask = () => {
    // The id comes from a counter, not from the last snapshot's task count: two
    // clicks inside one poll used to reuse the id and the second was rejected as
    // a duplicate. Seeding from the runtime's total keeps ids unique across a
    // page reload against the same runtime.
    const seqState = manualTaskSeq.current;
    if (seqState.runtimeId !== (snapshot?.runtimeId ?? '')) {
      manualTaskSeq.current = { runtimeId: snapshot?.runtimeId ?? '', next: 0 };
    }
    const n = Math.max(manualTaskSeq.current.next, snapshot?.taskTotals?.total ?? snapshot?.world.tasks.length ?? 0);
    manualTaskSeq.current.next = n + 1;
    const taskId = `M-${String(n).padStart(3, '0')}`;
    const pickups: Position[] = [{ x: 1, y: 0 }, { x: 14, y: 0 }, { x: 3, y: 9 }, { x: 9, y: 9 }];
    const dropoffs: Position[] = [{ x: 6, y: 12 }, { x: 17, y: 12 }, { x: 9, y: 1 }, { x: 13, y: 1 }];
    const weights = [15, 30, 60, 10, 45, 75];
    const task: Task = {
      id: taskId,
      pickup: pickups[n % pickups.length],
      dropoff: dropoffs[(n + 1) % dropoffs.length],
      weight: weights[n % weights.length],
      createdAt: snapshot?.world.tick ?? 0,
      priority: 1,
      status: 'pending',
    };
    setJustAnnounced((prev) => [...prev.slice(-2), taskId]);
    void send({ kind: 'task', task }, (ok, detail) => {
      if (!ok) { addLog(`task rejected: ${detail}`, 'error'); return; }
      addLog(
        `${taskId.toLowerCase()} announced (${task.weight} kg) — awaiting an ownership round, then A* and peer bidding`,
        'info',
      );
    });
  };

  const handleToggleOrderStream = () => {
    const next = !(snapshot?.orderStream?.enabled ?? false);
    // `order-stream` is harness state, not part of the runtime's command union,
    // so the cast is honest about widening the shape rather than pretending.
    void send({ kind: 'order-stream', on: next }, (ok, detail) => {
      if (!ok) { addLog(`could not change the order stream: ${detail}`, 'error'); return; }
      addLog(
        next
          ? 'order stream resumed — jobs are arriving every few ticks, so the fleet stays busy'
          : 'order stream paused — the fleet will drain its queue and go idle',
        next ? 'info' : 'warning',
      );
    });
  };

  // Read from the served map, not remembered: a resize rebuilds the world and
  // drops every block, and a robot standing in the aisle refuses its cell.
  const aisleBlocked = !!snapshot && AISLE_BLOCK_CELLS.some((p) =>
    snapshot.world.map.cells.some((c) => c.blocked && c.position.x === p.x && c.position.y === p.y));

  const handleBlockAisle = () => {
    if (aislePending) return;
    const next = !aisleBlocked;
    setAislePending(true);
    const failures: string[] = [];
    void Promise.all(AISLE_BLOCK_CELLS.map((position) =>
      send({ kind: 'block', position, blocked: next }, (ok, detail) => {
        if (!ok) failures.push(`(${position.x},${position.y}) ${detail}`);
      }))).then(() => {
      setAislePending(false);
      if (failures.length === AISLE_BLOCK_CELLS.length) {
        addLog(`could not ${next ? 'block' : 'clear'} the aisle: ${failures[0]}`, 'error');
        return;
      }
      addLog(
        next ? `aisle blocked at x=9 (rows 5-7) — routed traffic must replan around it${failures.length ? ` (skipped occupied ${failures.map(f => f.split(' ')[0]).join(', ')})` : ''}`
             : 'aisle cleared at x=9',
        next ? 'warning' : 'info'
      );
    });
  };

  const failTarget = snapshot?.world.robots.find((r) => r.id === 'AMR-02') ?? snapshot?.world.robots[0];

  const handleFailAMR = () => {
    if (failurePending) return;
    const target = failTarget;
    if (!target) return;
    const recovering = target.status === 'failed';
    setFailurePending(true);
    void send({ kind: recovering ? 'recover' : 'fail', robotId: target.id }, (ok, detail) => {
      if (!ok) { addLog(`${recovering ? 'recovery' : 'failure injection'} rejected: ${detail}`, 'error'); return; }
      addLog(recovering ? `${target.id.toLowerCase()} recovered — peer rejoins without resetting fleet work`
        : `${target.id.toLowerCase()} failure injected — recover it to clear any inaccessible delivery target`, recovering ? 'info' : 'error');
    }).finally(() => setFailurePending(false));
  };

  const severed = !!snapshot?.runtimeId && severedIn === snapshot.runtimeId;

  const handleToggleLink = () => {
    const [a, b] = snapshot?.world.robots.slice(0, 2).map((r) => r.id) ?? [];
    if (!a || !b) return;
    const reachable = severed;
    const runtimeId = snapshot?.runtimeId ?? null;
    void send({ kind: 'link', a, b, reachable }, (ok, detail) => {
      if (!ok) { addLog(`link change rejected: ${detail}`, 'error'); return; }
      setSeveredIn(reachable ? null : runtimeId);
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
  // The two staged scenarios genuinely do not exist on the distributed runtime.
  // They are now DISABLED in the panel with a visible reason, so these handlers
  // exist only to explain the tooltip and are never reachable from the UI.
  const notOnFleet = (what: string) => () =>
    addLog(`${what} is a central-simulation scenario and is not available on the distributed runtime`, 'warning');

  /**
   * Why each control is inert, shown on the control itself. A button that looks
   * live, takes the click, and only prints an internal error string into the log
   * is worse than a visibly disabled button: it costs the operator a demo cycle
   * and tells the audience nothing true.
   */
  const UNAVAILABLE = {
    simConflict: 'central-simulation scenario — use “block aisle” or “sever peer link” to force real contention',
    simDeadlock: 'central-simulation scenario — use “block aisle” to force a real detour',
  } as const;

  /**
   * Fleet size and the shelf layout are baked into a runtime at construction, so
   * changing either rebuilds it. That used to be impossible from here, which is
   * why both sliders were dead: they called a handler whose entire body was a log
   * message saying the dashboard could not do it. The server can now, so these
   * do the real thing and say plainly that the fleet restarted.
   */
  const robotCount = pendingLayout?.robots ?? snapshot?.layout?.robots ?? snapshot?.world.robots.length ?? 0;
  const shelfColCount = pendingLayout?.shelfColumns ?? snapshot?.layout?.shelfColumns ?? 6;
  const maxRobots = snapshot?.layout?.maxRobots ?? 10;

  // Sliders commit once, on release (see ControlPanel). Each commit is a full
  // restart, and a superseded one is ignored by `send`.
  const reconfigure = (change: { robots?: number; shelfColumns?: number }, describe: string) => {
    setPendingLayout(change);
    void send({ kind: 'reconfigure', ...change }, (ok, detail) => {
      setPendingLayout((current) => (current === change ? null : current));
      if (!ok) { addLog(`could not ${describe}: ${detail}`, 'error'); return; }
      addLog(`fleet restarted — ${describe}`, 'warning');
    });
  };

  const handleReset = () => {
    void send({ kind: 'reconfigure', robots: robotCount || 3 }, (ok, detail) => {
      if (!ok) { addLog(`could not reset the fleet: ${detail}`, 'error'); return; }
      setSelectedRobotId(null);
      setConflictTooltips([]);
      setJustAnnounced([]);
      addLog('fleet restarted — world rebuilt from scratch', 'warning');
    });
  };

  const handleRobotCountChange = (count: number) => {
    reconfigure({ robots: count }, `fleet resized to ${count} ${count === 1 ? 'robot' : 'robots'}`);
  };

  const handleShelfColCountChange = (count: number) => {
    reconfigure({ shelfColumns: count }, `warehouse rebuilt with ${count} shelf ${count === 1 ? 'column' : 'columns'}`);
  };

  // The runtime owns the authoritative event log, so the feed is derived from
  // it rather than mirrored into state — no chance of the two drifting.
  const events = snapshot?.events;
  const eventFeed = React.useMemo<LogEntry[]>(
    () => (events ?? []).slice(-8).map((e) => ({ time: `tick ${e.tick}`, text: e.text, type: 'info' as const })),
    [events]
  );
  const feed = React.useMemo(() => [...eventFeed, ...logs], [eventFeed, logs]);

  // ---- connection chrome ----
  //
  // The dashboard must never LOOK live while it is not. The previous version
  // kept rendering the full dashboard after the runtime went away, with the
  // tick counter frozen and the status dot still pulsing — a stale view that is
  // indistinguishable from a working one. In front of a jury that is the worst
  // failure mode available: it does not look like a bug, it looks like a system
  // that has stalled. So disconnection is stated, with the age of the data.
  if (!snapshot) {
    return (
      <div className="min-h-screen bg-[#09090b] text-[#fafafa] bg-[url('/bg.png')] bg-cover bg-fixed bg-center font-sans py-6 px-4 md:px-8 lg:px-12 flex justify-center items-start">
        <div className="w-full max-w-[1520px] bg-black/40 backdrop-blur-2xl rounded-2xl border border-zinc-800/80 shadow-[0_25px_70_-15px_rgba(0,0,0,0.85)] p-10">
          <Header onOpenTutorial={() => setIsTutorialOpen(true)} />
          <StartupScreen waitedS={waitedS} failed={disconnected} onRetry={() => window.location.reload()} />
        </div>
      </div>
    );
  }

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
          <span className={snapshot.topology === 'in-process' ? 'text-amber-300' : 'text-zinc-300'}>
            {snapshot.topology === 'in-process'
              ? 'in-process runtime — single Next server (set FLEET_URL for one-process-per-robot)'
              : 'node-hosted distributed peers'}
          </span>

          {status === 'connecting' ? (
            <span className="flex items-center gap-1.5 text-amber-300">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              waking the fleet server — showing last known frame
            </span>
          ) : disconnected ? (
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
              <RollingText value={snapshot.running ? 'running' : 'paused'} />
            </span>
          )}
          <span className="text-zinc-400 tabular-nums">
            tick <RollingText value={world.tick.toLocaleString()} pace="sampled" />
            {disconnected && frozenFor !== null && (
              <span className="text-amber-300"> · frozen for <RollingText value={`${frozenFor}s`} /></span>
            )}
          </span>
          <span className="text-zinc-400">
            swaps <RollingText className={safety.swaps > 0 ? 'text-amber-300' : 'text-zinc-300'} value={safety.swaps} />
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
                <span className="text-red-300"><RollingText value={safety.overlaps} /> collisions</span>
                <span className="text-red-300/80">safety invariant broken</span>
              </>
            ) : (
              <>
                <span className="text-emerald-200">0 collisions</span>
                <span className="text-emerald-300 tabular-nums">
                  across <RollingText value={world.tick.toLocaleString()} pace="sampled" /> ticks
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
              tick={world.tick}
              motionHistory={snapshot.motionHistory}
              runtimeId={snapshot.runtimeId}
              running={snapshot.running && status === 'live'}
            />

            <div className="shrink-0 flex flex-col gap-4">
              <ControlPanel
                isSimulating={snapshot.running}
                simulationPending={simulationPending}
                robotCount={robotCount}
                maxRobots={maxRobots}
                shelfColCount={shelfColCount}
                aisleBlocked={aisleBlocked}
                aislePending={aislePending}
                onCreateTask={handleCreateTask}
                onToggleSimulation={handleToggleSimulation}
                onSimulateConflict={notOnFleet('sim conflict')}
                onSimulateDeadlock={notOnFleet('sim deadlock')}
                onFailAMR={handleFailAMR}
                amrFailed={failTarget?.status === 'failed'}
                failTargetId={failTarget?.id}
                failurePending={failurePending}
                onBlockAisle={handleBlockAisle}
                onReset={handleReset}
                onRobotCountChange={handleRobotCountChange}
                onShelfColCountChange={handleShelfColCountChange}
                unavailable={UNAVAILABLE}
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
                  onClick={handleToggleOrderStream}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    snapshot.orderStream?.enabled
                      ? 'border-emerald-300/40 text-emerald-300 hover:bg-emerald-400/10'
                      : 'border-zinc-600 text-zinc-300 hover:bg-white/5'
                  }`}
                >
                  {snapshot.orderStream?.enabled ? 'Pause order stream' : 'Resume order stream'}
                </button>
                <button
                  onClick={handleToggleBids}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-600 text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  {snapshot.aiEnabled ? 'Disable learned bids' : 'Enable learned bids'}
                </button>
                <span className="text-[11px] font-mono text-zinc-400">
                  bids with AI: <RollingText value={metrics.aiBidAttempts} pace="sampled" /> · nonzero corrections: <RollingText value={metrics.nonzeroCorrections} pace="sampled" /> ·
                  deterministic fallbacks: <RollingText value={metrics.disabledFallbacks + metrics.failedModelFallbacks} pace="sampled" /> ·
                  energy holds: <RollingText value={metrics.energyHolds} pace="sampled" />
                </span>
              </div>

              <MetricsBar tasks={world.tasks} robots={world.robots} metrics={world.metrics} totals={snapshot.taskTotals} />

              <div id="tour-tasks-and-logs" className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ActiveTasks tasks={world.tasks} robots={world.robots} awaitingAuction={justAnnounced} />
                <EventLog logs={feed} />
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
