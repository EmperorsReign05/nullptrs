import { describe, it } from "vitest";
import { createInitialWorld } from "../src/core/simulation/state";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createWarehouseMap, computeCongestion, isTraversable, CHARGING_STATIONS } from "../src/core/map/warehouse";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import { growFleet, openCells } from "./harness";
import type { Position, RobotState, Task, WorldState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const emptyMetrics = () => ({ replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 });
function worldWith(robots: RobotState[], tasks: Task[] = [], map = createWarehouseMap()): WorldState {
  return { tick: 0, map: computeCongestion(map, robots), robots, tasks, metrics: emptyMetrics() };
}
function rob(o: Partial<RobotState> & Pick<RobotState, "id" | "position">): RobotState {
  return { home: o.position, battery: 100, status: "idle", model: ROBOT_MODELS[0], path: [], priority: 0, ...o };
}
function task(o: Partial<Task> & Pick<Task, "id" | "pickup" | "dropoff">): Task {
  return { weight: 10, createdAt: 0, priority: 1, status: "pending", ...o };
}
function makeTasks(w: WorldState, s: number, open: Position[], n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) { const k = s + i; const p = open[(k * 7 + 3) % open.length]; const d = open[(k * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push(task({ id: `L${k}`, pickup: p, dropoff: d, weight: (k % 9) * 10 + 10, createdAt: w.tick })); }
  return out;
}

describe("U1: NaN propagation — the worst one so far", () => {
  it("U1.1: a NaN weight silently poisons the whole auction", () => {
    const open = openCells(createInitialWorld());
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "BAD", pickup: open[5], dropoff: open[50], weight: NaN })]);
    let x = w;
    for (let i = 0; i < 10; i++) x = runDispatchTick(x);
    const t = x.tasks[0];
    console.log(`U1.1 NaN-weight task after 10 ticks: status=${t.status} assignedRobotId=${t.assignedRobotId ?? "none"}`);
    console.log(`U1.1 => assignTask compares bid.totalCost < best.totalCost; NaN < x is ALWAYS false, so a NaN bid can never win...`);
    console.log(`U1.1    unless it is the ONLY bidder, in which case best===null short-circuits and it WINS with a NaN cost.`);
  });

  it("U1.2: does one NaN robot poison every other robot's bid?", () => {
    const open = openCells(createInitialWorld());
    const robots = [
      rob({ id: "GOOD1", position: { x: 0, y: 0 } }),
      rob({ id: "NAN", position: { x: 3, y: 0 }, battery: NaN }),
      rob({ id: "GOOD2", position: { x: 6, y: 0 } }),
    ];
    const t = task({ id: "T", pickup: open[20], dropoff: open[80] });
    const w = worldWith(robots, [t]);
    let x = w;
    for (let i = 0; i < 5; i++) x = runDispatchTick(x);
    console.log(`U1.2 with one NaN-battery robot: ${x.robots.map((r) => `${r.id} b=${r.battery} ${r.status}`).join(" | ")}`);
    console.log(`U1.2 task status=${x.tasks[0].status} assigned=${x.tasks[0].assignedRobotId ?? "none"}`);
    console.log(`U1.2 => computeBatteryCost: projectedBattery = NaN - d*0.5 = NaN; NaN < 15 is false => FEASIBLE.`);
    console.log(`U1.2    So a NaN robot passes the safety check entirely and wins auctions it should never win.`);
  });

  it("U1.3: negative battery", () => {
    const open = openCells(createInitialWorld());
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 }, battery: -50 })], [task({ id: "T", pickup: open[5], dropoff: open[50] })]);
    let x = w;
    for (let i = 0; i < 3; i++) { x = runDispatchTick(x); console.log(`U1.3 t=${x.tick} battery=${x.robots[0].battery} status=${x.robots[0].status}`); }
    console.log(`U1.3 => Math.max(0, ...) clamps it, but only AFTER a move. Until then it is negative and bids as if healthy.`);
  });

  it("U1.4: Infinity / huge values", () => {
    const open = openCells(createInitialWorld());
    for (const [label, wt] of [["Infinity", Infinity], ["1e308", 1e308]] as [string, number][]) {
      const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "T", pickup: open[5], dropoff: open[50], weight: wt })]);
      let x = w;
      for (let i = 0; i < 3; i++) x = runDispatchTick(x);
      console.log(`U1.4 weight=${label}: task status after 3 ticks = ${x.tasks[0].status}`);
    }
  });
});

