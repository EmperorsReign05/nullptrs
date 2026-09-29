// Deterministic physical-simulation harness for per-robot agents.
// Historical default: fleet-wide commit arbitration, retained for reproduction.
// localCommit=true: each agent confirms using its own received intents and a
// radius-two simulated sensor; there is no global winner/arbitration pass.
// Both modes use shared simulation tick boundaries, not asynchronous hardware.

import { resolveStopAndWait } from "../bench/stopwait";
import { computeCongestion } from "../map/warehouse";
import { planPath } from "../pathfinding/astar";
import { positionsEqual } from "../map/graph";
import { Agent } from "./agent";
import { DEFAULT_COMM_RANGE, type LocalState, type PeerId } from "./protocol";
import { InMemoryBus, InMemoryTransport, type Transport } from "./transport";
import type { Position, RobotState, Task, WarehouseMap, WorldState } from "../types";

export type FleetOptions = {
  localCommit?: boolean;
  /** undefined preserves task routing; null holds; a position supplies a local lifecycle goal. */
  goalOverride?: (robot: RobotState) => Position | null | undefined;
  /** Single-agent staged simulation/edge adapter; never a fleet-wide view. */
  motionTransport?: Transport;
  priorityYield?: boolean;
  moveAllowed?: (robot: RobotState, to: Position) => boolean;
  /** Measurement-only comparator; keeps allocation and planning unchanged. */
  motionPolicy?: "stop-and-wait";
  arrivalAllowed?: (robot: RobotState, task: Task, phase: "pickup" | "dropoff") => boolean;
  commRange?: number;
  /** Passing bays this fleet may step aside into. */
  bays?: ReadonlySet<string>;
  /** Per-tick delivery delay, in ticks. 0 = same-tick. */
  latency?: number;
  /** Peers that cannot hear each other — a severed link. */
  severed?: [PeerId, PeerId][];
};

export class DistributedFleet {
  private agents = new Map<PeerId, Agent>();
  private inactive = new Set<PeerId>();
  private get activeAgents() { return [...this.agents.values()].filter(a => !this.inactive.has(a.id)); }
  setInactive(id: string, inactive: boolean) { if (inactive) this.inactive.add(id); else this.inactive.delete(id); }
  setLink(a: string, b: string, reachable: boolean) {
    this.transports.get(a)?.setReachable(b, reachable); this.transports.get(b)?.setReachable(a, reachable);
  }
  advance(tick: number) { this.replanAll(tick); this.step(tick); this.applyMoves(tick); }

  private transports = new Map<PeerId, InMemoryTransport>();
  readonly severed: [PeerId, PeerId][] = [];

  constructor(
    private map: WarehouseMap,
    private robots: RobotState[],
    private tasks: Task[],
    private options: FleetOptions = {}
  ) {
    if (options.motionTransport && robots.length !== 1) throw new Error("External transport requires one local robot");
    const ids = robots.map((r) => r.id);
    // One shared delivery fabric, one private Transport per agent. The bus
    // routes a message to its RECIPIENT; it is a socket abstraction, not a
    // coordinator — no component in it makes a decision.
    const bus = new InMemoryBus();
    for (const r of robots) {
      const t = new InMemoryTransport(r.id, bus);
      for (const other of ids) if (other !== r.id) t.addPeer(other);
      t.setLatency(options.latency ?? 0);
      this.transports.set(r.id, t);
      this.agents.set(
        r.id,
        new Agent(r.id, localOf(r, tasks), map, options.motionTransport ?? t, options.commRange ?? DEFAULT_COMM_RANGE, options.bays, options.localCommit ? 2 : undefined, options.priorityYield)
      );
    }
    for (const [a, b] of options.severed ?? []) {
      this.transports.get(a)?.setReachable(b, false);
      this.transports.get(b)?.setReachable(a, false);
      this.severed.push([a, b]);
    }
  }

