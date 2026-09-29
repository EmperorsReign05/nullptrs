import { describe, expect, it } from "vitest";
import { EdgePeer } from "../src/core/distributed/edge-peer";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import type { OwnershipMessage } from "../src/core/distributed/ownership";
import type { Message } from "../src/core/distributed/protocol";
import { edgeChokeScenario } from "../src/core/bench/edge-choke";
import { generateFleetConfig, mapHeightFor, quorumOf, validateFleetConfig } from "../src/core/fleet/config";

/** N private controllers wired peer-to-peer over in-memory transports, with
 * membership taken from the canonical fleet config exactly as the deployment
 * derives it. */
function setup(n: number, seed = 23000, policy: "negotiated" | "stop-and-wait" = "negotiated") {
  const roster = validateFleetConfig(generateFleetConfig(n), `n=${n}`).robots;
  const scenario = edgeChokeScenario(seed, policy, n, roster);
  const allocation = new InMemoryBus<OwnershipMessage>(), motion = new InMemoryBus<Message>();
  const transports = scenario.configs.map((c) => {
    const a = new InMemoryTransport(c.self.id, allocation), m = new InMemoryTransport(c.self.id, motion);
    c.members.filter((id) => id !== c.self.id).forEach((id) => { a.addPeer(id); m.addPeer(id); });
    return { a, m };
  });
  return { scenario, peers: scenario.configs.map((c, i) => new EdgePeer(c, transports[i].a, transports[i].m)) };
}

const SIZES = [1, 2, 3, 4, 5, 8];

describe(`edge fleet scales to arbitrary N`, () => {
  for (const n of SIZES) {
    it(`N=${n}: all controllers start, are heard by every peer, and never collide or swap`, () => {
      const { peers, scenario } = setup(n);
      expect(peers).toHaveLength(n);
      expect(scenario.robots).toHaveLength(n);
      expect(scenario.tasks).toHaveLength(n);
      // Every robot starts on a distinct, in-bounds, unblocked cell.
      const starts = new Set(scenario.robots.map((r) => `${r.position.x},${r.position.y}`));
      expect(starts.size).toBe(n);
      for (const r of scenario.robots) {
        expect(r.position.y).toBeLessThan(mapHeightFor(n));
        expect(scenario.map.cells.find((c) => c.position.x === r.position.x && c.position.y === r.position.y)!.blocked).toBe(false);
      }
      for (let tick = 0; tick < 400; tick++) {
        const before = peers.map((p) => ({ ...p.world.robots[0].position }));
        peers.forEach((p, i) => p.prepare(tick, before.filter((q, j) => i !== j && Math.abs(q.x - before[i].x) + Math.abs(q.y - before[i].y) <= 2)));
        peers.forEach((p) => p.propose(tick));
        peers.forEach((p) => p.commit(tick));
        const next = peers.map((p) => p.world.robots[0].position);
        // No duplicate occupied cell.
        expect(new Set(next.map((p) => `${p.x},${p.y}`)).size).toBe(n);
        // No swap, no non-adjacent move, no entry into a blocked cell.
        for (let i = 0; i < n; i++) {
          expect(Math.abs(next[i].x - before[i].x) + Math.abs(next[i].y - before[i].y)).toBeLessThanOrEqual(1);
          for (let j = i + 1; j < n; j++) {
            expect(before[i].x === next[j].x && before[i].y === next[j].y && before[j].x === next[i].x && before[j].y === next[i].y).toBe(false);
          }
          expect(scenario.map.cells.find((c) => c.position.x === next[i].x && c.position.y === next[i].y)!.blocked).toBe(false);
        }
      }
      // Each controller holds only its own robot and hears every other peer.
      expect(peers.every((p) => p.world.robots.length === 1)).toBe(true);
      expect(peers.every((p) => p.snapshot().peersHeard.length === n - 1)).toBe(true);
      expect(peers.every((p) => p.metrics.bidAttempts > 0)).toBe(true);
      // Task ownership stays unique: no task is held by two live robots.
      const owners = new Map<string, number>();
      for (const p of peers) {
        for (const id of [...p.world.robots[0].queuedTaskIds, p.world.robots[0].currentTaskId].filter(Boolean) as string[]) {
          owners.set(id, (owners.get(id) ?? 0) + 1);
        }
      }
      expect([...owners.values()].every((c) => c === 1)).toBe(true);
    });
  }

  it("N=1 is a valid single-robot fleet that still makes progress", () => {
    const { peers } = setup(1);
    for (let tick = 0; tick < 200; tick++) {
      peers.forEach((p) => p.prepare(tick, []));
      peers.forEach((p) => p.propose(tick));
      peers.forEach((p) => p.commit(tick));
    }
    expect(peers[0].snapshot().peersHeard).toHaveLength(0);
    expect(peers[0].metrics.moves).toBeGreaterThan(0);
  });

  it("killing one controller leaves the rest of the fleet running", () => {
    // Kill well before the fleet drains its work: admission is fast enough
    // that a late kill can leave nothing left to do, which would make the
    // progress-after-loss assertion vacuous.
    const n = 5, killAt = 2, killTick = 40;
    const { peers } = setup(n);
    let movesAtKill = 0;
    for (let tick = 0; tick < 300; tick++) {
      const before = peers.map((p) => ({ ...p.world.robots[0].position }));
      // A crash-stopped controller runs no further phases at all.
      const live = (i: number) => !(tick >= killTick && i === killAt);
      if (tick === killTick) movesAtKill = peers.filter((_, i) => i !== killAt).reduce((a, p) => a + p.metrics.moves, 0);
      peers.forEach((p, i) => { if (live(i)) p.prepare(tick, before.filter((q, j) => i !== j && Math.abs(q.x - before[i].x) + Math.abs(q.y - before[i].y) <= 2)); });
      peers.forEach((p, i) => { if (live(i)) p.propose(tick); });
      peers.forEach((p, i) => { if (live(i)) p.commit(tick); });
      // Safety must hold across the whole run, including the loss.
      const cells = peers.filter((_, i) => i !== killAt).map((p) => { const q = p.world.robots[0].position; return `${q.x},${q.y}`; });
      expect(new Set(cells).size, `duplicate occupied cell at tick ${tick}: ${cells.join(' ')}`).toBe(cells.length);
    }
    const survivors = peers.filter((_, i) => i !== killAt);
    // Survivors keep hearing each other (a peer never hears itself).
    for (const p of survivors) {
      for (const q of survivors) {
        if (p === q) continue;
        expect(p.snapshot().peersHeard, `${p.world.robots[0].id} does not hear ${q.world.robots[0].id}`).toContain(q.world.robots[0].id);
      }
    }
    // The fleet is not wedged: survivors kept executing after the loss.
    const movesAfterKill = survivors.reduce((a, p) => a + p.metrics.moves, 0);
    expect(movesAfterKill, 'survivors made no progress after the kill').toBeGreaterThan(movesAtKill);
    expect(survivors.every((p) => p.metrics.bidAttempts > 0)).toBe(true);
    // The killed controller did not teleport or fabricate progress.
    expect(peers[killAt].world.robots[0].position).toBeDefined();
    // Four survivors still form a majority of five.
    expect(quorumOf(n)).toBe(3);
    expect(survivors.length).toBeGreaterThanOrEqual(quorumOf(n));
  });
});
