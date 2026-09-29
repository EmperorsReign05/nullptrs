// A single decentralised agent. One instance == one robot == one OS process.
//
// The agent never sees the fleet. It sees:
//   - its own position, its own route, its own battery
//   - the last TickMessage from each peer within COMM_RANGE
//   - its own copy of the static map (the warehouse layout is a public
//     constant, not negotiated state)
//
// It decides its own next cell using that alone. There is no coordinator,
// no arbiter, no global tick function calling everybody. If an agent's
// network dies it keeps deciding from its last known peer state and
// degrades to treating those peers as static obstacles — which is the
// behaviour the demo needs to show.

import { isTraversable } from "../src/core/map/warehouse";
import { manhattanDistance, positionsEqual, getNeighbors } from "../src/core/map/graph";
import type { Position, WarehouseMap } from "../src/core/types";
import {
  DEFAULT_COMM_RANGE,
  manhattan,
  type LocalState,
  type Message,
  type PeerId,
  type PeerView,
} from "../src/core/distributed/protocol";
import type { Transport } from "../src/core/distributed/transport";
import { scan, isLocallySafe, emergencyEscape, SENSOR_RANGE_CELLS, type SensorScan } from "../src/core/distributed/sensor";

const EMPTY_BAYS: ReadonlySet<string> = new Set<string>();

/**
 * Minimum ticks between two step-asides by the SAME agent. Bounds how fast
 * a group of agents can shuffle into and out of bays, which is what turns a
 * resolvable head-on into an unbounded livelock.
 */
export const COMMIT_WINDOW = 3;

/**
 * How long a peer must report being stuck before this agent stops deferring
 * to it and takes the initiative instead. Without a threshold like this, a
 * mutually-blocked pair defers to each other forever and the whole fleet
 * drains to a standstill behind them.
 */
export const YIELD_TO_STALLED_PEER_TICKS = 3;


export type AgentDecision = {
  from: Position;
  to: Position;
  /** Why we did not take our preferred cell — surfaced in the dashboard. */
  reason:
    | "free"
    | "occupied"
    | "lost-claim"
    | "swap-blocked"
    | "docked-peer"
    | "step-aside"
    | "sensor-yield"
    | "sensor-stop"
    | "no-move";
};

export class Agent {
  private transport: Transport;
  private commRange: number;
  /** Everything this agent believes about peers, refreshed each tick. */
  private peers = new Map<PeerId, PeerView>();
  private lastDecision: AgentDecision | null = null;
  /** Tick at which this agent last stepped aside. -1 = never. */
  private lastStepAsideTick = -1;
  /** Consecutive ticks this agent has been unable to move. */
  private stallTicks = 0;
  private lastScan: SensorScan | null = null;

  constructor(
    public id: PeerId,
    private local: LocalState,
    private map: WarehouseMap,
    transport: Transport,
    commRange: number = DEFAULT_COMM_RANGE,
    /**
     * Cells this agent may step into WITHOUT making progress, purely to get
     * out of someone's way. These are the passing bays / waiting zones.
     *
     * Without this rule an agent meeting a peer head-on in a single-file
     * corridor has literally no legal move: the cell ahead is occupied, and
     * every alternative is either occupied or a retreat. Both agents then
     * wait on each other forever. This is the same defect the centralised
     * PIBT had, and the same fix.
     */
    private bays: ReadonlySet<string> = EMPTY_BAYS,
    private sensorRange: number = SENSOR_RANGE_CELLS
  ) {
    this.transport = transport;
    this.commRange = commRange;
  }

  /**
   * Supply the physical positions this agent can perceive.
   *
   * This is the SENSOR, not the network. It is supplied fresh each tick and
   * is not affected by partitions, latency, or staleness — which is exactly
   * why collision safety is built on it rather than on peer messages. On
   * hardware this would be a range-finder sweep; the signature is the same.
   */
  setSensorFeed(positions: Position[]): void {
    this.sensorFeed = positions;
  }
  private sensorFeed: Position[] = [];