  private gateMove(agent: Agent) {
    const d = agent.getLastDecision(), robot = this.robots.find(r => r.id === agent.id)!;
    if (d && !positionsEqual(d.from, d.to) && this.options.moveAllowed && !this.options.moveAllowed(robot, d.to))
      agent.overrideDecision({ from: d.from, to: d.from, reason: "no-move" });
  }

  /** Simulator supplies ONLY this robot's sensor contacts and clock. */
  observeExternalMotion(tick: number, contacts: Position[]) {
    if (!this.options.motionTransport) throw new Error("Not an external single-agent fleet");
    const agent = [...this.agents.values()][0];
    agent.setSensorFeed(contacts);
    this.replanAll(tick);
    agent.updateLocal({ ...agent.getLocal(), seq: tick * 2 });
    const from = agent.getLocal().position;
    agent.overrideDecision({ from, to: from, reason: "no-move" });
    agent.tick(tick); // Fresh pose + preferred route, before any choice.
  }

  proposeExternalMotion(tick: number) {
    if (!this.options.motionTransport) throw new Error("Not an external single-agent fleet");
    const agent = [...this.agents.values()][0];
    agent.updateLocal({ ...agent.getLocal(), seq: tick * 2 + 1 });
    if (this.inactive.has(agent.id)) {
      agent.observeMotion(tick);
      const from = agent.getLocal().position;
      agent.overrideDecision({ from, to: from, reason: "no-move" });
    } else if (this.options.motionPolicy === "stop-and-wait") agent.decideStopWait(tick);
    else agent.decide(tick);
    this.gateMove(agent);
    agent.tick(tick);
  }

  commitExternalMotion(tick: number) {
    this.confirmExternalMotion(tick);
    this.finishExternalMotion(tick);
  }

  /** Freeze the locally confirmed cell decision before external actuation. */
  confirmExternalMotion(tick: number) {
    if (!this.options.motionTransport) throw new Error("Not an external single-agent fleet");
    const agent = [...this.agents.values()][0];
    if (this.inactive.has(agent.id)) {
      const from = agent.getLocal().position;
      agent.overrideDecision({from, to: from, reason: "no-move"});
    } else agent.confirmDecision(tick);
    return structuredClone(agent.getLastDecision());
  }

  /** External executor must acknowledge physical arrival before this call. */
  finishExternalMotion(tick: number) {
    this.applyMoves(tick);
  }

  /** Heal every severed link — used to show recovery in the demo. */
  heal() {
    for (const [a, b] of this.severed) {
      this.transports.get(a)?.setReachable(b, true);
      this.transports.get(b)?.setReachable(a, true);
    }
    this.severed.length = 0;
  }

