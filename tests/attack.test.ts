import { BATTERY_SAFETY_RESERVE_PERCENT } from "../src/core/auction/cost";
import { describe, it, expect } from "vitest";
import { createInitialWorld } from "../src/core/simulation/state";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { planPath } from "../src/core/pathfinding/astar";
import { resolvePIBT } from "../src/core/pathfinding/pibt";
import { createWarehouseMap, computeCongestion, isTraversable, SHELF_BLOCKS, CHARGING_STATIONS, WAITING_ZONES, WAREHOUSE_WIDTH, WAREHOUSE_HEIGHT } from "../src/core/map/warehouse";
import { ROBOT_MODELS, MIN_BATTERY_TO_BID_PERCENT } from "../src/core/simulation/robotModels";
import { getAllBids, getBiddingRobots, assignTask } from "../src/core/auction/assign";
import type { Position, RobotState, Task, WorldState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const emptyMetrics = () => ({ replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 });
function worldWith(robots: RobotState[], tasks: Task[] = [], map = createWarehouseMap()): WorldState {
  return { tick: 0, map: computeCongestion(map, robots), robots, tasks, metrics: emptyMetrics() };
}
function rob(o: Partial<RobotState> & Pick<RobotState, "id" | "position">): RobotState {
  return { home: o.position, battery: 100, status: "idle", model: ROBOT_MODELS[0], path: [], priority: 0, ...o };
}
function openCells(map = createWarehouseMap()): Position[] {
  return map.cells.filter((c) => !c.blocked).map((c) => c.position);
}
function task(o: Partial<Task> & Pick<Task, "id" | "pickup" | "dropoff">): Task {
  return { weight: 10, createdAt: 0, priority: 1, status: "pending", ...o };
}

describe("T1: A* pathology", () => {
  it("T1.1: start and goal are the same cell", () => {
    const w = worldWith([]);
    const r = planPath({ x: 3, y: 0 }, { x: 3, y: 0 }, w);
    console.log(`T1.1 same-cell: found=${r.found} path=${JSON.stringify(r.path)} distance=${r.distance} eta=${r.eta}`);
    expect(r.found).toBe(true);
  });

  it("T1.2: goal is INSIDE a shelf (physically impossible)", () => {
    const w = worldWith([]);
    // (1,1) is inside shelf block [1,1,2,3]
    const r = planPath({ x: 0, y: 0 }, { x: 1, y: 1 }, w);
    console.log(`T1.2 goal inside shelf: found=${r.found} distance=${r.distance}`);
  });

  it("T1.3: goal is OUTSIDE the grid", () => {
    const w = worldWith([]);
    for (const g of [{ x: -1, y: 0 }, { x: 999, y: 0 }, { x: 0, y: 13 }, { x: 0, y: -5 }]) {
      const r = planPath({ x: 3, y: 0 }, g, w);
      console.log(`T1.3 out-of-bounds goal ${JSON.stringify(g)}: found=${r.found} distance=${r.distance}`);
    }
  });

  it("T1.4: start is out of bounds", () => {
    const w = worldWith([]);
    const r = planPath({ x: -3, y: 0 }, { x: 3, y: 0 }, w);
    console.log(`T1.4 out-of-bounds start: found=${r.found} distance=${r.distance}`);
  });

  it("T1.5: a robot standing ON a shelf cell", () => {
    // Simulates the 'block aisle' UI button being toggled under a robot.
    const r0 = rob({ id: "R", position: { x: 9, y: 6 } }); // AISLE_BLOCK_CELLS includes (9,6)
    const w = worldWith([r0]);
    console.log(`T1.5 robot at (9,6) isTraversable=${isTraversable(r0.position, w.map)}`);
    const map2 = { ...w.map, cells: w.map.cells.map((c) => (c.position.x === 9 && c.position.y === 6 ? { ...c, blocked: true } : c)) };
    const w2 = worldWith([r0], [], map2);
    const p = planPath(r0.position, { x: 9, y: 8 }, w2);
    console.log(`T1.5 with that cell now blocked, A* from inside it: found=${p.found} pathLen=${p.path.length} firstStep=${p.path.length > 1 ? key(p.path[1]) : "-"}`);
    const res = resolvePIBT([r0], w2);
    console.log(`T1.5 PIBT: ${res.moves.map((m) => key(m.from) + "->" + key(m.to)).join(" ")}`);
  });

  it("T1.6: the whole grid is blocked except one cell", () => {
    const map = createWarehouseMap();
    const walled = { ...map, cells: map.cells.map((c) => (c.position.x === 5 && c.position.y === 5 ? c : { ...c, blocked: true })) };
    const w = worldWith([], [], walled);
    const r = planPath({ x: 0, y: 0 }, { x: 19, y: 12 }, w);
    console.log(`T1.6 fully-walled grid: found=${r.found} (should be false, must terminate)`);
    const w2 = worldWith([rob({ id: "R", position: { x: 5, y: 5 } })], [], walled);
    const res = resolvePIBT([w2.robots[0]], w2);
    console.log(`T1.6 lone robot in the sealed cell: ${key(res.moves[0].from)}->${key(res.moves[0].to)}`);
  });

  it("T1.7: pickup == dropoff (the demo-task pattern)", () => {
    const w = worldWith([rob({ id: "R", position: { x: 1, y: 0 }, currentTaskId: "T", status: "assigned" })], [task({ id: "T", pickup: { x: 5, y: 0 }, dropoff: { x: 5, y: 0 }, status: "assigned", assignedRobotId: "R" })]);
    let x = w;
    for (let i = 0; i < 8; i++) { x = runDispatchTick(x); const r = x.robots[0]; console.log(`T1.7 t=${x.tick} pos=${key(r.position)} status=${r.status} taskStatus=${x.tasks[0].status}`); }
  });

  it("T1.8: pathological congestion values", () => {
    const map = createWarehouseMap();
    const hot = { ...map, cells: map.cells.map((c) => ({ ...c, congestion: 1e9 })) };
    const w = worldWith([], [], hot);
    const t0 = performance.now();
    const r = planPath({ x: 0, y: 0 }, { x: 19, y: 12 }, w);
    console.log(`T1.8 congestion=1e9 everywhere: found=${r.found} distance=${r.distance} congestionCost=${r.congestionCost} took=${(performance.now() - t0).toFixed(1)}ms`);
  });
});

describe("T2: auction pathology", () => {
  it("T2.1: task heavier than every robot", () => {
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "T", pickup: { x: 3, y: 0 }, dropoff: { x: 5, y: 0 }, weight: 10000 })]);
    const bids = getAllBids(w.tasks[0], w.robots, w);
    console.log(`T2.1 weight=10000: feasible=${bids[0].feasible} reason=${bids[0].infeasibleReason} totalCost=${bids[0].totalCost}`);
    console.log(`T2.1 assignTask returns: ${assignTask(w.tasks[0], w.robots, w)}`);
  });

  it("T2.2: negative / zero / NaN weights", () => {
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })]);
    for (const weight of [0, -50, NaN]) {
      const t = task({ id: "T", pickup: { x: 3, y: 0 }, dropoff: { x: 5, y: 0 }, weight });
      const b = getAllBids(t, w.robots, w)[0];
      console.log(`T2.2 weight=${weight}: feasible=${b.feasible} reason=${b.infeasibleReason} totalCost=${b.totalCost} payloadCost=${b.payloadCost}`);
    }
  });

  it("T2.3: task with pickup == dropoff on a valid cell", () => {
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "T", pickup: { x: 3, y: 0 }, dropoff: { x: 3, y: 0 } })]);
    const b = getAllBids(w.tasks[0], w.robots, w)[0];
    console.log(`T2.3 pickup==dropoff: travelCost=${b.travelCost} eta=${b.eta} feasible=${b.feasible}`);
  });

  it("T2.4: task in a sealed region (unreachable)", () => {
    const map = createWarehouseMap();
    const sealed = { ...map, cells: map.cells.map((c) => (c.position.x === 17 && c.position.y === 4 ? { ...c, blocked: true } : c)) };
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "T", pickup: { x: 17, y: 4 }, dropoff: { x: 0, y: 0 } })], sealed);
    const b = getAllBids(w.tasks[0], w.robots, w)[0];
    console.log(`T2.4 pickup sealed off: feasible=${b.feasible} reason=${b.infeasibleReason}`);
    let x = w;
    for (let i = 0; i < 20; i++) x = runDispatchTick(x);
    console.log(`T2.4 after 20 ticks task status=${x.tasks[0].status} (stuck pending forever?)`);
  });

  it("T2.5: deadline in the past / absurd deadline", () => {
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "T", pickup: { x: 3, y: 0 }, dropoff: { x: 5, y: 0 } })]);
    for (const dl of [-100, 0, 5, 1e9]) {
      const t = { ...w.tasks[0], deadline: dl };
      const b = getAllBids(t, w.robots, w)[0];
      console.log(`T2.5 deadline=${dl}: urgencyCost=${b.urgencyCost} totalCost=${b.totalCost}`);
    }
  });

  it("T2.6: robot with duplicate ID", () => {
    const w = worldWith([rob({ id: "DUP", position: { x: 0, y: 0 } }), rob({ id: "DUP", position: { x: 3, y: 0 } })], [task({ id: "T", pickup: { x: 6, y: 0 }, dropoff: { x: 8, y: 0 } })]);
    let x = w;
    for (let i = 0; i < 10; i++) x = runDispatchTick(x);
    console.log(`T2.6 duplicate robot IDs after 10 ticks: ${x.robots.map((r) => `${r.id}@${key(r.position)}/${r.status}`).join(" | ")}`);
    const seen = new Set(x.robots.map((r) => key(r.position)));
    console.log(`T2.6 distinct cells=${seen.size} of ${x.robots.length} robots => ${seen.size < x.robots.length ? "COLLISION" : "ok"}`);
  });

  it("T2.7: task assigned to a robot that does not exist", () => {
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], [task({ id: "GHOST", pickup: { x: 3, y: 0 }, dropoff: { x: 5, y: 0 }, status: "in_progress", assignedRobotId: "NOBODY" })]);
    let x = w;
    for (let i = 0; i < 30; i++) x = runDispatchTick(x);
    console.log(`T2.7 ghost-assigned task after 30 ticks: status=${x.tasks[0].status} (never resolves?)`);
  });

  it("T2.8: many more tasks than MAX_TASKS_PER_DISPATCH_ROUND", () => {
    const open = openCells();
    const tasks = Array.from({ length: 200 }, (_, i) => task({ id: `T${i}`, pickup: open[i % open.length], dropoff: open[(i * 7 + 3) % open.length] }));
    let w = worldWith([rob({ id: "A", position: { x: 0, y: 0 } })], tasks);
    const t0 = performance.now();
    w = runDispatchTick(w);
    console.log(`T2.8 200 tasks, 1 robot: one tick took ${(performance.now() - t0).toFixed(1)}ms; assigned=${w.tasks.filter((t) => t.status !== "pending").length}`);
  });
});

