import { describe, it, expect } from "vitest";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { scenarioChokePoint, scenarioTJunction, scenarioOpenFloor, CHOKE_BAYS } from "../src/core/bench/scenarios";
import { mapFromOpen } from "../src/core/bench/scenarios";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import type { Position, RobotState, Task } from "../src/core/types";

const key = (p: Position) => p.x + "," + p.y;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function lattice(width: number) {
  const open: Position[] = [];
  const period = width + 1;
  for (let y = 0; y < 13; y++) for (let x = 0; x < 20; x++) {
    const pillar = x % period === 0 && y % period === 0 && x !== 0 && y !== 0;
    if (!pillar) open.push({ x, y });
  }
  return mapFromOpen(open);
}

function makeScenario(width: number, n: number, seed: number) {
  const map = lattice(width);
  const open = map.cells.filter((c) => !c.blocked).map((c) => c.position);
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const sh = [...open];
  for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
  const used = new Set<string>(); const starts: Position[] = [];
  for (const c of sh) { if (used.has(key(c))) continue; used.add(key(c)); starts.push(c); if (starts.length >= n * 2) break; }
  const robots: RobotState[] = []; const tasks: Task[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < n; i++) {
    const s = starts[i];
    let best: Position | null = null; let bd = -1;
    for (const c of starts.slice(n)) { if (taken.has(key(c))) continue; const d = Math.abs(c.x - s.x) + Math.abs(c.y - s.y); if (d > bd) { bd = d; best = c; } }
    if (!best) best = { x: s.x, y: s.y };
    taken.add(key(best));
    const id = "AMR-" + String(i + 1).padStart(2, "0");
    robots.push({ id, position: { ...s }, home: { ...s }, battery: 100, status: "assigned", model: ROBOT_MODELS[0], currentTaskId: "T" + (i + 1), path: [], priority: 0 });
    tasks.push({ id: "T" + (i + 1), pickup: { ...s }, dropoff: { ...(best as Position) }, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: id });
  }
  return { map, robots, tasks };
}

describe("DIST: genuinely decentralised fleet", () => {
  it("D1: sanity — 3 robots on the choke point, no coordinator", () => {
    const g = scenarioChokePoint();
    const f = new DistributedFleet(g.map, clone(g.robots), clone(g.tasks));
    const r = f.run(400);
    console.log(`D1 distributed choke-point: completed ${r.completed}/${r.total} makespan=${r.makespan} history=${JSON.stringify(r.history)}`);
    // collisions?
    const cells = f.getRobots().map((x) => key(x.position));
    console.log(`D1 distinct cells ${new Set(cells).size}/${cells.length}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it("D2: the network cut — sever a link and the fleet must survive", () => {
    const g = scenarioOpenFloor();
    const base = new DistributedFleet(g.map, clone(g.robots), clone(g.tasks));
    const withCut = new DistributedFleet(g.map, clone(g.robots), clone(g.tasks), { severed: [["AMR-01", "AMR-02"]] });
    const rb = base.run(300);
    const rc = withCut.run(300);
    console.log(`D2 no cut : completed ${rb.completed}/${rb.total} makespan=${rb.makespan}`);
    console.log(`D2 cut    : completed ${rc.completed}/${rc.total} makespan=${rc.makespan}`);
    console.log(`D2 severed links: ${JSON.stringify(withCut.severed)}`);
    const cells = withCut.getRobots().map((x) => key(x.position));
    console.log(`D2 distinct cells under cut: ${new Set(cells).size}/${cells.length}`);
  });

  it("D3: agents only see peers inside comm range — locality, not omniscience", () => {
    const g = scenarioOpenFloor();
    const f = new DistributedFleet(g.map, clone(g.robots), clone(g.tasks), { commRange: 2 });
    f.run(5);
    for (const r of f.getRobots()) {
      const ag = f.getAgent(r.id)!;
      console.log(`D3 ${r.id} at ${key(r.position)} sees ${ag.getPeers().length} peers of ${f.getRobots().length - 1}`);
    }
  });

  it("D4: throughput vs fleet size, distributed", () => {
    for (const n of [3, 4, 5, 6, 8]) {
      let done = 0; let ms = 0; const N = 20;
      for (let s = 1; s <= N; s++) {
        const sc = makeScenario(1, n, s);
        const f = new DistributedFleet(sc.map, sc.robots, sc.tasks);
        const r = f.run(600);
        if (r.makespan !== null) { done++; ms += r.makespan; }
      }
      console.log(`D4 n=${n}: completed ${done}/${N}, mean makespan ${done ? (ms / done).toFixed(1) : "n/a"}`);
    }
  });
});