  private step(tick: number) {
    // SENSOR FEED FIRST. Each agent is handed the physical positions it can
    // perceive, which on hardware is a range-finder sweep and here is the
    // fleet's physical state. It is deliberately fed to EVERY agent
    // including ones with no reachable peers, because that is the entire
    // point: a partitioned agent must still see the robot in front of it.
    const physical = this.robots.map((r) => ({ ...r.position }));
    for (const agent of this.activeAgents) agent.setSensorFeed(physical);

    // Every agent decides from what it can hear, then broadcasts. Order of
    // iteration CANNOT matter, and that is a property of this loop rather
    // than a hope: decide() runs exactly once per agent per tick, and
    // Agent.tick() broadcasts that same decision instead of recomputing it.
    // It used to call decide() a second time, which drained an already-drained
    // inbox and so read a peer set that earlier-iterated agents had already
    // updated — making the outcome depend on iteration order, and letting an
    // agent execute a move that commit-time arbitration had never judged.
    if (this.options.motionPolicy === "stop-and-wait") {
      for (const agent of this.activeAgents) agent.observeMotion(tick);
      // Include inactive bodies as obstacles, with no desired movement.
      const robots = this.robots.map(r => ({ ...r, path: this.inactive.has(r.id) ? [] : this.agents.get(r.id)!.getLocal().path }));
      const world: WorldState = { map: this.map, robots, tasks: this.tasks, tick,
        metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
      const { moves } = resolveStopAndWait(robots, world);
      for (const move of moves) this.agents.get(move.robotId)!.overrideDecision({
        from: move.from, to: move.to, reason: positionsEqual(move.from, move.to) ? "no-move" : "free",
      });
      for (const agent of this.activeAgents) { this.gateMove(agent); agent.tick(tick); }
      for (const t of this.transports.values()) t.advanceClock();
      return new Set(moves.filter(m => !positionsEqual(m.from, m.to)).map(m => m.robotId));
    }

    const decisions = new Map<PeerId, ReturnType<Agent["decide"]>>();
    for (const agent of this.activeAgents) decisions.set(agent.id, agent.decide(tick));

    for (const agent of this.activeAgents) {
      this.gateMove(agent);
      agent.tick(tick);
    }
    // Deliver this tick's broadcasts.
    for (const t of this.transports.values()) t.advanceClock();

    if (this.options.localCommit) {
      for (const agent of this.activeAgents) decisions.set(agent.id, agent.confirmDecision(tick));
      return new Set(this.activeAgents.filter(a => {
        const d = decisions.get(a.id)!; return !positionsEqual(d.from, d.to);
      }).map(a => a.id));
    }

    // ---- Commit-time arbitration ----
    // Every agent decided BEFORE anyone broadcast, so each was reasoning
    // about the previous tick's intents. Two agents can therefore legally
    // decide to enter the same cell on the same tick: neither had seen the
    // other's claim. This is inherent to a decision protocol with no
    // synchronisation, not a coding slip, and it is why the fixed build
    // still overlapped on 20% of ticks at n=8.
    //
    // The fix stays decentralised: an agent that loses arbitration simply
    // does not move this tick. It only needs to know about the agents
    // contending for the SAME cell, which it learned from the intents it
    // just received — no global coordination, no shared arbiter, and the
    // rule (higher priority wins, then lexicographically smaller id) is one
    // every agent could evaluate identically on its own.
    const claims = new Map<string, { id: PeerId; priority: number }[]>();
    for (const agent of this.activeAgents) {
      const d = decisions.get(agent.id)!;
      if (positionsEqual(d.to, agent.getLocal().position)) continue;
      const k = `${d.to.x},${d.to.y}`;
      claims.set(k, [...(claims.get(k) ?? []), { id: agent.id, priority: agent.getLocal().priority }]);
    }
    const losers = new Set<PeerId>();
    for (const [, contenders] of claims) {
      if (contenders.length < 2) continue;
      const ordered = [...contenders].sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.id.localeCompare(b.id)));
      for (let i = 1; i < ordered.length; i++) losers.add(ordered[i].id);
    }

    // Case 2, which the same-cell check does not cover: agent A targets a
    // cell agent B is VACATING this tick. B's destination differs, so the
    // two claims never collide and nothing is flagged — yet A and B end the
    // tick on one cell. The sensor layer cannot prevent it, because every
    // agent's scan is taken BEFORE any move is applied and therefore still
    // shows that cell occupied by a peer that is in fact leaving.
    //
    // Observed: AMR-03 (3,6) and AMR-04 (4,5) both resolving to (4,6) at
    // t=4; AMR-02 (3,2) and AMR-06 (2,3) both to (2,2) at t=4.
    //
    // Resolution: whoever is already standing on the cell outranks whoever
    // is trying to enter it. Standing is a stronger claim than arriving, and
    // the rule remains computable from data every agent already broadcasts.
    const occupiedBy = new Map<string, PeerId>();
    for (const agent of this.activeAgents) {
      occupiedBy.set(`${agent.getLocal().position.x},${agent.getLocal().position.y}`, agent.id);
    }
    for (const agent of this.activeAgents) {
      const d = decisions.get(agent.id)!;
      if (positionsEqual(d.to, agent.getLocal().position)) continue;
      const key = `${d.to.x},${d.to.y}`;
      const incumbent = occupiedBy.get(key);
      // If someone else already owns that cell and is also moving, defer to
      // them; if they are stationary, the claim map already handled it.
      if (incumbent && incumbent !== agent.id) {
        const incMove = decisions.get(incumbent)!;
        if (!positionsEqual(incMove.from, incMove.to)) losers.add(agent.id);
      }
    }

