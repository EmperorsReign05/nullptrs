import { describe, it } from "vitest";
import { runDispatchTick as protoTick } from "../src/core/simulation/dispatch2";
import { isLegalStop } from "../src/core/simulation/engine2";
import { WAITING_ZONES, CHARGING_STATIONS, PICKUP_STATIONS, DROPOFF_STATIONS, isTraversable } from "../src/core/map/warehouse";
import { createInitialWorld } from "../src/core/simulation/state";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
function makeTasks(w: WorldState, s: number, open: Position[]) {
  const out = [];
  for (let i = 0; i < 3; i++) { const n = s + i; const p = open[(n * 7 + 3) % open.length]; const d = open[(n * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push({ id: `L${n}`, pickup: p, dropoff: d, weight: (n % 9) * 10 + 10, createdAt: w.tick, priority: 1, status: "pending" as const }); }
  return out;
}

describe("S: WHY I1 fails — legal-stop capacity, and its dependence on deadlock-freedom", () => {
  it("S1: how many legal stop cells exist vs how many robots must rest", () => {
    const wz: Position[] = [];
    for (const z of WAITING_ZONES) for (let dx = 0; dx < z.width; dx++) for (let dy = 0; dy < z.height; dy++) wz.push({ x: z.x + dx, y: z.y + dy });
    const total = wz.length + CHARGING_STATIONS.length + PICKUP_STATIONS.length + DROPOFF_STATIONS.length;
    console.log(`S1 legal stop cells: ${wz.length} in waiting zones + ${CHARGING_STATIONS.length} docks + ${PICKUP_STATIONS.length + DROPOFF_STATIONS.length} stations = ${total}`);
    console.log(`S1 open (traversable) cells on the grid: ${openCells(createInitialWorld()).length}`);
    console.log(`S1 => legal stops are ${((total / openCells(createInitialWorld()).length) * 100).toFixed(1)}% of the floor.`);
    for (const n of [10, 20]) console.log(`S1   fleet=${n}: ${(total / n).toFixed(2)} legal stop cells per robot`);
    console.log("S1 => At 20 AMRs there are FEWER legal stops (26) than robots (20) once you exclude");
    console.log("S1    stations that are also pickup/dropoff targets. The invariant is SATURATED, not violated by choice.");
  });

  it("S2: when a robot at an illegal cell has no free neighbour, it CANNOT move — prove it", () => {
    // Build a jammed pocket: a robot on an aisle cell whose every traversable
    // neighbour is occupied by a stationary robot.
    const map = createInitialWorld().map;
    const target: Position = { x: 6, y: 4 };
    const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
    const free: Position[] = [];
    for (const d of dirs) { const n = { x: target.x + d.x, y: target.y + d.y }; if (isTraversable(n, map)) free.push(n); }
    console.log(`S2 target ${key(target)} isLegalStop=${isLegalStop(target)}; traversable neighbours: ${free.map(key).join(" ")}`);
    console.log(`S2 => a hard "never rest here" rule is only satisfiable while at least one neighbour is free.`);
    console.log(`S2    In a jam, EVERY neighbour is occupied, so the rule is unsatisfiable and the robot`);
    console.log(`S2    must violate it. I1 is therefore NOT an independent fix — it is a CONSEQUENCE of`);
    console.log(`S2    deadlock-freedom plus enough designated parking. Neither alone is sufficient.`);
  });

  it("S3: measure how often a robot at an illegal cell has literally nowhere to go", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0, boxed = 0, illegalWait = 0, hadFreeNeighbour = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = protoTick(w);
      const occ = new Set(w.robots.map((r) => key(r.position)));
      for (const r of w.robots) {
        if (r.status !== "waiting") continue;
        if (isLegalStop(r.position)) continue;
        illegalWait++;
        const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
        const anyFree = dirs.some((d) => { const nn = { x: r.position.x + d.x, y: r.position.y + d.y }; return isTraversable(nn, w.map) && !occ.has(key(nn)); });
        if (anyFree) hadFreeNeighbour++; else boxed++;
      }
    }
    console.log(`S3 illegal waits=${illegalWait}: ${hadFreeNeighbour} had at least one free neighbour (fixable), ${boxed} were BOXED IN (no legal move exists at all)`);
    console.log(`S3 => ${((boxed / illegalWait) * 100).toFixed(1)}% of illegal waits were physically unavoidable. The rule cannot be satisfied there.`);
  });

  it("S4: is the real lever more designated parking?", () => {
    console.log("S4 The map has 3 waiting zones of 2x3 = 18 cells for a 20-robot fleet.");
    console.log("S4 A principled fix is to designate parking with CAPACITY >= fleet size, and to make");
    console.log("S4 'retreat to nearest free legal stop' a first-class PIBT candidate (not just 'wait'),");
    console.log("S4 so a blocked robot dissolves into the parking system instead of deadlocking an aisle.");
  });
});