describe("T3: PIBT pathology", () => {
  it("T3.1: 40 robots in a single-file corridor", () => {
    // x=6 is a fully open column for all 13 rows — a 1-wide corridor.
    const robots: RobotState[] = [];
    for (let i = 0; i < 13; i++) robots.push(rob({ id: `C${i}`, position: { x: 6, y: i }, status: "moving", path: [{ x: 6, y: i }, { x: 6, y: i + 1 }] }));
    const w = worldWith(robots);
    const res = resolvePIBT(robots, w);
    const dests = new Set(res.moves.map((m) => key(m.to)));
    console.log(`T3.1 13 robots nose-to-tail in a 1-wide corridor: distinct destinations=${dests.size}/${robots.length} => ${dests.size < robots.length ? "COLLISION" : "ok"}`);
  });

  it("T3.2: head-on pair in a dead-end (irreducible)", () => {
    const robots = [
      rob({ id: "A", position: { x: 3, y: 1 }, status: "moving", path: [{ x: 3, y: 1 }, { x: 3, y: 2 }] }),
      rob({ id: "B", position: { x: 3, y: 2 }, status: "moving", path: [{ x: 3, y: 2 }, { x: 3, y: 1 }] }),
    ];
    const res = resolvePIBT(robots, worldWith(robots));
    console.log(`T3.2 head-on: ${res.moves.map((m) => `${m.robotId} ${key(m.from)}->${key(m.to)}${m.from.x === m.to.x && m.from.y === m.to.y ? " WAIT" : ""}`).join(" | ")}`);
  });

  it("T3.3: 3-robot rotation cycle (documented as unresolvable)", () => {
    const robots = [
      rob({ id: "R1", position: { x: 3, y: 1 }, status: "moving", path: [{ x: 3, y: 1 }, { x: 3, y: 2 }] }),
      rob({ id: "R2", position: { x: 3, y: 2 }, status: "moving", path: [{ x: 3, y: 2 }, { x: 3, y: 3 }] }),
      rob({ id: "R3", position: { x: 3, y: 3 }, status: "moving", path: [{ x: 3, y: 3 }, { x: 3, y: 1 }] }),
    ];
    const res = resolvePIBT(robots, worldWith(robots));
    console.log(`T3.3 3-cycle: ${res.moves.map((m) => `${m.robotId}->${key(m.to)}`).join(" ")} waits=${res.metrics.waitMoves} conflicts=${res.metrics.conflictCount}`);
  });

  it("T3.4: a 'failed' robot blocking a corridor", () => {
    const robots = [
      rob({ id: "DEAD", position: { x: 6, y: 6 }, status: "failed" }),
      rob({ id: "LIVE", position: { x: 6, y: 5 }, status: "moving", path: [{ x: 6, y: 5 }, { x: 6, y: 6 }], priority: 99 }),
    ];
    const res = resolvePIBT(robots, worldWith(robots));
    console.log(`T3.4 LIVE(prio 99) vs DEAD: ${res.moves.map((m) => `${m.robotId} ${key(m.from)}->${key(m.to)}`).join(" | ")}`);
    console.log(`T3.4 => the failed robot is treated as a static obstacle; LIVE must route around or wait forever.`);
  });

  it("T3.5: priority explosion", () => {
    const robots = [
      rob({ id: "BLOCKER", position: { x: 6, y: 6 }, status: "charging", path: [] }),
      rob({ id: "WAITER", position: { x: 6, y: 5 }, status: "moving", path: [{ x: 6, y: 5 }, { x: 6, y: 6 }], priority: 0 }),
    ];
    let w = worldWith(robots);
    for (let i = 0; i < 50; i++) w = runDispatchTick(w);
    console.log(`T3.5 after 50 ticks: ${w.robots.map((r) => `${r.id} prio=${r.priority}`).join(" | ")}`);
  });

  it("T3.6: robot with a path that teleports (corrupt data)", () => {
    const robots = [rob({ id: "WARP", position: { x: 0, y: 0 }, status: "moving", path: [{ x: 0, y: 0 }, { x: 19, y: 12 }] })];
    const res = resolvePIBT(robots, worldWith(robots));
    console.log(`T3.6 path says next step is (19,12), 31 cells away: resolved move ${key(res.moves[0].from)}->${key(res.moves[0].to)} (must not teleport)`);
  });

  it("T3.7: 60 robots, full grid, all wanting the same goal", () => {
    const cells = openCells();
    const robots: RobotState[] = cells.slice(0, 60).map((p, i) => rob({ id: `F${i}`, position: p, status: "moving", path: [{ ...p }, { x: 3, y: 0 }] }));
    const res = resolvePIBT(robots, worldWith(robots));
    const dests = new Set(res.moves.map((m) => key(m.to)));
    console.log(`T3.7 60 robots converge on one goal: distinct destinations=${dests.size}/${robots.length} => ${dests.size === robots.length ? "ok" : "COLLISION"} conflicts=${res.metrics.conflictCount}`);
  });
});

