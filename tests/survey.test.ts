import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { WAITING_ZONES, CHARGING_STATIONS, PICKUP_STATIONS, DROPOFF_STATIONS, SHELF_BLOCKS, isTraversable } from "../src/core/map/warehouse";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position, RobotState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function inZone(p: Position, z: { x: number; y: number; width: number; height: number }) {
  return p.x >= z.x && p.x < z.x + z.width && p.y >= z.y && p.y < z.y + z.height;
}
function isWaitingZone(p: Position) { return WAITING_ZONES.some((z) => inZone(p, z)); }
function isDock(p: Position) { return CHARGING_STATIONS.some((s) => s.position.x === p.x && s.position.y === p.y); }
function isStation(p: Position) {
  return PICKUP_STATIONS.some((s) => s.position.x === p.x && s.position.y === p.y) ||
    DROPOFF_STATIONS.some((s) => s.position.x === p.x && s.position.y === p.y);
}

function makeTasks(world: WorldState, startIdx: number, open: Position[]) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = startIdx + i;
    const p = open[(n * 7 + 3) % open.length];
    const d = open[(n * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push({ id: `L${n}`, pickup: p, dropoff: d, weight: (n % 9) * 10 + 10, createdAt: world.tick, priority: 1, status: "pending" as const });
  }
  return out;
}

