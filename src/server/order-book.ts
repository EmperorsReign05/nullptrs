// A deterministic, continuous order stream for the deployed demo.
//
// WHY THIS EXISTS
// The FleetRuntime deliberately boots with an EMPTY task list (see the
// constructor: a self-constructed world has its seeded tasks wiped, because the
// distributed runtime owns allocation and must not inherit the central
// simulator's pre-assigned work). That is correct for the runtime and fatal for
// the demo: the dashboard loaded onto three idle robots, an empty warehouse, and
// a tick counter spinning four times a second with nothing behind it. The only
// way to create work was the "create task" button, which announces a single job
// and then shows nothing at all for the ~100 ticks it takes the ownership epoch
// and the fleet to retire it — about thirty seconds of dead air that looks
// exactly like a dead button.
//
// So the demo harness supplies the demand, not the engine. This is a HARNESS
// concern and it lives here, in the server entry point, rather than in the
// runtime: the runtime's semantics are unchanged, and a caller that supplies
// its own world still gets exactly the workload it asked for.
//
// DETERMINISM. No Math.random anywhere. The same sequence of jobs is produced on
// every start, so a demo can be rehearsed and a judge who asks "run it again"
// gets the same thing. The dashboard's own "create task" button used
// Math.random for task weight, which made every click a different system; that
// is fixed separately.

import type { Task } from "../core/types";
import { isTraversable } from "../core/map/warehouse";
import type { FleetRuntime } from "../core/distributed/runtime";

/** Real, traversable cells that read as a warehouse on screen. */
const PICKUP_ZONES: [number, number][] = [
  [1, 0], [14, 0], [3, 9], [9, 9], [12, 8], [6, 4], [17, 4], [9, 0],
];
const DROPOFF_ZONES: [number, number][] = [
  [6, 12], [17, 12], [9, 1], [13, 1], [3, 12], [12, 12], [0, 8], [19, 0],
];

/**
 * Deliberately includes weights above the Scout Agile 2.0's 50 kg capacity, so
 * the payload eligibility gate is visible on screen: a 60 kg job can only ever
 * be won by the Addverb Dynamo 100, and a judge can watch that happen.
 */
const WEIGHTS = [15, 30, 60, 10, 45, 75];

/** Ticks between releases. Fast enough that several jobs are in flight at once,
 *  which is the only way the auction is ever visibly doing something. */
export const RELEASE_INTERVAL_TICKS = 5;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export class OrderBook {
  private random: () => number;
  private next = 0;
  private released = new Set<string>();
  private stopped = false;
  enabled = true;

  constructor(private runtime: FleetRuntime, seed = 0x5EED) {
    this.random = lcg(seed);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.stopped = !on;
  }

  /** Jobs announced so far, and jobs still to come. Surfaced in the dashboard. */
  stats() {
    return { announced: this.released.size, enabled: this.enabled, intervalTicks: RELEASE_INTERVAL_TICKS };
  }

  /**
   * Announce everything whose release tick has arrived. Called once per runtime
   * tick by the server loop; idempotent per task id, and it never mutates the
   * runtime directly — every job goes through the same public command surface a
   * dashboard click uses, so this cannot create work the API could not.
   */
  releaseDue(): void {
    if (this.stopped) return;
    const now = this.runtime.world.tick;
    while (this.next * RELEASE_INTERVAL_TICKS <= now) {
      const createdAt = this.next * RELEASE_INTERVAL_TICKS;
      const task = this.build(createdAt);
      if (task) {
        try {
          this.runtime.command({ kind: "task", task });
          this.released.add(task.id);
        } catch {
          // A rejected job must not stall the stream. The runtime's own
          // validation is the authority on what a legal task is; if it says no,
          // skip this one rather than retry-looping on it.
        }
      }
      this.next++;
      if (this.next > 1e6) return; // pathological guard; unreachable in a demo
    }
  }

  private build(createdAt: number): Task | null {
    const map = this.runtime.world.map;
    const openCells: [number, number][] = map.cells
      .filter((cell) => !cell.blocked)
      .map((cell) => [cell.position.x, cell.position.y]);
    if (!openCells.length) return null;
    // Only offer cells that are actually walkable on the CURRENT map.
    //
    // The zone lists above read as a warehouse on screen, but widening the aisles
    // (the shelf slider) walls off the right-hand columns, which is where half of
    // them live. Taking them unconditionally produced a silent dead demo: every
    // job was rejected as invalid, so pulling the shelf slider stopped the order
    // stream dead with nothing on screen to say why. If the preferred zones are
    // all blocked, fall back to whatever is open rather than stalling.
    const walkable = (c: [number, number]) => isTraversable({ x: c[0], y: c[1] }, map);
    const pool = (preferred: [number, number][]) => (preferred.length ? preferred : openCells);
    const choose = (list: [number, number][]) => list[Math.floor(this.random() * list.length)];
    const p = choose(pool(PICKUP_ZONES.filter(walkable)));
    const d = choose(pool(DROPOFF_ZONES.filter(walkable)));
    if (p[0] === d[0] && p[1] === d[1]) return null;
    return {
      // Sequential, human-readable, and never colliding with the historical
      // T-102..T-104 ids the simulator route uses.
      id: `W-${String(createdAt).padStart(6, "0")}`,
      pickup: { x: p[0], y: p[1] },
      dropoff: { x: d[0], y: d[1] },
      weight: WEIGHTS[Math.floor(this.random() * WEIGHTS.length)],
      createdAt,
      priority: 1,
      status: "pending",
    };
  }
}
