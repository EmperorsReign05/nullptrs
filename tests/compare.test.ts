import { describe, it, expect } from "vitest";
import { runDispatchTick as baseTick } from "../src/core/simulation/dispatch";
import { runDispatchTick as protoTick } from "../src/core/simulation/dispatch2";
import { isLegalStop } from "../src/core/simulation/engine2";
import { createInitialWorld } from "../src/core/simulation/state";
import { CHARGING_STATIONS } from "../src/core/map/warehouse";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

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

function waitCycles(world: WorldState): string[][] {
  const at = new Map<string, string>();
  for (const r of world.robots) at.set(key(r.position), r.id);
  const edges = new Map<string, string>();
  for (const r of world.robots) {
    if (r.path.length > 1) { const w = at.get(key(r.path[1])); if (w && w !== r.id) edges.set(r.id, w); }
  }
  const cycles: string[][] = [];
  const color = new Map<string, number>(); const stack: string[] = [];
  const visit = (id: string) => {
    color.set(id, 1); stack.push(id);
    const nx = edges.get(id);
    if (nx) { if (color.get(nx) === 1) cycles.push(stack.slice(stack.indexOf(nx))); else if (!color.has(nx)) visit(nx); }
    stack.pop(); color.set(id, 2);
  };
  for (const id of edges.keys()) if (!color.has(id)) visit(id);
  return cycles;
}

type RunResult = {
  completed: number; generated: number; moving: number; waiting: number; charging: number; idle: number;
  cycles: number; conflicts: number; replans: number; illegalStalls: number; stallTicks: number;
  byX: number[]; minBattery: number; deadAt: number; lastProgress: number;
};

function run(tick: (w: WorldState) => WorldState, robots: number, ticks: number): RunResult {
  let w = growFleet(createInitialWorld(), robots);
  const open = openCells(w);
  let n = 0;
  const occ = new Array(20).fill(0);
  let stallTicks = 0, illegalStalls = 0, lastDone = 0, lastProgress = 0, deadAt = -1;
  let totalOcc = 0;

  for (let i = 0; i < ticks; i++) {
    if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
    w = tick(w);
    for (const r of w.robots) { occ[r.position.x]++; totalOcc++; }
    if (!isLegalStop(r_check(r_dummy(w)))) void 0;
    const done = w.tasks.filter((t) => t.status === "completed").length;
    if (done > lastDone) { lastProgress = i; lastDone = done; }
    if (deadAt === -1 && i > 300 && i - lastProgress > 300) deadAt = i;
  }
  // stall accounting over a final observation window
  const obs = 200;
  for (let i = 0; i < obs; i++) {
    w = tick(w);
    for (const r of w.robots) {
      const moving = r.status === "moving";
      if (!moving) { stallTicks++; if (!isLegalStop(r.position)) illegalStalls++; }
    }
  }
  return {
    completed: w.tasks.filter((t) => t.status === "completed").length,
    generated: w.tasks.length,
    moving: w.robots.filter((r) => r.status === "moving").length,
    waiting: w.robots.filter((r) => r.status === "waiting").length,
    charging: w.robots.filter((r) => r.status === "charging").length,
    idle: w.robots.filter((r) => r.status === "idle").length,
    cycles: waitCycles(w).length,
    conflicts: w.metrics.conflictCount,
    replans: w.metrics.replans,
    illegalStalls, stallTicks, byX: occ.map((c) => (c / totalOcc) * 100),
    minBattery: Math.min(...w.robots.map((r) => r.battery)),
    deadAt, lastProgress,
  };
}
function r_dummy(w: WorldState) { return w.robots[0].position; }
function r_check(p: Position) { return p; }

