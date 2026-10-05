import { FleetRuntime } from "../core/distributed/runtime";
import { loadFleetConfig } from "../core/fleet/config";
import { createWarehouseMap } from "../core/map/warehouse";
import { createInitialWorld } from "../core/simulation/state";
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

/** Must match TICK_MS in the dashboard's interpolation and the interval below. */
const TICK_MS = 250;

function configFromEnv(): Config {
  let robots = 3;
  try { robots = loadFleetConfig().robots.length; } catch { /* unconfigured local dev */ }
  return { robots, shelfColumns: 6, orderStream: true };
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
  const templates = createInitialWorld().robots;
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
  return { runtime: new FleetRuntime(world), map };
}

function start(config: Config): Holder {
  const { runtime } = build(config);
  const orderBook = new OrderBook(runtime);
  orderBook.setEnabled(config.orderStream);
  orderBook.releaseDue();
  const timer = setInterval(() => advanceIfDue(current), TICK_MS);
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
  current.lastStepAt = now;
  current.orderBook.releaseDue();
  current.runtime.step();
}

export function stepIfDue(): void { advanceIfDue(holder()); }

export function fleetOrderBook(): OrderBook { return holder().orderBook; }
export function fleetConfig(): Config { return { ...holder().config }; }

/**
 * Rebuild the runtime with a new fleet size and/or shelf layout, preserving the
 * order-stream setting. Any blocked cells from the "block aisle" control are
 * dropped along with the old world, which is correct: they were an experiment on
 * the old map.
 */
export function reconfigureFleet(next: Partial<Config>): Config {
  const current = holder();
  const merged: Config = {
    robots: next.robots ?? current.config.robots,
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
