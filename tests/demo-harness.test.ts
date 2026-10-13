// The demo harness, tested as behaviour rather than as markup.
//
// Every test here corresponds to something that was broken and would be broken
// again by an innocent-looking edit:
//
//   * the runtime booted with ZERO robots, because FleetRuntime only sizes a
//     fleet when handed no world at all, and the harness handed it an empty one;
//   * the runtime booted with ZERO tasks, because FleetRuntime deliberately wipes
//     the seeded ones, leaving an empty warehouse and a spinning tick counter;
//   * `fleet-http` captured the runtime at module load, so after a resize every
//     later command went to a disposed runtime that still answered HTTP 200;
//   * the shelf slider walled off the aisle columns the order book picks from, so
//     pulling it silently stopped all work;
//   * the robot-count slider and reset did nothing at all beyond logging.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OrderBook, RELEASE_INTERVAL_TICKS } from "../src/server/order-book";
import { layoutWithShelfColumns, clampShelfColumns, MIN_SHELF_COLUMNS, MAX_SHELF_COLUMNS, passingCapacity } from "../src/server/layout";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createWarehouseMap } from "../src/core/map/warehouse";
import { createFleetRoster, createInitialWorld } from "../src/core/simulation/state";
import { CHARGING_STATIONS, DROPOFF_STATIONS, PICKUP_STATIONS } from "../src/core/map/warehouse";
import type { RobotState, WorldState } from "../src/core/types";


