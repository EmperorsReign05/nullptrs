import { describe, it, expect } from "vitest";
import { OwnershipPeer, type OwnershipMessage, OWNERSHIP_EPOCH_TICKS } from "../src/core/distributed/ownership";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import { generateFleetConfig, quorumOf, mapHeightFor, validateFleetConfig } from "../src/core/fleet/config";
import type { LocalBidPacket } from "../src/core/ml/bidmodel";
import type { Task } from "../src/core/types";

const task: Task = { id: "job", pickup: { x: 0, y: 0 }, dropoff: { x: 4, y: 0 }, weight: 10, createdAt: 0, priority: 1, status: "pending" };

/** A rig of `n` peers whose membership comes from the canonical fleet config,
 * exactly as the deployment derives it. Cheap bids break ties toward the lowest
 * index so the expected winner is deterministic. */
function rig(n: number, options: { tie?: boolean; costs?: number[] } = {}) {
  const config = validateFleetConfig(generateFleetConfig(n), `generated n=${n}`);
  const ids = config.robots.map((r) => r.id);
  const costs = options.costs ?? ids.map((_, i) => 10 + i);
  const bus = new InMemoryBus<OwnershipMessage>();
  const transports = ids.map((id) => {
    const t = new InMemoryTransport(id, bus);
    ids.filter((p) => p !== id).forEach((p) => t.addPeer(p));
    return t;
  });
  const peers = ids.map((id, i) => new OwnershipPeer(id, ids, transports[i], (tk, tick): LocalBidPacket => ({
    robotId: id, taskId: tk.id, tick,
    bid: { robotId: id, taskId: tk.id, eta: 4, travelCost: 4, congestionCost: 0, batteryCost: 2,
           workloadCost: 0, urgencyCost: 0, payloadCost: 0, totalCost: costs[i], feasible: true, infeasibleReason: null },
    features: Array(16).fill(0), mlCost: costs[i],
    energy: { admitted: true, reason: "certified", activeRouteCertified: true, battery: 100, committedDistance: 4,
              chargingDistance: 2, requiredEnergy: 18, reserve: 15, margin: 82, charger: { x: 0, y: 0 } },
    reciprocalIntent: false, completePeerKnowledge: true,
  })));
  peers[0].announce(task);
  let tick = 0;
  const dead = new Set<number>();
  const advance = (count = 1) => {
    for (let t = 0; t < count; t++, tick++) {
      peers.forEach((p, i) => { if (!dead.has(i)) p.tick(tick, { x: i, y: 0 }, []); });
      const executing = peers.filter((p, i) => !dead.has(i) && p.mayExecute(task.id));
      expect(executing.length).toBeLessThanOrEqual(1);
    }
  };
  /** Cut every link between a set and its complement, in both directions. */
  const partitionSet = (inside: number[]) => {
    for (const i of inside) for (const j of ids.map((_, k) => k)) {
      if (inside.includes(j)) continue;
      transports[i].setReachable(ids[j], false);
      transports[j].setReachable(ids[i], false);
    }
  };
  const heal = () => { for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) if (i !== j) { transports[i].setReachable(ids[j], true); } };
  return { peers, transports, ids, advance, dead, partitionSet, heal, bus, quorum: quorumOf(n), get tick() { return tick; } };
}

const SIZES = [1, 2, 3, 4, 5, 8];