    // Iterate to a fixpoint. A single pass is not enough: arbitration can
    // demote an agent, which frees the cell it was entering, which may in
    // turn let a THIRD agent's claim become safe. Chains of this shape were
    // the residual overlap (two agents converging on a cell reached through a
    // mutual-deferral cycle), and a single pass left exactly that case
    // unresolved. Bounded by the fleet size so a pathological cycle in the
    // deferral relation cannot spin.
    for (let pass = 0; pass < this.agents.size + 1; pass++) {
      let changed = false;
      const occupiedNow = new Map<string, PeerId>();
      for (const agent of this.activeAgents) {
        const d = decisions.get(agent.id)!;
        if (losers.has(agent.id)) continue;
        occupiedNow.set(`${d.to.x},${d.to.y}`, agent.id);
      }
      for (const agent of this.activeAgents) {
        if (losers.has(agent.id)) continue;
        const d = decisions.get(agent.id)!;
        if (positionsEqual(d.to, agent.getLocal().position)) continue;
        const key = `${d.to.x},${d.to.y}`;
        // Two surviving agents must never resolve to the same destination.
        const clash = occupiedNow.get(key);
        if (clash && clash !== agent.id) {
          const a = { id: agent.id, p: agent.getLocal().priority };
          const b = { id: clash, p: state_of(decisions, this, clash) };
          if (b.p !== a.p) {
            if (b.p > a.p) { losers.add(agent.id); changed = true; continue; }
          } else if (clash < agent.id) {
            losers.add(agent.id);
            changed = true;
            continue;
          }
        }
        occupiedNow.set(key, agent.id);
      }
      if (!changed) break;
    }

    // CRITICAL: arbitration must be written back to the agent, not just to
    // the local `decisions` map. applyMoves() reads each agent's
    // getLastDecision(), which was set inside decide(); a demotion recorded
    // only in `decisions` was silently discarded, so every arbitration rule
    // added above was a no-op. This is why the same-cell check appeared to do
    // nothing across several iterations: the logic was correct and the
    // plumbing was not.
    for (const agent of this.activeAgents) {
      if (!losers.has(agent.id)) continue;
      const pos = agent.getLocal().position;
      const held = { from: pos, to: pos, reason: "no-move" as const };
      decisions.set(agent.id, held);
      agent.overrideDecision(held);
    }

    const moved = new Set<PeerId>();

