import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { growFleet, openCells } from "./harness";
import { getBiddingRobots } from "../src/core/auction/assign";
import type { WorldState, Position, Task } from "../src/core/types";

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

describe("N: the left-of-warehouse bias", () => {
  it("N1: spatial distribution of robot occupancy over a long run", () => {
    const w0 = growFleet(createInitialWorld(), 20);
    const open = openCells(w0);
    let w = w0;
    let n = 0;
    const occ = new Map<string, number>();
    for (let i = 0; i < 1200; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = runDispatchTick(w);
      for (const r of w.robots) occ.set(key(r.position), (occ.get(key(r.position)) ?? 0) + 1);
    }
    const byX = new Array(20).fill(0);
    let total = 0;
    for (const [k, c] of occ) { const x = Number(k.split(",")[0]); byX[x] += c; total += c; }
    console.log("N1 robot-tick occupancy by column (x=0 leftmost .. x=19 rightmost):");
    for (let x = 0; x < 20; x++) {
      const pctv = ((byX[x] / total) * 100).toFixed(1);
      const bar = "#".repeat(Math.round((byX[x] / Math.max(...byX)) * 40));
      console.log(`N1  x=${String(x).padStart(2)} ${String(pctv).padStart(5)}%  ${bar}`);
    }
    const left = byX.slice(0, 10).reduce((a, b) => a + b, 0);
    const right = byX.slice(10).reduce((a, b) => a + b, 0);
    console.log(`N1 left half (x0-9) = ${((left / total) * 100).toFixed(1)}%, right half (x10-19) = ${((right / total) * 100).toFixed(1)}%`);
  });

  it("N2: is it the SEED, the SHELVES, or the ALGORITHM? — control experiment", () => {
    // Run the SAME workload with a fleet whose homes are mirrored to the
    // right half. If the bias follows the fleet, it's algorithmic; if it
    // stays put, it's the seed/spawn positions.
    const open = openCells(growFleet(createInitialWorld(), 20));

    const measure = (mirror: boolean) => {
      let w = growFleet(createInitialWorld(), 20);
      if (mirror) {
        w = { ...w, robots: w.robots.map((r) => ({ ...r, position: { x: 19 - r.position.x, y: r.position.y }, home: { x: 19 - r.home.x, y: r.home.y } })) };
      }
      let n = 0;
      const occ = new Map<string, number>();
      for (let i = 0; i < 1200; i++) {
        if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
        w = runDispatchTick(w);
        for (const r of w.robots) occ.set(key(r.position), (occ.get(key(r.position)) ?? 0) + 1);
      }
      const byX = new Array(20).fill(0);
      let total = 0;
      for (const [k, c] of occ) { byX[Number(k.split(",")[0])] += c; total += c; }
      const left = byX.slice(0, 10).reduce((a, b) => a + b, 0);
      return { left: (left / total) * 100, byX, total };
    };

    const a = measure(false);
    const b = measure(true);
    console.log(`N2 as-seeded fleet      : left half = ${a.left.toFixed(1)}%`);
    console.log(`N2 x-mirrored fleet     : left half = ${b.left.toFixed(1)}%  (seed/homes moved to the right)`);
    console.log(`N2 => if mirroring the fleet MOVES the hotspot, the bias is in the fleet's own state (home/seed).`);
    console.log(`N2    if the hotspot stays left, it's in the map/cost function.`);
  });

  it("N3: which cost term creates the pull? isolate workloadCost", () => {
    // cost.ts: computeWorkloadCost = manhattanDistance(position, home).
    // Robots are pulled TOWARD their home. Seed homes cluster left/centre.
    let w = growFleet(createInitialWorld(), 20);
    const homes = w.robots.map((r) => r.home.x).sort((a, b) => a - b);
    console.log(`N3 seeded home columns: ${homes.join(",")}`);
    console.log(`N3 sum=${homes.reduce((a, b) => a + b, 0)} mean=${(homes.reduce((a, b) => a + b, 0) / homes.length).toFixed(1)} (uniform would be 9.5)`);
    console.log(`N3 => computeWorkloadCost pulls each robot toward its home with weight 1.0.`);
  });

  it("N4: the real spatial hot-spot — the deadlock kernel cell and its pull", () => {
    let w = growFleet(createInitialWorld(), 20);
    const open = openCells(w);
    let n = 0;
    const occ = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; }
      w = runDispatchTick(w);
      for (const r of w.robots) occ.set(key(r.position), (occ.get(key(r.position)) ?? 0) + 1);
    }
    const top = [...occ.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log("N4 top-10 most-occupied cells over 3000 ticks:");
    for (const [k, c] of top) console.log(`N4   ${k.padEnd(6)} ${c} robot-ticks`);
    console.log("N4 charging stations are at (0,4) (19,8) (9,0) (9,12). C2=(19,8) is the kernel.");
  });
});
