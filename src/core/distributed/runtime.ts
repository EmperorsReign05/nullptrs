import { createInitialWorld } from "../simulation/state";
import { BATTERY_PERCENT_PER_CELL } from "../simulation/robotModels";
import { assessBidEnergy, type LocalBidInput } from "../ml/bidfeatures";
import { makeLocalBid, type BidModel, type LocalBidPacket } from "../ml/bidmodel";
import frozen from "../../../artifacts/bid-energy-v4/model.json";
import { DistributedFleet } from "./fleet";
import { OwnershipPeer, type OwnershipMessage } from "./ownership";
import { InMemoryBus, InMemoryTransport } from "./transport";
import type { Position, Task, WorldState } from "../types";

export type RuntimeCommand = { kind: "run" | "pause" | "ai-on" | "ai-off" | "heal" }
  | { kind: "fail"; robotId: string }
  | { kind: "link"; a: string; b: string; reachable: boolean }
  | { kind: "block"; position: Position; blocked: boolean }
  | { kind: "task"; task: Task };
export class FleetRuntime {
  readonly world: WorldState;
  readonly peers = new Map<string, OwnershipPeer>();
  readonly fleet: DistributedFleet;
  readonly events: { tick: number; text: string }[] = [];
  readonly safety = { overlaps: 0, swaps: 0, blockedCells: 0, zeroBatteryWork: 0, queueOverflow: 0, payloadViolations: 0 };
  readonly metrics = { aiBidAttempts: 0, nonzeroCorrections: 0, disabledFallbacks: 0, failedModelFallbacks: 0, moves: 0, reroutes: 0 };
  private channels = new Map<string, InMemoryTransport<OwnershipMessage>>();
  private dead = new Set<string>();
  running = true;
  aiEnabled = true;
  constructor(world?: WorldState, private model: BidModel = frozen.model) {
    this.world = structuredClone(world ?? createInitialWorld());
    if (!world) { this.world.robots = this.world.robots.slice(0, 3); this.world.tasks = []; }
    this.world.robots.forEach(r => { r.currentTaskId = undefined; r.queuedTaskIds = []; r.path = []; r.status = "idle"; });
    const ids = this.world.robots.map(r => r.id), bus = new InMemoryBus<OwnershipMessage>();
    for (const r of this.world.robots) {
      const channel = new InMemoryTransport(r.id, bus); ids.filter(id => id !== r.id).forEach(id => channel.addPeer(id)); this.channels.set(r.id, channel);
      this.peers.set(r.id, new OwnershipPeer(r.id, ids, channel, (task, tick) => this.bid(r.id, task, tick)));
    }
    this.fleet = new DistributedFleet(this.world.map, this.world.robots, this.world.tasks, { commRange: 6, localCommit: true,
      arrivalAllowed: (r, t, phase) => {
        const peer = this.peers.get(r.id)!;
        if (!peer.mayExecute(t.id)) return phase === "dropoff" && peer.acknowledged(t.id, "completed");
        return peer.mark(t.id, phase === "pickup" ? "custody" : "completed");
      } });
    for (const task of this.world.tasks) this.peers.get(ids[0])!.announce({ ...task, status: "pending", assignedRobotId: undefined });
  }
  private bid(id: string, task: Task, tick: number): LocalBidPacket {
    const self = this.world.robots.find(r => r.id === id)!, peer = this.peers.get(id)!;
    const input: LocalBidInput = { tick, self: structuredClone(self), task,
      ownTasks: [...peer.tasks.values()].filter(t => t.id === self.currentTaskId || self.queuedTaskIds?.includes(t.id)).map(t => ({
        ...t, status: peer.completed(t.id) ? "completed" : peer.phase(t.id) ? "in_progress" : "assigned", assignedRobotId: id,
      })),
      geometry: this.world.map, expectedPeerIds: [...this.peers.keys()].filter(p => p !== id), maxPeerAgeTicks: 2,
      receivedPeers: [...peer.heard].filter(([p]) => p !== id).map(([senderId, p]) => ({ senderId, sequence: p.tick, observedTick: p.tick, position: p.position, path: p.path })) };
    // Disabled/unavailable AI still follows the identical deterministic packet
    // and hard eligibility path. The frozen network is never retrained here.
    let packet: LocalBidPacket;
    try {
      packet = makeLocalBid(input, this.aiEnabled ? this.model : frozen.model, this.aiEnabled ? frozen.bound : 0);
      if (this.aiEnabled) this.metrics.aiBidAttempts++; else this.metrics.disabledFallbacks++;
      if (packet.bid && packet.mlCost !== null && packet.mlCost < packet.bid.totalCost) this.metrics.nonzeroCorrections++;
    } catch {
      this.metrics.failedModelFallbacks++;
      packet = makeLocalBid(input, frozen.model, 0);
    }
    return packet;
  }
  private log(text: string) { this.events.push({ tick: this.world.tick, text }); if (this.events.length > 200) this.events.shift(); }
  command(command: RuntimeCommand) {
    if (command.kind === "run") this.running = true;
    if (command.kind === "pause") this.running = false;
    if (command.kind === "ai-on") this.aiEnabled = true;
    if (command.kind === "ai-off") this.aiEnabled = false;
    if (command.kind === "fail") {
      const r = this.world.robots.find(r => r.id === command.robotId); if (!r) throw new Error("Unknown robot");
      this.dead.add(r.id); r.status = "failed"; r.path = [];
      // Keep physical custody visible after pickup; unpicked work is no longer
      // an active execution on the failed body. Lease expiry governs reassignment.
      if (this.world.tasks.find(t => t.id === r.currentTaskId)?.status !== "in_progress") r.currentTaskId = undefined;
      r.queuedTaskIds = []; this.fleet.setInactive(r.id, true);
    }
    if (command.kind === "link") {
      if (typeof command.reachable !== "boolean") throw new Error("Invalid link state");
      if (!this.peers.has(command.a) || !this.peers.has(command.b)) throw new Error("Unknown peer");
      this.channels.get(command.a)!.setReachable(command.b, command.reachable); this.channels.get(command.b)!.setReachable(command.a, command.reachable);
      this.fleet.setLink(command.a, command.b, command.reachable);
    }
    if (command.kind === "heal") for (const a of this.peers.keys()) for (const b of this.peers.keys()) if (a !== b) {
      this.channels.get(a)!.setReachable(b, true); this.fleet.setLink(a, b, true);
    }
    if (command.kind === "block") {
      if (typeof command.blocked !== "boolean") throw new Error("Invalid blocked state");
      const c = this.world.map.cells.find(c => c.position.x === command.position.x && c.position.y === command.position.y);
      if (!c || command.blocked && this.world.robots.some(r => r.position.x === c.position.x && r.position.y === c.position.y)) throw new Error("Cannot block absent or occupied cell");
      c.blocked = command.blocked;
      for (const r of this.world.robots) this.fleet.getAgent(r.id)?.markReplanPending(this.world.tick);
    }
    if (command.kind === "task") {
      if (this.world.tasks.some(t => t.id === command.task.id)) throw new Error("Duplicate task id");
      const t = structuredClone(command.task);
      if (typeof t.id !== "string" || !t.id.length || t.id.length > 128 || !Number.isFinite(t.priority) || !Number.isInteger(t.createdAt) || t.createdAt < 0 || t.status !== "pending" || t.assignedRobotId || !Number.isFinite(t.weight) || t.weight < 0 ||
        ![t.pickup, t.dropoff].every(p => this.world.map.cells.some(c => !c.blocked && c.position.x === p.x && c.position.y === p.y))) throw new Error("Invalid task");
      const announcer = [...this.peers.values()].find(p => !this.dead.has(p.id)); if (!announcer) throw new Error("No live agent");
      this.world.tasks.push(t); announcer.announce(t);
    }
    this.log(JSON.stringify(command));
  }
  step() {
    if (!this.running) return;
    const tick = this.world.tick;
    for (const r of this.world.robots) if (!this.dead.has(r.id)) this.peers.get(r.id)!.tick(tick, r.position, this.fleet.getAgent(r.id)!.getLocal().path);
    for (const t of this.world.tasks) {
      if (t.status === "completed") continue;
      if ([...this.peers.values()].some(p => p.completed(t.id))) {
        t.status = "completed"; this.log(`completed ${t.id}`); continue;
      }
      const holder = [...this.peers.values()].find(p => !this.dead.has(p.id) && p.mayExecute(t.id));
      const owner = holder?.id;
      if (t.assignedRobotId !== owner) {
        this.log(`ownership ${t.id}: ${t.assignedRobotId ?? "none"} -> ${owner ?? "none"}`);
        t.assignedRobotId = owner;
        if (t.status !== "in_progress") t.status = owner ? "assigned" : "pending";
      }
    }
    for (const r of this.world.robots) {
      if (this.dead.has(r.id)) continue;
      const peer = this.peers.get(r.id)!;
      // An expired lease fences execution; it does not erase local knowledge
      // of unfinished commitments. Keep them in the next bid's energy/queue
      // features until completion or a received newer certificate transfers
      // ownership. Otherwise every lease boundary falsely makes a busy bidder
      // appear idle and promotes work against an understated energy budget.
      const remembered = new Set([r.currentTaskId, ...(r.queuedTaskIds ?? [])]);
      const owned = this.world.tasks.filter(t => !peer.completed(t.id) &&
        (peer.ownership(t.id)?.owner === r.id || remembered.has(t.id) && !peer.ownership(t.id)));
      const active = owned.find(t => t.id === r.currentTaskId) ?? owned[0];
      r.currentTaskId = active?.id; r.queuedTaskIds = owned.filter(t => t !== active).slice(0, 4).map(t => t.id);
      r.status = active ? peer.mayExecute(active.id) ? "assigned" : "waiting" : "idle";
      // Motion rounds use the shared simulator sequence even after a lease
      // pause; an inactive robot must not resume with a permanently old seq.
      const agent = this.fleet.getAgent(r.id)!;
      agent.updateLocal({ ...agent.getLocal(), seq: tick });
      // Ownership is necessary but not sufficient: before installing a new
      // commitment, energy must cover task + charging + reserve. No movement
      // with depleted battery. Existing active certified routes remain intact.
      const safe = !active || active.status === "in_progress" || assessBidEnergy({ ...r, currentTaskId: undefined }, active, this.world).admitted;
      this.fleet.setInactive(r.id, !safe || r.battery <= 0 || !!active && !peer.mayExecute(active.id));
      if (active && active.status === "in_progress" && !peer.acknowledged(active.id, "custody")) peer.mark(active.id, "custody");
    }
    const before = this.world.robots.map(r => ({ ...r.position }));
    const paths = this.world.robots.map(r => JSON.stringify(this.fleet.getAgent(r.id)!.getLocal().path));
    this.fleet.advance(tick);
    this.world.robots.forEach((r, i) => {
      const path = this.fleet.getAgent(r.id)!.getLocal().path; r.path = path;
      const moved = before[i].x !== r.position.x || before[i].y !== r.position.y;
      if (moved) { r.battery = Math.max(0, r.battery - BATTERY_PERCENT_PER_CELL); this.metrics.moves++; }
      if (!moved && paths[i] !== JSON.stringify(path)) { this.metrics.reroutes++; this.world.metrics.replans++; }
      if (!moved && r.currentTaskId) this.world.metrics.waitMoves++;
      if (r.battery <= 0 && r.currentTaskId) this.safety.zeroBatteryWork++;
      if ((r.queuedTaskIds?.length ?? 0) > 4) this.safety.queueOverflow++;
      if (this.world.tasks.some(t => t.id === r.currentTaskId && t.weight > r.model.payloadCapacity)) this.safety.payloadViolations++;
      if (this.world.map.cells.some(c => c.blocked && c.position.x === r.position.x && c.position.y === r.position.y)) this.safety.blockedCells++;
      for (let j = i + 1; j < this.world.robots.length; j++) if (moved && before[i].x === this.world.robots[j].position.x && before[i].y === this.world.robots[j].position.y && before[j].x === r.position.x && before[j].y === r.position.y) this.safety.swaps++;
    });
    this.safety.overlaps += this.world.robots.length - new Set(this.world.robots.map(r => `${r.position.x},${r.position.y}`)).size;
    this.world.tick++;
  }
  snapshot() {
    return structuredClone({ world: this.world, running: this.running, aiEnabled: this.aiEnabled, events: this.events, safety: this.safety, metrics: this.metrics,
      deployment: "Node-hosted distributed-peer simulation; synchronous local commit; simulated sensors; no ROS2/hardware",
      ownership: [...this.peers].map(([id, p]) => ({ id, metrics: p.metrics, tasks: [...p.tasks.keys()].map(taskId => ({ taskId, lease: (p.ownership(taskId)?.expires ?? 0) > this.world.tick ? p.ownership(taskId) : undefined, recoveryRequired: p.recoveryRequired(taskId), completed: p.completed(taskId) })) })) });
  }
}