describe("U2: fleet scaling via the UI path — the real user-facing bug", () => {
  it("U2.1: growing the fleet past 12 spawns robots ON TOP of each other", () => {
    // The UI's safeSpawns has 12 entries and wraps with modulo.
    for (const target of [12, 13, 15, 20, 24, 25, 30]) {
      let w = growFleet(createInitialWorld(), target);
      const cells = new Map<string, string[]>();
      for (const r of w.robots) cells.set(key(r.position), [...(cells.get(key(r.position)) ?? []), r.id]);
      const dupes = [...cells.entries()].filter(([, ids]) => ids.length > 1);
      const onDock = w.robots.filter((r) => CHARGING_STATIONS.some((s) => s.position.x === r.position.x && s.position.y === r.position.y));
      console.log(`U2.1 target=${String(target).padStart(2)}: robots=${w.robots.length} distinctCells=${cells.size} COLLIDING_CELLS=${dupes.length}${dupes.length ? " -> " + dupes.map(([c, ids]) => `${c}:${ids.length}`).join(",") : ""} spawnedOnDocks=${onDock.length}`);
    }
  });

  it("U2.2: shrinking the fleet silently deletes robots that still own tasks", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    w = { ...w, tasks: [...w.tasks, ...makeTasks(w, 0, open, 8)] };
    for (let i = 0; i < 200; i++) w = runDispatchTick(w);
    const before = w.robots.length;
    const owners = w.robots.filter((r) => r.currentTaskId).map((r) => r.id);
    // simulate the slider going back down
    w = { ...w, robots: w.robots.slice(0, 10) };
    const survivors = new Set(w.robots.map((r) => r.id));
    const orphaned = owners.filter((id) => !survivors.has(id));
    console.log(`U2.2 shrank ${before} -> ${w.robots.length}; robots that owned tasks: ${owners.join(",")}`);
    console.log(`U2.2 orphaned owners: [${orphaned.join(",")}] => their tasks reference a robot that no longer exists`);
    for (let i = 0; i < 100; i++) w = runDispatchTick(w);
    const stuck = w.tasks.filter((t) => (t.status === "assigned" || t.status === "in_progress") && t.assignedRobotId && !survivors.has(t.assignedRobotId));
    console.log(`U2.2 tasks permanently stuck pointing at deleted robots: ${stuck.length} (${stuck.map((t) => `${t.id}->${t.assignedRobotId}:${t.status}`).join(", ") || "none"})`);
  });
});

describe("U3: scale limits", () => {
  it("U3.1: how many robots before a tick gets expensive?", () => {
    const open = openCells(createInitialWorld());
    for (const n of [20, 40, 60, 80, 100, 120]) {
      const cells = open.slice(0, n);
      if (cells.length < n) { console.log(`U3.1 n=${n}: only ${open.length} open cells available, skipping`); continue; }
      const robots = cells.map((p, i) => rob({ id: `F${i}`, position: p, status: "idle", battery: 80 }));
      let w = worldWith(robots, makeTasks(worldWith(robots), 0, open, 20));
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) w = runDispatchTick(w);
      const per = (performance.now() - t0) / 50;
      console.log(`U3.1 n=${String(n).padStart(3)}: ${per.toFixed(2)} ms/tick  => at 10Hz that's ${(per * 10).toFixed(0)}% of a 100ms budget, at 60Hz ${(per * 60).toFixed(0)}%`);
    }
  });

  it("U3.2: auction cost is O(robots x tasks x A*)", () => {
    const open = openCells(createInitialWorld());
    for (const [n, nt] of [[10, 10], [20, 50], [20, 200], [40, 200]] as [number, number][]) {
      const cells = open.slice(0, n);
      const robots = cells.map((p, i) => rob({ id: `F${i}`, position: p, battery: 90 }));
      const tasks = makeTasks(worldWith(robots), 0, open, nt);
      const w = worldWith(robots, tasks);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) runDispatchTick(w);
      console.log(`U3.2 robots=${String(n).padStart(2)} tasks=${String(nt).padStart(3)}: ${((performance.now() - t0) / 20).toFixed(2)} ms/tick`);
    }
  });
});