describe("T4: map/geometry invariants", () => {
  it("T4.1: are the charging docks and waiting zones actually reachable/usable?", () => {
    const map = createWarehouseMap();
    const open = openCells(map);
    for (const s of CHARGING_STATIONS) {
      const traversable = isTraversable(s.position, map);
      const reachable = planPath({ x: 0, y: 0 }, s.position, { ...worldWith([]), map }).found;
      console.log(`T4.1 ${s.id} @${key(s.position)} traversable=${traversable} reachableFromCorner=${reachable}`);
    }
    for (const z of WAITING_ZONES) {
      let free = 0, total = 0;
      for (let dx = 0; dx < z.width; dx++) for (let dy = 0; dy < z.height; dy++) { total++; if (isTraversable({ x: z.x + dx, y: z.y + dy }, map)) free++; }
      console.log(`T4.1 ${z.id} (${z.x},${z.y} ${z.width}x${z.height}): ${free}/${total} cells traversable`);
    }
  });

  it("T4.2: do shelf blocks overlap each other or touch the border?", () => {
    for (const [x, y, w, h] of SHELF_BLOCKS) {
      if (x === 0 || y === 0 || x + w > WAREHOUSE_WIDTH || y + h > WAREHOUSE_HEIGHT) console.log(`T4.2 shelf [${x},${y},${w},${h}] touches or crosses the border`);
    }
    console.log(`T4.2 ${SHELF_BLOCKS.length} shelf blocks checked`);
  });

  it("T4.3: the UI's AISLE_BLOCK_CELLS — does blocking them disconnect the map?", () => {
    const map = createWarehouseMap();
    const blocked = new Set(["9,5", "9,6", "9,7"]);
    const m2 = { ...map, cells: map.cells.map((c) => (blocked.has(key(c.position)) ? { ...c, blocked: true } : c)) };
    const w = { ...worldWith([], [], m2) };
    // can everything still reach everything?
    let unreachable = 0, checked = 0;
    for (const g of openCells(m2)) {
      checked++;
      if (!planPath({ x: 0, y: 0 }, g, w).found) unreachable++;
    }
    console.log(`T4.3 with x=9 rows 5-7 blocked: ${unreachable}/${checked} open cells unreachable from (0,0)`);
  });

  it("T4.4: is the whole open map mutually connected?", () => {
    const map = createWarehouseMap();
    const open = openCells(map);
    let unreachable = 0;
    for (const g of open) if (!planPath({ x: 0, y: 0 }, g, worldWith([], [], map)).found) { unreachable++; console.log(`T4.4 UNREACHABLE from (0,0): ${key(g)}`); }
    console.log(`T4.4 ${unreachable}/${open.length} open cells unreachable from (0,0)`);
  });

  it("T4.5: grid dimensions vs the constants the UI assumes", () => {
    console.log(`T4.5 WAREHOUSE_WIDTH=${WAREHOUSE_WIDTH} HEIGHT=${WAREHOUSE_HEIGHT} => ${WAREHOUSE_WIDTH * WAREHOUSE_HEIGHT} cells`);
    const open = openCells();
    console.log(`T4.5 traversable=${open.length}, blocked=${WAREHOUSE_WIDTH * WAREHOUSE_HEIGHT - open.length} (${(((WAREHOUSE_WIDTH * WAREHOUSE_HEIGHT - open.length) / (WAREHOUSE_WIDTH * WAREHOUSE_HEIGHT)) * 100).toFixed(0)}% blocked)`);
  });
});

