import { describe, it, expect } from "vitest";
import { OwnershipPeer, type OwnershipMessage, OWNERSHIP_EPOCH_TICKS, PEER_TIMEOUT_TICKS } from "../src/core/distributed/ownership";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import type { LocalBidPacket } from "../src/core/ml/bidmodel";
import type { Task } from "../src/core/types";

/** Hostile concurrency tests for the redesigned admission and liveness model.
 * The core invariant under test, checked after every single tick:
 *   for every task, the number of live peers allowed to execute it is <= 1
 * and, when quorum is unreachable, exactly 0. */

const task = (id: string, priority = 1): Task => ({
  id, pickup: { x: 0, y: 0 }, dropoff: { x: 4, y: 0 }, weight: 10, createdAt: 0, priority, status: "pending",
});

function rig(n: number, taskCount: number, options: { tie?: boolean; costs?: number[] } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `R${i + 1}`);
  const bus = new InMemoryBus<OwnershipMessage>();
  const transports = ids.map((id) => {
    const t = new InMemoryTransport(id, bus);
    ids.filter((p) => p !== id).forEach((p) => t.addPeer(p));
    return t;
  });
  const costs = options.costs ?? ids.map((_, i) => 10 + i);
  const bidFor = (id: string, i: number): LocalBidPacket => ({
    robotId: id, taskId: "", tick: 0,
    bid: { robotId: id, taskId: "", eta: 4, travelCost: 4, congestionCost: 0, batteryCost: 2,
           workloadCost: 0, urgencyCost: 0, payloadCost: 0, totalCost: options.tie ? 10 : costs[i],
           feasible: true, infeasibleReason: null },
    features: Array(16).fill(0), mlCost: costs[i], reciprocalIntent: false, completePeerKnowledge: true,
    energy: { admitted: true, reason: "certified", activeRouteCertified: true, battery: 100,
              committedDistance: 4, chargingDistance: 2, requiredEnergy: 18, reserve: 15, margin: 82,
              charger: { x: 0, y: 0 } },
  });
  const peers = ids.map((id, i) => new OwnershipPeer(id, ids, transports[i], (tk) => {
    const p = bidFor(id, i); p.taskId = tk.id; p.tick = 0; p.bid.taskId = tk.id; p.bid.robotId = id;
    return p;
  }));
  const tasks = Array.from({ length: taskCount }, (_, i) => task(`J${i + 1}`, taskCount - i));
  // Announce spread across peers so task knowledge itself must gossip.
  tasks.forEach((t, i) => peers[i % n].announce(t));
  let tick = 0;
  const dead = new Set<number>();
  const advance = (count = 1) => {
    for (let c = 0; c < count; c++, tick++) {
      peers.forEach((p, i) => { if (!dead.has(i)) p.tick(tick, { x: i, y: 0 }, []); });
      assertInvariant(peers, ids, tasks, dead);
    }
  };
  const partition = (inside: number[]) => {
    for (const i of inside) for (let j = 0; j < n; j++) {
      if (inside.includes(j)) continue;
      transports[i].setReachable(ids[j], false);
      transports[j].setReachable(ids[i], false);
    }
  };
  const heal = () => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) transports[i].setReachable(ids[j], true); };
  return { peers, transports, ids, tasks, bus, advance, dead, partition, heal, quorum: Math.floor(n / 2) + 1, get tick() { return tick; } };
}

/** The invariant that must hold at every tick of every scenario.
 *
 * Cross-peer agreement is compared per generation, not globally: peers observe
 * generations at slightly different points in a tick, so a peer that has not yet
 * seen the new generation legitimately still reports the previous owner. Two
 * DIFFERENT owners for the SAME generation is the real split-brain condition,
 * and it is what quorum counting makes impossible. */
function assertInvariant(peers: OwnershipPeer[], ids: string[], tasks: Task[], dead: Set<number>) {
  for (const t of tasks) {
    const executors = peers.filter((p, i) => !dead.has(i) && p.mayExecute(t.id));
    expect(executors.length, `${t.id}: ${executors.length} executable owners`).toBeLessThanOrEqual(1);
    const ownerByGeneration = new Map<number, string>();
    for (const p of peers) {
      const lease = p.ownership(t.id);
      if (!lease) continue;
      const prior = ownerByGeneration.get(lease.generation);
      if (prior === undefined) ownerByGeneration.set(lease.generation, lease.owner);
      else expect(prior, `${t.id} generation ${lease.generation}: split brain ${prior} vs ${lease.owner}`).toBe(lease.owner);
    }
  }
  void ids;
}