function roll(robots: number, ticks: number, withLoad: boolean) {
  let w = growFleet(createInitialWorld(), robots);
  const open = openCells(w);
  let n = 0;
  const stopEvents: { cell: string; kind: string; count: number }[] = [];
  const stopAccum = new Map<string, number>();
  const prev = new Map<string, Position>();
  for (let i = 0; i < ticks; i++) {
    if (withLoad && i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
    w = runDispatchTick(w);
    for (const r of w.robots) {
      const before = prev.get(r.id);
      const movedNow = !before || before.x !== r.position.x || before.y !== r.position.y;
      // A "stop event" = a robot that was moving last tick and is now stationary.
      if (before && movedNow === false && before.x === r.position.x && before.y === r.position.y) {
        const k = key(r.position);
        stopAccum.set(k, (stopAccum.get(k) ?? 0) + 1);
      }
      prev.set(r.id, { ...r.position });
    }
  }
  return { world: w, stopAccum };
}

describe("L: where do AMRs actually stop?", () => {
  it("L1: classify every stall location (20 AMRs, sustained load)", () => {
    const { stopAccum } = roll(20, 3000, true);
    const entries = [...stopAccum.entries()].sort((a, b) => b[1] - a[1]);
    let aisle = 0, wz = 0, dock = 0, station = 0, other = 0;
    const aisleCells: [string, number][] = [];
    for (const [k, n] of entries) {
      const [x, y] = k.split(",").map(Number);
      const p = { x, y };
      if (isDock(p)) dock += n;
      else if (isWaitingZone(p)) wz += n;
      else if (isStation(p)) station += n;
      else { aisle += n; aisleCells.push([k, n]); }
    }
    const total = aisle + wz + dock + station;
    console.log(`L1 total stall-ticks: ${total}`);
    console.log(`L1   in an AISLE (illegal stop): ${aisle}  (${((aisle / total) * 100).toFixed(1)}%) across ${aisleCells.length} distinct cells`);
    console.log(`L1   in a waiting zone:           ${wz}  (${((wz / total) * 100).toFixed(1)}%)`);
    console.log(`L1   on a charging dock:          ${dock}  (${((dock / total) * 100).toFixed(1)}%)`);
    console.log(`L1   on a pickup/dropoff station: ${station}  (${((station / total) * 100).toFixed(1)}%)`);
    console.log(`L1 worst aisle stall cells: ${aisleCells.slice(0, 12).map(([k, n]) => `${k}:${n}`).join("  ")}`);
  });

  it("L2: does a robot EVER voluntarily reposition to a waiting zone?", () => {
    const { world } = roll(20, 3000, true);
    const inWz = world.robots.filter((r) => isWaitingZone(r.position)).length;
    const onDock = world.robots.filter((r) => isDock(r.position)).length;
    console.log(`L2 final: ${inWz} robots inside a waiting zone, ${onDock} on a dock, out of 20`);
    console.log(`L2 waiting zones are: ${WAITING_ZONES.map((z) => `${z.id}(${z.x},${z.y} ${z.width}x${z.height})`).join(" ")}`);
    console.log(`L2 => WAITING_ZONES is exported from warehouse.ts but is it referenced by the engine at all?`);
  });

  it("L3: is WAITING_ZONES referenced anywhere in core?", () => {
    console.log("L3 (grep in a follow-up step) WAITING_ZONES consumers");
  });
});

describe("M: the all-below-floor starvation", () => {
  it("M1: every robot below the bidding floor, pending tasks exist, no bids are possible", () => {
    const base = growFleet(createInitialWorld(), 6);
    // Put the whole fleet just under MIN_BATTERY_TO_BID_PERCENT with zero
    // streak (so needsToCharge is false until the floor check fires).
    let world: WorldState = {
      ...base,
      robots: base.robots.map((r) => ({ ...r, battery: 19, lowBatteryStreak: 0, status: "idle" as const, path: [], queuedTaskIds: [] })),
      tasks: [
        { id: "S1", pickup: { x: 3, y: 9 }, dropoff: { x: 9, y: 1 }, weight: 20, createdAt: 0, priority: 1, status: "pending" },
        { id: "S2", pickup: { x: 9, y: 9 }, dropoff: { x: 13, y: 1 }, weight: 20, createdAt: 0, priority: 1, status: "pending" },
      ],
    };
    world = runDispatchTick(world);
    const s = world.robots.map((r) => `${r.id}:${r.status}@b${r.battery}`).join(" ");
    const pend = world.tasks.filter((t) => t.status === "pending").length;
    console.log(`M1 after 1 tick: ${s}`);
    console.log(`M1 pending tasks still pending: ${pend} of 2`);
    for (let i = 0; i < 30; i++) world = runDispatchTick(world);
    const pend2 = world.tasks.filter((t) => t.status === "pending").length;
    const avgB = world.robots.reduce((a, r) => a + r.battery, 0) / world.robots.length;
    console.log(`M1 after 31 ticks: pending=${pend2}/2 avgBattery=${avgB.toFixed(1)} statuses=${world.robots.map((r) => r.status).join(",")}`);
    console.log("M1 => isEligible() hard-gates on battery >= MIN_BATTERY_TO_BID_PERCENT, so a below-floor robot");
    console.log("M1    makes NO BID AT ALL. Zero bids => assignTask returns null => task stays pending forever.");
    console.log("M1    Meanwhile resolveIdleWork SHOULD pull them to charge. Check if it does.");
  });

  it("M2: the pathological case — robot is mid-task AND below floor (can neither bid nor charge)", () => {
    const base = growFleet(createInitialWorld(), 1);
    let world: WorldState = {
      ...base,
      robots: [{ ...base.robots[0], id: "STRANDED", battery: 5, lowBatteryStreak: 0, status: "assigned", currentTaskId: "LONG", path: [], queuedTaskIds: [] }],
      tasks: [{ id: "LONG", pickup: { x: 17, y: 0 }, dropoff: { x: 1, y: 0 }, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: "STRANDED" }],
    };
    for (let i = 0; i < 60; i++) world = runDispatchTick(world);
    const r = world.robots[0];
    const t = world.tasks[0];
    console.log(`M2 STRANDED: battery=${r.battery} status=${r.status} task=${r.currentTaskId} taskStatus=${t.status} pos=${key(r.position)}`);
    console.log("M2 => if the task can never complete, currentTaskId is never cleared, so resolveIdleWork's");
    console.log("M2    `if (robot.currentTaskId) return robot` means it can NEVER be sent to charge. Permanent.");
  });

  it("M3: battery floor vs charging threshold — are they even consistent?", () => {
    console.log("M3 constants:");
    console.log("M3   MIN_BATTERY_TO_BID_PERCENT = 20  (isEligible hard gate in assign.ts)");
    console.log("M3   BATTERY_SAFETY_RESERVE_PERCENT = 15  (cost.ts infeasibleReason 'battery')");
    console.log("M3   RECHARGE_TARGET_PERCENT = 50  (leave charging here)");
    console.log("M3   BATTERY_PERCENT_PER_CELL = 0.5, CHARGE_PERCENT_PER_TICK = 2");
    console.log("M3 => a robot that finishes charging leaves at 50%. It can then accept a task costing up to");
    console.log("M3    (50-15)/0.5 = 70 cells. Fine. But a robot at 20% can only afford (20-15)/0.5 = 10 cells,");
    console.log("M3    and a robot at 20% that loses its task and idles has 0 incentive to charge until 19%.");
    console.log("M3    The gap between 'can still bid' (>=20) and 'wants to charge' (needsToCharge) is the hazard zone.");
  });
});