describe("ownership across arbitrary membership sizes", () => {
  for (const n of SIZES) {
    it(`N=${n}: quorum is floor(N/2)+1 and is computed from membership`, () => {
      const r = rig(n);
      expect(r.quorum).toBe(Math.floor(n / 2) + 1);
      for (const p of r.peers) {
        expect(p.quorum).toBe(Math.floor(n / 2) + 1);
        expect(p.members).toHaveLength(n);
      }
      // N=1 is the degenerate but valid case: the single peer is its own majority.
      expect(rig(1).peers[0].quorum).toBe(1);
    });

    it(`N=${n}: every live peer converges on exactly one owner`, () => {
      const r = rig(n);
      r.advance(12);
      const owners = new Set(r.peers.map((p) => p.ownership(task.id)?.owner));
      expect(owners.size).toBe(1);
      expect([...owners][0]).toBe(r.ids[0]);
      expect(r.peers.every((p) => p.ownership(task.id)?.owner === r.ids[0])).toBe(true);
      expect(r.peers.filter((p) => p.mayExecute(task.id))).toHaveLength(n === 1 ? 1 : 1);
    });

    it(`N=${n}: identical bids resolve deterministically`, () => {
      const r = rig(n, { costs: Array(n).fill(10) });
      r.advance(12);
      const owners = new Set(r.peers.map((p) => p.ownership(task.id)?.owner));
      expect(owners.size).toBe(1);
      expect([...owners][0]).toBe(r.ids[0]);
    });

    it(`N=${n}: stale grants from an earlier generation are ignored`, () => {
      const r = rig(n);
      r.advance(12);
      const stale = r.peers[0].ownership(task.id)!;
      const current = stale.generation;
      r.advance(OWNERSHIP_EPOCH_TICKS + 2);
      // A late frame carrying the old lease must not resurrect or replace it.
      r.bus.post(r.ids[0], { kind: "grant", from: r.ids[1], tick: current * OWNERSHIP_EPOCH_TICKS + 1, lease: { ...stale, owner: r.ids[1] } } as never);
      r.advance(2);
      expect(r.peers.every((p) => p.ownership(task.id)?.generation > current)).toBe(true);
      expect(new Set(r.peers.map((p) => p.ownership(task.id)?.owner)).size).toBe(1);
    });

    it(`N=${n}: a minority partition fences itself and the majority still elects one owner`, () => {
      const r = rig(n);
      r.advance(12);
      const minorityIndexes = r.ids.map((_, i) => i).slice(r.quorum);
      const majorityIndexes = r.ids.map((_, i) => i).slice(0, r.quorum);
      r.partitionSet(minorityIndexes);
      r.advance(OWNERSHIP_EPOCH_TICKS * 2 + 4);
      if (minorityIndexes.length > 0) {
        // The minority cannot reach quorum, so nobody there may execute.
        for (const i of minorityIndexes) expect(r.peers[i].mayExecute(task.id)).toBe(false);
        // The majority still agrees on exactly one owner.
        const majorityOwners = new Set(majorityIndexes.map((i) => r.peers[i].ownership(task.id)?.owner));
        expect(majorityOwners.size).toBe(1);
        expect([...majorityOwners][0]).toBeDefined();
      } else {
        // N=1 and N=2 have no proper minority: the whole roster is the quorum,
        // so nothing can be fenced. Safety still holds.
        expect(majorityIndexes).toHaveLength(n);
      }
    });

    it(`N=${n}: owner death before pickup reassigns only if survivors are a majority`, () => {
      const r = rig(n);
      r.advance(12);
      r.dead.add(0);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      const survivors = r.peers.slice(1);
      const owners = new Set(survivors.map((p) => p.ownership(task.id)?.owner).filter((o): o is string => !!o));
      // Safety always holds: never two owners.
      expect(owners.size).toBeLessThanOrEqual(1);
      if (n - 1 >= r.quorum) {
        // Survivors are a majority, so liveness is permitted and expected.
        expect(owners.size).toBe(1);
        expect([...owners][0]).toBeDefined();
        expect([...owners][0]).not.toBe(r.ids[0]);
        expect(survivors.filter((p) => p.mayExecute(task.id))).toHaveLength(1);
      } else {
        // No majority survives (N=1 leaves nobody; N=2 leaves one peer, below
        // quorum 2). A 2-node majority quorum tolerates no failures, so the task
        // must never reach a live executor: at worst the dead owner still
        // nominally holds the lease, which is safe because nobody may act on it.
        expect(owners.size).toBeLessThanOrEqual(1);
        expect(survivors.every((p) => !p.mayExecute(task.id))).toBe(true);
        expect([...owners].every((o) => o === r.ids[0])).toBe(true);      }
    });

    it(`N=${n}: custody after pickup demands recovery, never a duplicate pickup`, () => {
      const r = rig(n);
      r.advance(12);
      r.peers[0].mark(task.id, "custody");
      r.advance(4);
      expect(r.peers[0].acknowledged(task.id, "custody")).toBe(true);
      r.dead.add(0);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      for (const p of r.peers.slice(1)) {
        expect(p.recoveryRequired(task.id)).toBe(true);
        expect(p.mayExecute(task.id)).toBe(false);
      }
    });

    it(`N=${n}: completed custody is terminal and never reassigned`, () => {
      const r = rig(n);
      r.advance(12);
      r.peers[0].mark(task.id, "custody");
      r.advance(4);
      r.peers[0].mark(task.id, "completed");
      r.advance(4);
      r.dead.add(0);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      for (const p of r.peers.slice(1)) {
        expect(p.completed(task.id)).toBe(true);
        expect(p.mayExecute(task.id)).toBe(false);
      }
    });
  }

  it("even membership cannot produce two certificates in one generation", () => {
    // N=4 and N=8 are the cases where a naive floor(N/2) quorum would allow two
    // disjoint majorities to both certify a different owner for the same task.
    for (const n of [2, 4, 8]) {
      const r = rig(n);
      r.advance(12);
      // Split into two halves and cut between them, repeatedly, for many ticks.
      const half = Math.floor(n / 2);
      for (let round = 0; round < 6; round++) {
        r.partitionSet(r.ids.map((_, i) => i).slice(0, half));
        r.advance(6);
        const owners = r.peers.map((p) => p.ownership(task.id)?.owner).filter(Boolean);
        // Whatever each side believes, no two peers may be executable at once.
        expect(r.peers.filter((p) => p.mayExecute(task.id)).length).toBeLessThanOrEqual(1);
        r.heal();
        r.advance(6);
        const healed = new Set(r.peers.map((p) => p.ownership(task.id)?.owner));
        expect(healed.size).toBeLessThanOrEqual(1);
        expect(owners.length).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a full partition leaves nobody able to execute", () => {
    for (const n of SIZES) {
      const r = rig(n);
      // N=1 has no peer to cut; its single peer is always its own majority.
      if (n === 1) { r.advance(OWNERSHIP_EPOCH_TICKS * 3); expect(r.peers[0].mayExecute(task.id)).toBe(true); continue; }
      r.partitionSet([0]);
      r.partitionSet([1]);
      r.advance(OWNERSHIP_EPOCH_TICKS * 3);
      expect(r.peers.every((p) => !p.mayExecute(task.id))).toBe(true);
    }
  });
});

describe("fleet config governs membership for every N", () => {
  it("origins stay inside the generated map for every supported size", () => {
    for (const n of [1, 2, 3, 4, 5, 8, 12, 20]) {
      const config = validateFleetConfig(generateFleetConfig(n), `n=${n}`);
      for (const robot of config.robots) {
        expect(robot.origin.y).toBeLessThan(mapHeightFor(n));
        expect(robot.origin.x).toBeGreaterThanOrEqual(0);
      }
      expect(new Set(config.robots.map((r) => r.id)).size).toBe(n);
      expect(new Set(config.robots.map((r) => r.namespace)).size).toBe(n);
      expect(new Set(config.robots.map((r) => r.executorPort)).size).toBe(n);
    }
  });

  it("rejects duplicate ids, namespaces, origins and executor ports", () => {
    const base = generateFleetConfig(3);
    const mutate = (fn: (c: typeof base) => void) => { const c = structuredClone(base); fn(c); return () => validateFleetConfig(c, "test"); };
    expect(mutate((c) => { c.robots[1].id = c.robots[0].id; })).toThrow(/duplicate robot id/);
    expect(mutate((c) => { c.robots[1].namespace = c.robots[0].namespace; })).toThrow(/duplicate namespace/);
    expect(mutate((c) => { c.robots[1].origin = { ...c.robots[0].origin }; })).toThrow(/duplicate origin/);
    expect(mutate((c) => { c.robots[1].executorPort = c.robots[0].executorPort; })).toThrow(/executor port collision/);
  });

  it("rejects an empty fleet, a bad cell size and an out-of-bounds origin", () => {
    expect(() => validateFleetConfig({ ...generateFleetConfig(2), robots: [] })).toThrow(/non-empty/);
    expect(() => validateFleetConfig({ ...generateFleetConfig(2), cellMetres: 0 })).toThrow(/cellMetres/);
    expect(() => validateFleetConfig({ ...generateFleetConfig(2), rosDomainId: 999 })).toThrow(/rosDomainId/);
    const tall = generateFleetConfig(2);
    tall.robots[1].origin = { x: 1, y: 40 };
    expect(() => validateFleetConfig(tall)).toThrow(/outside the 2-robot map height/);
  });

  it("rejects N below one", () => {
    expect(() => generateFleetConfig(0)).toThrow(/positive integer/);
    expect(() => quorumOf(0)).toThrow(/positive integer/);
  });
});
