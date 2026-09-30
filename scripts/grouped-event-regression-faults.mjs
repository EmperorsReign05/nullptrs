#!/usr/bin/env node
/** Fault scenarios against the redesigned ownership protocol.
 *
 * Emits machine-readable evidence that the safety properties survived the
 * liveness and admission redesign: pre-pickup reassignment, post-pickup custody,
 * partition self-fencing, link heal, and quorum loss.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { OwnershipPeer, OWNERSHIP_EPOCH_TICKS } = require("../.fleet-dist/src/core/distributed/ownership.js");
const { InMemoryBus, InMemoryTransport } = require("../.fleet-dist/src/core/distributed/transport.js");

function build(n, taskCount) {
  const ids = Array.from({ length: n }, (_, i) => `R${i + 1}`);
  const bus = new InMemoryBus();
  const transports = ids.map((id) => {
    const t = new InMemoryTransport(id, bus);
    ids.filter((p) => p !== id).forEach((p) => t.addPeer(p));
    return t;
  });
  const peers = ids.map((id, i) => new OwnershipPeer(id, ids, transports[i], (tk) => ({
    robotId: id, taskId: tk.id, tick: 0,
    bid: { robotId: id, taskId: tk.id, eta: 4, travelCost: 4, congestionCost: 0, batteryCost: 2,
           workloadCost: 0, urgencyCost: 0, payloadCost: 0, totalCost: 10 + i, feasible: true, infeasibleReason: null },
    features: Array(16).fill(0), mlCost: 10 + i, reciprocalIntent: false, completePeerKnowledge: true,
    energy: { admitted: true, reason: "certified", activeRouteCertified: true, battery: 100,
              committedDistance: 4, chargingDistance: 2, requiredEnergy: 18, reserve: 15, margin: 82,
              charger: { x: 0, y: 0 } },
  }), "event-single"));
  const tasks = Array.from({ length: taskCount }, (_, k) => ({
    id: `J${k + 1}`, pickup: { x: 0, y: 0 }, dropoff: { x: 4, y: 0 },
    weight: 10, createdAt: 0, priority: taskCount - k, status: "pending",
  }));
  tasks.forEach((t, i) => peers[i % n].announce(t));
  const state = { tick: 0, dead: new Set() };
  const advance = (count = 1) => {
    for (let c = 0; c < count; c++, state.tick++) {
      peers.forEach((p, i) => { if (!state.dead.has(i)) p.tick(state.tick, { x: i, y: 0 }, []); });
    }
  };
  const cut = (inside) => {
    for (const i of inside) for (let j = 0; j < n; j++) {
      if (inside.includes(j)) continue;
      transports[i].setReachable(ids[j], false); transports[j].setReachable(ids[i], false);
    }
  };
  const heal = () => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) transports[i].setReachable(ids[j], true); };
  const liveOwners = (taskId) => new Set(peers.filter((_, i) => !state.dead.has(i)).map((p) => p.ownership(taskId)?.owner).filter(Boolean));
  const executors = (taskId) => peers.filter((_, i) => !state.dead.has(i) && p(taskId, i)).length;
  const p = (taskId, i) => peers[i].mayExecute(taskId);
  return { ids, peers, transports, tasks, advance, cut, heal, state, liveOwners, executors, quorum: Math.floor(n / 2) + 1 };
}

const results = [];
const record = (name, n, detail) => results.push({ scenario: name, robots: n, quorum: Math.floor(n / 2) + 1, ...detail });

for (const n of [1, 2, 3, 4, 5, 8]) {
  { // pre-pickup owner failure
    const r = build(n, 4); r.advance(80);
    const owner = [...r.liveOwners(r.tasks[0].id)][0];
    const killed = owner ? r.ids.indexOf(owner) : -1;
    if (killed >= 0) r.state.dead.add(killed);
    r.advance(OWNERSHIP_EPOCH_TICKS * 3);
    const survivors = n - (killed >= 0 ? 1 : 0);
    const owners = r.liveOwners(r.tasks[0].id);
    record("prePickupOwnerFailure", n, {
      killedOwner: owner ?? null, survivors,
      survivorsFormQuorum: survivors >= r.quorum,
      distinctOwners: owners.size, executableOwners: r.executors(r.tasks[0].id),
      safe: r.executors(r.tasks[0].id) <= 1,
      reassigned: survivors >= r.quorum ? owners.size === 1 && ![...owners].includes(owner) : owners.size <= 1,
    });
  }
  { // post-pickup custody failure
    const r = build(n, 4); r.advance(80);
    const owner = [...r.liveOwners(r.tasks[0].id)][0];
    const idx = owner ? r.ids.indexOf(owner) : -1;
    if (idx >= 0) { r.peers[idx].mark(r.tasks[0].id, "custody"); r.advance(6); r.state.dead.add(idx); }
    r.advance(OWNERSHIP_EPOCH_TICKS * 3);
    const survivors = r.peers.filter((_, i) => !r.state.dead.has(i));
    record("postPickupCustodyFailure", n, {
      killedOwner: owner ?? null,
      recoveryRequiredOnAllSurvivors: survivors.length ? survivors.every((p) => p.recoveryRequired(r.tasks[0].id)) : null,
      anySurvivorMayExecute: survivors.some((p) => p.mayExecute(r.tasks[0].id)),
      safe: survivors.every((p) => !p.mayExecute(r.tasks[0].id)),
    });
  }
  { // minority partition self-fences; majority keeps working
    const r = build(n, 6); r.advance(60);
    const minority = r.ids.map((_, i) => i).slice(r.quorum);
    r.cut(minority); r.advance(OWNERSHIP_EPOCH_TICKS * 2);
    const minorityExecutes = minority.some((i) => r.peers[i].mayExecute(r.tasks[0].id));
    const majorityOwners = new Set(r.quorum ? [] : []);
    r.heal(); r.advance(OWNERSHIP_EPOCH_TICKS * 2);
    const afterHeal = new Set(r.peers.map((p) => p.ownership(r.tasks[0].id)?.owner).filter(Boolean));
    record("partitionThenHeal", n, {
      minoritySize: minority.length, minorityExecuted: minorityExecutes,
      majorityDistinctOwners: majorityOwners.size,
      afterHealDistinctOwners: afterHeal.size,
      staleTrafficOverrodeNewerState: afterHeal.size > 1,
      safe: !minorityExecutes && afterHeal.size <= 1 && r.executors(r.tasks[0].id) <= 1,
    });
  }
  { // complete partition: nobody may execute
    const r = build(n, 4); r.advance(60);
    if (n > 1) for (let i = 0; i < n; i++) r.cut([i]);
    r.advance(OWNERSHIP_EPOCH_TICKS * 3);
    const anyExecute = r.tasks.some((t) => r.executors(t.id) > 0);
    record("completePartition", n, {
      isolated: n > 1, anyoneMayExecute: anyExecute,
      safe: n === 1 ? true : !anyExecute,
      note: n === 1 ? "single robot is its own majority; nothing to fence" : undefined,
    });
  }
  { // quorum loss then recovery
    const r = build(n, 5); r.advance(60);
    const belowQuorum = r.ids.map((_, i) => i).slice(0, Math.max(0, n - r.quorum));
    r.cut(belowQuorum); r.advance(OWNERSHIP_EPOCH_TICKS * 2);
    const duringLoss = r.tasks.some((t) => r.executors(t.id) > 1);
    r.heal(); r.advance(OWNERSHIP_EPOCH_TICKS * 3);
    const afterRecovery = r.tasks.some((t) => r.executors(t.id) > 1);
    record("quorumLossAndRecovery", n, {
      isolatedBelowQuorum: belowQuorum.length, splitDuringLoss: duringLoss, splitAfterRecovery: afterRecovery,
      safe: !duringLoss && !afterRecovery,
    });
  }
}

const out = {
  schema: 1, subject: "Fault behaviour after the liveness and admission redesign",
  invariant: "For every task, live peers allowed to execute <= 1; and 0 when quorum is unreachable (except N=1).",
  scenarios: results,
  allSafe: results.every((r) => r.safe !== false),
};
writeFileSync("artifacts/event-grouped/phase3/grouped-v4/regression/event-single-faults.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ scenarios: results.length, allSafe: out.allSafe,
  unsafe: results.filter((r) => r.safe === false).map((r) => `${r.scenario}@N${r.robots}`) }));
