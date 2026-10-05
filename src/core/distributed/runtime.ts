import { randomUUID } from "node:crypto";
import { groupBid, groupIdentity, bundleExecutionAllowed, type GroupBid } from "../auction/grouped";
import { executionActiveTaskAllowed, executionIdleMoveAllowed } from "./execution-energy";
import { DistributedCharging } from "./charging";
import { createInitialWorld } from "../simulation/state";
import { BATTERY_PERCENT_PER_CELL, RECHARGE_TARGET_PERCENT } from "../simulation/robotModels";
import { type LocalBidInput } from "../ml/bidfeatures";
import { makeLocalBid, type BidModel, type LocalBidPacket } from "../ml/bidmodel";
import frozen from "../../../artifacts/bid-energy-v4/model.json";
import { DistributedFleet } from "./fleet";
import { OwnershipPeer, OWNERSHIP_EPOCH_TICKS, type OwnershipMessage } from "./ownership";
import { InMemoryBus, InMemoryTransport } from "./transport";
import type { Position, Task, WorldState } from "../types";

export type RuntimeCommand = { kind: "run" | "pause" | "ai-on" | "ai-off" | "heal" }
  | { kind: "fail"; robotId: string }
  | { kind: "link"; a: string; b: string; reachable: boolean }
  | { kind: "block"; position: Position; blocked: boolean }
  | { kind: "task"; task: Task };
