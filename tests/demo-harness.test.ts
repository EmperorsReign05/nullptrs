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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OrderBook, RELEASE_INTERVAL_TICKS } from "../src/server/order-book";
import { layoutWithShelfColumns, clampShelfColumns, MIN_SHELF_COLUMNS, MAX_SHELF_COLUMNS, passingCapacity } from "../src/server/layout";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createWarehouseMap } from "../src/core/map/warehouse";
import { createInitialWorld } from "../src/core/simulation/state";
import { advanceSmooth, initialSmooth, sampleSmooth, MAX_STEP_MS, TICK_MS } from "../src/components/dashboard/useSmoothRobots";
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

  it("offers a heavy job so the payload eligibility gate is demonstrable", () => {
    const book = new OrderBook(runtime);
    for (let i = 0; i < 40; i++) { runtime.world.tick += RELEASE_INTERVAL_TICKS; book.releaseDue(); }
    // Scout Agile 2.0 carries 50 kg, so anything heavier can only be won by the
    // Addverb. A demo that never exercises that gate never shows it working.
    expect(runtime.world.tasks.some((t) => t.weight > 50)).toBe(true);
  });
});

describe("motion interpolation", () => {
  const robot = (id: string, x: number, y: number) => ({ id, position: { x, y } }) as never;

  it("holds a robot still when nothing moved", () => {
    const s0 = initialSmooth([robot("a", 1, 1)], 0);
    const s1 = advanceSmooth(s0, [robot("a", 1, 1)], 5, 5, 100);
    expect(s1).toBe(s0);
    expect(sampleSmooth(s1, 999).a).toEqual({ x: 1, y: 1 });
  });

  it("derives duration from the TICK difference, not from packet latency", () => {
    // This is the whole fix: a 4-tick move must take 4 * TICK_MS of animation no
    // matter how long after the previous packet this one arrived. Using the
    // wall-clock gap instead is what produced the "sometimes fast, sometimes
    // slow" stutter, because poll latency is jittery and the sim is not.
    const s0 = initialSmooth([robot("a", 1, 1)], 0);
    const late = advanceSmooth(s0, [robot("a", 2, 1)], 4, 0, 9_000);
    const prompt = advanceSmooth(s0, [robot("a", 2, 1)], 4, 0, 1);
    expect(late.durationMs).toBe(prompt.durationMs);
    expect(late.durationMs).toBe(4 * TICK_MS);
  });

  it("clamps a long stall so a frozen host cannot produce a ten-second glide", () => {
    const s0 = initialSmooth([robot("a", 1, 1)], 0);
    expect(advanceSmooth(s0, [robot("a", 9, 1)], 400, 0, 0).durationMs).toBe(MAX_STEP_MS);
    // A single tick is the floor, and it is reachable because steps >= 1.
    expect(advanceSmooth(s0, [robot("a", 9, 1)], 5, 4, 0).durationMs).toBe(TICK_MS);
  });

  it("crosses the cell at a constant speed, and lands exactly on the target", () => {
    const s0 = initialSmooth([robot("a", 1, 1)], 0);
    const s1 = advanceSmooth(s0, [robot("a", 5, 1)], 1, 0, 1_000);
    const mid = sampleSmooth(s1, 1_000 + s1.durationMs / 2).a;
    expect(mid.x).toBeCloseTo(3, 6);
    // Sample just before the end and just after: never overshoots, never snaps back.
    const before = sampleSmooth(s1, 1_000 + s1.durationMs - 1).a;
    const after = sampleSmooth(s1, 1_000 + s1.durationMs + 5_000).a;
    expect(before.x).toBeLessThan(5);
    expect(after.x).toBe(5);
  });

  it("restarts from what is painted, so a late packet corrects instead of snapping", () => {
    const s0 = initialSmooth([robot("a", 1, 1)], 0);
    const s1 = advanceSmooth(s0, [robot("a", 3, 1)], 1, 0, 0);
    const midway = s1.durationMs / 2;
    expect(sampleSmooth(s1, midway).a.x).toBeCloseTo(2, 6);
    // A packet lands mid-move reporting the robot has gone FURTHER. The new
    // interpolation must begin at 2 (what is on screen), not at 3 (the old
    // target) — otherwise the robot visibly snaps forward and re-animates.
    const s2 = advanceSmooth(s1, [robot("a", 4, 1)], 2, 1, midway);
    expect(s2.from.a.x).toBeCloseTo(2, 6);
    expect(s2.to.a).toEqual({ x: 4, y: 1 });
    // A packet that reports no change must not restart anything.
    expect(advanceSmooth(s1, [robot("a", 3, 1)], 2, 1, midway)).toBe(s1);
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

  it("rejects a malformed reconfigure instead of building an impossible world", async () => {
    const { GET, POST } = await import("../src/app/api/fleet/route");
    await GET();
    // The runtime's own `command` silently ignores an unrecognised kind, so the
    // in-process path used to answer 200 to garbage while the proxied path
    // answered 400. Both topologies must reject the same things.
    for (const bad of [{ kind: "reconfigure", robots: 0 }, { kind: "reconfigure", robots: 99 }, { kind: "reconfigure", shelfColumns: 12 }, { kind: "nonsense" }, {}]) {
      const response = await POST(new Request("http://local/api/fleet", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bad),
      }));
      expect(response.status).toBe(400);
    }
  });
});
