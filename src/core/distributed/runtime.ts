import { randomUUID } from "node:crypto";
import { groupBid, groupIdentity, bundleExecutionAllowed, type GroupBid } from "../auction/grouped";
import { executionActiveTaskAllowed, executionIdleMoveAllowed } from "./execution-energy";
import { DistributedCharging } from "./charging";
import { createInitialWorld } from "../simulation/state";
import { CHARGING_STATIONS, DROPOFF_STATIONS, PICKUP_STATIONS, WAITING_ZONE_CELLS } from "../map/warehouse";
import { planPath } from "../pathfinding/astar";
import { BATTERY_PERCENT_PER_CELL, RECHARGE_TARGET_PERCENT } from "../simulation/robotModels";
import { type LocalBidInput } from "../ml/bidfeatures";
import { makeLocalBid, type BidModel, type LocalBidPacket } from "../ml/bidmodel";
import frozen from "../../../artifacts/bid-energy-v4/model.json";
import { DistributedFleet } from "./fleet";
import { OwnershipPeer, OWNERSHIP_EPOCH_TICKS, PEER_TIMEOUT_TICKS, type OwnershipMessage } from "./ownership";
import { InMemoryBus, InMemoryTransport } from "./transport";
import type { Position, RobotState, Task, WorldState } from "../types";

export type RuntimeCommand = { kind: "run" | "pause" | "ai-on" | "ai-off" | "heal" }
  | { kind: "fail"; robotId: string }
  | { kind: "recover"; robotId: string }
  | { kind: "link"; a: string; b: string; reachable: boolean }
  | { kind: "block"; position: Position; blocked: boolean }
  | { kind: "task"; task: Task };
export const MOTION_HISTORY_TICKS = 24;

