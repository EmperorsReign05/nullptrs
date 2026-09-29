import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { calculateBid, getAllBids, getBiddingRobots } from "../src/core/auction/assign";
import { planPath } from "../src/core/pathfinding/astar";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position, Task, RobotState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

describe("O: can the BID COST function fix these problems at all? (structural analysis)", () => {
  it("O1: the bid cost is only consulted for ELIGIBLE robots — a starved robot never gets a say", () => {
    const w = growFleet(createInitialWorld(), 6);
    const task: Task = { id: "X", pickup: { x: 3, y: 9 }, dropoff: { x: 9, y: 1 }, weight: 20, createdAt: 0, priority: 1, status: "pending" };
    const world: WorldState = { ...w, tasks: [task] };
    const withLow = w.robots.map((r, i) => (i < 3 ? { ...r, battery: 5 } : r));
    const worldLow: WorldState = { ...world, robots: withLow };
    console.log(`O1 eligible bidders at healthy battery: ${getBiddingRobots(task, world.robots, world).length}/${w.robots.length}`);
    console.log(`O1 eligible bidders with 3 robots at 5%: ${getBiddingRobots(task, worldLow.robots, worldLow).length}/${w.robots.length}`);
    console.log("O1 => a cost function can only RE-RANK candidates. It cannot create a candidate.");
    console.log("O1    So 'no robot can bid' is NOT a bid-cost problem. It is an eligibility/feasibility problem.");
  });

  it("O2: breakdown of what each term actually contributes to a real bid", () => {
    const w = growFleet(createInitialWorld(), 20);
    const task: Task = { id: "X", pickup: { x: 3, y: 9 }, dropoff: { x: 9, y: 1 }, weight: 20, createdAt: 0, priority: 1, status: "pending" };
    const world: WorldState = { ...w, tasks: [task] };
    const bids = getAllBids(task, w.robots, world).filter((b) => b.feasible);
    console.log("O2 robot  travel  cong  batt  work  urg  payload  TOTAL");
    for (const b of bids.slice(0, 10)) {
      console.log(`O2 ${b.robotId}  ${b.travelCost.toFixed(0).padStart(5)} ${b.congestionCost.toFixed(0).padStart(5)} ${b.batteryCost.toFixed(0).padStart(5)} ${b.workloadCost.toFixed(0).padStart(5)} ${b.urgencyCost.toFixed(0).padStart(4)} ${b.payloadCost.toFixed(0).padStart(7)} ${b.totalCost.toFixed(0).padStart(6)}`);
    }
    // weighted contributions
    const W = { travel: 1, congestion: 1.5, battery: 4, workload: 1, urgency: 3, payload: 0.5 };
    const contrib = { travel: 0, congestion: 0, battery: 0, workload: 0, urgency: 0, payload: 0 };
    for (const b of bids) {
      contrib.travel += W.travel * b.travelCost;
      contrib.congestion += W.congestion * b.congestionCost;
      contrib.battery += W.battery * b.batteryCost;
      contrib.workload += W.workload * b.workloadCost;
      contrib.urgency += W.urgency * b.urgencyCost;
      contrib.payload += W.payload * b.payloadCost;
    }
    const sum = Object.values(contrib).reduce((a, b) => a + b, 0);
    console.log("O2 share of total bid cost across all feasible bidders:");
    for (const [k, v] of Object.entries(contrib).sort((a, b) => b[1] - a[1])) {
      console.log(`O2   ${k.padEnd(11)} ${v.toFixed(0).padStart(6)}  ${((v / sum) * 100).toFixed(1).padStart(5)}%  ${"#".repeat(Math.round((v / sum) * 30))}`);
    }
    console.log("O2 NOTE: the task has NO deadline, so urgencyCost is identically 0 for every robot — a dead term.");
  });

  it("O3: is congestionCost even meaningful, or is it double-counting occupancy?", () => {
    const w = growFleet(createInitialWorld(), 20);
    const task: Task = { id: "X", pickup: { x: 3, y: 9 }, dropoff: { x: 9, y: 1 }, weight: 20, createdAt: 0, priority: 1, status: "pending" };
    const world: WorldState = { ...w, tasks: [task] };
    const r = w.robots[0];
    const path = planPath(r.position, task.pickup, world);
    console.log(`O3 robot ${r.id} at ${key(r.position)} -> pickup ${key(task.pickup)}: distance=${path.distance} congestionCost=${path.congestionCost.toFixed(1)}`);
    console.log(`O3 CONGESTION_WEIGHT=1, and computeCongestion gives an OCCUPIED cell weight 3 and each neighbour 1.`);
    console.log(`O3 So merely passing through a cell with ONE robot on it costs 3 — the same as 3 extra steps of travel.`);
    console.log(`O3 And since every robot sees the same congestion field, congestionCost is IDENTICAL across robots`);
    console.log(`O3 for the same task at the same tick — it shifts all bids by a constant and cannot change the winner`);
    console.log(`O3 UNLESS robots are at different distances. Check spread:`);
    const spreads = getAllBids(task, w.robots, world).filter((b) => b.feasible).map((b) => b.congestionCost);
    console.log(`O3 congestionCost across bidders: min=${Math.min(...spreads).toFixed(1)} max=${Math.max(...spreads).toFixed(1)} distinct=${new Set(spreads.map((s) => s.toFixed(2))).size}`);
    const travels = getAllBids(task, w.robots, world).filter((b) => b.feasible).map((b) => b.travelCost);
    console.log(`O3 travelCost      across bidders: min=${Math.min(...travels)} max=${Math.max(...travels)} distinct=${new Set(travels).size}`);
  });

  it("O4: does the bid cost know anything about the OTHER robots' plans?", () => {
    const w = growFleet(createInitialWorld(), 20);
    const task: Task = { id: "X", pickup: { x: 3, y: 9 }, dropoff: { x: 9, y: 1 }, weight: 20, createdAt: 0, priority: 1, status: "pending" };
    const world: WorldState = { ...w, tasks: [task] };
    const r = w.robots[0];
    console.log(`O4 calculateBid(robot, task, world) reads: robot.position/battery/path/model, task.pickup/dropoff/weight/priority/deadline, world.map.congestion, world.tick.`);
    console.log(`O4 It does NOT read: any other robot's currentTaskId, path, or status.`);
    console.log(`O4 => two robots bidding for the SAME task cannot see that they would route through the same corridor.`);
    const a = w.robots.find((x) => x.id === "AMR-01")!;
    const b = w.robots.find((x) => x.id === "AMR-05")!;
    const pa = planPath(a.position, task.pickup, world);
    const pb = planPath(b.position, task.pickup, world);
    const shared = pa.path.filter((p) => pb.path.some((q) => q.x === p.x && q.y === p.y));
    console.log(`O4 AMR-01 path and AMR-05 path share ${shared.length} cells: ${shared.slice(0, 10).map(key).join(" ")}`);
    console.log(`O4 => contention is invisible to the auction. It is only discovered later, by PIBT, as a conflict.`);
  });

  it("O5: the assignment is greedy-per-task with no global load balance", () => {
    const w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    // 4 identical tasks, all with the same pickup.
    const tasks: Task[] = [0, 1, 2, 3].map((i) => ({ id: `M${i}`, pickup: open[40], dropoff: open[80], weight: 20, createdAt: 0, priority: 1, status: "pending" as const }));
    let world: WorldState = { ...w, tasks };
    // one auction round
    const before = world.robots.filter((r) => (r.queuedTaskIds?.length ?? 0) > 0).length;
    world = runDispatchTick(world);
    const dist: Record<number, number> = {};
    for (const r of world.robots) { const k = r.currentTaskId ? 1 : 0; dist[k] = (dist[k] ?? 0) + 1; }
    console.log(`O5 4 identical tasks (same pickup+dropoff), 20 robots:`);
    console.log(`O5   active=${dist[1] ?? 0} idle/no-task=${dist[0] ?? 0} queuedTotal=${world.robots.reduce((a, r) => a + (r.queuedTaskIds?.length ?? 0), 0)}`);
    console.log(`O5 => each task is auctioned INDEPENDENTLY against the same robot set, and a winner can then win again.`);
    console.log(`O5    Nothing in the cost function prices in "this robot already has 4 tasks queued".`);
  });
});
