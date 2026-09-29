import type { Position, Task } from "../types";
import type { Transport } from "./transport";
import { selectLocalBid, type LocalBidPacket } from "../ml/bidmodel";

/** Fixed-membership, crash-stop task leases for the shared-clock simulator.
 * Safety assumptions: identical integer tick domain, honest peers, no state
 * loss/restart within an epoch. Not a wall-clock UDP lease implementation.
 * One durable-in-process vote per task/generation + intersecting majorities
 * prevents overlapping certificates. Execution ALWAYS checks local expiry.
 * Minority partitions stop at expiry. Custody is quorum-written BEFORE pickup;
 * any later majority intersects that write and cannot give the load to another
 * owner. In-progress crash recovery is manual, never a phantom second pickup.
 */
export const OWNERSHIP_EPOCH_TICKS = 32;
export const BID_WINDOW = 4;
export const PEER_TIMEOUT_TICKS = 6;
export type Ownership = { taskId: string; generation: number; owner: string; expires: number };
type Marker = { owner: string; generation: number; phase: "custody" | "completed" };
type Proposal = Ownership & { bids: LocalBidPacket[] };
export type OwnershipMessage = { from: string; tick: number } & (
  | { kind: "heartbeat"; position: Position; path: Position[] }
  | { kind: "announce"; task: Task }
  | { kind: "bid"; generation: number; packet: LocalBidPacket }
  | { kind: "propose"; proposal: Proposal }
  | { kind: "grant"; lease: Ownership }
  | { kind: "mark"; lease: Ownership; phase: Marker["phase"] }
  | { kind: "ack"; lease: Ownership; phase: Marker["phase"] }
  | { kind: "checkpoint"; taskId: string; generation: number; owner: string; phase: Marker["phase"]; witnesses: string[] }
);
const same = (a: Ownership, b: Ownership) => a.taskId === b.taskId && a.generation === b.generation && a.owner === b.owner && a.expires === b.expires;
export class OwnershipPeer {
  readonly tasks = new Map<string, Task>();
  readonly heard = new Map<string, { tick: number; position: Position; path: Position[] }>();
  readonly metrics = { bids: 0, mlCorrections: 0, winnerChanges: 0, suppressed: 0, grants: 0, stale: 0 };
  private votes = new Map<string, Ownership>();
  private grants = new Map<string, Map<string, Ownership>>();
  private bids = new Map<string, Map<string, LocalBidPacket>>();
  private markers = new Map<string, Marker>();
  private acks = new Map<string, Set<string>>();
  private checkpoints = new Map<string, Extract<OwnershipMessage, { kind: "checkpoint" }>>();
  private requested = new Map<string, { lease: Ownership; phase: Marker["phase"] }>();
  private now = -1;
  readonly members: readonly string[];
  readonly quorum: number;
  constructor(readonly id: string, members: readonly string[], private transport: Transport<OwnershipMessage>,
    private computeBid: (task: Task, tick: number) => LocalBidPacket) {
    this.members = [...new Set(members)].sort();
    if (this.members.length !== members.length || !this.members.includes(id)) throw new Error("Invalid membership");
    this.quorum = Math.floor(members.length / 2) + 1;
  }
  private key(taskId: string, generation: number) { return `${generation}:${taskId}`; }
  private ackKey(lease: Ownership, phase: Marker["phase"]) { return `${this.key(lease.taskId, lease.generation)}:${lease.owner}:${phase}`; }
  private send(message: OwnershipMessage) { this.transport.send(undefined, message); this.receive(message); }
  announce(task: Task) {
    const old = this.tasks.get(task.id);
    if (old && JSON.stringify(old) !== JSON.stringify(task)) throw new Error("Task id is immutable");
    this.tasks.set(task.id, structuredClone(task));
  }
  private validLease(l: Ownership) {
    return this.tasks.has(l.taskId) && this.members.includes(l.owner) && Number.isInteger(l.generation) &&
      l.generation === Math.floor(this.now / OWNERSHIP_EPOCH_TICKS) && l.expires === (l.generation + 1) * OWNERSHIP_EPOCH_TICKS && this.now < l.expires;
  }
  private receive(m: OwnershipMessage) {
    if (!this.members.includes(m.from) || !Number.isInteger(m.tick) || m.tick > this.now || m.tick < 0) return;
    if (m.kind === "heartbeat") {
      const old = this.heard.get(m.from);
      if (!old || m.tick > old.tick) this.heard.set(m.from, { tick: m.tick, position: m.position, path: m.path });
      return;
    }
    if (m.kind === "announce") { if (!this.tasks.has(m.task.id)) this.tasks.set(m.task.id, structuredClone(m.task)); return; }
    if (m.kind === "checkpoint") {
      if (!this.tasks.has(m.taskId) || !this.members.includes(m.owner) || !Number.isInteger(m.generation) ||
        m.generation < 0 || m.generation > Math.floor(this.now / OWNERSHIP_EPOCH_TICKS) ||
        new Set(m.witnesses).size < this.quorum || m.witnesses.some(id => !this.members.includes(id))) return;
      const old = this.checkpoints.get(m.taskId);
      if (old?.phase === "completed" || old && old.generation > m.generation && m.phase !== "completed") return;
      this.checkpoints.set(m.taskId, m);
      this.markers.set(m.taskId, { owner: m.owner, generation: m.generation, phase: m.phase });
      return;
    }
    const generation = m.kind === "bid" ? m.generation : m.kind === "propose" ? m.proposal.generation : m.lease.generation;
    if (generation !== Math.floor(this.now / OWNERSHIP_EPOCH_TICKS)) { this.metrics.stale++; return; }
    if (m.kind === "bid") {
      if (m.packet.robotId !== m.from || !this.tasks.has(m.packet.taskId) || m.tick % OWNERSHIP_EPOCH_TICKS >= BID_WINDOW) return;
      const key = this.key(m.packet.taskId, generation);
      const bids = this.bids.get(key) ?? new Map();
      if (!bids.has(m.from)) bids.set(m.from, structuredClone(m.packet));
      this.bids.set(key, bids); return;
    }
    if (m.kind === "propose") {
      const p = m.proposal, key = this.key(p.taskId, generation);
      if (!this.validLease(p) || this.now % OWNERSHIP_EPOCH_TICKS < BID_WINDOW) return;
      const marker = this.markers.get(p.taskId);
      if (this.completed(p.taskId) || (marker && marker.owner !== p.owner)) return;
      const previous = this.votes.get(key);
      if (previous && !same(previous, p)) return;
      const distinct = new Set(p.bids.map(b => b.robotId));
      if (distinct.size < this.quorum || distinct.size !== p.bids.length || p.bids.some(b => !this.members.includes(b.robotId) || b.taskId !== p.taskId)) return;
      let decision;
      try { decision = selectLocalBid(p.bids.map(b => ({ ...b, tick: generation }))); } catch { return; }
      // Renewal keeps a live owner; otherwise every grantor recomputes winner
      // from the transmitted bid bundle. Differing bundles may split votes,
      // but cannot produce two majority certificates in one generation.
      const prior = this.previousOwner(p.taskId);
      if (prior && this.isLive(prior)) { if (prior !== p.owner) return; }
      else if (decision.winner !== p.owner) return;
      if (!previous) this.metrics.grants++;
      this.votes.set(key, { taskId: p.taskId, owner: p.owner, generation, expires: p.expires });
      this.send({ from: this.id, tick: this.now, kind: "grant", lease: this.votes.get(key)! });
      return;
    }
    if (!this.validLease(m.lease)) return;
    if (m.kind === "grant") {
      const key = this.key(m.lease.taskId, generation), grants = this.grants.get(key) ?? new Map();
      if (!grants.has(m.from)) grants.set(m.from, m.lease);
      this.grants.set(key, grants); return;
    }
    const held = this.ownership(m.lease.taskId);
    if (!held || !same(held, m.lease)) return;
    if (m.kind === "mark") {
      if (m.from !== held.owner) return;
      const old = this.markers.get(held.taskId);
      if (old && (old.owner !== held.owner || old.phase === "completed" && m.phase !== "completed")) return;
      this.markers.set(held.taskId, { owner: held.owner, generation, phase: m.phase });
      this.send({ from: this.id, tick: this.now, kind: "ack", lease: held, phase: m.phase });
    } else {
      const key = this.ackKey(held, m.phase), acks = this.acks.get(key) ?? new Set();
      acks.add(m.from); this.acks.set(key, acks);
      if (acks.size >= this.quorum) this.receive({ from: this.id, tick: this.now, kind: "checkpoint",
        taskId: held.taskId, generation: held.generation, owner: held.owner, phase: m.phase, witnesses: [...acks] });
    }
  }
  private previousOwner(taskId: string) {
    const marker = this.markers.get(taskId);
    if (marker) return marker.owner;
    const prior = this.grants.get(this.key(taskId, Math.floor(this.now / OWNERSHIP_EPOCH_TICKS) - 1));
    if (!prior) return undefined;
    for (const candidate of prior.values()) if ([...prior.values()].filter(g => same(g, candidate)).length >= this.quorum) return candidate.owner;
  }
  isLive(id: string) { return id === this.id || this.now - (this.heard.get(id)?.tick ?? -Infinity) <= PEER_TIMEOUT_TICKS; }
  ownership(taskId: string): Ownership | undefined {
    const gs = this.grants.get(this.key(taskId, Math.floor(this.now / OWNERSHIP_EPOCH_TICKS)));
    if (!gs) return;
    for (const candidate of gs.values()) if (this.validLease(candidate) && [...gs.values()].filter(g => same(g, candidate)).length >= this.quorum) return candidate;
  }
  mayExecute(taskId: string) { return this.ownership(taskId)?.owner === this.id && !this.completed(taskId); }
  mark(taskId: string, phase: Marker["phase"]) {
    const lease = this.ownership(taskId);
    if (!lease || lease.owner !== this.id) return false;
    if (this.requested.get(taskId)?.phase !== "completed" || phase === "completed") this.requested.set(taskId, { lease, phase });
    return this.acknowledged(taskId, phase);
  }
  acknowledged(taskId: string, phase: Marker["phase"]) {
    const proof = this.checkpoints.get(taskId);
    if (proof?.owner === this.id && (proof.phase === phase || proof.phase === "completed")) return true;
    const lease = this.ownership(taskId);
    return !!lease && (this.acks.get(this.ackKey(lease, phase))?.size ?? 0) >= this.quorum;
  }
  phase(taskId: string) { return this.markers.get(taskId)?.phase; }
  completed(taskId: string) { return this.checkpoints.get(taskId)?.phase === "completed"; }
  recoveryRequired(taskId: string) {
    const marker = this.markers.get(taskId);
    return !!marker && !this.completed(taskId) && !this.isLive(marker.owner);
  }
  tick(tick: number, position: Position, path: Position[]) {
    if (!Number.isInteger(tick) || tick <= this.now) throw new Error("Clock must advance monotonically");
    this.now = tick;
    for (const m of this.transport.drain()) this.receive(m);
    this.send({ from: this.id, tick, kind: "heartbeat", position, path });
    const generation = Math.floor(tick / OWNERSHIP_EPOCH_TICKS), phase = tick % OWNERSHIP_EPOCH_TICKS;
    // At most one NEW assignment per generation. This prevents several
    // simultaneous auctions spending the same robot's queue/energy headroom.
    // Existing leases can all renew; fresh admission observes previous work.
    const candidate = [...this.tasks.values()].filter(t => !this.completed(t.id) && !this.previousOwner(t.id))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]?.id;
    for (const task of this.tasks.values()) {
      this.send({ from: this.id, tick, kind: "announce", task });
      const request = this.requested.get(task.id), lease = this.ownership(task.id);
      if (request && lease?.owner === this.id) {
        request.lease = lease;
        this.send({ from: this.id, tick, kind: "mark", lease, phase: request.phase });
      }
      const checkpoint = this.checkpoints.get(task.id);
      if (checkpoint) this.send({ ...checkpoint, from: this.id, tick });
      if (this.completed(task.id) || !this.previousOwner(task.id) && task.id !== candidate) continue;
      const key = this.key(task.id, generation);
      const vote = this.votes.get(key);
      if (vote) this.send({ from: this.id, tick, kind: "grant", lease: vote });
      if (phase === BID_WINDOW - 1) {
        let packet = this.bids.get(key)?.get(this.id);
        if (!packet) { packet = this.computeBid(task, tick); this.metrics.bids++; if (packet.bid && packet.mlCost !== null && packet.mlCost < packet.bid.totalCost) this.metrics.mlCorrections++; }
        this.send({ from: this.id, tick, kind: "bid", generation, packet });
      } else if (phase >= BID_WINDOW && !this.ownership(task.id)) {
        const bids = [...(this.bids.get(key)?.values() ?? [])].filter(b => this.isLive(b.robotId));
        if (bids.length < this.quorum) continue;
        const leader = bids.map(b => b.robotId).sort()[0];
        if (leader !== this.id) continue;
        const decision = selectLocalBid(bids.map(b => ({ ...b, tick: generation })));
        const previous = this.previousOwner(task.id);
        const owner = previous && this.isLive(previous) ? previous : decision.winner;
        if (!owner) continue;
        if (decision.winner !== decision.deterministicWinner) this.metrics.winnerChanges++;
        if (decision.suppressed) this.metrics.suppressed++;
        this.send({ from: this.id, tick, kind: "propose", proposal: { taskId: task.id, generation, owner, expires: (generation + 1) * OWNERSHIP_EPOCH_TICKS, bids } });
      }

    }
  }
}
