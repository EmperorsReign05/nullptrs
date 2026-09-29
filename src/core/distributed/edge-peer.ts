import { DistributedFleet } from "./fleet";
import { OwnershipPeer, type OwnershipMessage } from "./ownership";
import type { Transport } from "./transport";
import type { Message } from "./protocol";
import { makeLocalBid } from "../ml/bidmodel";
import frozen from "../../../artifacts/bid-energy-v4/model.json";
import { executionActiveTaskAllowed, executionIdleMoveAllowed } from "./execution-energy";
import { DistributedCharging } from "./charging";
import { BATTERY_PERCENT_PER_CELL } from "../simulation/robotModels";
import type { Position, RobotState, Task, WarehouseMap, WorldState } from "../types";

export type EdgeConfig = {
  self: RobotState; members: string[]; map: WarehouseMap; tasks: Task[];
  motionStartTick: number; policy: "negotiated" | "stop-and-wait"; aiEnabled?: boolean;
};
/** One physical robot's controller. Contains no other robot's private state.
 * The host supplies static geometry, integer simulation time and range-two
 * sensor positions. Bids, ownership, planning and intents stay on this peer.
 */
export class EdgePeer {
  readonly world: WorldState;
  readonly ownership: OwnershipPeer;
  readonly charging = new DistributedCharging();
  readonly fleet: DistributedFleet;
  readonly metrics = { bidAttempts: 0, corrections: 0, fallbacks: 0, moves: 0, energyHolds: 0 };
  aiEnabled: boolean;
  private tick = -1;
  private prepared = false;
  private proposed = false;
  private executing = false;
  private before: Position = { x: 0, y: 0 };
  constructor(readonly config: EdgeConfig, allocation: Transport<OwnershipMessage>, motion: Transport<Message>) {
    const self = structuredClone(config.self);
    self.path = []; self.currentTaskId = undefined; self.queuedTaskIds = []; self.status = "idle";
    this.world = { tick: 0, map: structuredClone(config.map), robots: [self], tasks: [],
      metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
    this.aiEnabled = config.aiEnabled !== false;
    this.ownership = new OwnershipPeer(self.id, config.members, allocation, (task, tick) => {
      this.metrics.bidAttempts++;
      const input = { tick, self: structuredClone(self), task,
        ownTasks: this.world.tasks.filter(t => t.id === self.currentTaskId || self.queuedTaskIds?.includes(t.id)),
        geometry: this.world.map, expectedPeerIds: config.members.filter(id => id !== self.id), maxPeerAgeTicks: 2,
        receivedPeers: [...this.ownership.heard].filter(([id]) => id !== self.id).map(([senderId, p]) =>
          ({ senderId, sequence: p.tick, observedTick: p.tick, position: p.position, path: p.path })) };
      let packet;
      try { packet = makeLocalBid(input, frozen.model, this.aiEnabled ? frozen.bound : 0); }
      catch { this.metrics.fallbacks++; packet = makeLocalBid(input, frozen.model, 0); }
      if (!this.aiEnabled) this.metrics.fallbacks++;
      if (packet.bid && packet.mlCost !== null && packet.mlCost < packet.bid.totalCost) this.metrics.corrections++;
      return packet;
    });
    this.fleet = new DistributedFleet(this.world.map, [self], this.world.tasks, {
      localCommit: true, motionTransport: motion, commRange: 6, priorityYield: true,
      motionPolicy: config.policy === "stop-and-wait" ? "stop-and-wait" : undefined,
      goalOverride: () => this.charging.active ? this.charging.goal ?? null : undefined,
      moveAllowed: (r, to) => {
        const task = this.world.tasks.find(t => t.id === r.currentTaskId);
        const allowed = this.charging.active ? this.charging.allowsMove(r, to, this.world) : task
          ? executionActiveTaskAllowed(r, task, to, this.world) : executionIdleMoveAllowed(r, to, this.world);
        if (!allowed) this.metrics.energyHolds++;
        return allowed;
      },
      arrivalAllowed: (_r, task, phase) => {
        if (this.charging.active) return false;
        if (!this.ownership.mayExecute(task.id)) return phase === "dropoff" && this.ownership.acknowledged(task.id, "completed");
        return this.ownership.mark(task.id, phase === "pickup" ? "custody" : "completed");
      },
    });
    for (const task of config.tasks) this.ownership.announce(task);
  }
  /** Called once before motion for each common simulation tick. */
  prepare(tick: number, contacts: Position[], blocks: { position: Position; blocked: boolean }[] = []) {
    if (this.prepared || tick !== this.tick + 1) throw new Error("Out-of-order prepare");
    const self = this.world.robots[0], agent = this.fleet.getAgent(self.id)!;
    this.tick = tick; this.world.tick = tick; this.prepared = true; this.before = { ...self.position };
    for (const change of blocks) {
      const cell = this.world.map.cells.find(c => c.position.x === change.position.x && c.position.y === change.position.y);
      if (!cell || change.blocked && cell.position.x === self.position.x && cell.position.y === self.position.y) throw new Error("Invalid blocked cell");
      cell.blocked = change.blocked; agent.markReplanPending(tick);
    }
    this.ownership.tick(tick, self.position, agent.getLocal().path);
    for (const received of this.ownership.tasks.values()) {
      let task = this.world.tasks.find(t => t.id === received.id);
      if (!task) { task = structuredClone(received); this.world.tasks.push(task); }
      if (this.ownership.completed(task.id)) task.status = "completed";
      const lease = this.ownership.ownership(task.id);
      task.assignedRobotId = lease?.owner;
      if (task.status !== "in_progress" && task.status !== "completed") task.status = lease ? "assigned" : "pending";
    }
    const remembered = new Set([self.currentTaskId, ...self.queuedTaskIds ?? []]);
    const owned = this.world.tasks.filter(t => !this.ownership.completed(t.id) &&
      (this.ownership.ownership(t.id)?.owner === self.id || remembered.has(t.id) && !this.ownership.ownership(t.id)));
    const active = owned.find(t => t.id === self.currentTaskId) ?? owned[0];
    self.currentTaskId = active?.id; self.queuedTaskIds = owned.filter(t => t !== active).map(t => t.id);
    self.status = active ? this.ownership.mayExecute(active.id) ? "assigned" : "waiting" : "idle";
    agent.updateLocal({ ...agent.getLocal(), seq: tick });
    const charge = this.charging.prepare(self, this.world, tick);
    this.fleet.setInactive(self.id, tick < this.config.motionStartTick || charge.hold || self.battery <= 0 || charge.mode === "work" && !!active && !this.ownership.mayExecute(active.id));
    this.fleet.observeExternalMotion(tick, contacts);
  }
  propose(tick: number) {
    if (!this.prepared || this.proposed || tick !== this.tick) throw new Error("Out-of-order propose");
    this.fleet.proposeExternalMotion(tick); this.proposed = true;
  }
  commit(tick: number) {
    if (this.executing) throw new Error("External execution in flight or faulted");
    if (!this.prepared || !this.proposed || tick !== this.tick) throw new Error("Out-of-order commit");
    this.fleet.commitExternalMotion(tick);
    return this.finishCommit(tick);
  }
  /** Lockstep continuous simulation: never settle tasks before actual arrival.
   * Rejection deliberately leaves this tick prepared: no later tick may run. */
  async commitExecuted(tick: number, execute: (from: Position, to: Position) => Promise<void>) {
    if (!this.prepared || !this.proposed || tick !== this.tick) throw new Error("Out-of-order commit");
    if (this.executing) throw new Error("Execution already in flight or faulted");
    this.executing = true;
    const decision = this.fleet.confirmExternalMotion(tick);
    const current = this.world.robots[0].position;
    if (decision && (decision.from.x !== current.x || decision.from.y !== current.y ||
      Math.abs(decision.to.x-current.x)+Math.abs(decision.to.y-current.y)>1)) throw new Error("Invalid external decision");
    if (decision) await execute(decision.from, decision.to);
    this.fleet.finishExternalMotion(tick);
    return this.finishCommit(tick);
  }
  private finishCommit(tick: number) {
    const self = this.world.robots[0];
    self.path = this.fleet.getAgent(self.id)!.getLocal().path;
    if (self.position.x !== this.before.x || self.position.y !== this.before.y) {
      self.battery = Math.max(0, self.battery - BATTERY_PERCENT_PER_CELL); this.metrics.moves++;
    }
    this.charging.afterMotion(self, this.world, tick);
    this.prepared = false; this.proposed = false; this.executing = false;
    return this.snapshot();
  }
  snapshot() {
    const self = this.world.robots[0];
    return structuredClone({ tick: this.tick, robot: self, tasks: this.world.tasks,
      charging: this.charging.state, metrics: this.metrics, ownershipMetrics: this.ownership.metrics,
      completed: this.world.tasks.filter(t => this.ownership.completed(t.id)).map(t => t.id),
      claims: this.world.tasks.map(t => ({ taskId: t.id, lease: this.ownership.ownership(t.id), recoveryRequired: this.ownership.recoveryRequired(t.id) })),
      peersHeard: [...this.ownership.heard.keys()].filter(id => id !== self.id),
      decision: this.fleet.getAgent(self.id)!.getLastDecision() });
  }
}
