import { FleetRuntime, MOTION_HISTORY_TICKS, type FleetTraffic } from "../core/distributed/runtime";
import { loadFleetConfig } from "../core/fleet/config";
import { createWarehouseMap } from "../core/map/warehouse";
import { createFleetRoster } from "../core/simulation/state";
import { OrderBook } from "./order-book";
import { layoutWithShelfColumns } from "./layout";
import type { RobotState, WarehouseMap, WorldState } from "../core/types";

// One long-lived Node runtime. HTTP/browser lifetime never drives robot ticks.
// Deployment target is the separate fleet-http Node process, not serverless.
//
// Two things are baked into a runtime at construction and cannot be changed in
// place: fleet MEMBERSHIP (ownership quorum is derived from it) and the MAP (it
// is a constructor argument that every planner reads). The dashboard exposes
// sliders for both, and for a long time they were wired to log messages that did
// nothing at all, because there was no honest way to honour them. There is now:
// `reconfigureFleet` builds a new runtime with the requested shape and swaps it
// in. That is a restart, the dashboard says so, and it is a real change you can
// watch take effect — which is a far better demo than a slider that lies.
const key = Symbol.for("sih.fleet-runtime.v2");

type Config = { robots: number; shelfColumns: number; orderStream: boolean };
type Holder = {
  runtime: FleetRuntime;
  orderBook: OrderBook;
  timer: ReturnType<typeof setInterval>;
  config: Config;
  lastStepAt: number;
};

/** Nominal tick. The dashboard measures the real cadence, but it should be this. */
const TICK_MS = 250;
/**
 * The interval only CHECKS whether a tick is due; the schedule itself is
 * `lastStepAt += TICK_MS`. Stepping on a 250 ms interval and stamping
 * `lastStepAt = now` let every late timer push the whole schedule back, so the
 * fleet really ran at ~260 ms and every animated cell ended in a stall.
 */
const CHECK_MS = 25;
/**
 * A suspended host (serverless) catches up at most this many ticks on wake.
 * It equals the runtime's retained motion history, so a client that
 * polls right after a catch-up still receives every committed cell.
 */
const MAX_CATCH_UP_TICKS = MOTION_HISTORY_TICKS;
/**
 * Fleet size is bounded by the robot templates that exist. The slider used to
 * allow 20 while only 10 templates existed, so 11..20 silently built 10 robots
 * and the next poll yanked the slider back. The roster now has twenty.
 */
export const MAX_FLEET_ROBOTS = createFleetRoster().length;
/** Released-but-unfinished jobs per robot before the order stream holds back. */
const OUTSTANDING_JOBS_PER_ROBOT = 2;
/**
 * Dense-fleet traffic aids for the served runtime (off by default in the
 * runtime itself, so benchmark runs are unchanged).
 *
 * Without them the served fleet froze for good within ten minutes at every
 * size from ten robots up: no job completed in the last third of any measured
 * run. The causes, each one measured, were robots that took jobs with no
 * battery slack and could then not afford a side-step around traffic; robots
 * holding jobs the move gate would never let them start, and so never charging;
 * idle robots parked on chargers; queues boxing in the dead-end charger; and
 * robots drained below the reserve on the way to charge, stranded mid-floor.
 * Over 8 seeds x 10/15/20 robots x 20 minutes, with these on, see the PR for
 * #38 for the numbers.
 */
export const TRAFFIC_AIDS: FleetTraffic = {
  loadAwareCharging: true,
  stationEtiquette: true,
  deadlockRecovery: true,
  chargeMarginPercent: 15,
};

function configFromEnv(): Config {
  let robots = 3;
  try { robots = loadFleetConfig().robots.length; } catch { /* unconfigured local dev */ }
  return { robots: Math.min(robots, MAX_FLEET_ROBOTS), shelfColumns: 6, orderStream: true };
}

/**
 * Build a runtime for an explicit shape. The map is generated for the requested
 * number of rack columns, the fleet is truncated or extended to the requested
 * size, and the seeded tasks are dropped in favour of the harness order stream
 * for the same reason they always were: allocation belongs to the runtime and
 * must not inherit the central simulator's pre-assigned work.
 */
