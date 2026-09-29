import { describe, it, expect } from "vitest";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "./ml-scenarios";

const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

/**
 * PERMANENT GUARD. Two robots must never occupy the same cell, and an agent
 * must never perceive itself as a peer.
 *
 * This test exists because the previous build passed every other test while
 * agents were blind to each other: InMemoryTransport.send() delivered into
 * the SENDER's own inbox, so 43% of ticks at n=8 had two robots on one cell.
 * The other tests asserted on task completion and final positions, both of
 * which stay green when robots collide freely. Collision and peer
 * visibility are the two invariants that actually detect the failure, so
 * they are asserted directly and on every tick.
 */
function auditFleet(n: number, seeds: number, opts: { severed?: [string, string][] } = {}) {
  let overlapTicks = 0, totalTicks = 0, selfPeers = 0, realPeerObs = 0, completed = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const sc = latticeScenario(1, n, seed, 7);
    const robots = JSON.parse(JSON.stringify(sc.robots));
    const tasks = JSON.parse(JSON.stringify(sc.tasks));
    const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6, severed: opts.severed });
    for (let t = 0; t < 400; t++) {
      f["replanAll"](t);
      const before = new Map(f.getRobots().map((r) => [r.id, key(r.position)]));
      f["step"](t);
      f["applyMoves"]();
      const cells = f.getRobots().map((r) => key(r.position));
      if (new Set(cells).size !== cells.length) overlapTicks++;
      for (const r of f.getRobots()) {
        for (const p of f.getAgent(r.id)!.getPeers()) {
          if (p.id === r.id) selfPeers++;
          else {
            realPeerObs++;
            void before;
          }
        }
      }
      totalTicks++;
      if (tasks.every((x) => x.status === "completed")) { completed++; break; }
    }
  }
  return { overlapTicks, totalTicks, selfPeers, realPeerObs, completed, seeds };
}

describe("DISTRIBUTED SAFETY: the invariants that actually catch blindness", () => {
  it("zero cell overlap and no self-peers at every fleet size", () => {
    for (const n of [4, 6, 8, 10]) {
      const r = auditFleet(n, 8);
      const pctv = ((r.overlapTicks / r.totalTicks) * 100).toFixed(2);
      console.log(`n=${n}: overlap ${r.overlapTicks}/${r.totalTicks} (${pctv}%)  selfPeers=${r.selfPeers}  realPeerObservations=${r.realPeerObs}  completed ${r.completed}/${r.seeds}`);
      expect(r.selfPeers).toBe(0);
      expect(r.overlapTicks).toBe(0);
      expect(r.realPeerObs).toBeGreaterThan(0);
    }
  }, 600000);

  it("a severed link must not cause collisions", () => {
    const r = auditFleet(8, 8, { severed: [["AMR-01", "AMR-02"]] });
    console.log(`severed: overlap ${r.overlapTicks}/${r.totalTicks}  completed ${r.completed}/${r.seeds}`);
    expect(r.overlapTicks).toBe(0);
  }, 600000);
});
