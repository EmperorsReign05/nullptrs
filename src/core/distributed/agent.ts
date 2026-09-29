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

import { isTraversable } from "../map/warehouse";
import { manhattanDistance, positionsEqual, getNeighbors } from "../map/graph";
import type { Position, WarehouseMap } from "../types";
import {
  DEFAULT_COMM_RANGE,
  manhattan,
  type LocalState,
  type Message,
  type PeerId,
  type PeerView,
} from "./protocol";
import type { Transport } from "./transport";
import { scan, isLocallySafe, emergencyEscape, SENSOR_RANGE_CELLS, type SensorScan } from "./sensor";

const EMPTY_BAYS: ReadonlySet<string> = new Set<string>();

// ---- TEMPORARY MEASUREMENT SWITCHES. Remove before committing. ----
const DIST_NO_COLLINEAR_RETREAT = process.env.DIST_NO_COLLINEAR_RETREAT ?? "1";
const DIST_YIELD = process.env.DIST_YIELD ?? "shuffle";

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

/**
 * Consecutive ticks the same physical cell must block my next step before I
 * treat it as a wall for planning. One tick of blockage is ordinary traffic and
 * must not re-plan; a robot standing still in a single-file corridor blocks me
 * on every tick, and that is the case A* cannot see through on its own.
 */
export const PERSISTENT_BLOCK_TICKS = Number(process.env.DIST_PERSIST ?? 2);

/**
 * How long a learned obstruction is remembered. Long enough to route around a
 * robot that is parked for the rest of the run, short enough that a robot that
 * has genuinely moved on stops distorting my routes.
 */
