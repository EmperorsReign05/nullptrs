import { groupIdentity, orderGroup, taskGroups, selectGroup, type GroupBid, type GroupAssignment } from "../auction/grouped";
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
export type Ownership = { taskId: string; generation: number; owner: string; expires: number; bundleId?: string };
type Marker = { owner: string; generation: number; phase: "custody" | "completed" };
type GroupProposal = { groupId: string; generation: number; taskIds: string[]; bids: GroupBid[]; assignments: GroupAssignment[] };
type Proposal = Ownership & { bids: LocalBidPacket[] };
export type OwnershipMessage = { from: string; tick: number } & (
  | { kind: "heartbeat"; position: Position; path: Position[] }
  | { kind: "announce"; task: Task }
  | { kind: "group-bid"; bid: GroupBid }
  | { kind: "group-propose"; proposal: GroupProposal }
  | { kind: "bid"; generation: number; packet: LocalBidPacket }
  | { kind: "propose"; proposal: Proposal }
  | { kind: "grant"; lease: Ownership }
  | { kind: "mark"; lease: Ownership; phase: Marker["phase"] }
  | { kind: "ack"; lease: Ownership; phase: Marker["phase"] }
  | { kind: "checkpoint"; taskId: string; generation: number; owner: string; phase: Marker["phase"]; witnesses: string[] }
);
const same = (a: Ownership, b: Ownership) => a.taskId === b.taskId && a.generation === b.generation && a.owner === b.owner && a.expires === b.expires && a.bundleId === b.bundleId;
export class OwnershipPeer {
  /** Passive first-observation timestamps in protocol tick coordinates. */
  readonly latency = new Map<string, Partial<Record<"firstAnnouncementTick" | "firstAuctionEligibleTick" | "firstBidTick" | "quorumBidTick" | "proposalTick" | "firstGrantTick" | "certificateTick", number>>>();
  private observe(taskId: string, stage: keyof NonNullable<ReturnType<typeof this.latency.get>>) {
    const trace = this.latency.get(taskId) ?? {};
    if (trace[stage] === undefined) trace[stage] = this.now;
    this.latency.set(taskId, trace);
  }
  readonly tasks = new Map<string, Task>();
  readonly heard = new Map<string, { tick: number; position: Position; path: Position[] }>();
  readonly metrics = { bids: 0, mlCorrections: 0, winnerChanges: 0, suppressed: 0, grants: 0, stale: 0 };
  /** Outbound ownership message volume by kind; used to scale-test transport. */
  readonly sentByKind: Record<string, number> = { heartbeat: 0, announce: 0, bid: 0, propose: 0, grant: 0, mark: 0, ack: 0, checkpoint: 0 };
  readonly certifiedBundles=new Map<string,{owner:string;taskIds:string[];size:number}>();
  readonly groupAttempts=new Map<string,Set<string>>();
  readonly groupMetrics = { proposals: 0, bids: 0, rejected: 0, refreshes: 0, bundleSizes: [] as number[], groupSizes: [] as number[] };
  private groupBids = new Map<string, Map<string, GroupBid>>();
  private groupSent = new Map<string, string>();
  private groupProposed = new Map<string, string>();
  private bundlePlans = new Map<string, GroupAssignment>();
  private reservationGenerations = new Map<string,number>();
  private reservations = new Map<string, string[]>();
  private queueOwners = new Map<string,string>();
  private nextQueueOrder=0;
  private queueOrder = new Map<string, number>();
  certifiedOrder(taskId: string) { return this.queueOrder.get(taskId) ?? Number.MAX_SAFE_INTEGER; }
  private votes = new Map<string, Ownership>();
  private grants = new Map<string, Map<string, Ownership>>();
  private bids = new Map<string, Map<string, LocalBidPacket>>();
  private markers = new Map<string, Marker>();
  private acks = new Map<string, Set<string>>();
  private checkpoints = new Map<string, Extract<OwnershipMessage, { kind: "checkpoint" }>>();
  private requested = new Map<string, { lease: Ownership; phase: Marker["phase"] }>();
  /** Diagnostic view of this tick's admission frontier; not read by the protocol. */
  private candidateTaskIds = new Set<string>();
  /** Newest tick observed on the network; the clock liveness is measured against. */
  private progressWatermark = -1;
  /** Whether the current drain carried any genuine peer message. */
  private sawPeerNews = false;
  /** Bid-set size behind our last proposal per (generation,task); bounds retries. */
  private proposedWith = new Map<string, number>();
  /** Last mark emitted per task, so an unacknowledged mark is not resent every tick. */
  private lastMarked = new Map<string, { lease: Ownership; phase: Marker["phase"]; tick: number }>();
  /** Tick a custody/completion proof was first learned locally, for gossip healing. */
  private checkpointLearnedAt = new Map<string, number>();
  /** Identity of the grant we last re-gossiped per task, to avoid per-tick resends. */
  private lastGrantSent = new Map<string, string>();
  /** Tick at which a task first became known locally, for announce healing. */
  private learnedAt = new Map<string, number>();
  private now = -1;
  /** Effective freshness clock: observed network progress, or our own tick when
   * the transport is entirely silent. Falling back is what keeps a lone dead peer
   * and a total stall detectable while a merely-backlogged peer is not. */
  private get freshness() { return this.progressWatermark >= this.now ? this.now : this.progressWatermark; }
  readonly members: readonly string[];
  readonly quorum: number;
  constructor(readonly id: string, members: readonly string[], private transport: Transport<OwnershipMessage>,
    private computeBid: (task: Task, tick: number) => LocalBidPacket,
    readonly allocationMode: "epoch" | "event-single" | "event-grouped" = "epoch",
    private computeGroupBid?: (tasks: Task[], tick: number) => GroupBid) {
    if (allocationMode === "event-grouped" && !computeGroupBid) throw new Error("Grouped mode needs local bundle bids");
    this.members = [...new Set(members)].sort();
    if (this.members.length !== members.length || !this.members.includes(id)) throw new Error("Invalid membership");
    this.quorum = Math.floor(members.length / 2) + 1;
  }
  /** How many previously-unowned tasks may be auctioned in one generation.
   * The protocol used to admit exactly one, capping fleet throughput at one task
   * per 32 ticks no matter how large the fleet was. The bound still has to stop a
   * peer spending all of its queue and energy headroom at once, so it scales with
   * the number of robots that could plausibly be idle. At N=1/2/3 this evaluates
   * to 1, leaving the small-fleet protocol bit-for-bit unchanged. */
  private admissionFrontier() { return Math.max(1, Math.floor(this.members.length / 2)); }
  private key(taskId: string, generation: number) { return `${generation}:${taskId}`; }
  private ackKey(lease: Ownership, phase: Marker["phase"]) { return `${this.key(lease.taskId, lease.generation)}:${lease.owner}:${phase}`; }
  private send(message: OwnershipMessage) {
    this.sentByKind[message.kind] = (this.sentByKind[message.kind] ?? 0) + 1;
    if (message.kind === "announce") this.observe(message.task.id, "firstAnnouncementTick");
    if (message.kind === "propose") this.observe(message.proposal.taskId, "proposalTick");
    this.transport.send(undefined, message);
    this.receive(message);
  }
  announce(task: Task) {
    const old = this.tasks.get(task.id);
    if (old && JSON.stringify(old) !== JSON.stringify(task)) throw new Error("Task id is immutable");
    if (!this.tasks.has(task.id)) this.learnedAt.set(task.id, this.now);
    this.tasks.set(task.id, structuredClone(task));
  }
  private validLease(l: Ownership) {
    return this.tasks.has(l.taskId) && this.members.includes(l.owner) && Number.isInteger(l.generation) &&
      l.generation === Math.floor(this.now / OWNERSHIP_EPOCH_TICKS) && l.expires === (l.generation + 1) * OWNERSHIP_EPOCH_TICKS && this.now < l.expires;
  }
  private receive(m: OwnershipMessage) {
    if (!this.members.includes(m.from) || !Number.isInteger(m.tick) || m.tick > this.now || m.tick < 0) return;
    // Freshness watermark: the newest tick this peer has actually observed on the
    // network. Liveness is judged against this rather than against our own tick
    // counter. Our counter is driven by the host and runs ahead of real fleet
    // progress whenever delivery is backed up, so comparing against it declares
    // healthy peers dead purely because their heartbeats are in flight.
    // Self-delivery is synchronous and says nothing about the transport, so only
    // genuine peer observations move this.
    if (m.from !== this.id) {
      this.sawPeerNews = true;
      if (m.tick > this.progressWatermark) this.progressWatermark = m.tick;
    }
    if (m.kind === "heartbeat") {
      const old = this.heard.get(m.from);
      if (!old || m.tick > old.tick) this.heard.set(m.from, { tick: m.tick, position: m.position, path: m.path });
      return;
    }
    if (m.kind === "announce") {
      if (!this.tasks.has(m.task.id)) { this.learnedAt.set(m.task.id, this.now); this.tasks.set(m.task.id, structuredClone(m.task)); }
      return;
    }
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
    if (m.kind === "group-bid" || m.kind === "group-propose") {
      if (this.allocationMode === "event-grouped") this.receiveGroup(m);
      return;
    }
    const generation = m.kind === "bid" ? m.generation : m.kind === "propose" ? m.proposal.generation : m.lease.generation;
    if (generation !== Math.floor(this.now / OWNERSHIP_EPOCH_TICKS)) { this.metrics.stale++; return; }
    if (m.kind === "bid") {
      if (m.packet.robotId !== m.from || !this.tasks.has(m.packet.taskId) || (this.allocationMode === "epoch" && m.tick % OWNERSHIP_EPOCH_TICKS >= BID_WINDOW)) return;
      const key = this.key(m.packet.taskId, generation);
      const bids = this.bids.get(key) ?? new Map();
      if (!bids.has(m.from)) bids.set(m.from, structuredClone(m.packet));
      this.observe(m.packet.taskId, "firstBidTick");
      if (bids.size >= this.quorum) this.observe(m.packet.taskId, "quorumBidTick");
      this.bids.set(key, bids); return;
    }
    if (m.kind === "propose") {
      const p = m.proposal, key = this.key(p.taskId, generation);
      if (this.allocationMode === "event-grouped" && (!this.previousOwner(p.taskId)||p.owner!==this.previousOwner(p.taskId))) return;
      if (!this.validLease(p) || (this.allocationMode === "epoch" && this.now % OWNERSHIP_EPOCH_TICKS < BID_WINDOW)) return;
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
      this.observe(p.taskId, "proposalTick");
      if (!previous) this.metrics.grants++;
      this.votes.set(key, { taskId: p.taskId, owner: p.owner, generation, expires: p.expires });
      this.send({ from: this.id, tick: this.now, kind: "grant", lease: this.votes.get(key)! });
      return;
    }
    if (!this.validLease(m.lease)) return;
    if (m.kind === "grant") {
      const key = this.key(m.lease.taskId, generation), grants = this.grants.get(key) ?? new Map();
      if (!grants.has(m.from)) grants.set(m.from, m.lease);
      this.observe(m.lease.taskId, "firstGrantTick");
      this.grants.set(key, grants);
      if (this.ownership(m.lease.taskId)) this.observe(m.lease.taskId, "certificateTick");
      if(m.lease.bundleId && this.bundleCertified(m.lease)) {
        const plan=this.bundlePlans.get(m.lease.bundleId)!;
        if(!this.certifiedBundles.has(m.lease.bundleId)) {
          for(const id of plan.taskIds) {
            if(this.queueOwners.get(id)!==plan.owner) {
              this.queueOwners.set(id,plan.owner);this.queueOrder.set(id,this.nextQueueOrder++);
            }
          }
        }
        this.certifiedBundles.set(m.lease.bundleId,{...plan,size:plan.taskIds.length});
        for(const id of plan.taskIds)this.observe(id,"certificateTick");
      }
      return;
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

  private receiveGroup(m: Extract<OwnershipMessage, {kind: "group-bid" | "group-propose"}>) {
    const body = m.kind === "group-bid" ? m.bid : m.proposal;
    const generation = Math.floor(this.now / OWNERSHIP_EPOCH_TICKS);
    if (body.generation !== generation) { this.metrics.stale++; return; }
    const tasks = body.taskIds.map(id=>this.tasks.get(id));
    if (!tasks.length || tasks.length > 4 || tasks.some(t=>!t) || new Set(body.taskIds).size !== tasks.length ||
      body.groupId !== groupIdentity(generation,tasks as Task[]) || JSON.stringify(body.taskIds)!==JSON.stringify(orderGroup(tasks as Task[]).map(t=>t.id))) return;
    if (m.kind === "group-bid") {
      if (m.bid.robotId !== m.from || m.bid.tick !== m.tick) return;
      try { selectGroup([m.bid]); } catch { return; }
      const held=this.groupBids.get(body.groupId)??new Map<string,GroupBid>();
      if ((held.get(m.from)?.tick??-1) >= m.bid.tick) return;
      held.set(m.from,structuredClone(m.bid)); this.groupBids.set(body.groupId,held);
      for (const id of body.taskIds) { this.observe(id,"firstBidTick"); if(held.size>=this.quorum)this.observe(id,"quorumBidTick"); }
      return;
    }
    const p=m.proposal;
    if(p.bids.length<this.quorum || p.bids.some(b=>!this.members.includes(b.robotId)||b.tick>m.tick||b.generation!==generation||b.groupId!==p.groupId||JSON.stringify(b.taskIds)!==JSON.stringify(p.taskIds))) return;
    let result:GroupAssignment[];
    try { result=selectGroup(p.bids); } catch { return; }
    if(!result.length || JSON.stringify(result)!==JSON.stringify(p.assignments)) return;
    const bundleId=JSON.stringify([p.groupId,result]);
    const leases=result.flatMap(a=>a.taskIds.map(taskId=>({taskId,generation,owner:a.owner,expires:(generation+1)*OWNERSHIP_EPOCH_TICKS,bundleId:bundleId+":"+a.owner})));
    if(leases.every(lease=>{const vote=this.votes.get(this.key(lease.taskId,generation));return vote&&same(vote,lease);})) return;
    for(const lease of leases) {
      const prior=this.votes.get(this.key(lease.taskId,generation));
      if(this.completed(lease.taskId)||this.markers.has(lease.taskId)||(prior&&!same(prior,lease))||(this.previousOwner(lease.taskId)&&this.isLive(this.previousOwner(lease.taskId)!))) { this.groupMetrics.rejected++; return; }
    }
    for(const assignment of result) {
      const bid=p.bids.find(b=>b.robotId===assignment.owner)!;
      const reserved=(this.reservations.get(assignment.owner)??[]).filter(id=>this.reservationActive(assignment.owner,id));
      if(reserved.some(id=>!bid.commitmentIds.includes(id)&&!assignment.taskIds.includes(id))) {this.groupMetrics.rejected++;return;}
      if(assignment.owner===this.id) {
        const fresh=this.computeGroupBid!(tasks as Task[],this.now);
        if(!fresh.offers.some(o=>JSON.stringify(o.taskIds)===JSON.stringify(assignment.taskIds))) {this.groupMetrics.rejected++;this.groupSent.delete(p.groupId);return;}
      }
    }
    // Install every reservation and vote before sending any grant. Reordering
    // deliveries cannot expose an unreserved partial plan.
    for(const assignment of result) {
      this.bundlePlans.set(bundleId+":"+assignment.owner,assignment);
      this.reservations.set(assignment.owner,[...new Set([...(this.reservations.get(assignment.owner)??[]).filter(id=>this.reservationActive(assignment.owner,id)),...assignment.taskIds])]);
      for(const id of assignment.taskIds)this.reservationGenerations.set(assignment.owner+":"+id,generation);
    }
    for(const lease of leases) {
      const plan=result.find(a=>a.owner===lease.owner)!;
      const perRobot={...lease,bundleId:bundleId+":"+lease.owner};
      this.bundlePlans.set(perRobot.bundleId,plan);
      const key=this.key(lease.taskId,generation);
      // Identity includes robot suffix in both stored votes and transmitted grants.
      this.votes.set(key,perRobot); this.metrics.grants++;
      this.observe(lease.taskId,"proposalTick");
    }
    for(const lease of leases) this.send({kind:"grant",from:this.id,tick:this.now,lease:this.votes.get(this.key(lease.taskId,generation))!});
  }
  private tickGroups() {
    const generation=Math.floor(this.now/OWNERSHIP_EPOCH_TICKS);
    const pending=[...this.tasks.values()].filter(t=>!this.completed(t.id)&&!this.markers.has(t.id)&&!this.ownership(t.id)&&(!this.previousOwner(t.id)||!this.isLive(this.previousOwner(t.id)!)));
    this.candidateTaskIds=new Set(pending.map(t=>t.id));
    for(const tasks of taskGroups(pending)) {
      const id=groupIdentity(generation,tasks);
      for(const task of tasks)this.observe(task.id,"firstAuctionEligibleTick");
      const packet=this.computeGroupBid!(tasks,this.now);
      const signature=JSON.stringify([packet.commitmentIds,packet.offers.map(o=>o.taskIds)]);
      if(this.groupSent.get(id)!==signature) {
        if(this.groupSent.has(id))this.groupMetrics.refreshes++;
        this.groupSent.set(id,signature);this.groupMetrics.bids++;
        this.send({kind:"group-bid",from:this.id,tick:this.now,bid:packet});
      }
      const bids=[...(this.groupBids.get(id)?.values()??[])].filter(b=>this.isLive(b.robotId)).sort((a,b)=>a.robotId.localeCompare(b.robotId));
      if(bids.length<this.quorum || bids[0].robotId!==this.id)continue;
      const proposalSignature=JSON.stringify(bids.map(b=>[b.robotId,b.tick]));
      if(this.groupProposed.get(id)===proposalSignature)continue;
      this.groupProposed.set(id,proposalSignature);
      const assignments=selectGroup(bids);if(!assignments.length)continue;
      this.groupMetrics.proposals++;this.groupMetrics.groupSizes.push(tasks.length);
      for(const a of assignments)for(const taskId of a.taskIds) {
        const attempts=this.groupAttempts.get(taskId)??new Set<string>();attempts.add(id+":"+proposalSignature);this.groupAttempts.set(taskId,attempts);
      }
      this.groupMetrics.bundleSizes.push(...assignments.map(a=>a.taskIds.length));
      for(const a of assignments)for(const taskId of a.taskIds)this.observe(taskId,"proposalTick");
      this.send({kind:"group-propose",from:this.id,tick:this.now,proposal:{groupId:id,generation,taskIds:tasks.map(t=>t.id),bids,assignments}});
    }
  }
  private reservationActive(owner:string, taskId:string) {
    if(this.completed(taskId))return false;
    const held=this.ownership(taskId);
    if(held&&held.owner!==owner)return false;
    const generation=this.reservationGenerations.get(owner+":"+taskId);
    if(generation!==undefined&&generation<Math.floor(this.now/OWNERSHIP_EPOCH_TICKS)&&!this.markers.has(taskId)) {
      const vote=this.votes.get(this.key(taskId,generation)),grants=this.grants.get(this.key(taskId,generation));
      // An uncertified, expired reservation cannot ever execute. Retain known
      // certified commitments until completion/transfer; custody never expires.
      if(!vote||!grants||[...grants.values()].filter(g=>same(g,vote)).length<this.quorum||!this.bundleCertified(vote))return false;
    }
    return true;
  }
  private bundleCertified(candidate: Ownership) {
    if(!candidate.bundleId)return true;
    const plan=this.bundlePlans.get(candidate.bundleId);
    if(!plan||plan.owner!==candidate.owner||!plan.taskIds.includes(candidate.taskId))return false;
    return plan.taskIds.every(id=>{
      const grants=this.grants.get(this.key(id,candidate.generation)),lease={...candidate,taskId:id};
      const ownerVote=grants?.get(candidate.owner);
      return grants && ownerVote && same(ownerVote,lease) && [...grants.values()].filter(v=>same(v,lease)).length>=this.quorum;
    });
  }
  private previousOwner(taskId: string) {
    const marker = this.markers.get(taskId);
    if (marker) return marker.owner;
    const prior = this.grants.get(this.key(taskId, Math.floor(this.now / OWNERSHIP_EPOCH_TICKS) - 1));
    if (!prior) return undefined;
    for (const candidate of prior.values()) if ([...prior.values()].filter(g => same(g, candidate)).length >= this.quorum && this.bundleCertified(candidate)) return candidate.owner;
  }
  isLive(id: string) { return id === this.id || this.freshness - (this.heard.get(id)?.tick ?? -Infinity) <= PEER_TIMEOUT_TICKS; }
  /** Opt-in scale instrumentation. Reads only; never consulted by the protocol,
   * so enabling it cannot change ownership behaviour. */
  diagnostics() {
    const generation = Math.floor(this.now / OWNERSHIP_EPOCH_TICKS);
    const heard: Record<string, { tick: number | null; age: number | null; live: boolean }> = {};
    for (const id of this.members) {
      if (id === this.id) { heard[id] = { tick: this.now, age: 0, live: true }; continue; }
      const tick = this.heard.get(id)?.tick ?? null;
      heard[id] = { tick, age: tick === null ? null : this.now - tick, live: this.isLive(id) };
    }
    const liveMembers = this.members.filter((id) => this.isLive(id));
    const auctions: Record<string, unknown> = {};
    for (const task of this.tasks.values()) {
      const key = this.key(task.id, generation);
      const held = [...(this.bids.get(key)?.values() ?? [])];
      const groupedHeld=this.allocationMode==="event-grouped" ? Math.max(0,...[...this.groupBids.values()].filter(b=>[...b.values()].some(v=>v.generation===generation&&v.taskIds.includes(task.id))).map(b=>b.size)) : 0;
      const lease = this.ownership(task.id);
      auctions[task.id] = {
        bidsHeld: Math.max(held.length,groupedHeld),
        bidsLive: held.filter((b) => this.isLive(b.robotId)).length,
        isCandidate: this.candidateTaskIds.has(task.id),
        hasPreviousOwner: this.previousOwner(task.id) !== undefined,
        previousOwner: this.previousOwner(task.id) ?? null,
        lease: lease ? { owner: lease.owner, generation: lease.generation, expires: lease.expires } : null,
        grantVotes: this.grants.get(key)?.size ?? 0,
        certificateReached: lease !== undefined,
      };
    }
    return {
      now: this.now, generation, phase: this.now % OWNERSHIP_EPOCH_TICKS,
      quorum: this.quorum, memberCount: this.members.length,
      liveMembers, liveCount: liveMembers.length,
      quorumReachable: liveMembers.length >= this.quorum,
      heard, metrics: { ...this.metrics },
      freshness: this.freshness, progressWatermark: this.progressWatermark, admissionFrontier: this.admissionFrontier(),
      sentByKind: { ...this.sentByKind },
      taskCount: this.tasks.size, auctions,
    };
  }
  ownership(taskId: string): Ownership | undefined {
    const gs = this.grants.get(this.key(taskId, Math.floor(this.now / OWNERSHIP_EPOCH_TICKS)));
    if (!gs) return;
    for (const candidate of gs.values()) if (this.validLease(candidate) && [...gs.values()].filter(g => same(g, candidate)).length >= this.quorum) {
      if (!this.bundleCertified(candidate)) continue;
      return candidate;
    }
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
    this.sawPeerNews = false;
    for (const m of this.transport.drain()) this.receive(m);
    // If the transport produced no peer news at all this tick, there is no
    // evidence of anyone being behind, so fall back to our own tick. This is what
    // keeps a lone dead peer and a total stall detectable; a merely delayed
    // transport still supplies peer news and is therefore not mistaken for death.
    if (!this.sawPeerNews) this.progressWatermark = this.now;
    this.send({ from: this.id, tick, kind: "heartbeat", position, path });
    const generation = Math.floor(tick / OWNERSHIP_EPOCH_TICKS), phase = tick % OWNERSHIP_EPOCH_TICKS;
    // New assignments per generation are capped by admissionFrontier(), so several
    // independent tasks can be auctioned at once without letting one peer spend all
    // of its queue/energy headroom. Existing leases can all renew; fresh admission
    // observes previous work.
    const candidates = new Set([...this.tasks.values()]
      .filter(t => !this.completed(t.id) && !this.previousOwner(t.id))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, this.admissionFrontier()).map(t => t.id));
    this.candidateTaskIds = candidates;
    const healing = tick % OWNERSHIP_EPOCH_TICKS === 0;
    for (const task of this.tasks.values()) {
      // Re-announcing an immutable task on every tick is pure waste: a receiver
      // ignores an announce it already holds, and per-tick fan-out is
      // O(N^2 x tasks). Push on first knowledge, then re-heal once per generation,
      // which bounds loss-repair latency without a broadcast storm.
      if (tick - (this.learnedAt.get(task.id) ?? tick) < OWNERSHIP_EPOCH_TICKS || healing) {
        this.send({ from: this.id, tick, kind: "announce", task });
      }
      const request = this.requested.get(task.id), lease = this.ownership(task.id);
      if (request && lease?.owner === this.id) {
        request.lease = lease;
        // Marking is idempotent once a quorum has acknowledged, so repeating it
        // every tick only adds traffic. Re-mark on a change of lease or phase,
        // otherwise heal on the generation boundary.
        const prior = this.lastMarked.get(task.id);
        if (!prior || prior.lease !== lease || prior.phase !== request.phase ||
            tick - prior.tick >= OWNERSHIP_EPOCH_TICKS || healing) {
          this.lastMarked.set(task.id, { lease, phase: request.phase, tick });
          this.send({ from: this.id, tick, kind: "mark", lease, phase: request.phase });
        }
      }
      const checkpoint = this.checkpoints.get(task.id);
      // Same reasoning for custody/completion proofs: gossip them on arrival and
      // heal periodically, not once per tick per completed task.
      const learned = this.checkpointLearnedAt.get(task.id);
      if (checkpoint && (learned === undefined || tick - learned < OWNERSHIP_EPOCH_TICKS || healing)) {
        this.checkpointLearnedAt.set(task.id, learned ?? tick);
        this.send({ ...checkpoint, from: this.id, tick });
      }
      if (this.completed(task.id) || !this.previousOwner(task.id) && !candidates.has(task.id)) continue;
      if (this.allocationMode === "event-grouped" && (!this.previousOwner(task.id)||(!this.isLive(this.previousOwner(task.id)!)&&!this.markers.has(task.id)))) continue;
      this.observe(task.id, "firstAuctionEligibleTick");
      const key = this.key(task.id, generation);
      const vote = this.votes.get(key);
      // Re-gossip our own grant only when it is new, or heal on the generation
      // boundary. Quorum is reached from one round, so a per-tick resend is pure
      // traffic that scales with the number of owned tasks.
      if (vote && (this.lastGrantSent.get(task.id) !== `${generation}:${vote.owner}:${vote.expires}` || healing)) {
        this.lastGrantSent.set(task.id, `${generation}:${vote.owner}:${vote.expires}`);
        this.send({ from: this.id, tick, kind: "grant", lease: vote });
      }
      if (this.allocationMode !== "epoch" ? !this.bids.get(key)?.has(this.id) : phase === BID_WINDOW - 1) {
        let packet = this.bids.get(key)?.get(this.id);
        if (!packet) { packet = this.computeBid(task, tick); this.metrics.bids++; if (packet.bid && packet.mlCost !== null && packet.mlCost < packet.bid.totalCost) this.metrics.mlCorrections++; }
        this.send({ from: this.id, tick, kind: "bid", generation, packet });
      } else if ((this.allocationMode !== "epoch" || phase >= BID_WINDOW) && !this.ownership(task.id)) {
        const bids = [...(this.bids.get(key)?.values() ?? [])].filter(b => this.isLive(b.robotId));
        if (bids.length < this.quorum) continue;
        const leader = bids.map(b => b.robotId).sort()[0];
        if (leader !== this.id) continue;
        // Propose only when the bid set has actually grown. Re-proposing the same
        // bundle every tick cannot produce a second certificate, and under a slow
        // transport that retry traffic is self-sustaining: it starves the very
        // bids it is waiting for.
        const proposedWith = this.proposedWith.get(key) ?? -1;
        if (bids.length <= proposedWith) continue;
        this.proposedWith.set(key, bids.length);
        const decision = selectLocalBid(bids.map(b => ({ ...b, tick: generation })));
        const previous = this.previousOwner(task.id);
        const owner = previous && this.isLive(previous) ? previous : decision.winner;
        if (!owner) continue;
        if (decision.winner !== decision.deterministicWinner) this.metrics.winnerChanges++;
        if (decision.suppressed) this.metrics.suppressed++;
        this.send({ from: this.id, tick, kind: "propose", proposal: { taskId: task.id, generation, owner, expires: (generation + 1) * OWNERSHIP_EPOCH_TICKS, bids } });
      }

    }
    if (this.allocationMode === "event-grouped") this.tickGroups();
  }
}