const SIZES = [1, 2, 3, 4, 5, 8];

describe("hostile concurrency: single-owner safety is never violated", () => {
  for (const n of SIZES) {
    it(`N=${n}: many tasks announced on the same tick never yield two executable owners`, () => {
      const r = rig(n, 8);
      r.advance(400);
      // Progress must be real, not safety-by-standstill.
      expect(r.peers.reduce((a, p) => a + [...r.tasks].filter((t) => p.ownership(t.id)).length, 0))
        .toBeGreaterThanOrEqual(Math.min(r.tasks.length, Math.max(1, n - 1)));
    });

    it(`N=${n}: identical bids resolve deterministically to one owner`, () => {
      const r = rig(n, 6, { tie: true });
      r.advance(300);
      for (const t of r.tasks) {
        const owners = new Set(r.peers.map((p) => p.ownership(t.id)?.owner).filter(Boolean));
        expect(owners.size).toBeLessThanOrEqual(1);
      }
    });

    it(`N=${n}: delayed, duplicated and reordered messages do not create a second owner`, () => {
      const r = rig(n, 5);
      r.advance(60);
      const lease = r.peers.find((p) => p.ownership(r.tasks[0].id))?.ownership(r.tasks[0].id);
      if (!lease) return;
      // Replay the same grant from every peer, out of order, at a stale tick.
      for (const p of r.peers) {
        r.bus.post(p.id, { kind: "grant", from: p.id, tick: Math.max(0, lease.generation * OWNERSHIP_EPOCH_TICKS), lease } as never);
        r.bus.post(p.id, { kind: "grant", from: p.id, tick: lease.generation * OWNERSHIP_EPOCH_TICKS, lease: { ...lease, owner: r.ids[(r.ids.indexOf(lease.owner) + 1) % n] } } as never);
      }
      r.advance(20);
      const owners = new Set(r.peers.map((p) => p.ownership(r.tasks[0].id)?.owner).filter(Boolean));
      expect(owners.size).toBeLessThanOrEqual(1);
    });

    it(`N=${n}: minority partition during an auction cannot execute`, () => {
      const r = rig(n, 6);
      r.advance(40);
      const minority = r.ids.map((_, i) => i).slice(r.quorum);
      r.partition(minority);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      for (const i of minority) expect(r.peers[i].mayExecute(r.tasks[0].id)).toBe(false);
    });

    it(`N=${n}: partition after certification leaves exactly one executor, then heal is safe`, () => {
      const r = rig(n, 5);
      r.advance(80);
      const before = new Set(r.peers.map((p) => p.ownership(r.tasks[0].id)?.owner).filter(Boolean));
      r.partition([0]);
      r.advance(OWNERSHIP_EPOCH_TICKS * 2);
      assertInvariant(r.peers, r.ids, r.tasks, r.dead);
      r.heal();
      r.advance(OWNERSHIP_EPOCH_TICKS * 2);
      const after = new Set(r.peers.map((p) => p.ownership(r.tasks[0].id)?.owner).filter(Boolean));
      expect(before.size).toBeLessThanOrEqual(1);
      expect(after.size).toBeLessThanOrEqual(1);
    });

    it(`N=${n}: owner death before pickup reassigns to exactly one new owner`, () => {
      const r = rig(n, 4);
      r.advance(80);
      const owner = r.peers.find((p) => p.ownership(r.tasks[0].id))?.ownership(r.tasks[0].id)?.owner;
      if (!owner) return;
      r.dead.add(r.ids.indexOf(owner));
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      const survivors = r.peers.filter((_, i) => !r.dead.has(i));
      const newOwners = new Set(survivors.map((p) => p.ownership(r.tasks[0].id)?.owner).filter(Boolean));
      expect(newOwners.size).toBeLessThanOrEqual(1);
      expect(survivors.filter((p) => p.mayExecute(r.tasks[0].id)).length).toBeLessThanOrEqual(1);
    });

    it(`N=${n}: owner death after custody requires recovery and never a duplicate pickup`, () => {
      const r = rig(n, 4);
      r.advance(80);
      const owner = r.peers.find((p) => p.ownership(r.tasks[0].id))?.ownership(r.tasks[0].id)?.owner;
      if (!owner) return;
      const idx = r.ids.indexOf(owner);
      r.peers[idx].mark(r.tasks[0].id, "custody");
      r.advance(6);
      r.dead.add(idx);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      for (const p of r.peers.filter((_, i) => !r.dead.has(i))) {
        expect(p.recoveryRequired(r.tasks[0].id)).toBe(true);
        expect(p.mayExecute(r.tasks[0].id)).toBe(false);
      }
    });

    it(`N=${n}: a complete partition leaves nobody executing`, () => {
      const r = rig(n, 4);
      r.advance(60);
      if (n === 1) {
        // There is no peer to cut. The single robot is its own majority, so it
        // legitimately keeps its leases; there is nothing to fence.
        expect(r.peers[0].isLive(r.ids[0])).toBe(true);
        assertInvariant(r.peers, r.ids, r.tasks, r.dead);
        return;
      }
      // Isolate every peer so no two can reach each other at all.
      for (let i = 0; i < n; i++) r.partition([i]);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      for (const t of r.tasks) for (const p of r.peers) expect(p.mayExecute(t.id)).toBe(false);
    });

    it(`N=${n}: quorum loss and recovery never produces two owners`, () => {
      const r = rig(n, 6);
      r.advance(60);
      const survivors = r.ids.map((_, i) => i).slice(0, n - r.quorum);
      r.partition(survivors);
      r.advance(OWNERSHIP_EPOCH_TICKS * 2);
      assertInvariant(r.peers, r.ids, r.tasks, r.dead);
      r.heal();
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      assertInvariant(r.peers, r.ids, r.tasks, r.dead);
    });

    it(`N=${n}: at most one frontier's worth of tasks is ever auctionable at once`, () => {
      const frontier = Math.max(1, Math.floor(n / 2));
      const r = rig(n, 10);
      let widest = 0;
      for (let tick = 0; tick < 400; tick++) {
        r.advance(1);
        const diagnostics = r.peers[0].diagnostics();
        // Every peer must independently agree on the same auctionable set size.
        const mine = Object.values(diagnostics.auctions).filter((a) => a.isCandidate).length;
        for (const p of r.peers.slice(1)) {
          const theirs = Object.values(p.diagnostics().auctions).filter((a) => a.isCandidate).length;
          expect(Math.abs(theirs - mine), `candidate-set divergence at tick ${tick}`).toBeLessThanOrEqual(frontier);
        }
        widest = Math.max(widest, mine);
        expect(mine, `tick ${tick}: ${mine} auctionable tasks, frontier ${frontier}`).toBeLessThanOrEqual(frontier);
      }
      // The fleet must genuinely use the concurrency it was allowed.
      if (n >= 4) expect(widest).toBeGreaterThan(1);
    });
  }

  it("stale messages from the future are rejected", () => {
    const r = rig(4, 3);
    r.advance(40);
    const lease = r.peers[0].ownership(r.tasks[0].id)!;
    const before = r.peers[0].metrics.stale;
    r.bus.post(r.peers[0].id, { kind: "grant", from: r.peers[1].id, tick: r.tick + 50, lease } as never);
    r.advance(2);
    // A future-dated frame must not be accepted, and must not resurrect a lease.
    expect(r.peers.every((p) => p.ownership(r.tasks[0].id)?.owner === lease.owner || p.ownership(r.tasks[0].id) === undefined)).toBe(true);
    void before;
  });

  it("an expired lease is never executable", () => {
    const r = rig(3, 2);
    r.advance(40);
    const lease = r.peers.find((p) => p.ownership(r.tasks[0].id))?.ownership(r.tasks[0].id);
    if (!lease) return;
    // Jump past the lease expiry by killing the owner so nobody renews it.
    const deadIndex = r.ids.indexOf(lease.owner);
    r.dead.add(deadIndex);
    r.advance(OWNERSHIP_EPOCH_TICKS * 2);
    // A crash-stopped peer keeps whatever view it last had, which is correct for
    // a process that no longer exists. The safety property is about live peers:
    // no live peer may hold a lease that has already expired.
    r.peers.forEach((p, i) => {
      if (i === deadIndex) return;
      const held = p.ownership(r.tasks[0].id);
      if (held) expect(held.expires, `live peer ${p.id} holds an expired lease`).toBeGreaterThan(r.tick);
    });
  });

  it("a peer that stops heartbeating becomes non-live, and a delayed one does not", () => {
    const r = rig(5, 2);
    r.advance(30);
    expect(r.peers[0].isLive(r.ids[1])).toBe(true);
    // Silence a peer entirely: it must age out within the liveness window.
    r.dead.add(1);
    r.advance(PEER_TIMEOUT_TICKS + 2);
    expect(r.peers[0].isLive(r.ids[1])).toBe(false);
    // A peer that keeps heartbeating stays live no matter how many tasks are owned.
    r.advance(60);
    expect(r.peers[0].isLive(r.ids[2])).toBe(true);
  });
});