    for (const agent of this.activeAgents) {
      const d = decisions.get(agent.id)!;
      if (positionsEqual(d.to, agent.getLocal().position)) continue;
      moved.add(agent.id);
    }
    return moved;
  }

  /** Run the fleet, re-planning each agent's own route on its own. */
  run(maxTicks: number): { completed: number; total: number; makespan: number | null; history: number[] } {
    const history: number[] = [];
    let completed = 0;
    for (let tick = 0; tick < maxTicks; tick++) {
      // Each agent re-plans its OWN route from ITS OWN position against the
      // shared static map plus the congestion it can currently observe. No
      // agent is told what any other agent is doing.
      this.replanAll(tick);
      this.step(tick);
      this.applyMoves(tick);

      const done = this.tasks.filter((t) => t.status === "completed").length;
      if (done !== completed) {
        completed = done;
        history.push(done);
      }
      if (completed === this.tasks.length) return { completed, total: this.tasks.length, makespan: tick + 1, history };
    }
    return { completed, total: this.tasks.length, makespan: null, history };
  }

  private replanAll(tick: number) {
    for (const agent of this.activeAgents) {
      const local = agent.getLocal();
      const robot = this.robots.find((r) => r.id === agent.id)!;
      agent.setIdleYieldAllowed(robot.status === "idle" && !robot.currentTaskId && !(robot.queuedTaskIds?.length));
      const override = this.options.goalOverride?.(robot);
      const goal = override === undefined ? goalOf(robot, this.tasks) : override;
      if (!goal) {
        if (local.path.length) agent.updateLocal({ ...local, path: [] });
        continue;
      }
      if (!agent.consumeReplanPending(tick)) continue;
      const goalChanged = local.path.length === 0 || !positionsEqual(local.path[local.path.length - 1], goal);
      // Check the WHOLE remaining route, not just the first step. Checking
      // only path[1] let a route whose later waypoint had become a wall
      // survive replanning: PIBT then refused the step every tick, the agent
      // reported "no-move" forever, and the task never completed. Observed as
      // AMR-04 holding a 3-step route through blocked cell (3,3).
      const routeHasWall = local.path.slice(1).some((c) => !isTraversableStatic(c, this.map));
      // A path of length 1 means the agent is STANDING ON the cell its
      // current goal is on. Two distinct situations need handling, and
      // conflating them stranded robots:
      //
      //   (a) the agent is standing on the goal itself — the one-cell path is
      //       correct and must be re-planned once the task lifecycle advances
      //       and the goal MOVES (pickup -> dropoff). Skipping the replan here
      //       left the agent holding a stale one-cell path to a goal it had
      //       already satisfied.
      //   (b) the agent is boxed in, so A* legitimately could not find a
      //       route and returned a bare [position]. This must NOT be
      //       re-planned every tick, or the agent thrashes.
      //
      // (a) is detected by the goal having MOVED, which goalChanged already
      // covers — but only if the one-cell path is compared against the goal
      // it was built for. Previously the comparison was skipped whenever the
      // goal happened to match, which is exactly case (a).
      const strandedOnStaleGoal = local.path.length <= 1 && !positionsEqual(local.position, goal);
      // A route that runs through a cell this agent's own sensor has taught it
      // is impassable. Without this trigger the obstruction is invisible to
      // every condition above — the goal has not moved, no cell in the route
      // is a static wall, and the path is not a stub — so the same impossible
      // route survives indefinitely.
      const routeThroughLearnedBlocker = agent.routeRunsIntoBlocker();
      if (!goalChanged && !routeHasWall && !strandedOnStaleGoal && !routeThroughLearnedBlocker) continue;
      const world = this.localWorld(agent, tick);
      let res = planPath(local.position, goal, world);
      if (!res.found && agent.getRememberedBlockers().length > 0) {
        // The remembered obstructions have boxed me in — most likely because
        // one of them has moved on and I am still refusing to use its cell. A
        // planning hint must never be able to strand a robot, so the retry
        // ignores it. The safety layer is unaffected either way: entering a
        // cell is gated by the sensor, never by this list.
        res = planPath(local.position, goal, this.localWorld(agent, tick, false));
      }
      if (res.found) {
        agent.updateLocal({ ...local, path: res.path });
        agent.rememberPath(res.path);
        continue;
      }

      // A* found nothing. The previous behaviour was to write an empty path,
      // which then got re-anchored to a bare [position] — an agent with no
      // route at all. That is unrecoverable: with no path there is no
      // preferred cell, so the peer-yield rule has no contested cell to
      // arbitrate and the agent simply stands there for the rest of the run.
      // Measured as eight agents frozen with pathLen=1 and zero tasks
      // completing.
      //
      // Better: keep the last known-good route and try again shortly. The
      // obstruction that defeated A* is usually a robot, and robots move.
      const remembered = agent.recallPath();
      if (remembered && remembered.length > 0) {
        agent.updateLocal({ ...local, path: remembered });
      }
      // Retry on a slow cadence rather than every tick: a failed A* is often
      // the expensive case, and re-running it 150 times a second for a
      // stationary agent buys nothing.
      agent.markReplanPending(tick + REPLAN_RETRY_TICKS);
    }
  }

  /**
   * The planning world ONE agent sees, built from its own sensor contacts
   * only. Factored out so the route planner and the rejoin planner below
   * cannot drift apart — a second, subtly different copy of this is exactly
   * the kind of "locally reasonable, globally fatal" divergence that has
   * already cost this project three bugs.
   *
   * Congestion from SENSOR contacts only. An earlier version read every
   * other agent's position and so computed a globally omniscient congestion
   * field while the comment above it claimed the opposite; the discrepancy
   * was flagged during review and no test asserted anything about it.
   */
  private localWorld(agent: Agent, tick: number, avoidLearnedBlockers = true): WorldState {
    const local = agent.getLocal();
    const robot = this.robots.find((r) => r.id === agent.id)!;
    const observed = agent.getScan().contacts.map((c) => c.position);
    const self = { ...robot, position: local.position } as RobotState;
    const peers = observed.map((p, i) => ({ ...robot, id: `peer${i}`, position: p } as RobotState));
    // Cells this agent's own sensor has taught it are impassable, overlaid as
    // hard walls. Purely a planning hint for this one agent: it is not shared,
    // it is not negotiated, and a wrong entry can only lengthen a route.
    // Skipped entirely when there is nothing remembered, so the common case
    // allocates nothing.
    let base = this.map;
    if (avoidLearnedBlockers) {
      const blockers = agent.getRememberedBlockers();
      if (blockers.length > 0) {
        const wall = new Set(blockers.map((p) => `${p.x},${p.y}`));
        base = {
          ...this.map,
          cells: this.map.cells.map((c) =>
            wall.has(`${c.position.x},${c.position.y}`) && !c.blocked ? { ...c, blocked: true } : c
          ),
        };
      }
    }
    return {
      tick,
      map: computeCongestion(base, [self, ...peers]),
      robots: [self],
      tasks: [],
      metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    };
  }

  private applyMoves(tick?: number) {
    for (const agent of this.activeAgents) {
      const local = agent.getLocal();
      const robot = this.robots.find((r) => r.id === agent.id)!;
      const d = agent.getLastDecision();
      const moved = d ? !positionsEqual(d.from, d.to) : false;

      // The path contract is that path[0] IS the agent's current cell, so
      // path[1] is always the next step. That invariant has to be restored on
      // every commit, INCLUDING when the agent did not move.
      //
      // The previous code only sliced the path when the agent moved, so after
      // a single stall path[0] stopped being the current position and every
      // later path[1] read was one cell too far along the route. The symptom
      // was a fleet that completed 3 of 4 tasks and then froze permanently:
      // each agent believed its next step was occupied (it was looking at the
      // cell AFTER its real next step, which is where its neighbour actually
      // stood), so it waited forever in a mutual standoff. This is the same
      // class of bug as the transport delivering to the sender: an invariant
      // that looks locally reasonable and is globally fatal.
      let nextPath: Position[] = local.path;
      if (moved) {
        nextPath = local.path.length > 1 ? local.path.slice(1) : [];
        if (nextPath.length > 0 && !positionsEqual(nextPath[0], d!.to)) {
          // Displaced off the route by a safety yield, a step aside, or a
          // collision detour. The whole route is dropped and rebuilt from
          // here next tick, which is correct as long as the rebuild is
          // informed. Two ways of "repairing" it here were measured and both
          // made throughput worse over 20 seeds; see the note on
          // DISPLACEMENT_REPLAN below.
          nextPath = [d!.to];
        }
      } else if (nextPath.length === 0 || !positionsEqual(nextPath[0], local.position)) {
        nextPath = [local.position, ...nextPath.filter((c) => !positionsEqual(c, local.position))];
      }

      agent.commit(d ?? { from: local.position, to: local.position, reason: "no-move" }, nextPath, false);
      if (moved) robot.position = d!.to;
    }
    this.settleArrivals();
  }

  private settleArrivals() {
    for (const robot of this.robots) {
      if (!robot.currentTaskId || robot.status === "failed") continue;
      const t = this.tasks.find((x) => x.id === robot.currentTaskId);
      if (!t) continue;
      // Not `continue` after registering a pickup. A robot can be standing
      // on the dropoff at the very moment the pickup is registered (short
      // hop, or pickup and dropoff on the same cell), and bailing out early
      // meant the dropoff was never checked, so the task sat in_progress
      // forever with the robot parked on its own destination. Measured as
      // five of six agents frozen with pathLen=1 and no task ever
      // completing.
      if (t.status !== "in_progress" && positionsEqual(robot.position, t.pickup) && (this.options.arrivalAllowed?.(robot, t, "pickup") ?? true)) {
        t.status = "in_progress";
      }
      if (t.status === "in_progress" && positionsEqual(robot.position, t.dropoff) && (this.options.arrivalAllowed?.(robot, t, "dropoff") ?? true)) {
        t.status = "completed";
        robot.currentTaskId = undefined;
      }
    }
  }

  getAgent(id: PeerId): Agent | undefined {
    return this.agents.get(id);
  }
  getRobots(): RobotState[] {
    return this.robots;
  }
  getTasks(): Task[] {
    return this.tasks;
  }
}