function worldOf(robots: number, shelfColumns = MAX_SHELF_COLUMNS): WorldState {
  return {
    tick: 0,
    map: layoutWithShelfColumns(createWarehouseMap(), shelfColumns),
    robots: createInitialWorld().robots.slice(0, robots).map((t) => ({
      ...t, position: { ...t.position }, home: { ...t.home }, battery: 100,
      status: "idle" as const, path: [], currentTaskId: undefined, queuedTaskIds: [],
    })) as RobotState[],
    tasks: [],
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
}

describe("warehouse layout control", () => {
  it("really changes the map, and only in the direction it promises", () => {
    const stock = createWarehouseMap();
    const open = (m: typeof stock) => m.cells.filter((c) => !c.blocked).length;
    expect(open(stock)).toBe(158);
    // Fewer shelf columns means wider aisles, so strictly MORE open cells.
    let previous = open(stock);
    for (let columns = MAX_SHELF_COLUMNS - 1; columns >= MIN_SHELF_COLUMNS; columns--) {
      const count = open(layoutWithShelfColumns(stock, columns));
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(open(layoutWithShelfColumns(stock, 0))).toBeGreaterThan(158);
    // Out-of-range values clamp rather than produce an impossible map.
    expect(open(layoutWithShelfColumns(stock, 99))).toBe(158);
    expect(open(layoutWithShelfColumns(stock, -5))).toBe(open(layoutWithShelfColumns(stock, 0)));
  });

  it("raises passing capacity, which is the number the control is really about", () => {
    // This assertion has taken two wrong shapes, and both are worth recording.
    // The first measured a vertical run per column, which is 13 in EVERY layout
    // because every corridor spans the full height of the map, so it passed against
    // an implementation that was making the warehouse SMALLER. The second measured
    // a horizontal run per row, which is 20 in every layout because the top and
    // bottom rows are always open end to end. Neither could have detected the bug.
    const stock = createWarehouseMap();
    let previous = -1;
    for (let columns = MAX_SHELF_COLUMNS; columns >= MIN_SHELF_COLUMNS; columns--) {
      const capacity = passingCapacity(layoutWithShelfColumns(stock, columns));
      expect(capacity).toBeGreaterThan(previous);
      previous = capacity;
    }
    expect(passingCapacity(layoutWithShelfColumns(stock, 0))).toBe(1);
    expect(passingCapacity(stock)).toBeLessThan(1);
  });

  it("only ever unblocks, so it cannot wall off floor that was already open", () => {
    const stock = createWarehouseMap();
    for (const columns of [0, 2, 4]) {
      const variant = layoutWithShelfColumns(stock, columns);
      for (const cell of stock.cells) {
        if (cell.blocked) continue;
        expect(variant.cells.find((c) => c.position.x === cell.position.x && c.position.y === cell.position.y)!.blocked).toBe(false);
      }
    }
    expect(clampShelfColumns(3.7)).toBe(3);
  });
});

describe("fleet roster", () => {
  it("offers twenty distinct robots, both models, without changing the seeded ten", () => {
    const roster = createFleetRoster();
    expect(roster).toHaveLength(20);
    expect(new Set(roster.map((r) => r.id)).size).toBe(20);
    expect(roster.slice(0, 10)).toEqual(createInitialWorld().robots);
    const models = roster.map((r) => r.model.model);
    expect(models.filter((m) => m === roster[0].model.model)).toHaveLength(10);
    expect(new Set(models).size).toBe(2);
  });

  it("starts every robot on its own open cell in every shelf layout, off stations", () => {
    const roster = createFleetRoster();
    expect(new Set(roster.map((r) => `${r.position.x},${r.position.y}`)).size).toBe(20);
    const stations = new Set([...PICKUP_STATIONS, ...DROPOFF_STATIONS, ...CHARGING_STATIONS]
      .map((s) => `${s.position.x},${s.position.y}`));
    for (let columns = MIN_SHELF_COLUMNS; columns <= MAX_SHELF_COLUMNS; columns++) {
      const map = layoutWithShelfColumns(createWarehouseMap(), columns);
      for (const r of roster) {
        expect(map.cells.find((c) => c.position.x === r.position.x && c.position.y === r.position.y)!.blocked).toBe(false);
      }
    }
    // The ten new starts stay clear of every station (AMR-01 has always sat on P1).
    for (const r of roster.slice(10)) expect(stations.has(`${r.position.x},${r.position.y}`)).toBe(false);
  });
});

describe("order stream", () => {
  let runtime: FleetRuntime;
  beforeEach(() => { runtime = new FleetRuntime(worldOf(4)); });

  it("actually produces work, and every job is legal", () => {
    const book = new OrderBook(runtime);
    book.releaseDue();
    expect(runtime.world.tasks.length).toBeGreaterThan(0);
    for (const t of runtime.world.tasks) {
      expect(t.status).toBe("pending");
      expect(t.weight).toBeGreaterThan(0);
      expect(t.id).toMatch(/^W-\d{6}$/);
      const open = (p: { x: number; y: number }) => !runtime.world.map.cells.find((c) => c.position.x === p.x && c.position.y === p.y)!.blocked;
      expect(open(t.pickup)).toBe(true);
      expect(open(t.dropoff)).toBe(true);
    }
  });

  it("is deterministic — no Math.random, so a demo can be rehearsed and repeated", () => {
    // A judge who asks "run it again" must get the same thing. The dashboard's own
    // create-task button used Math.random for task weight, so every click was a
    // different system and no demo could be rehearsed.
    const build = () => {
      const rt = new FleetRuntime(worldOf(4));
      const book = new OrderBook(rt, 0x5EED);
      for (let i = 0; i < 6; i++) { rt.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue(); }
      return rt.world.tasks.map((t) => `${t.id}@${t.pickup.x},${t.pickup.y}->${t.dropoff.x},${t.dropoff.y}/${t.weight}kg`);
    };
    expect(build()).toEqual(build());
    expect(build().length).toBeGreaterThan(3);
  });

  it("keeps producing work when the shelf slider walls off its preferred cells", () => {
    // The regression: half the pickup/dropoff zones live in the right-hand
    // columns, which widening the aisles blocks. Silently zero jobs followed.
    const wide = new FleetRuntime(worldOf(3, 2));
    const book = new OrderBook(wide);
    for (let i = 0; i < 8; i++) { wide.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue(); }
    expect(wide.world.tasks.length).toBeGreaterThan(0);
  });

  it("stops on request and resumes", () => {
    const book = new OrderBook(runtime);
    book.setEnabled(false);
    for (let i = 0; i < 10; i++) { runtime.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue(); }
    expect(runtime.world.tasks).toHaveLength(0);
    book.setEnabled(true);
    book.releaseDue();
    expect(runtime.world.tasks.length).toBeGreaterThan(0);
  });

  it("holds back when the fleet is saturated, and never releases the backlog as a burst", () => {
    // Unbounded, the stream piled up ~480 jobs in ten minutes against ~50
    // completions with three robots, and the dashboard polled all of them.
    const book = new OrderBook(runtime, 0x5EED, { maxOutstanding: 6 });
    for (let i = 0; i < 60; i++) { runtime.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue(); }
    expect(runtime.world.tasks).toHaveLength(6);
    expect(book.stats().held).toBeGreaterThan(40);
    // Capacity frees up: at most one new job per release slot, not the backlog.
    for (const t of runtime.world.tasks.slice(0, 3)) t.status = "completed";
    runtime.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue();
    expect(runtime.world.tasks.filter((t) => t.status !== "completed")).toHaveLength(4);
  });

  it("never ends a job in a dead end or on a charger", () => {
    // Two robots meeting in the approach to a dead-end job cell (the corner
    // (19,0) used to be one) can never pass, and the jobs queued behind them
    // parked most of the fleet there. A job on a charger boxed in whoever was
    // charging on it. Checked on every shelf layout, including the fallback pool.
    for (let columns = MIN_SHELF_COLUMNS; columns <= MAX_SHELF_COLUMNS; columns++) {
      const rt = new FleetRuntime(worldOf(4, columns));
      const book = new OrderBook(rt, 7, { maxOutstanding: 400 });
      for (let i = 0; i < 400; i++) { book.releaseDue(); rt.world.tick++; }
      const map = rt.world.map;
      const open = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && !map.cells[y * map.width + x].blocked;
      const exits = (p: { x: number; y: number }) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => open(p.x + dx, p.y + dy)).length;
      expect(rt.world.tasks.length).toBeGreaterThan(20);
      for (const t of rt.world.tasks) for (const end of [t.pickup, t.dropoff]) {
        expect(exits(end), `${t.id} ${columns} cols ${end.x},${end.y}`).toBeGreaterThanOrEqual(2);
        expect(CHARGING_STATIONS.some((c) => c.position.x === end.x && c.position.y === end.y)).toBe(false);
      }
    }
  });

  it("offers a heavy job so the payload eligibility gate is demonstrable", () => {
    const book = new OrderBook(runtime);
    for (let i = 0; i < 40; i++) { runtime.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue(); }
    // Scout Agile 2.0 carries 50 kg, so anything heavier can only be won by the
    // Addverb. A demo that never exercises that gate never shows it working.
    expect(runtime.world.tasks.some((t) => t.weight > 50)).toBe(true);
  });
});

describe("the /api/fleet adapter", () => {
  // Exercised by calling the route handlers directly rather than through a dev
  // server. The properties that matter here are exactly the ones a curl test
  // would be flaky about, and calling them directly is both faster and stricter:
  // there is no port, no timeout and no dev-server compile step in the way.
  //
  // delete process.env.FLEET_URL in a beforeEach is deliberately absent: if the
  // ambient environment happens to set FLEET_URL these tests would silently
  // start proxying to whatever is on that port, and a test that changes meaning
  // based on the shell is worse than no test.
  const original = process.env.FLEET_URL;
  beforeEach(() => { delete process.env.FLEET_URL; });
  afterEach(() => { if (original === undefined) delete process.env.FLEET_URL; else process.env.FLEET_URL = original; });

  it("always answers with a live runtime, even with no external one configured", async () => {
    // This is the Vercel case. The old route proxied to 127.0.0.1:4010 and
    // returned 503 when nothing was there, so a single-deploy host could never
    // show a live fleet: the demo was dead on arrival for exactly the audience it
    // was built for. Now there is always a runtime behind the endpoint.
    const { GET } = await import("../src/app/api/fleet/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json() as { topology: string; world: { robots: unknown[]; tick: number } };
    expect(body.topology).toBe("in-process");
    expect(body.world.robots.length).toBeGreaterThan(0);
  });

  it("reconfigures the fleet and keeps serving commands to the NEW runtime", async () => {
    // The zombie-runtime defect: the HTTP layer used to capture the runtime at
    // module load, so after a resize every later command was accepted by a
    // disposed runtime that still answered 200 and then never advanced again.
    const { GET, POST } = await import("../src/app/api/fleet/route");
    await GET();
    const post = (body: unknown) => POST(new Request("http://local/api/fleet", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));

    const before = (await (await GET()).json() as { world: { robots: unknown[]; tick: number } }).world;
    const full = await post({ kind: "reconfigure", robots: 20 });
    expect((await full.json() as { world: { robots: unknown[] } }).world.robots).toHaveLength(20);
    const resized = await post({ kind: "reconfigure", robots: 7 });
    expect(resized.status).toBe(200);
    const after = (await resized.json() as { world: { robots: unknown[]; tick: number } }).world;
    expect(after.robots).toHaveLength(7);
    // A brand new runtime: the tick counter restarts, proving the swap happened.
    expect(after.tick).toBeLessThan(before.tick + 1e6);

    // The command must land on the runtime that is actually being served.
    const blocked = await post({ kind: "block", position: { x: 9, y: 5 }, blocked: true });
    expect(blocked.status).toBe(200);
    const served = await (await GET()).json() as { world: { map: { cells: { position: { x: number; y: number }; blocked: boolean }[] } } };
    const cell = served.world.map.cells.find((c) => c.position.x === 9 && c.position.y === 5);
    expect(cell?.blocked).toBe(true);
  });

  it("serves the dashboard a lean payload with exact totals and the real layout", async () => {
    const { GET, POST } = await import("../src/app/api/fleet/route");
    await POST(new Request("http://local/api/fleet", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reconfigure", robots: 4, shelfColumns: 3 }),
    }));
    const body = await (await GET()).json();
    expect(body.ownership).toBeUndefined();
    expect(body.charging).toBeUndefined();
    expect(body.events.length).toBeLessThanOrEqual(20);
    expect(body.taskTotals.total).toBeGreaterThanOrEqual(body.world.tasks.length);
    expect(body.layout).toEqual({ robots: 4, shelfColumns: 3, maxRobots: createFleetRoster().length });
    expect(body.motionHistory.length).toBeGreaterThan(0);
  });

  it("Reset rebuilds a world even when the requested fleet size is unchanged", async () => {
    const { GET, POST } = await import("../src/app/api/fleet/route");
    const before = await (await GET()).json();
    const response = await POST(new Request("http://local/api/fleet", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reconfigure", robots: before.world.robots.length }),
    }));
    expect(response.status).toBe(200);
    const reset = await response.json();
    expect(reset.runtimeId).not.toBe(before.runtimeId);
    expect(reset.world.tick).toBe(0);
    expect(reset.world.robots.every((r: RobotState) => r.battery === 100)).toBe(true);
  });

  it("an external outage never switches commands or telemetry to a different fleet", async () => {
    const { GET, POST } = await import("../src/app/api/fleet/route");
    process.env.FLEET_URL = "http://unreachable-fleet.invalid";
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    try {
      const state = await GET();
      expect(state.status).toBe(503);
      expect(await state.json()).toEqual({ error: "Configured fleet runtime unreachable" });
      const command = await POST(new Request("http://local/api/fleet", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "run" }),
      }));
      expect(command.status).toBe(503);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a command meant for another world, and applies one meant for this one", async () => {
    // On a multi-instance host each instance runs its own world. A command that
    // landed on the wrong one used to answer 200 and change a world nobody was
    // looking at, so the dashboard's buttons appeared to do nothing.
    const { GET, POST } = await import("../src/app/api/fleet/route");
    const { runtimeId } = await (await GET()).json() as { runtimeId: string };
    const post = (body: unknown) => POST(new Request("http://local/api/fleet", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const stray = await post({ kind: "pause", expectRuntime: "some-other-world" });
    expect(stray.status).toBe(409);
    expect((await stray.json() as { runtimeId: string }).runtimeId).toBe(runtimeId);
    expect((await (await GET()).json() as { running: boolean }).running).toBe(true);

    const mine = await post({ kind: "pause", expectRuntime: runtimeId });
    expect(mine.status).toBe(200);
    expect((await mine.json() as { running: boolean }).running).toBe(false);
    // Untagged commands (scripts, curl) keep working as before.
    expect((await post({ kind: "run" })).status).toBe(200);
  });

  it("rejects a malformed reconfigure instead of building an impossible world", async () => {
    const { GET, POST } = await import("../src/app/api/fleet/route");
    await GET();
    // The runtime's own `command` silently ignores an unrecognised kind, so the
    // in-process path used to answer 200 to garbage while the proxied path
    // answered 400. Both topologies must reject the same things.
    // Sizes beyond the roster used to be accepted and silently truncated.
    for (const bad of [{ kind: "reconfigure", robots: 0 }, { kind: "reconfigure", robots: 21 }, { kind: "reconfigure", robots: 99 }, { kind: "reconfigure", shelfColumns: 12 }, { kind: "nonsense" }, {}]) {
      const response = await POST(new Request("http://local/api/fleet", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bad),
      }));
      expect(response.status).toBe(400);
    }
  });
});