function build(config: Config): { runtime: FleetRuntime; map: WarehouseMap } {
  const map = layoutWithShelfColumns(createWarehouseMap(), config.shelfColumns);
  // The roster MUST be built here, explicitly.
  //
  // FleetRuntime only sizes the fleet when it is handed NO world at all; given an
  // explicit world it takes the membership it is given and never truncates. That
  // is the right contract for the benchmark, and the wrong one for a size the
  // operator just picked on a slider: passing an empty robot list produced a
  // zero-robot runtime that stepped forever, could never own a task, and left the
  // dashboard showing an empty warehouse with a live tick counter.
  const templates = createFleetRoster();
  const robots: RobotState[] = templates.slice(0, config.robots).map((t) => ({
    ...t,
    position: { ...t.position },
    home: { ...t.home },
    battery: 100,
    status: "idle" as const,
    path: [],
    currentTaskId: undefined,
    queuedTaskIds: [],
  }));
  const world: WorldState = {
    tick: 0,
    map,
    robots,
    // No seeded tasks: allocation belongs to the runtime, and the harness order
    // stream is what puts work in front of it.
    tasks: [],
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
  return { runtime: new FleetRuntime(world, undefined, { traffic: TRAFFIC_AIDS }), map };
}

function start(config: Config): Holder {
  const { runtime } = build(config);
  // Demand is bounded by what the fleet can absorb. An unbounded stream piled
  // up ~480 jobs in ten minutes against ~50 completions with three robots, and
  // every one of them was cloned, serialised, polled and rendered 4x a second.
  const orderBook = new OrderBook(runtime, undefined, {
    maxOutstanding: Math.max(4, OUTSTANDING_JOBS_PER_ROBOT * runtime.world.robots.length),
  });
  orderBook.setEnabled(config.orderStream);
  orderBook.releaseDue();
  const timer = setInterval(() => advanceIfDue(current), CHECK_MS);
  const current: Holder = { runtime, orderBook, config, lastStepAt: Date.now(), timer };
  timer.unref();
  return current;
}

function holder(): Holder {
  const root = globalThis as typeof globalThis & { [key]?: Holder };
  if (!root[key]) root[key] = start(configFromEnv());
  return root[key]!;
}

export function fleetService(): FleetRuntime { return holder().runtime; }

/**
 * Advance the in-process runtime by one tick if a tick is due.
 *
 * The 250 ms interval is enough on a long-lived server and useless on a host that
 * freezes the process between requests — a serverless function can be suspended,
 * so the interval may not run at all until the next invocation. Stepping on read
 * means a frozen instance still moves the fleet forward the moment anyone looks
 * at it, which is the difference between a demo that is merely choppy and one
 * that is permanently stuck on tick 0.
 */
function advanceIfDue(current: Holder): void {
  const now = Date.now();
  if (now - current.lastStepAt < TICK_MS) return;
  if (now - current.lastStepAt >= TICK_MS * (MAX_CATCH_UP_TICKS + 1)) {
    current.lastStepAt = now - TICK_MS * MAX_CATCH_UP_TICKS;
  }
  while (now - current.lastStepAt >= TICK_MS) {
    current.lastStepAt += TICK_MS;
    current.orderBook.releaseDue();
    current.runtime.step();
  }
}

export function stepIfDue(): void { advanceIfDue(holder()); }

export function fleetOrderBook(): OrderBook { return holder().orderBook; }

/**
 * Commands name the world they were issued against (`expectRuntime`, the
 * runtimeId the dashboard is showing). On a serverless host each instance runs
 * its own world, so a command routed to a different instance used to be applied
 * to a world nobody was looking at: it answered 200 and nothing visible happened.
 * Now that instance refuses it with 409 and the dashboard retries, which in
 * practice lands it on the instance that owns the world. Strips the field so the
 * runtime never sees it. Returns the refusal message, or null to proceed.
 */
export function wrongWorld(command: Record<string, unknown>): string | null {
  const expected = command.expectRuntime;
  delete command.expectRuntime;
  if (expected === undefined) return null;
  const actual = fleetService().runtimeId;
  return expected === actual ? null : `command was for fleet ${String(expected).slice(0, 8)}, this server runs ${actual.slice(0, 8)}`;
}
export function fleetConfig(): Config { return { ...holder().config }; }
/** The layout the served runtime was actually built with, for the dashboard's controls. */
export function fleetLayout() {
  const { config, runtime } = holder();
  return { robots: runtime.world.robots.length, shelfColumns: config.shelfColumns, maxRobots: MAX_FLEET_ROBOTS };
}

/**
 * Rebuild the runtime with a new fleet size and/or shelf layout, preserving the
 * order-stream setting. Any blocked cells from the "block aisle" control are
 * dropped along with the old world, which is correct: they were an experiment on
 * the old map.
 */
export function reconfigureFleet(next: Partial<Config>): Config {
  const current = holder();
  const merged: Config = {
    robots: Math.min(next.robots ?? current.config.robots, MAX_FLEET_ROBOTS),
    shelfColumns: next.shelfColumns ?? current.config.shelfColumns,
    orderStream: next.orderStream ?? current.config.orderStream,
  };
  // Reconfiguration is an explicit restart. In particular, Reset sends the
  // current fleet size; treating that as a no-op left the old world running.
  clearInterval(current.timer);
  const root = globalThis as typeof globalThis & { [key]?: Holder };
  root[key] = start(merged);
  // Release a couple of jobs immediately so a resized fleet is never briefly idle.
  root[key]!.orderBook.releaseDue();
  return merged;
}