describe("T5: threshold coherence", () => {
  it("T5.1: eligibility floor vs safety reserve vs charge target", () => {
    console.log(`T5.1 MIN_BATTERY_TO_BID_PERCENT (assign.ts isEligible) = ${MIN_BATTERY_TO_BID_PERCENT}`);
    console.log(`T5.1 BATTERY_SAFETY_RESERVE_PERCENT (cost.ts)         = ${BATTERY_SAFETY_RESERVE_PERCENT}`);
    console.log(`T5.1 => a robot with battery in [${BATTERY_SAFETY_RESERVE_PERCENT}, ${MIN_BATTERY_TO_BID_PERCENT}) is ELIGIBLE but every bid it makes is battery-infeasible.`);
    console.log(`T5.1 => it is therefore evaluated, always loses, and accrues a lowBatteryStreak it cannot clear.`);
    const w = worldWith([rob({ id: "A", position: { x: 0, y: 0 }, battery: 17, lowBatteryStreak: 0 })], [task({ id: "T", pickup: { x: 3, y: 9 }, dropoff: { x: 9, y: 1 } })]);
    const b = getAllBids(w.tasks[0], w.robots, w)[0];
    console.log(`T5.1 robot at 17%: eligible=${getBiddingRobots(w.tasks[0], w.robots, w).length > 0} bidFeasible=${b.feasible} reason=${b.infeasibleReason}`);
  });
});
