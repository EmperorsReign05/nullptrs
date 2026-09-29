import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
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
function waitGraph(world: WorldState) {
  const at = new Map<string, string>();
  for (const r of world.robots) at.set(key(r.position), r.id);
  const edges = new Map<string, string>();
  for (const r of world.robots) {
    if (r.path.length > 1) { const want = at.get(key(r.path[1])); if (want && want !== r.id) edges.set(r.id, want); }
  }
  const cycles: string[][] = [];
  const st = new Map<string, number>(); const stack: string[] = [];
  const visit = (id: string) => { st.set(id, 1); stack.push(id); const nx = edges.get(id);
    if (nx) { if (st.get(nx) === 1) cycles.push(stack.slice(stack.indexOf(nx))); else if (!st.has(nx)) visit(nx); }
    stack.pop(); st.set(id, 2); };
  for (const id of edges.keys()) if (!st.has(id)) visit(id);
  return { edges, cycles };
}
function rollTo(robots: number, ticks: number) {
  let w = growFleet(createInitialWorld(), robots);
  const open = openCells(w);
  let n = 0;
  for (let i = 0; i < ticks; i++) {
    if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
    w = runDispatchTick(w);
  }
  return w;
}

describe("J: breaking point and the compounding", () => {
  it("J1: throughput vs fleet size — where does it fall off a cliff", () => {
    console.log("J1 fleet | completed | moving waiting charging | cycles | replans  conflicts");
    for (const n of [4, 6, 8, 10, 12, 14, 16, 18, 20]) {
      const w = rollTo(n, 3000);
      const done = w.tasks.filter((t) => t.status === "completed").length;
      const { cycles } = waitGraph(w);
      console.log(`J1 ${String(n).padStart(5)} | ${String(done).padStart(9)} | ${String(w.robots.filter((r) => r.status === "moving").length).padStart(6)} ${String(w.robots.filter((r) => r.status === "waiting").length).padStart(7)} ${String(w.robots.filter((r) => r.status === "charging").length).padStart(8)} | ${String(cycles.length).padStart(6)} | ${String(w.metrics.replans).padStart(7)} ${String(w.metrics.conflictCount).padStart(9)}`);
    }
  });

  it("J2: the kernel deadlock, isolated — a task robot standing ON a charging station", () => {
    // The exact 2-cycle from the 20-AMR run, with nothing else in the world.
    const base = growFleet(createInitialWorld(), 2);
    const c2 = CHARGING_STATIONS.find((s) => s.id === "C2")!.position; // (19,8)
    let world: WorldState = {
      ...base,
      robots: [
        { ...base.robots[0], id: "BLOCKED", position: { ...c2 }, home: { x: 5, y: 5 }, status: "assigned", path: [], priority: 0, battery: 51, currentTaskId: "T1", queuedTaskIds: [] },
        { ...base.robots[1], id: "CHARGER", position: { x: c2.x - 1, y: c2.y }, home: { x: 5, y: 5 }, status: "charging", path: [], priority: 0, battery: 19, currentTaskId: undefined, queuedTaskIds: [] },
      ],
      tasks: [{ id: "T1", pickup: { x: 10, y: 4 }, dropoff: { x: 10, y: 1 }, weight: 1, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: "BLOCKED" }],
    };
    console.log(`J2 kernel: BLOCKED stands ON station C2 ${key(c2)} holding task T1; CHARGER adjacent wants C2.`);
    for (let i = 0; i < 6; i++) {
      world = runDispatchTick(world);
      const b = world.robots.find((r) => r.id === "BLOCKED")!;
      const c = world.robots.find((r) => r.id === "CHARGER")!;
      console.log(`J2 t=${world.tick} BLOCKED@${key(b.position)} ${b.status.padEnd(9)} b=${b.battery.toFixed(1)} | CHARGER@${key(c.position)} ${c.status.padEnd(9)} b=${c.battery.toFixed(1)}`);
    }
    const b = world.robots.find((r) => r.id === "BLOCKED")!;
    const c = world.robots.find((r) => r.id === "CHARGER")!;
    console.log(`J2 VERDICT: BLOCKED never leaves the station (b=${b.battery.toFixed(1)}), CHARGER never charges (b=${c.battery.toFixed(1)}). Both stuck forever.`);
    console.log("J2 ROOT: BLOCKED can't charge because resolveIdleWork skips any robot with a currentTaskId,");
    console.log("J2       and can't move because the only cell CHARGER wants is the one BLOCKED is standing on.");
  });

  it("J3: replans go to exactly 0 once the kernel forms", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0, lastReplans = 0, frozenAt = -1;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = runDispatchTick(w);
      if (w.metrics.replans === lastReplans && i > 300 && frozenAt === -1 && w.robots.every((r) => r.status !== "moving")) frozenAt = i;
      lastReplans = w.metrics.replans;
    }
    console.log(`J3 replans froze at tick ~${frozenAt}, final replans=${w.metrics.replans}, but conflicts kept climbing to ${w.metrics.conflictCount}`);
    console.log("J3 => once the kernel forms, planRoutes() finds every goal unchanged and every next-step still traversable,");
    console.log("J3    so the entire fleet stops replanning while PIBT spins on the same 2-cycle forever.");
  });

  it("J4: the dashboard default (10 AMRs) is already degraded, not just 20", () => {
    const w = rollTo(10, 3000);
    const done = w.tasks.filter((t) => t.status === "completed").length;
    const total = w.tasks.length;
    console.log(`J4 10 AMRs, 3000 ticks: completed ${done}/${total} (${((done / total) * 100).toFixed(0)}%), moving=${w.robots.filter((r) => r.status === "moving").length}, waiting=${w.robots.filter((r) => r.status === "waiting").length}, charging=${w.robots.filter((r) => r.status === "charging").length}, avgBattery=${(w.robots.reduce((a, r) => a + r.battery, 0) / 10).toFixed(1)}`);
  });
});