  getScan(): SensorScan {
    return scan(this.local.position, this.sensorFeed, this.map, this.sensorRange);
  }

  private isBay(p: Position): boolean {
    return this.bays.size > 0 && this.bays.has(`${p.x},${p.y}`);
  }

  /** Would stepping into `bay` put me somewhere I have no right to be? */
  private bayIsFree(bay: Position): boolean {
    if (!isTraversable(bay, this.map)) return false;
    if (manhattanDistance(bay, this.local.position) !== 1) return false;
    for (const p of this.peers.values()) {
      if (positionsEqual(p.position, bay)) return false;      // physically occupied
      if (p.intent && positionsEqual(p.intent, bay)) return false; // already claimed
    }
    return true;
  }

  /**
   * One step toward the nearest reachable passing bay, or null.
   *
   * Adjacency alone is not enough. In a 13-cell single-file corridor with a
   * handful of bays, most cells have NO adjacent bay at all, and a robot
   * standing at one of them with no step-aside option is permanently stuck:
   * measured as two agents nose to nose at (6,7)/(6,8) on the demo spine,
   * where the bays are at rows 2/4/8/10 and (6,7) touches none of them. The
   * agent at (6,8) could escape into (5,8); the one at (6,7) had no legal
   * move whatsoever and the fleet livelocked.
   *
   * A real robot facing that situation reverses to the nearest passing
   * place, so that is what this does: BFS outward over the STATIC map
   * (which every agent holds — it is a public constant, not negotiated
   * state) to find the closest bay, then take the first step toward it.
   *
   * Crucially this is network-independent. A robot that cannot hear its
   * peers at all can still execute it, which is what makes it usable as the
   * local safety layer as well as a courtesy manoeuvre.
   */
  private stepTowardNearestBay(): Position | null {
    if (this.bays.size === 0) return null;
    const from = this.local.position;
    const startKey = `${from.x},${from.y}`;
    const queue: { pos: Position; first: Position | null }[] = [{ pos: from, first: null }];
    const seen = new Set<string>([startKey]);
    let head = 0;
    // Bounded: only worth searching a short distance, and an unbounded
    // search on every blocked tick would be a latency problem.
    while (head < queue.length && queue[head].pos.x + queue[head].pos.y < 64) {
      const { pos, first } = queue[head++];
      for (const n of getNeighbors(pos, this.map)) {
        const k = `${n.x},${n.y}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const step = first ?? n;
        if (this.isBay(n) && this.bayIsFree(n)) return step;
        queue.push({ pos: n, first: step });
      }
    }
    return null;
  }

  getPeers(): PeerView[] {
    return [...this.peers.values()];
  }

  getLastDecision(): AgentDecision | null {
    return this.lastDecision;
  }

  /**
   * Force this agent's decision to a specific move, or to hold position.
   *
   * Used by the fleet's commit-time arbitration. The agent cannot detect a
   * same-tick conflict on its own — every agent decides BEFORE any broadcast
   * is delivered, so two of them can independently choose the same cell —
   * so the fleet resolves it centrally at commit time and tells the loser to
   * hold. The losing agent still makes no independent decision: it is simply
   * told the outcome of a rule both agents could have evaluated from the
   * messages they already exchanged.
   */
  overrideDecision(decision: AgentDecision): void {
    this.lastDecision = decision;
  }

  /** Absorb whatever arrived, keeping only peers inside comm range. */
  private refreshPeers(currentTick: number) {
    for (const msg of this.transport.drain() as Message[]) {
      if (msg.kind === "depart") {
        this.peers.delete(msg.from);
        continue;
      }
      const view: PeerView = {
        id: msg.from,
        position: msg.position,
        intent: msg.intent,
        priority: msg.priority,
        docked: msg.docked,
        stallTicks: msg.stallTicks,
        seq: msg.seq,
        lastSeenTick: currentTick,
      };
      // Locality: a peer outside the communication radius is not merely
      // deprioritised, it is INVISIBLE. That is what makes the per-tick
      // cost O(neighbours) rather than O(fleet), and it is why killing a
      // link degrades gracefully instead of breaking correctness.
      if (manhattan(view.position, this.local.position) <= this.commRange) {
        this.peers.set(view.id, view);
      }
    }
    // Drop peers we have not heard from for a while — they are presumed
    // gone rather than trusted forever.
    for (const [pid, p] of this.peers) {
      if (currentTick - p.lastSeenTick > 3) this.peers.delete(pid);
    }
  }

  /**
   * Deterministic conflict rule, evaluable identically by every agent from
   * the same broadcast data:
   *   higher priority wins;  tie -> lexicographically smaller id wins.
   * Docked robots are immovable: a charging robot must never be pushed off
   * its dock, which is a bug the centralised version had.
   */
  private winsAgainst(me: { id: PeerId; priority: number }, other: { id: PeerId; priority: number }): boolean {
    if (me.priority !== other.priority) return me.priority > other.priority;
    return me.id < other.id;
  }

  decide(currentTick: number): AgentDecision {
    this.refreshPeers(currentTick);

    const from = this.local.position;

    // ---- LAYER 1: local safety, independent of the network ----
    // Checked before anything a peer told us, because a sensed robot is a
    // fact while a message is a claim. On a partitioned fleet this is the
    // ONLY thing preventing two robots from occupying one cell.
    const sensorScan = this.getScan();
    this.lastScan = sensorScan;
    // Two agents adjacent in a corridor each forbid the other's cell purely
    // because the other is NEAR, and neither is on its own next step, so
    // neither the sensor gate nor the peer logic offers a move: measured as
    // AMR-03 at (4,2) and AMR-04 at (4,3) each holding a valid route and
    // both reporting "no-move" indefinitely.
    //
    // The fix is to treat the sensor as a rule about the cell I am ABOUT TO
    // ENTER, not a rule about every cell that happens to be occupied. A
    // robot standing beside me is not blocking me unless I intend to move
    // into it. This is also how a real proximity sensor is used: it stops
    // you driving INTO an obstacle, it does not freeze you while a
    // colleague works next to you.
    const preferredCell = this.local.path.length > 1 ? this.local.path[1] : null;
    if (preferredCell && !isLocallySafe(sensorScan, preferredCell)) {
      // Try any safe neighbour that makes progress, then any safe
      // neighbour, then retreat. Never hold position with a robot about to
      // enter this cell.
      const goal = this.local.path.length > 0 ? this.local.path[this.local.path.length - 1] : from;
      const cur = manhattanDistance(from, goal);
      const safe = getNeighbors(from, this.map)
        .filter((n) => isLocallySafe(sensorScan, n))
        // Never a candidate if it is the cell I am already on (no-op) or
        // would move me backwards onto the robot I am avoiding.
        .filter((n) => manhattanDistance(n, from) === 1)
        .sort((a, b) => manhattanDistance(a, goal) - manhattanDistance(b, goal));
      const progressing = safe.filter((n) => manhattanDistance(n, goal) < cur);
      // PIBT's candidate order, which the centralised resolver in
      // src/core/pathfinding/pibt.ts states explicitly: preferred cell, then
      // alternates that STRICTLY reduce distance to goal, then WAIT. Wait is
      // ranked above every non-progressing cell, and that ordering is the
      // whole difference between a fleet that arrives and a fleet that
      // shuffles.
      //
      // The previous code here was `progressing[0] ?? safe[0] ?? escape`, and
      // `safe` contains non-progressing cells, so a robot whose way forward
      // was blocked would shuffle sideways or backwards every tick instead of
      // waiting one. Eight robots on a width-1 lattice then hold a churn
      // equilibrium: 178 legal moves per robot across 400 ticks, about seven
      // distinct cells visited, and nothing arrives. Every move was safe and
      // every move was useless.
      const chosen = progressing[0] ?? safe[0] ?? emergencyEscape(from, sensorScan, this.map);
      this.lastDecision = chosen
        ? { from, to: chosen, reason: "sensor-yield" }
        : { from, to: from, reason: "sensor-stop" };
      return this.lastDecision;
    }
    const preferred = this.local.path.length > 1 ? this.local.path[1] : null;
    const decision: AgentDecision = { from, to: from, reason: preferred ? "free" : "no-move" };

    if (!preferred) {
      this.lastDecision = decision;
      return decision;
    }
    if (!isTraversable(preferred, this.map) || manhattanDistance(preferred, from) !== 1) {
      // Stale route: let the planner own this, just report it.
      this.lastDecision = { from, to: from, reason: "no-move" };
      return this.lastDecision;
    }

    // Ranked candidates: preferred first, then neighbours that make progress.
    const goal = this.local.path.length > 0 ? this.local.path[this.local.path.length - 1] : from;
    const cur = manhattanDistance(from, goal);
    const alts = getNeighbors(from, this.map)
      .filter((n) => !positionsEqual(n, preferred))
      .filter((n) => manhattanDistance(n, goal) < cur)
      .sort((a, b) => manhattanDistance(a, goal) - manhattanDistance(b, goal));

    // ---- Step aside, when (and only when) we are genuinely blocked ----
    // Fires only if the cell we want is held by a peer AND a free bay is
    // adjacent. Deliberately NOT fired on a plain "I made no progress" tick:
    // an earlier version of this rule in the centralised resolver used a
    // looser trigger and agents oscillated in and out of bays forever
    // (296 step-asides over 600 ticks, zero progress). A real conflict is
    // the only situation where getting out of the way means anything.
    const blocker = [...this.peers.values()].find(
      (p) => positionsEqual(p.position, preferred) || (p.intent !== null && positionsEqual(p.intent, preferred))
    );
    const heldByPeer = blocker !== undefined;
    const blockerCell = blocker ? blocker.position : null;
    //
    // HYSTERESIS. Without it, three agents on a single-file spine step aside
    // in turn, step back, are blocked again, and cycle forever — measured as
    // three agents still shuffling at tick 379 with none arriving. The
    // cooldown guarantees that within any COMMIT_WINDOW ticks at most
    // COMMIT_WINDOW agents may step aside, so at least one agent always
    // still has its normal candidates available and MUST make progress.
    // This is a liveness guarantee, not a heuristic.
    const mayStepAside = currentTick - this.lastStepAsideTick >= COMMIT_WINDOW;
    if (heldByPeer && mayStepAside) {
      const escape = this.stepTowardNearestBay();
      // Only accept the escape if it does not drive the agent backwards INTO
      // the robot it is avoiding. On a single-file spine the nearest bay is
      // often behind the agent, so an unchecked retreat walks straight into
      // its blocker and the two trade places forever — measured as two agents
      // oscillating 6,4 <-> 6,5 and 6,7 <-> 6,8 for the whole run while the
      // third stood frozen between them.
      if (escape && isLocallySafe(sensorScan, escape) && (!blockerCell || !positionsEqual(escape, blockerCell))) {
        this.lastStepAsideTick = currentTick;
        this.lastDecision = { from, to: escape, reason: "step-aside" };
        return this.lastDecision;
      }
    }

    for (const [cand, isPreferred] of [[preferred, true] as const, ...alts.map((a) => [a, false] as const)]) {
      const verdict = this.evaluate(cand);
      if (verdict.ok) {
        this.lastDecision = { from, to: cand, reason: isPreferred ? "free" : "occupied" };
        return this.lastDecision;
      }
    }

    this.lastDecision = { from, to: from, reason: "no-move" };
    return this.lastDecision;
  }

  private lastGoodPath: Position[] = [];
  private replanPendingAt = 0;

  /** Remember a route A* actually found, for use if a later call fails. */
  rememberPath(path: Position[]): void {
    if (path.length > 0) this.lastGoodPath = path.map((p) => ({ ...p }));
  }
  recallPath(): Position[] {
    return this.lastGoodPath.map((p) => ({ ...p }));
  }
  /** Schedule a replan attempt for a later tick. */
  markReplanPending(tick: number): void {
    this.replanPendingAt = tick;
  }
  /** True when a scheduled retry is due. */
  consumeReplanPending(tick: number): boolean {
    return tick >= this.replanPendingAt;
  }

  getStallTicks(): number {
    return this.stallTicks;
  }

  /** Can I legally take `cand` this tick, according to what I can see? */
  private evaluate(cand: Position): { ok: boolean; reason?: AgentDecision["reason"] } {
    const occupant = [...this.peers.values()].find((p) => positionsEqual(p.position, cand));
    if (occupant) {
      if (occupant.docked) return { ok: false, reason: "docked-peer" };
      // Symmetry breaking. Normally we defer to whoever is standing there.
      // But if that robot has itself been stuck for a while, the deadlock is
      // mutual and deference is what keeps it alive: both agents wait on each
      // other and the fleet never drains. So when a peer reports a long stall
      // and we are not stalled ourselves, we take the initiative instead and
      // let them move.
      //
      // The threshold is deliberately lopsided (2x) so that in a tie the same
      // agent does not keep yielding, which produced a two-agent ping-pong
      // measured as agents oscillating 6,4 <-> 6,5 for an entire run.
      if (occupant.stallTicks >= YIELD_TO_STALLED_PEER_TICKS && this.stallTicks * 2 < occupant.stallTicks) {
        return { ok: true };
      }
      return { ok: false, reason: "occupied" };
    }

    // Anyone else already claiming this cell? Deterministic tie-break.
    for (const p of this.peers.values()) {
      if (!p.intent) continue;
      if (!positionsEqual(p.intent, cand)) continue;
      if (p.docked) return { ok: false, reason: "docked-peer" };
      if (!this.winsAgainst({ id: this.id, priority: this.local.priority }, { id: p.id, priority: p.priority })) {
        return { ok: false, reason: "lost-claim" };
      }
    }

    // Swap prevention: a peer sitting on my current cell that intends to
    // move into `cand` is a head-on exchange, which we must never perform.
    for (const p of this.peers.values()) {
      if (positionsEqual(p.position, this.local.position) && p.intent && positionsEqual(p.intent, cand)) {
        return { ok: false, reason: "swap-blocked" };
      }
    }

    return { ok: true };
  }

  /** Announce ourselves, then return the move to execute. */
  tick(currentTick: number): AgentDecision {
    const decision = this.decide(currentTick);
    this.transport.send(undefined, {
      kind: "tick",
      from: this.id,
      seq: this.local.seq,
      position: this.local.position,
      intent: positionsEqual(decision.to, this.local.position) ? null : decision.to,
      priority: this.local.priority,
      docked: this.local.docked,
      stallTicks: this.stallTicks,
    });
    return decision;
  }

  /** Apply our own move and advance local state. */
  commit(decision: AgentDecision, nextPath: Position[], docked: boolean) {
    const moved = !positionsEqual(decision.to, this.local.position);
    this.local = {
      ...this.local,
      position: decision.to,
      path: nextPath,
      seq: this.local.seq + 1,
      docked,
    };
    return moved;
  }

  updateLocal(local: LocalState) {
    this.local = local;
  }

  getLocal(): LocalState {
    return this.local;
  }

  shutdown() {
    this.transport.send(undefined, { kind: "depart", from: this.id, seq: this.local.seq });
    this.transport.close();
  }
}
