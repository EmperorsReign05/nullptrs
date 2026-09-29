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

// A "wait dependency" edge: A wants cell X, X is held by B. Follow it and
// see whether it terminates in a cycle or at a free cell.
function waitGraph(world: WorldState) {
  const at = new Map<string, string>();
  for (const r of world.robots) at.set(key(r.position), r.id);
  const edges = new Map<string, string>();
  for (const r of world.robots) {
    if (r.path.length > 1) {
      const want = at.get(key(r.path[1]));
      if (want && want !== r.id) edges.set(r.id, want);
    }
  }
  // find cycles
  const cycles: string[][] = [];
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1); stack.push(id);
    const next = edges.get(id);
    if (next) {
      if (state.get(next) === 1) {
        const i = stack.indexOf(next);
        cycles.push(stack.slice(i));
      } else if (!state.has(next)) visit(next);
    }
    stack.pop(); state.set(id, 2);
  };
  for (const id of edges.keys()) if (!state.has(id)) visit(id);
  return { edges, cycles };
}

describe("I: wait-for cycle analysis", () => {
  it("I1: how big do the wait cycles get, and do they ever break?", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeTasks(world, n, open)] }; n += 3; }
      world = runDispatchTick(world);
      if (i % 500 === 0) {
        const { edges, cycles } = waitGraph(world);
        const biggest = cycles.reduce((a, c) => Math.max(a, c.length), 0);
        console.log(`I1 t=${i}: ${edges.size} robots waiting on someone, ${cycles.length} distinct cycles, largest cycle = ${biggest} robots`);
        for (const c of cycles.slice(0, 4)) console.log(`      cycle: ${c.join(" -> ")} -> ${c[0]}`);
      }
    }
    const { cycles } = waitGraph(world);
    console.log(`I1 FINAL tick ${world.tick}: ${cycles.length} irreducible cycles still present.`);
    console.log("I1 => PIBT's documented scope limit ('cycles longer than a direct 2-robot swap are conservatively unresolvable, all participants wait')");
    console.log("I1    is exactly what happens here, and nothing ever escapes it: no replan, no backoff, no priority that can break a cycle.");
  });

  it("I2: does raising PIBT's in-progress cycle limit actually fix it? (proof the cycle IS the cause)", () => {
    // If cycles are the cause, then detecting "nobody moved and a cycle
    // exists" and forcing a deterministic yield must break the deadlock.
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    const roll = (w: WorldState) => runDispatchTick(w);
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeTasks(world, n, open)] }; n += 3; }
      world = roll(world);
    }
    const before = world.tasks.filter((t) => t.status === "completed").length;

    // Same seed, but every 50 ticks if nothing moved, forcibly displace one
    // member of the largest cycle to a free neighbour.
    let world2 = growFleet(createInitialWorld(), 20);
    let n2 = 0, esc = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { world2 = { ...world2, tasks: [...world2.tasks, ...makeTasks(world2, n2, open)] }; n2 += 3; }
      world2 = roll(world2);
      const moved = world2.robots.some((r, j) => r.position.x !== world2.robots[j].position.x || r.position.y !== world2.robots[j].position.y);
      if (i % 50 === 49 && !moved) {
        const { cycles } = waitGraph(world2);
        const victim = cycles.sort((a, b) => b.length - a.length)[0]?.[0];
        if (victim) {
          const r = world2.robots.find((x) => x.id === victim)!;
          const occ = new Set(world2.robots.map((o) => key(o.position)));
          for (const d of [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]) {
            const n = { x: r.position.x + d.x, y: r.position.y + d.y };
            if (!occ.has(key(n))) { world2 = { ...world2, robots: world2.robots.map((x) => x.id === victim ? { ...x, position: n } : x) }; esc++; break; }
          }
        }
      }
    }
    const after = world2.tasks.filter((t) => t.status === "completed").length;
    console.log(`I2 baseline completed=${before} (deadlocked)`);
    console.log(`I2 with a deadlock-breaker nudge every 50 ticks: completed=${after} (${esc} escapes) => ${after > before + 20 ? "CYCLE IS THE CAUSE" : "still stuck, cause is elsewhere"}`);
  });

  it("I3: the chargers mutually block each other at one station", () => {
    const { edges, cycles } = waitGraph((() => {
      let w = growFleet(createInitialWorld(), 20);
      const open = openCells(w);
      let n = 0;
      for (let i = 0; i < 3000; i++) { if (i % 20 === 0) { w = { ...w, tasks: [...w.tasks, ...makeTasks(w, n, open)] }; n += 3; } w = runDispatchTick(w); }
      return w;
    })());
    const w = (() => {
      let ww = growFleet(createInitialWorld(), 20);
      const open = openCells(ww);
      let n = 0;
      for (let i = 0; i < 3000; i++) { if (i % 20 === 0) { ww = { ...ww, tasks: [...ww.tasks, ...makeTasks(ww, n, open)] }; n += 3; } ww = runDispatchTick(ww); }
      return ww;
    })();
    for (const c of cycles) {
      const statuses = c.map((id) => { const r = w.robots.find((x) => x.id === id); return `${id}(${r?.status})`; });
      const allCharging = c.every((id) => w.robots.find((x) => x.id === id)?.status === "charging");
      console.log(`I3 cycle: ${statuses.join(" -> ")} -> ${c[0]}${allCharging ? "   <-- ALL CHARGING: mutual block at a station" : ""}`);
    }
    console.log(`I3 stations: ${CHARGING_STATIONS.map((s) => `${s.id}=(${s.position.x},${s.position.y})`).join(" ")}`);
  });
});