describe("U4: long-horizon degradation", () => {
  it("U4.1: does state accumulate without bound?", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0;
    for (let i = 0; i < 8000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = runDispatchTick(w);
    }
    const byStatus: Record<string, number> = {};
    for (const t of w.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const totalQueued = w.robots.reduce((a, r) => a + (r.queuedTaskIds?.length ?? 0), 0);
    console.log(`U4.1 after 8000 ticks: ${w.tasks.length} tasks accumulated ${JSON.stringify(byStatus)}`);
    console.log(`U4.1 task list is NEVER pruned — ${w.tasks.length} objects retained forever, each scanned by the UI's ActiveTasks and by the auction's pending filter.`);
    console.log(`U4.1 queued task ids held by robots: ${totalQueued}; robots=${w.robots.length}`);
    console.log(`U4.1 metrics counters are monotonic and unbounded: conflicts=${w.metrics.conflictCount} replans=${w.metrics.replans} waitMoves=${w.metrics.waitMoves}`);
  });

  it("U4.2: battery economy at steady state", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0;
    const hist: number[] = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = runDispatchTick(w);
      if (i % 500 === 0) hist.push(w.robots.reduce((a, r) => a + r.battery, 0) / 20);
    }
    console.log(`U4.2 avg battery over time: ${hist.map((h) => h.toFixed(1)).join(" -> ")}`);
    const below = w.robots.filter((r) => r.battery < 20).length;
    console.log(`U4.2 robots below the bidding floor at the end: ${below}/20`);
  });
});

describe("U5: the shelf-count slider lies", () => {
  it("U5.1: shelfColCount is render-only", () => {
    console.log("U5.1 WarehouseMap.tsx:48 filters which shelf COLUMNS ARE DRAWN by shelfColCount.");
    console.log("U5.1 No call to createWarehouseMap/SHELF_BLOCKS anywhere takes shelfColCount as input.");
    console.log("U5.1 => set the slider to 1 and the UI shows 1 shelf column while A*, PIBT and congestion still treat all 6 as solid.");
    const w0 = createInitialWorld();
    const blocked = w0.map.cells.filter((c) => c.blocked).length;
    console.log(`U5.1 simulation sees ${blocked} blocked cells regardless of the slider.`);
  });
});

describe("U6: determinism", () => {
  it("U6.1: is the same input guaranteed to give the same output?", () => {
    let a = growFleet(createInitialWorld(), 20);
    const open = openCells(a);
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 0) a = { ...a, tasks: [...a.tasks, ...makeTasks(a, i, open)] };
      a = runDispatchTick(a);
    }
    let b = growFleet(createInitialWorld(), 20);
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 0) b = { ...b, tasks: [...b.tasks, ...makeTasks(b, i, open)] };
      b = runDispatchTick(b);
    }
    const same = JSON.stringify(a.robots) === JSON.stringify(b.robots);
    console.log(`U6.1 two identical runs produce identical robot state: ${same}`);
    console.log(`U6.1 => A* tie-breaks on row-major index and PIBT sorts by (priority, id), so the CORE is deterministic.`);
    console.log(`U6.1    Any nondeterminism would come from the UI: handleRobotCountChange uses Math.random() for battery.`);
  });
});