export type FleetTraffic = {
  /** Choose chargers by expected wait as well as distance. */
  loadAwareCharging?: boolean;
  /** Never park on a station, wait clear of a busy charger, one robot per dead-end charger. */
  stationEtiquette?: boolean;
  /** Persistent energy refusals send a robot to charge; a robot stuck long enough may limp aside. */
  deadlockRecovery?: boolean;
  /** Battery slack kept above job + charger + reserve (see ChargingTraffic.marginPercent). */
  chargeMarginPercent?: number;
};
export class FleetRuntime {
  readonly world: WorldState;
  readonly runtimeId = randomUUID();
  /** Committed positions for the last MOTION_HISTORY_TICKS ticks (plus the current one), so a
   *  viewer that missed several seconds of polls still replays every cell instead of jumping. */
  private motionHistory: { tick: number; positions: Record<string, Position> }[] = [];
  private recordMotion() {
    this.motionHistory.push({ tick: this.world.tick, positions: Object.fromEntries(this.world.robots.map(r => [r.id, { ...r.position }])) });
    if (this.motionHistory.length > MOTION_HISTORY_TICKS + 1) this.motionHistory.shift();
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
  /**
   * Robots refused a move toward a job they have not picked up yet, this tick,
   * and for how many consecutive ticks. The move gate certifies the cell the
   * robot is stepping INTO, the charging planner only the cell it stands on, so
   * a robot near its margin forced onto a detour by traffic was "ready" to the
   * planner and refused every step by the gate. It stood still, holding its jobs,
   * never going to charge. Two such robots blocking each other froze for good,
   * and within ten minutes the whole fleet did. With deadlock recovery on, a
   * refusal that persists counts as unaffordable commitments, which sends the
   * robot to charge (a carrier keeps its cargo while it does).
   */
  private energyRefused = new Set<string>();
  private energyRefusedStreak = new Map<string, number>();
  private static readonly ENERGY_REFUSAL_TICKS = 3;
  /** Consecutive ticks each robot has stood still with somewhere to go. */
  private stillTicks = new Map<string, number>();
  /** Stuck this long, a robot may dip into its reserve to step aside. */
  private static readonly LIMP_AFTER_TICKS = 20;
  /** The floor limp mode keeps, with a charger still reachable on top of it. */
  private static readonly LIMP_FLOOR_PERCENT = 5;
  private bidRechargeTargets = new Map<string, number>();
  private dead = new Set<string>();
  running = true;
  aiEnabled = true;
  constructor(world?: WorldState, private model: BidModel = frozen.model, private options: { motionPolicy?: "stop-and-wait"; fleetSize?: number; allocationMode?: "epoch" | "event-single" | "event-grouped"; groupedQueueRecharge?: boolean;
    /**
     * Opt-in dense-fleet traffic aids, off by default so measured runs are
     * unchanged. The served dashboard runtime turns them all on; see
     * TRAFFIC_AIDS in server/fleet-service.ts for what each one fixed.
     */
    traffic?: FleetTraffic } = {}) {
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
      goalOverride: r => this.stationGoal(r) ?? (this.charging.get(r.id)!.active ? this.charging.get(r.id)!.goal ?? null : undefined),
      moveAllowed: (r, to) => {
        const charge = this.charging.get(r.id)!, task = this.world.tasks.find(t => t.id === r.currentTaskId);
        let allowed = charge.active ? charge.allowsMove(r, to, this.world) : task
          ? executionActiveTaskAllowed(r, task, to, this.world) : executionIdleMoveAllowed(r, to, this.world);
        if (!allowed && options.traffic?.deadlockRecovery && (this.stillTicks.get(r.id) ?? 0) >= FleetRuntime.LIMP_AFTER_TICKS)
          allowed = this.limpAllowed(r, to);
        const groupedBudget = options.allocationMode !== "event-grouped" || charge.active || !task || bundleExecutionAllowed(r,to,this.world);
        if(options.groupedQueueRecharge && options.allocationMode === "event-grouped" && !charge.active && task && task.status !== "in_progress" && (!allowed || !groupedBudget)) this.groupedEnergyBlocked.add(r.id);
        if (!allowed && options.traffic?.deadlockRecovery && !charge.active && task) this.energyRefused.add(r.id);
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
  /**
   * Limp mode. A robot boxed in at the bottom of its battery could not afford
   * the one side-step that would let its neighbours pass, so it never moved and
   * neither did they. Once it has been stuck LIMP_AFTER_TICKS it may spend its
   * reserve down to LIMP_FLOOR_PERCENT, as long as a charger is still reachable
   * on top of that floor. Safety is unchanged: the sensor and the motion commit
   * still decide whether the cell is free.
   */
  private limpAllowed(r: RobotState, to: Position) {
    if (r.status === "failed" || Math.abs(to.x - r.position.x) + Math.abs(to.y - r.position.y) !== 1) return false;
    const map = this.world.map, cell = map.cells[to.y * map.width + to.x];
    if (!cell || cell.blocked) return false;
    const left = r.battery - BATTERY_PERCENT_PER_CELL - FleetRuntime.LIMP_FLOOR_PERCENT;
    return left >= 0 && CHARGING_STATIONS.some(s => {
      const route = planPath(to, s.position, this.world);
      return route.found && route.distance * BATTERY_PERCENT_PER_CELL <= left;
    });
  }
  /** Peers one robot has heard from recently: where they are and where their route ends. */
  private heardPeers(id: string) {
    const tick = this.world.tick;
    return [...this.peers.get(id)!.heard].filter(([peer, h]) => peer !== id && tick - h.tick <= PEER_TIMEOUT_TICKS)
      .map(([, h]) => ({ position: h.position, end: h.path.at(-1) ?? h.position }));
  }
  /** Holding cells chosen for the station etiquette, sticky per robot. */
  private holding = new Map<string, Position>();
  private static readonly STATIONS = new Set([...CHARGING_STATIONS, ...PICKUP_STATIONS, ...DROPOFF_STATIONS]
    .map(s => `${s.position.x},${s.position.y}`));
  /** Waiting before a busy charger closer than this blocks its only way out. */
  private static readonly CHARGER_HOLD_DISTANCE = 3;

  /**
   * Station etiquette (opt-in): two rules that broke the dense-fleet deadlock.
   *
   * Measured at twenty robots: once a robot reached the recharge target it went
   * idle and stayed parked ON the charger, while robots at 16-18% queued beside
   * it; and charger C2 sits at a dead end, so a robot waiting in its only
   * approach and the robot charging inside blocked each other permanently, with
   * the queue backing up the corridor behind them. The whole fleet froze.
   *
   * 1. A robot with no work that stands on a station moves to a free passing-bay
   *    cell, so chargers, pickups and dropoffs are never used as parking.
   * 2. A robot heading to a charger it knows is occupied waits in a free bay once
   *    it is within CHARGER_HOLD_DISTANCE, instead of in the approach.
   *
   * Occupancy comes only from this robot's own received heartbeats; there is no
   * global reservation. Returns undefined when neither rule applies.
   */
  private stationGoal(r: RobotState): Position | null | undefined {
    if (!this.options.traffic?.stationEtiquette || this.dead.has(r.id)) return undefined;
    const charge = this.charging.get(r.id)!, state = charge.state;
    const eq = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
    const peers = this.heardPeers(r.id);
    if (charge.active) {
      const station = state.goal;
      const busy = !!station && state.mode === "transit" && peers.some(p => eq(p.position, station));
      if (!busy || Math.abs(r.position.x - station.x) + Math.abs(r.position.y - station.y) > FleetRuntime.CHARGER_HOLD_DISTANCE) {
        this.holding.delete(r.id);
        return undefined;
      }
      return this.holdingCell(r, peers) ?? null;
    }
    const free = !r.currentTaskId && !r.queuedTaskIds?.length;
    if (!free) { this.holding.delete(r.id); return undefined; }
    const held = this.holding.get(r.id);
    if (held && eq(held, r.position)) { this.holding.delete(r.id); return undefined; }
    if (held) return held;
    return FleetRuntime.STATIONS.has(`${r.position.x},${r.position.y}`) ? this.holdingCell(r, peers) : undefined;
  }

  /** Nearest reachable passing-bay cell nobody is known to be in or heading to. */
  private holdingCell(r: RobotState, peers: { position: Position; end: Position }[]): Position | undefined {
    const sticky = this.holding.get(r.id);
    if (sticky) return sticky;
    const taken = new Set(peers.flatMap(p => [`${p.position.x},${p.position.y}`, `${p.end.x},${p.end.y}`]));
    const options = [...WAITING_ZONE_CELLS].filter(k => !taken.has(k)).map(k => {
      const [x, y] = k.split(",").map(Number);
      return { x, y, d: Math.abs(x - r.position.x) + Math.abs(y - r.position.y) };
    }).sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
    for (const cell of options.slice(0, 4)) {
      if (this.world.map.cells[cell.y * this.world.map.width + cell.x]?.blocked) continue;
      if (!planPath(r.position, cell, this.world).found) continue;
      const at = { x: cell.x, y: cell.y };
      this.holding.set(r.id, at);
      return at;
    }
    return undefined;
  }

  /**
   * Charger load as one robot knows it: peers it has heard from recently whose
   * reported position, or the end of whose reported route, is that station.
   * Built from that robot's own received heartbeats, never from the world state.
   */
  private stationLoad(id: string, tick: number) {
    const heard = [...this.peers.get(id)!.heard].filter(([peer, h]) => peer !== id && tick - h.tick <= PEER_TIMEOUT_TICKS);
    return (station: Position) => heard.filter(([, h]) => {
      const end = h.path.at(-1) ?? h.position;
      return (h.position.x === station.x && h.position.y === station.y) || (end.x === station.x && end.y === station.y);
    }).length;
  }
  /**
   * A dead-end station (one open neighbour) is taken, as one robot knows it,
   * when a peer it has recently heard stands on it, or is routing to it from
   * closer (lower id on a tie). Distance first: a robot already in the approach
   * must never give the station up to one further back, or it is left facing
   * that robot head-on in the only lane. Ties break the same way on every
   * robot, so two robots never both give it up or both keep it.
   */
  private stationTaken(id: string, tick: number) {
    const map = this.world.map;
    const open = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && !map.cells[y * map.width + x].blocked;
    const heard = [...this.peers.get(id)!.heard].filter(([peer, h]) => peer !== id && !this.dead.has(peer) && tick - h.tick <= PEER_TIMEOUT_TICKS);
    const self = this.world.robots.find(r => r.id === id)!.position;
    const dist = (a: Position, b: Position) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    return (s: Position) => {
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => open(s.x + dx, s.y + dy)).length > 1) return false;
      const mine = dist(self, s);
      return heard.some(([peer, h]) => {
        const end = h.path.at(-1) ?? h.position, theirs = dist(h.position, s);
        return theirs === 0 || (end.x === s.x && end.y === s.y && (theirs < mine || theirs === mine && peer < id));
      });
    };
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
    if (command.kind === "recover") {
      const r = this.world.robots.find(r => r.id === command.robotId);
      if (!r) throw new Error("Unknown robot");
      if (!this.dead.has(r.id)) throw new Error("Robot is not failed");
      // Resume this peer; its retained ownership/custody record must decide
      // what it may execute. Recovery never relocates the physical body or
      // turns a carried delivery into a new auction candidate.
      this.dead.delete(r.id);
      r.status = r.currentTaskId ? "waiting" : "idle";
      this.fleet.setInactive(r.id, false);
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
      const streak = this.energyRefused.has(r.id) ? (this.energyRefusedStreak.get(r.id) ?? 0) + 1 : 0;
      // Only ever non-zero with deadlock recovery on (energyRefused stays empty otherwise).
      this.energyRefusedStreak.set(r.id, streak); this.energyRefused.delete(r.id);
      const commitmentsAffordable = streak < FleetRuntime.ENERGY_REFUSAL_TICKS && (!queueRecharge || !this.groupedEnergyBlocked.has(r.id) && bundleExecutionAllowed(r,r.position,this.world)) &&
        (bidRechargeTarget === undefined || r.battery >= bidRechargeTarget);
      this.groupedEnergyBlocked.delete(r.id);
      const traffic = this.options.traffic;
      const charge = this.charging.get(r.id)!.prepare(r, this.world, tick, commitmentsAffordable, traffic && {
        stationLoad: traffic.loadAwareCharging ? this.stationLoad(r.id, tick) : undefined,
        stationTaken: traffic.stationEtiquette ? this.stationTaken(r.id, tick) : undefined,
        marginPercent: traffic.chargeMarginPercent, cargoTopUp: traffic.deadlockRecovery,
        strandedFloorPercent: traffic.deadlockRecovery ? FleetRuntime.LIMP_FLOOR_PERCENT : undefined });
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
      this.stillTicks.set(r.id, moved || path.length < 2 ? 0 : (this.stillTicks.get(r.id) ?? 0) + 1);
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