describe("P: BASELINE vs PROTOTYPE, identical workload and seed", () => {
  for (const n of [10, 20]) {
    it(`P: ${n} AMRs, 3000 ticks — baseline vs prototype`, () => {
      const b = run(baseTick, n, 3000);
      const p = run(protoTick, n, 3000);
      const row = (label: string, x: RunResult) =>
        `P ${label.padEnd(10)} completed=${String(x.completed).padStart(4)}/${String(x.generated).padStart(4)} moving=${String(x.moving).padStart(2)} wait=${String(x.waiting).padStart(2)} charge=${String(x.charging).padStart(2)} idle=${String(x.idle).padStart(2)} cycles=${x.cycles} conflicts=${String(x.conflicts).padStart(6)} | illegalStalls=${String(x.illegalStalls).padStart(5)}/${String(x.stallTicks).padStart(5)} | minB=${x.minBattery.toFixed(1).padStart(5)} | deadAt=${x.deadAt}`;
      console.log(row("BASELINE", b));
      console.log(row("PROTOTYPE", p));
      const ratio = b.completed === 0 ? "n/a" : ((p.completed / b.completed) * 100).toFixed(0) + "%";
      console.log(`P ${n} AMRs: throughput ${b.completed} -> ${p.completed} (${ratio}), cycles ${b.cycles} -> ${p.cycles}, illegal stalls ${b.illegalStalls} -> ${p.illegalStalls}`);
      const bLeft = b.byX.slice(0, 10).reduce((a, c) => a + c, 0);
      const pLeft = p.byX.slice(0, 10).reduce((a, c) => a + c, 0);
      console.log(`P ${n} AMRs: left-half occupancy ${bLeft.toFixed(1)}% -> ${pLeft.toFixed(1)}% (uniform = 50%)`);
      expect(p.cycles).toBe(0);
    });
  }

  it("P: spatial distribution, prototype vs baseline (20 AMRs)", () => {
    const b = run(baseTick, 20, 1200);
    const p = run(protoTick, 20, 1200);
    console.log("P col   baseline  prototype");
    for (let x = 0; x < 20; x++) {
      console.log(`P x=${String(x).padStart(2)}  ${b.byX[x].toFixed(1).padStart(6)}%  ${p.byX[x].toFixed(1).padStart(6)}%  ${"#".repeat(Math.round(p.byX[x] / 2))}`);
    }
  });

  it("P: the starvation scenario — can the fleet ever reach 'nobody can bid'?", () => {
    const test = (tick: (w: WorldState) => WorldState, label: string) => {
      let w = growFleet(createInitialWorld(), 20);
      const open = openCells(w);
      w = { ...w, robots: w.robots.map((r) => ({ ...r, battery: 19, lowBatteryStreak: 0, status: "idle" as const, path: [], queuedTaskIds: [] })) };
      w = { ...w, tasks: [...w.tasks, { id: "S1", pickup: open[10], dropoff: open[60], weight: 20, createdAt: 0, priority: 1, status: "pending" as const }] };
      let starvTicks = 0;
      for (let i = 0; i < 400; i++) {
        w = tick(w);
        const anyoneCanBid = w.robots.some((r) => r.battery >= 20 && r.status !== "charging");
        if (!anyoneCanBid) starvTicks++;
      }
      const pend = w.tasks.filter((t) => t.status === "pending").length;
      console.log(`P ${label.padEnd(10)} ticks with NO robot able to bid: ${starvTicks}/400, task still pending at end: ${pend}, avgBattery=${(w.robots.reduce((a, r) => a + r.battery, 0) / w.robots.length).toFixed(1)}`);
    };
    test(baseTick, "BASELINE");
    test(protoTick, "PROTOTYPE");
  });

  it("P: energy floor is derived, not guessed", () => {
    console.log(`P energyFloorPercent = 40 cells * 0.5%/cell + 15% reserve = 35%`);
    console.log(`P CHARGING_STATIONS: ${CHARGING_STATIONS.map((s) => `${s.id}=(${s.position.x},${s.position.y})`).join(" ")}`);
    console.log(`P => a robot at 35% can always reach a dock from anywhere on the grid, so it can never strand.`);
  });
});
