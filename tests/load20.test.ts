import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { MIN_BATTERY_TO_BID_PERCENT, BATTERY_PERCENT_PER_CELL } from "../src/core/simulation/robotModels";
import { growFleet, sample, createLoadWorld, openCells, makeLoadTasks } from "./harness";
import type { WorldState } from "../src/core/types";

const TICKS = 3000;

function run(world: WorldState, ticks: number, every: number) {
  const samples = [];
  for (let i = 0; i < ticks; i++) {
    world = runDispatchTick(world);
    if (i % every === 0 || i === ticks - 1) samples.push(sample(world));
  }
  return { world, samples };
}

function pct(n: number, d: number) { return d === 0 ? "0%" : ((n / d) * 100).toFixed(1) + "%"; }

describe("A: the exact dashboard scenario — slider to 20 AMRs, Start Sim, no new tasks", () => {
  it("A1: fleet scaling itself is already broken before a single tick runs", () => {
    let world = createInitialWorld();
    console.log(`seed fleet = ${world.robots.length} robots`);
    world = growFleet(world, 20);

    const cells = new Map<string, string[]>();
    for (const r of world.robots) cells.set(`${r.position.x},${r.position.y}`, [...(cells.get(`${r.position.x},${r.position.y}`) ?? []), r.id]);
    const dupes = [...cells.entries()].filter(([, ids]) => ids.length > 1);
    console.log(`A1 after growing to 20: ${world.robots.length} robots, ${cells.size} distinct cells, ${dupes.length} COLLISIONS`);
    for (const [c, ids] of dupes) console.log(`   cell ${c} holds ${ids.length} robots: ${ids.join(", ")}`);

    // How many ticks until PIBT notices? Does it self-heal or stay broken?
    const { world: w2 } = run(world, 5, 1000);
    const s = sample(w2);
    console.log(`A1 after 5 ticks: duplicateOccupancy=${s.duplicateOccupancy}`);
  });

  it("A2: 20 AMRs, no new tasks, 3000 ticks — what does the fleet actually do?", () => {
    let world = growFleet(createInitialWorld(), 20);
    const { world: w, samples } = run(world, TICKS, 500);
    console.log("A2 tick |  idle wait move charge chrg |  avgB  minB | pend inProg done | dup onBlk atStn | waitMoves conflicts replans");
    for (const s of samples) {
      console.log(
        `A2 ${String(s.tick).padStart(5)} | ${String(s.idle).padStart(4)} ${String(s.waiting).padStart(4)} ${String(s.moving).padStart(4)} ${String(s.assigned).padStart(5)} ${String(s.charging).padStart(4)} | ` +
        `${s.avgBattery.toFixed(1).padStart(5)} ${s.minBattery.toFixed(1).padStart(5)} | ${String(s.pending).padStart(4)} ${String(s.inProgress).padStart(6)} ${String(s.completed).padStart(4)} | ` +
        `${String(s.duplicateOccupancy).padStart(3)} ${String(s.onBlockedCell).padStart(4)} ${String(s.robotsAtStation).padStart(5)} | ` +
        `${String(s.metrics.waitMoves).padStart(9)} ${String(s.metrics.conflictCount).padStart(9)} ${String(s.metrics.replans).padStart(7)}`
      );
    }
    const last = samples[samples.length - 1];
    console.log(`A2 FINAL: idle=${last.idle} waiting=${last.waiting} moving=${last.moving} charging=${last.charging} completed=${last.completed} zeroBatteryWorking=${last.zeroBatteryWorking}`);
  });
});

describe("B: 20 AMRs under sustained task load", () => {
  it("B1: 12 initial tasks, 3000 ticks", () => {
    let world = createLoadWorld(20, 12);
    const { world: w, samples } = run(world, TICKS, 500);
    console.log("B1 tick |  idle wait move assign charge |  avgB  minB | pend inProg done | ownerless dup | waitMoves conflicts replans backtrk inherit");
    for (const s of samples) {
      console.log(
        `B1 ${String(s.tick).padStart(5)} | ${String(s.idle).padStart(4)} ${String(s.waiting).padStart(4)} ${String(s.moving).padStart(4)} ${String(s.assigned).padStart(6)} ${String(s.charging).padStart(5)} | ` +
        `${s.avgBattery.toFixed(1).padStart(5)} ${s.minBattery.toFixed(1).padStart(5)} | ${String(s.pending).padStart(4)} ${String(s.inProgress).padStart(6)} ${String(s.completed).padStart(4)} | ` +
        `${String(s.taskOwnerless).padStart(9)} ${String(s.duplicateOccupancy).padStart(3)} | ${String(s.metrics.waitMoves).padStart(9)} ${String(s.metrics.conflictCount).padStart(9)} ${String(s.metrics.replans).padStart(7)} ${String(s.metrics.backtracks).padStart(7)} ${String(s.metrics.inheritedPriorities).padStart(7)}`
      );
    }
  });

  it("B2: rolling task injection — 20 AMRs, new task every 20 ticks", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    const samples = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) {
        const fresh = makeLoadTasks(world, n, 3, open);
        n += 3;
        world = { ...world, tasks: [...world.tasks, ...fresh] };
      }
      world = runDispatchTick(world);
      if (i % 500 === 0 || i === 2999) samples.push(sample(world));
    }
    console.log("B2 tick |  idle wait move assign charge |  avgB  minB | pend inProg done | dup onBlk | waitMoves conflicts replans");
    for (const s of samples) {
      console.log(
        `B2 ${String(s.tick).padStart(5)} | ${String(s.idle).padStart(4)} ${String(s.waiting).padStart(4)} ${String(s.moving).padStart(4)} ${String(s.assigned).padStart(6)} ${String(s.charging).padStart(5)} | ` +
        `${s.avgBattery.toFixed(1).padStart(5)} ${s.minBattery.toFixed(1).padStart(5)} | ${String(s.pending).padStart(4)} ${String(s.inProgress).padStart(6)} ${String(s.completed).padStart(4)} | ` +
        `${String(s.duplicateOccupancy).padStart(3)} ${String(s.onBlockedCell).padStart(4)} | ${String(s.metrics.waitMoves).padStart(9)} ${String(s.metrics.conflictCount).padStart(9)} ${String(s.metrics.replans).padStart(7)}`
      );
    }
  });
});