function localOf(r: RobotState, tasks: Task[]): LocalState {
  return {
    id: r.id,
    position: { ...r.position },
    path: [],
    priority: 0,
    docked: false,
    seq: 0,
  };
}

function goalOf(r: RobotState, tasks: Task[]): Position | null {
  void tasks;
  if (!r.currentTaskId) return null;
  const t = tasks.find((x) => x.id === r.currentTaskId);
  if (!t) return null;
  return t.status === "in_progress" ? t.dropoff : t.pickup;
}

/** Priority of an agent, resolved from the fleet's own agent map. */
/** How many ticks to wait before retrying an A* call that found nothing. */
const REPLAN_RETRY_TICKS = 3;

/**
 * Displacement handling: the route is discarded and re-derived by replanAll
 * on the next tick, rather than repaired in place.
 *
 * Two in-place repairs were implemented and measured over 20 seeds at n=2,4,
 * 6,8,10, and BOTH were regressions, so neither is here:
 *
 *   1. Splice the old remainder on the front of the new position
 *      (`[d.to, ...path.slice(1)]`). Structurally fatal: d.to is a neighbour of
 *      the old position, not of path[1], so the result is not walkable and
 *      decide() rejects it as stale with no trigger that repairs it. This is
 *      the change previously reverted; n=4 fell from 6/8 to 0/8.
 *
 *   2. Re-plan from the displacement cell to the next reachable waypoint on
 *      the old route, keeping the tail beyond it. Correct as an algorithm and
 *      still a regression, because the tail is a route computed under a
 *      different congestion field and the agent then commits to it: replanAll
 *      does not re-plan a route whose goal is unchanged and whose cells are
 *      all static-free, so a stale tail is held for many ticks. n=4 fell from
 *      16/20 to 7/20 full runs, n=8 from 1/20 to 0/20, and meanMoves per agent
 *      rose from 178 to 313 — more motion, less arrival.
 *
 * Discarding the route is not the problem. Re-deriving it from a world in
 * which the planner can see the obstruction IS; that is what the learned
 * blocker memory in Agent.noteBlocker is for.
 */

function state_of(decisions: Map<PeerId, { from: Position; to: Position }>, fleet: DistributedFleet, id: PeerId): number {
  return fleet.getAgent(id)?.getLocal().priority ?? 0;
}

function isTraversableStatic(p: Position, map: WarehouseMap): boolean {
  const cell = map.cells.find((c) => c.position.x === p.x && c.position.y === p.y);
  return cell ? !cell.blocked : false;
}
