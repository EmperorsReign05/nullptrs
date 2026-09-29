// Is edge-peer.test.ts's "3 completed after 200 ticks" a deadlock, or a
// threshold that is simply too tight for a single-bridge scenario where motion
// only starts at tick 112? Track completion and safety out to a long horizon.
import { EdgePeer } from "../src/core/distributed/edge-peer";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import type { OwnershipMessage } from "../src/core/distributed/ownership";
import type { Message } from "../src/core/distributed/protocol";
import { edgeChokeScenario } from "../src/core/bench/edge-choke";
import type { Position } from "../src/core/types";

function setup(seed: number, policy: "negotiated" | "stop-and-wait") {
  const scenario = edgeChokeScenario(seed, policy);
  const allocation = new InMemoryBus<OwnershipMessage>();
  const motion = new InMemoryBus<Message>();
  const transports = scenario.configs.map((c) => {
    const a = new InMemoryTransport(c.self.id, allocation);
    const m = new InMemoryTransport(c.self.id, motion);
    c.members.filter((id) => id !== c.self.id).forEach((id) => { a.addPeer(id); m.addPeer(id); });
    return { a, m };
  });
  return { scenario, peers: scenario.configs.map((c, i) => new EdgePeer(c, transports[i].a, transports[i].m)) };
}

const key = (p: Position) => `${p.x},${p.y}`;
const seed = Number(process.argv[2] ?? 23000);
const horizon = Number(process.argv[3] ?? 1200);
const { peers } = setup(seed, "negotiated");

let overlap = 0, ticks = 0, swaps = 0;
const completedAt: number[] = [];
const bridgeOccupancy = new Map<number, number>();
for (let tick = 0; tick < horizon; tick++) {
  const before = peers.map((p) => ({ ...p.world.robots[0].position }));
  const done = new Set(peers.flatMap((p) => p.snapshot().completed));
  peers.forEach((p, i) => p.prepare(tick, before.filter((q, j) => i !== j && Math.abs(q.x - before[i].x) + Math.abs(q.y - before[i].y) <= 2)));
  try { peers.forEach((p) => p.propose(tick)); peers.forEach((p) => p.commit(tick)); }
  catch (e) {
    console.log(`THREW at tick ${tick}: ${(e as Error).message}`);
    peers.forEach((q, i) => console.log(`  peer${i} internalTick=${(q as any).tick} prepared=${(q as any).prepared} proposed=${(q as any).proposed}`));
    break;
  }
  const next = peers.map((p) => ({ ...p.world.robots[0].position }));
  ticks++;
  if (new Set(next.map(key)).size !== next.length) overlap++;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    if (key(before[i]) === key(next[j]) && key(before[j]) === key(next[i]) && key(before[i]) !== key(next[i])) swaps++;
  }
  if (next.some((q) => q.x === 9 && q.y === 6)) bridgeOccupancy.set(tick, (bridgeOccupancy.get(tick) ?? 0) + 1);
  const after = new Set(peers.flatMap((p) => p.snapshot().completed));
  for (const c of after) if (!done.has(c)) completedAt.push(tick);
  if (after.size === 3) { console.log(`all 3 tasks completed at tick ${tick}`); break; }
}
const finalCompleted = new Set(peers.flatMap((p) => p.snapshot().completed));
console.log(`edge-choke seed=${seed} horizon=${horizon} ticks=${ticks}`);
console.log(`  distinct completed: ${finalCompleted.size}/3   completion ticks: [${completedAt.join(", ")}]`);
console.log(`  overlap ticks ${overlap}/${ticks}   swaps ${swaps}   bridge(9,6) occupied on ${bridgeOccupancy.size} ticks`);
console.log(`  at tick 200 (the test's horizon) the test saw ${new Set(peers.flatMap((p) => p.snapshot().completed)).size ? "..." : ""}`);
peers.forEach((p) => console.log(`  ${p.world.robots[0].id} pos=${key(p.world.robots[0].position)} task=${p.world.robots[0].currentTaskId ?? "-"} completed=[${p.snapshot().completed.join(",")}] corrections=${p.metrics.corrections}`));
