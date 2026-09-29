#!/usr/bin/env node
/** Task-admission throughput benchmark, isolated from physical travel.
 *
 * Movement is disabled (every robot holds) so the measurement reflects
 * certification latency only, not Nav2 or PIBT time. Each run reports how many
 * tasks reached a quorum-backed executable certificate, and how long that took.
 *
 * --frontier=1   reproduces the pre-change behaviour: exactly one new task
 *                admitted per ownership generation.
 * --frontier=auto uses the membership-derived frontier (floor(N/2)).
 */
import { createRequire } from "node:module";
import { parseArgs } from "./fleet-config.mjs";
const require = createRequire(import.meta.url);
const { OwnershipPeer, OWNERSHIP_EPOCH_TICKS } = require("../.fleet-dist/src/core/distributed/ownership.js");
const { InMemoryBus, InMemoryTransport } = require("../.fleet-dist/src/core/distributed/transport.js");

const args = parseArgs();
const n = Number(args.robots ?? 3);
const taskCount = Number(args.tasks ?? n);
const ticks = Number(args.ticks ?? 600);
const mode = args.frontier ?? "auto";

const ids = Array.from({ length: n }, (_, i) => `AMR-${String(i + 1).padStart(2, "0")}`);
const quorum = Math.floor(n / 2) + 1;
const tasks = Array.from({ length: taskCount }, (_, i) => ({
  id: `T-${i + 1}`, pickup: { x: 0, y: 0 }, dropoff: { x: 1, y: 0 },
  weight: 1, createdAt: 0, priority: 1, status: "pending",
}));

const bus = new InMemoryBus();
const peers = ids.map((id, i) => {
  const transport = new InMemoryTransport(id, bus);
  ids.filter((p) => p !== id).forEach((p) => transport.addPeer(p));
  const peer = new OwnershipPeer(id, ids, transport, (task) => ({
    robotId: id, taskId: task.id, tick: 0,
    bid: { robotId: id, taskId: task.id, eta: 1, travelCost: 1, congestionCost: 0,
           batteryCost: 0, workloadCost: i, urgencyCost: 0, payloadCost: 0,
           totalCost: 10 + i, feasible: true, infeasibleReason: null },
    features: Array(16).fill(0), mlCost: 10 + i, completePeerKnowledge: true, reciprocalIntent: false,
    energy: { admitted: true, reason: "bench", activeRouteCertified: true, battery: 100,
              committedDistance: 0, chargingDistance: 0, requiredEnergy: 0, reserve: 0, margin: 0,
              charger: { x: 0, y: 0 } },
  }));
  return peer;
});
// Pin the frontier to compare serialized vs concurrent admission on the same code.
if (mode !== "auto") {
  Object.defineProperty(peers[0], "admissionFrontier", { value: () => Number(mode) });
  for (const p of peers.slice(1)) Object.defineProperty(p, "admissionFrontier", { value: () => Number(mode) });
}
peers[0].announce(tasks[0]);
for (let i = 1; i < taskCount; i++) peers[i % n].announce(tasks[i]);

// Hold robots still: only ownership progresses, no motion is ever planned.
const certifiedAt = new Map();
let violations = 0;
for (let tick = 0; tick < ticks; tick++) {
  for (const p of peers) p.tick(tick, { x: 0, y: 0 }, []);
  const owners = new Map();
  for (const p of peers) {
    for (const t of tasks) {
      const lease = p.ownership(t.id);
      if (!lease) continue;
      if (!certifiedAt.has(t.id)) certifiedAt.set(t.id, tick);
      const prior = owners.get(t.id);
      if (prior && prior !== lease.owner) violations++;
      owners.set(t.id, lease.owner);
    }
  }
  const executing = peers.filter((p) => tasks.some((t) => p.mayExecute(t.id)));
  const perTask = new Map();
  for (const p of peers) for (const t of tasks) if (p.mayExecute(t.id)) perTask.set(t.id, (perTask.get(t.id) ?? 0) + 1);
  for (const [, c] of perTask) if (c > 1) violations++;
  void executing;
  if (certifiedAt.size === taskCount) break;
}
const latencies = [...certifiedAt.values()].map((t) => t).sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null);
const out = {
  schema: 1, robots: n, taskCount, frontier: mode, quorum, ticksRun: ticks,
  certified: certifiedAt.size,
  // Rate is measured against the makespan (last certification), not the budget,
  // otherwise every arm reports the same budget-normalised number.
  makespanTicks: latencies[latencies.length - 1] ?? null,
  certifiedPer100Ticks: latencies.length
    ? Number((certifiedAt.size * 100 / latencies[latencies.length - 1]).toFixed(2))
    : 0,
  medianCertificationLatencyTicks: pct(0.5), p95CertificationLatencyTicks: pct(0.95),
  firstCertifiedAtTick: latencies[0] ?? null, lastCertifiedAtTick: latencies[latencies.length - 1] ?? null,
  ownershipEpochTicks: OWNERSHIP_EPOCH_TICKS,
  duplicateExecutableOwnerViolations: violations,
};
console.log(JSON.stringify(out));
