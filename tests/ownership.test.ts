import { describe, it, expect } from "vitest";
import { OwnershipPeer, type OwnershipMessage, OWNERSHIP_EPOCH_TICKS } from "../src/core/distributed/ownership";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import type { LocalBidPacket } from "../src/core/ml/bidmodel";
import type { Task } from "../src/core/types";
const task: Task = { id: "job", pickup: { x: 0, y: 0 }, dropoff: { x: 4, y: 0 }, weight: 10, createdAt: 0, priority: 1, status: "pending" };
function rig(costs = [10, 11, 12]) {
  const ids = ["a", "b", "c"], bus = new InMemoryBus<OwnershipMessage>();
  const transports = ids.map(id => { const t = new InMemoryTransport(id, bus); ids.filter(p => p !== id).forEach(p => t.addPeer(p)); return t; });
  const peers = ids.map((id, i) => new OwnershipPeer(id, ids, transports[i], (task, tick): LocalBidPacket => ({
    robotId: id, taskId: task.id, tick, bid: { robotId: id, taskId: task.id, eta: 4, travelCost: 4, congestionCost: 0, batteryCost: 2, workloadCost: 0, urgencyCost: 0, payloadCost: 0, totalCost: costs[i], feasible: true, infeasibleReason: null },
    features: Array(16).fill(0), mlCost: costs[i], energy: { admitted: true, reason: "certified", activeRouteCertified: true, battery: 100, committedDistance: 4, chargingDistance: 2, requiredEnergy: 18, reserve: 15, margin: 82, charger: { x: 0, y: 0 } }, reciprocalIntent: false, completePeerKnowledge: true,
  })));
  peers[0].announce(task); let tick = 0; const dead = new Set<number>();
  const advance = (count = 1) => { for (let t = 0; t < count; t++, tick++) {
    peers.forEach((p, i) => { if (!dead.has(i)) p.tick(tick, { x: i, y: 0 }, []); });
    const executing = peers.filter((p, i) => !dead.has(i) && p.mayExecute(task.id));
    expect(executing.length).toBeLessThanOrEqual(1);
  } };
  const partition = (i: number) => ids.forEach((_, j) => { if (i !== j) { transports[i].setReachable(ids[j], false); transports[j].setReachable(ids[i], false); } });
  return { peers, transports, advance, dead, partition, bus, get tick() { return tick; } };
}
describe("quorum task ownership", () => {
  it("three peers agree on independent bids and deterministic ties", () => {
    for (const costs of [[10,11,12], [10,10,10]]) { const r = rig(costs); r.advance(12); expect(r.peers.map(p => p.ownership("job")?.owner)).toEqual(["a","a","a"]); }
  });
  it("owner death before pickup expires ownership and reassigns unfinished work", () => {
    const r = rig(); r.advance(12); r.dead.add(0); r.advance(50);
    expect(r.peers[1].ownership("job")?.owner).toBe("b"); expect(r.peers[2].ownership("job")?.owner).toBe("b");
    expect(r.peers[1].ownership("job")!.generation).toBeGreaterThan(0);
  });
  it("owner death after acknowledged pickup requires physical recovery, never duplicate pickup", () => {
    const r = rig(); r.advance(12); r.peers[0].mark("job", "custody"); r.advance(4);
    expect(r.peers[0].acknowledged("job", "custody")).toBe(true);
    r.dead.add(0); r.advance(55);
    expect(r.peers.slice(1).every(p => p.recoveryRequired("job"))).toBe(true);
    expect(r.peers.slice(1).every(p => !p.mayExecute("job"))).toBe(true);
  });
  it("stale grants cannot overwrite newer generations", () => {
    const r = rig(); r.advance(12); const old = r.peers[0].ownership("job")!;
    r.dead.add(0); r.advance(35); const current = r.peers[1].ownership("job")!;
    r.bus.post("b", { kind: "grant", from: "a", tick: 1, lease: old }); r.advance();
    expect(r.peers[1].ownership("job")).toEqual(current); expect(r.peers[1].metrics.stale).toBeGreaterThan(0);
  });
  it("duplicate/conflicting claims cannot yield a second valid owner", () => {
    const r = rig(); r.advance(12); const lease = r.peers[0].ownership("job")!;
    r.bus.post("b", { kind: "grant", from: "c", tick: 11, lease: { ...lease, owner: "b" } });
    r.bus.post("b", { kind: "grant", from: "c", tick: 11, lease: { ...lease, owner: "b" } }); r.advance(6);
    expect(r.peers[1].ownership("job")?.owner).toBe("a");
  });
  it("isolated live owner self-fences at expiry while majority may recover", () => {
    const r = rig(); r.advance(12); r.partition(0); r.advance(45);
    expect(r.peers[0].mayExecute("job")).toBe(false);
    expect(r.peers[1].ownership("job")?.owner).toBe("b");
  });
  it("total partition and lost/delayed grants cannot create ownership", () => {
    const r = rig(); r.partition(0); r.partition(1); r.advance(OWNERSHIP_EPOCH_TICKS * 3);
    expect(r.peers.every(p => !p.mayExecute("job"))).toBe(true);
    const delayed = rig(); delayed.transports.forEach(t => t.setLatency(2));
    for (let i = 0; i < 70; i++) { delayed.advance(); delayed.transports.forEach(t => t.advanceClock()); }
  });
  it("completed custody is terminal and is never reassigned", () => {
    const r = rig(); r.advance(12); r.peers[0].mark("job", "custody"); r.advance(4);
    r.peers[0].mark("job", "completed"); r.advance(4); r.dead.add(0); r.advance(50);
    expect(r.peers.slice(1).every(p => p.completed("job") && !p.mayExecute("job"))).toBe(true);
  });
});

it("does not spend one bidder's queue headroom on simultaneous new assignments", () => {
  const r = rig();
  for (let i = 0; i < 8; i++) r.peers[0].announce({ ...task, id: `job-${i}` });
  r.advance(12);
  const owned = [...r.peers[0].tasks.keys()].filter(id => r.peers[0].ownership(id));
  expect(owned).toEqual(["job"]);
});

it("gossips completed custody to a healed peer even after the owner dies", () => {
  const r = rig(); r.advance(12); r.partition(2);
  r.peers[0].mark("job", "custody"); r.advance(4);
  r.peers[0].mark("job", "completed"); r.advance(4);
  expect(r.peers[0].completed("job")).toBe(true);
  expect(r.peers[2].completed("job")).toBe(false);
  r.dead.add(0);
  r.transports[1].setReachable("c",true); r.transports[2].setReachable("b",true);
  r.advance(40);
  expect(r.peers[2].completed("job")).toBe(true);
  expect(r.peers[2].mayExecute("job")).toBe(false);
});

it("retries a completion whose acknowledgements crossed the lease boundary", () => {
  const r = rig(); r.advance(12); r.peers[0].mark("job", "custody"); r.advance(19);
  expect(r.tick).toBe(31); r.peers[0].mark("job", "completed"); r.advance(15);
  expect(r.peers.every(p => p.completed("job"))).toBe(true);
});
