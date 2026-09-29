import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { CHARGING_STATIONS } from "../src/core/map/warehouse";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function rollout(until: (w: WorldState, t: number) => boolean) {
  let world = growFleet(createInitialWorld(), 20);
  const open = openCells(world);
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeTasks(world, n, open)] }; n += 3; }
    world = runDispatchTick(world);
    if (until(world, i)) return { world, t: i };
  }
  return { world, t: -1 };
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

describe("G: find and trace the exact deadlock", () => {
  it("G1: first tick where ZERO robots are moving (global gridlock)", () => {
    const { world, t } = rollout((w) => w.robots.filter((r) => r.status === "moving").length === 0 && w.tick > 50);
    console.log(`G1 global gridlock (0 moving) first at tick ${t}`);
    if (t < 0) return;
    console.log("G1 state at that tick:");
    for (const r of world.robots) {
      const g = r.path.length ? key(r.path[r.path.length - 1]) : "-";
      const nx = r.path.length > 1 ? key(r.path[1]) : "-";
      const occ = world.robots.filter((o) => o.id !== r.id && o.position.x === r.path[1]?.x && o.position.y === r.path[1]?.y).map((o) => o.id);
      console.log(`   ${r.id} @${key(r.position).padEnd(6)} ${r.status.padEnd(9)} prio=${String(r.priority).padStart(4)} goal=${g.padEnd(6)} next=${nx.padEnd(6)} ${occ.length ? "BLOCKED BY " + occ.join(",") : ""}`);
    }
  });

  it("G2: first tick where completed-task throughput hits zero for 200 consecutive ticks", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    let lastDone = 0, lastProgress = 0;
    console.log("G2 tick completed (+delta) moving waiting charging");
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeTasks(world, n, open)] }; n += 3; }
      world = runDispatchTick(world);
      const done = world.tasks.filter((t) => t.status === "completed").length;
      if (done > lastDone) { lastProgress = i; lastDone = done; }
      if (i % 300 === 0) console.log(`   t=${i} done=${done} (+${done - (i === 0 ? 0 : 0)}) moving=${world.robots.filter((r) => r.status === "moving").length} waiting=${world.robots.filter((r) => r.status === "waiting").length} charging=${world.robots.filter((r) => r.status === "charging").length}`);
      if (i > 400 && i - lastProgress > 200) { console.log(`G2 THROUGHPUT DEAD at tick ${i}: no task completed in 200 ticks (last completion at t=${lastProgress})`); break; }
    }
  });

  it("G3: charging robots all converging on ONE station while it is occupied", () => {
    const { world } = rollout((w) => w.tick > 2000);
    const charging = world.robots.filter((r) => r.status === "charging");
    const goals = new Map<string, string[]>();
    for (const r of charging) {
      const g = r.path.length ? key(r.path[r.path.length - 1]) : "PARKED";
      goals.set(g, [...(goals.get(g) ?? []), r.id]);
    }
    console.log(`G3 ${charging.length} charging robots:`);
    for (const [g, ids] of goals) console.log(`   -> ${g}: ${ids.length} robots ${ids.join(",")}`);
    console.log(`G3 stations: ${CHARGING_STATIONS.map((s) => `${s.id}=(${s.position.x},${s.position.y})`).join(" ")}`);
    console.log(`G3 => nearestChargingStation() has no reservation: every robot independently picks its own nearest, and they pile onto the same cell.`);
  });

  it("G4: is a robot parked ON a charging station immune from being pushed?", () => {
    // Put a charging robot on C2 (19,8) and a task robot that needs to pass.
    const world0 = growFleet(createInitialWorld(), 2);
    const [a, b] = world0.robots;
    let world: WorldState = { ...world0, robots: [
      { ...a, id: "CHARGER", position: { x: 19, y: 8 }, status: "charging", path: [], battery: 10, currentTaskId: undefined, queuedTaskIds: [] },
      { ...b, id: "PASSER", position: { x: 19, y: 7 }, status: "assigned", path: [], battery: 100, currentTaskId: "X" },
    ], tasks: [{ id: "X", pickup: { x: 19, y: 9 }, dropoff: { x: 19, y: 10 }, weight: 1, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: "PASSER" }] };
    for (let i = 0; i < 3; i++) {
      world = runDispatchTick(world);
      const c = world.robots.find((r) => r.id === "CHARGER")!;
      const p = world.robots.find((r) => r.id === "PASSER")!;
      console.log(`G4 t=${world.tick} CHARGER @${key(c.position)} ${c.status} | PASSER @${key(p.position)} ${p.status}`);
    }
    console.log("G4 => the charger has status 'charging' but is NOT excluded from PIBT's push set, so it gets shoved off mid-charge.");
  });
});