export class FleetRuntime {
  readonly world: WorldState;
  readonly runtimeId = randomUUID();
  private motionHistory: { tick: number; positions: Record<string, Position> }[] = [];
  private recordMotion() {
    this.motionHistory.push({ tick: this.world.tick, positions: Object.fromEntries(this.world.robots.map(r => [r.id, { ...r.position }])) });
    if (this.motionHistory.length > 9) this.motionHistory.shift();
  }
  readonly peers = new Map<string, OwnershipPeer>();
  readonly charging = new Map<string, DistributedCharging>();
  readonly fleet: DistributedFleet;
  readonly events: { tick: number; text: string }[] = [];
  readonly safety = { overlaps: 0, swaps: 0, blockedCells: 0, zeroBatteryWork: 0, queueOverflow: 0, payloadViolations: 0 };
  readonly metrics = { aiBidAttempts: 0, nonzeroCorrections: 0, disabledFallbacks: 0, failedModelFallbacks: 0, moves: 0, reroutes: 0, energyHolds: 0 };
  private channels = new Map<string, InMemoryTransport<OwnershipMessage>>();
  private groupCache = new Map<string,{state:string;bid:GroupBid}>();
  private groupedEnergyBlocked = new Set<string>();
  private bidRechargeTargets = new Map<string, number>();
  private dead = new Set<string>();
  running = true;
  aiEnabled = true;
  constructor(world?: WorldState, private model: BidModel = frozen.model, private options: { motionPolicy?: "stop-and-wait"; fleetSize?: number; allocationMode?: "epoch" | "event-single" | "event-grouped"; groupedQueueRecharge?: boolean } = {}) {
    this.world = structuredClone(world ?? createInitialWorld());
    if (!world) {
      this.world.tasks = [];
      // Only the self-constructed default world is sized. A caller-supplied
      // world defines its own membership and is never truncated.
      const fleetSize = options.fleetSize ?? 3;
      if (!Number.isInteger(fleetSize) || fleetSize < 1) throw new Error(`fleetSize must be a positive integer, got ${fleetSize}`);
      if (fleetSize < this.world.robots.length) this.world.robots = this.world.robots.slice(0, fleetSize);
    }
    this.world.robots.forEach(r => { r.currentTaskId = undefined; r.queuedTaskIds = []; r.path = []; r.status = "idle"; });
    this.recordMotion();
    const ids = this.world.robots.map(r => r.id), bus = new InMemoryBus<OwnershipMessage>();
    for (const r of this.world.robots) {
      this.charging.set(r.id, new DistributedCharging());
      const channel = new InMemoryTransport(r.id, bus); ids.filter(id => id !== r.id).forEach(id => channel.addPeer(id)); this.channels.set(r.id, channel);
      this.peers.set(r.id, new OwnershipPeer(r.id, ids, channel, (task, tick) => this.bid(r.id, task, tick), options.allocationMode,
        (tasks, tick, fresh) => this.bundleBid(r.id,tasks,tick,fresh)));
    }
    this.fleet = new DistributedFleet(this.world.map, this.world.robots, this.world.tasks, { commRange: 6, localCommit: true, motionPolicy: options.motionPolicy,
      goalOverride: r => this.charging.get(r.id)!.active ? this.charging.get(r.id)!.goal ?? null : undefined,
      moveAllowed: (r, to) => {
        const charge = this.charging.get(r.id)!, task = this.world.tasks.find(t => t.id === r.currentTaskId);
        const allowed = charge.active ? charge.allowsMove(r, to, this.world) : task
          ? executionActiveTaskAllowed(r, task, to, this.world) : executionIdleMoveAllowed(r, to, this.world);
        const groupedBudget = options.allocationMode !== "event-grouped" || charge.active || !task || bundleExecutionAllowed(r,to,this.world);
        if(options.groupedQueueRecharge && options.allocationMode === "event-grouped" && !charge.active && task && task.status !== "in_progress" && (!allowed || !groupedBudget)) this.groupedEnergyBlocked.add(r.id);
        if (!allowed || !groupedBudget) this.metrics.energyHolds++;
        return allowed && groupedBudget;
      },
      arrivalAllowed: (r, t, phase) => {
        if (this.charging.get(r.id)!.active) return false;
        if(options.allocationMode === "event-grouped" && phase === "pickup" && !bundleExecutionAllowed(r,r.position,this.world)) return false;
        const peer = this.peers.get(r.id)!;
        if (!peer.mayExecute(t.id)) return phase === "dropoff" && peer.acknowledged(t.id, "completed");
        return peer.mark(t.id, phase === "pickup" ? "custody" : "completed");
      } });
    for (const task of this.world.tasks) this.peers.get(ids[0])!.announce({ ...task, status: "pending", assignedRobotId: undefined });
  }
  private bundleBid(id:string,tasks:Task[],tick:number,fresh=false):GroupBid {
    const input=this.bidInput(id,tasks[0],tick),generation=Math.floor(tick/OWNERSHIP_EPOCH_TICKS);
    const key=id+":"+groupIdentity(generation,tasks);
    // Refresh on commitments, charging/availability, membership, geometry,
    // auction generation and 5%-battery transitions. Motion alone does not
    // cause a new auction. Winning owners always bypass this cache at grant.
    const peers=input.receivedPeers.filter(p=>tick-p.observedTick<=input.maxPeerAgeTicks).map(p=>p.senderId).sort();
    const active=input.ownTasks.find(t=>t.id===input.self.currentTaskId);
    const goal=active?(active.status==="in_progress"?active.dropoff:active.pickup):undefined;
    const path=input.self.path;
    const validActive=!active||path.length>0&&path[0].x===input.self.position.x&&path[0].y===input.self.position.y&&
      path[path.length-1].x===goal!.x&&path[path.length-1].y===goal!.y;
    const state=JSON.stringify([input.self.currentTaskId,input.self.queuedTaskIds,input.self.status,Math.floor(input.self.battery/5),validActive,
      input.ownTasks.map(t=>[t.id,t.status]),peers,this.aiEnabled,input.geometry.cells.map(c=>c.blocked),tasks.some(t=>t.deadline!==undefined)?tick:null]);
    const cached=this.groupCache.get(key);
    if(!fresh&&cached?.state===state)return {...cached.bid,tick};
    const bid=groupBid(input,tasks,generation,this.model,this.aiEnabled?frozen.bound:0);
    this.groupCache.set(key,{state,bid});return bid;
  }
  private bidInput(id: string, task: Task, tick: number): LocalBidInput {
    const self = this.world.robots.find(r => r.id === id)!, peer = this.peers.get(id)!;
    return { tick, self: structuredClone(self), task,
      ownTasks: [...peer.tasks.values()].filter(t => t.id === self.currentTaskId || self.queuedTaskIds?.includes(t.id)).map(t => ({
        ...t, status: peer.completed(t.id) ? "completed" : peer.phase(t.id) ? "in_progress" : "assigned", assignedRobotId: id,
      })),
      geometry: this.world.map, expectedPeerIds: [...this.peers.keys()].filter(p => p !== id), maxPeerAgeTicks: 2,
      receivedPeers: [...peer.heard].filter(([p]) => p !== id).map(([senderId, p]) => ({ senderId, sequence: p.tick, observedTick: p.tick, position: p.position, path: p.path })) };
  }
  private bid(id: string, task: Task, tick: number): LocalBidPacket {
    const input=this.bidInput(id,task,tick);
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
    // Idle bidders can reject the head job for energy while still above the
    // hard low-battery floor. Without this signal, they never go to charge and
    // the same job blocks admission indefinitely. Keep ownership untouched;
    // recharge only a robot with no active or queued commitments.
    const robot = this.world.robots.find(r => r.id === id)!;
    if (!robot.currentTaskId && !robot.queuedTaskIds?.length && packet.energy.reason === "insufficient-energy" &&
        Number.isFinite(packet.energy.requiredEnergy) && packet.energy.requiredEnergy <= 100) {
      this.bidRechargeTargets.set(id, Math.max(RECHARGE_TARGET_PERCENT, packet.energy.requiredEnergy));
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
      if(peer.allocationMode === "event-grouped") {
        owned.sort((a,b)=>peer.certifiedOrder(a.id)-peer.certifiedOrder(b.id));
        if(owned.length>5) throw new Error(`Certified queue overflow for ${r.id}: ${owned.length}`);
      }
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
      // A rejected pre-pickup energy move is a useful recharge event, even
      // when the cheaper static active-task estimate still says "ready".
      // The full commitment guard remains enforced and custody stays sticky.
      const queueRecharge = this.options.groupedQueueRecharge && peer.allocationMode === "event-grouped" && active && active.status !== "in_progress";
      const bidRechargeTarget = !active && !r.queuedTaskIds.length ? this.bidRechargeTargets.get(r.id) : undefined;
      const commitmentsAffordable = (!queueRecharge || !this.groupedEnergyBlocked.has(r.id) && bundleExecutionAllowed(r,r.position,this.world)) &&
        (bidRechargeTarget === undefined || r.battery >= bidRechargeTarget);
      this.groupedEnergyBlocked.delete(r.id);
      const charge = this.charging.get(r.id)!.prepare(r, this.world, tick, commitmentsAffordable);
      if (bidRechargeTarget !== undefined && charge.mode === "work") this.bidRechargeTargets.delete(r.id);
      this.fleet.setInactive(r.id, charge.hold || r.battery <= 0 || charge.mode === "work" && !!active && !peer.mayExecute(active.id));
      if (active && active.status === "in_progress" && !peer.acknowledged(active.id, "custody")) peer.mark(active.id, "custody");
    }
    const before = this.world.robots.map(r => ({ ...r.position }));
    const paths = this.world.robots.map(r => JSON.stringify(this.fleet.getAgent(r.id)!.getLocal().path));
    this.fleet.advance(tick);
    this.world.robots.forEach((r, i) => {
      const path = this.fleet.getAgent(r.id)!.getLocal().path; r.path = path;
      const moved = before[i].x !== r.position.x || before[i].y !== r.position.y;
      if (moved) { r.battery = Math.max(0, r.battery - BATTERY_PERCENT_PER_CELL); this.metrics.moves++; }
      if (!this.dead.has(r.id)) this.charging.get(r.id)!.afterMotion(r, this.world, tick);
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
    this.recordMotion();
  }
  snapshot() {
    return structuredClone({ runtimeId: this.runtimeId, motionHistory: this.motionHistory, world: this.world, running: this.running, aiEnabled: this.aiEnabled, events: this.events, safety: this.safety, metrics: this.metrics,
      charging: [...this.charging].map(([id, c]) => ({ id, ...c.state })),
      deployment: "Node-hosted distributed-peer simulation; synchronous local commit; simulated sensors; no ROS2/hardware",
      ownership: [...this.peers].map(([id, p]) => ({ id, metrics: p.metrics, tasks: [...p.tasks.keys()].map(taskId => ({ taskId, lease: (p.ownership(taskId)?.expires ?? 0) > this.world.tick ? p.ownership(taskId) : undefined, recoveryRequired: p.recoveryRequired(taskId), completed: p.completed(taskId) })) })) });
  }
}