export const BLOCKER_MEMORY_TICKS = Number(process.env.DIST_MEMORY ?? 60);

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
  /** Cell -> when I learned it was impassable for me. Learned from my sensor. */
  private rememberedBlockers = new Map<string, { pos: Position; until: number }>();
  /** Consecutive ticks each candidate blocker has denied me my next step. */
  private blockerStreak = new Map<string, number>();

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

  /**
   * Remember a cell that kept physically blocking me, so my planner can route
   * around it.
   *
   * WHY THIS IS NECESSARY, AND WHY A* DOES NOT DO IT ALREADY. Congestion in
   * this codebase is a soft A* cost: an occupied cell costs BASE_MOVE_COST
   * plus CONGESTION_OCCUPIED_WEIGHT, so entering one costs 4 against 1 for a
   * free cell — a penalty of 3 steps. On open floor a 3-step penalty is
   * enough and A* routes around traffic by itself. In a single-file corridor
   * it is not enough: going round a blocked cell means leaving the corridor
   * and coming back, which costs 4 steps or more, so A* pays the 3 and plans
   * straight through the robot. It then produces the same route every tick,
   * because the congestion field is identical every tick. Nothing in the
   * trigger set in replanAll fires either: the goal has not changed, no cell
   * in the route is a static wall, and the path is longer than one cell. So
   * the invalid route is never re-derived and the robot shuffles against the
   * obstruction for the rest of the run.
   *
   * Measured, n=8: 45% of all moves were safety displacements, path invariants
   * never violated, A* reporting a valid 4-to-11 cell route on every single
   * tick, and a single robot holding station three cells from its dropoff for
   * 360 consecutive ticks. A breadth-first search with the idle robots'
   * cells treated as walls found an OPEN route to that dropoff in every one of
   * 213 unfinished agents measured — so the fleet was never sealed in. The
   * route was simply pointing at a wall that only the planner could not see.
   *
   * WHY IT IS STILL DECENTRALISED. The observation is a SENSOR contact, not a
   * broadcast: this is the same network-independent fact the safety layer runs
   * on, so a partitioned robot builds the same memory from the same sight.
   * Nothing is negotiated, no message is added, and no agent is asked what any
   * other agent is doing. The memory is per-agent and is thrown away with the
   * agent.
   *
   * WHY IT IS SAFE WHEN IT IS WRONG. These cells are a PLANNING hint only.
   * They are never consulted when deciding whether a move is safe — that stays
   * with the sensor — and a cell remembered as blocked can still be entered if
   * the sensor says it is free. A stale memory can only make a route longer.
   * The one way it could make a robot stop is by making its goal unreachable,
   * so the caller retries without the overlay, and the memory expires anyway.
   */
  private noteBlocker(cell: Position, sensorScan: SensorScan, currentTick: number) {
    if (process.env.DIST_BLOCKERS === "0") return;
    const k = `${cell.x},${cell.y}`;
    // Age out anything I have been allowed to forget, and anything the sensor
    // can currently see is clear. A cell I cannot see is left blocked: the
    // sensor range is one cell, so "not visible" is not evidence of "free".
    for (const [bk, entry] of [...this.rememberedBlockers]) {
      if (currentTick >= entry.until) { this.rememberedBlockers.delete(bk); continue; }
      if (this.scanSees(sensorScan, entry.pos) && !isLocallySafe(sensorScan, entry.pos)) continue;
      if (this.scanSees(sensorScan, entry.pos)) this.rememberedBlockers.delete(bk);
    }
    const streak = (this.blockerStreak.get(k) ?? 0) + 1;
    this.blockerStreak.set(k, streak);
    for (const other of this.blockerStreak.keys()) if (other !== k) this.blockerStreak.delete(other);
    if (streak < PERSISTENT_BLOCK_TICKS) return;
    if (this.rememberedBlockers.has(k)) return;
    this.rememberedBlockers.set(k, { pos: { ...cell }, until: currentTick + BLOCKER_MEMORY_TICKS });
    this.blockerStreak.delete(k);
  }

  private scanSees(sensorScan: SensorScan, p: Position): boolean {
    return sensorScan.contacts.some((c) => positionsEqual(c.position, p));
  }

  /** Cells my own planner should treat as walls, learned from my own sensor. */
  getRememberedBlockers(): Position[] {
    if (process.env.DIST_BLOCKERS === "0") return [];
    return [...this.rememberedBlockers.values()].map((e) => ({ ...e.pos }));
  }

  /** True when the agent's current route runs through a remembered blocker. */
  routeRunsIntoBlocker(): boolean {
    for (let i = 1; i < this.local.path.length; i++) {
      const c = this.local.path[i];
      if (this.rememberedBlockers.has(`${c.x},${c.y}`)) return true;
    }
    return false;
  }

  /**
   * Yield candidates, with collinear retreat deprioritised.
   *
   * A COLLINEAR RETREAT is stepping directly away from the robot that is
   * blocking me — same axis, opposite direction. It is the move a naive
   * "any safe neighbour, ranked by distance to goal" rule picks first when
   * nothing else progresses, and it is precisely the move that cannot make
   * progress: it hands the blocked cell back, the blocker follows into it,
   * and next tick the pair is nose to nose one cell further along. The
   * conflict is not resolved, it is RELOCATED, once per tick, forever.
   *
   * This is not a guess. src/core/pathfinding/pibt.ts carries the same
   * finding in the centralised resolver, and it is the mechanism behind the
   * livelock measured here: eight agents on a width-1 lattice each visiting
   * about seven distinct cells across 400 ticks while executing 178 moves
   * apiece. Every one of those moves was legal. None of them arrived
   * anywhere.
   *
   * Stepping OFF the blocker's axis does resolve it, because it vacates the
   * corridor the blocker is travelling down instead of racing it. A cell that
   * is neither collinear-withdrawal nor legal is left to the emergency
   * escape, which prefers maximum clearance and so degrades to the retreat
   * only as a last resort.
   */
  private offLineOrSafe(safe: Position[], from: Position, blocker: Position): Position | null {
    if (DIST_NO_COLLINEAR_RETREAT === "0") return safe[0] ?? null;
    const awayX = from.x - blocker.x;
    const awayY = from.y - blocker.y;
    const isCollinearRetreat = (n: Position) => n.x - from.x === awayX && n.y - from.y === awayY;
    return safe.find((n) => !isCollinearRetreat(n)) ?? safe[0] ?? null;
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
      // A robot is physically sitting on the cell I was about to enter. Note
      // it: if the SAME cell keeps blocking me, the route through it is not
      // merely slow, it is impossible, and I have to plan around it. See
      // noteBlocker() for why A* will not do this on its own.
      this.noteBlocker(preferredCell, sensorScan, currentTick);
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
      const chosen =
        progressing[0] ??
        (DIST_YIELD === "shuffle"
          ? this.offLineOrSafe(safe, from, preferredCell)
          : DIST_YIELD === "offline"
            ? this.offLineOrSafe(safe, from, preferredCell)
            : null);
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

  /**
   * Announce ourselves, then return the move to be executed.
   *
   * THIS MUST NOT DECIDE A SECOND TIME. It used to call decide() again, which
   * looked harmless — decide() is a pure function of local state and the peer
   * inbox — and was not. In the second pass the inbox has already been drained
   * by the first, but the peers who were iterated EARLIER have already
   * broadcast this tick, so the second pass sees a half-updated peer set that
   * depends on iteration order. Two agents then decide DIFFERENTLY in the two
   * passes, and the fleet arbitrated the first pass while the agents executed
   * the second — so arbitration's guarantees did not apply to the moves
   * actually performed. That was the entire residual cell overlap: measured at
   * n=8 seed 17 tick 2, AMR-03 read "no-move" in pass 1 and "free, enter 2,6"
   * in pass 2, AMR-08 claimed 2,6 in both, only one claim was ever registered,
   * and both robots finished the tick on (2,6).
   *
   * Broadcasting the decision that was actually made also means an agent
   * never advertises an intent it is not going to perform, which is what
   * worker.ts was doing: it committed decide()'s first result while this
   * method broadcast the second.
   */
  tick(currentTick: number): AgentDecision {
    const decision =
      process.env.DIST_DOUBLE_DECIDE === "1" ? this.decide(currentTick) : this.lastDecision ?? this.decide(currentTick);
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
    // Drive the stall counter. It was declared, broadcast to every peer, and
    // read by the peer-yield rule in evaluate() — and never incremented
    // anywhere, so it was permanently zero and that rule was permanently
    // unreachable. A counter nobody drives is the same defect class as an
    // arbitration result nobody reads, which this codebase has now paid for
    // three times.
    //
    // Note WHEN it is updated: after decide() and after the broadcast, so a
    // peer evaluating me this tick sees the count as of the start of the tick.
    // That is the right ordering — the number describes the ticks I have
    // already gone without moving, which is exactly what a peer deciding
    // whether to take the initiative needs to know.
    if (process.env.DIST_STALL_COUNTER === "0") { /* frozen control */ }
    else if (moved) this.stallTicks = 0;
    else this.stallTicks += 1;
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
