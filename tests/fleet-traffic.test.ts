// Liveness of the served fleet under its own order stream (#38).
//
// Without the traffic aids, every measured run from ten robots up stopped
// completing work for good within ten minutes: robots boxed in around chargers
// and in single-lane aisles, unable to afford the side-step that would free
// their neighbours. This runs the served configuration, the same world, order
// stream and TRAFFIC_AIDS the dashboard gets, and requires the fleet still to
// be delivering in the final third of a ten-minute run.
import { describe, it, expect } from "vitest";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createWarehouseMap } from "../src/core/map/warehouse";
import { createFleetRoster } from "../src/core/simulation/state";
import { OrderBook } from "../src/server/order-book";
import { layoutWithShelfColumns } from "../src/server/layout";
import { TRAFFIC_AIDS } from "../src/server/fleet-service";
import type { FleetTraffic } from "../src/core/distributed/runtime";
import type { RobotState, WorldState } from "../src/core/types";

function served(robots: number, options: { traffic?: FleetTraffic } = { traffic: TRAFFIC_AIDS }) {
  const world: WorldState = {
    tick: 0,
    map: layoutWithShelfColumns(createWarehouseMap(), 6),
    robots: createFleetRoster().slice(0, robots).map((t) => ({
      ...t, position: { ...t.position }, home: { ...t.home }, battery: 100,
      status: "idle" as const, path: [], currentTaskId: undefined, queuedTaskIds: [],
    })) as RobotState[],
    tasks: [],
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
  const runtime = new FleetRuntime(world, undefined, options);
  const book = new OrderBook(runtime, 1, { maxOutstanding: 2 * robots });
  book.setEnabled(true);
  return { runtime, book };
}

const TEN_MINUTES = 2400;
const completed = (rt: FleetRuntime) => rt.world.tasks.filter((t) => t.status === "completed").length;

describe("served fleet traffic", () => {
  it("is still delivering at the end of a ten-minute run, with nobody colliding", () => {
    const { runtime, book } = served(10);
    let atTwoThirds = 0;
    for (let tick = 0; tick < TEN_MINUTES; tick++) {
      if (tick === (TEN_MINUTES * 2) / 3) atTwoThirds = completed(runtime);
      book.releaseDue();
      runtime.step();
    }
    expect(completed(runtime) - atTwoThirds).toBeGreaterThan(20);
    expect(runtime.safety.overlaps).toBe(0);
    expect(runtime.safety.swaps).toBe(0);
    expect(runtime.safety.zeroBatteryWork).toBe(0);
  }, 120_000);

  it("leaves the runtime's default behaviour alone", () => {
    // The aids are opt-in, so benchmarks and every existing measured run are
    // unchanged unless they ask for them.
    const off = served(10, { traffic: {} }), plain = served(10, {});
    for (let tick = 0; tick < 1200; tick++) {
      off.book.releaseDue(); off.runtime.step();
      plain.book.releaseDue(); plain.runtime.step();
    }
    expect(off.runtime.world.robots).toEqual(plain.runtime.world.robots);
    expect(off.runtime.world.tasks).toEqual(plain.runtime.world.tasks);
  }, 60_000);
});
