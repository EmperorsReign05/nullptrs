// One frozen scenario, run under one policy arm.
//
// The runner adds NO policy logic of its own. It builds the FleetRuntime the
// production system already exposes, releases the frozen task schedule, steps
// it, and then READS state that the system already maintains. The only thing it
// writes is instrumentation, and every instrumented quantity is derived from
// data the runtime already produces:
//
//   moves / waits  - world.robots positions before and after fleet.advance()
//   conflict cause - Agent.getLastDecision().reason, which the agent already
//                    computes for the dashboard and which the commit protocol
//                    itself overwrites when it demotes a move
//   task phase     - task.status, which the ownership/custody layer maintains
//
// Nothing here can influence a decision: no setter, no callback, no override.

import { FleetRuntime } from "../../distributed/runtime";
import type { BidModel } from "../../ml/bidmodel";
import frozenModel from "../../../../artifacts/bid-energy-v4/model.json";
import { ARMS, type ArmId } from "./protocol";
import { routeGuidanceTollField, degreeField, type RouteGuidanceModel } from "../../ml/routeguidance";
import { layoutMap, scenarioWorld, taskObject, type ScenarioRecord } from "./scenario";
import { SAFETY_COUNTERS } from "./protocol";

const FROZEN = frozenModel as { model: BidModel; bound: number };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export type TaskTrace = {
  id: string;
  createdAt: number;
  ownershipStages?: Record<string, number>;
  firstAssignedTick: number | null;
  pickedUpTick: number | null;
  completedTick: number | null;
  finalOwner: string | null;
};

export type PhaseTickCounts = { travel: number; wait: number };

export type ArmRun = {
  arm: ArmId;
  armName: string;
  scenarioId: string;
  seed: number;
  fleetSize: number;
  layout: string;
  regime: string;
  endpointFamily: string;
  horizonTicks: number;
  ticksRun: number;

  completed: boolean;
  tasksCompleted: number;
  tasksTotal: number;
  /** PRIMARY metric. Sum of (completionTick - createdAt) over COMPLETED tasks. */
  sumTaskCompletionTime: number;
  /** SECOND reading. lastTaskCompletionTick - firstTaskCreationTick. Only defined when completed. */
  makespan: number | null;
  /** Longest stretch of consecutive ticks with no task completion while work was outstanding. */
  longestNoProgressTicks: number;

  ownershipTelemetry?: {
    messages: number; peerTicks: number; staleRejected: number;
    auctionRounds: number; certifiedRounds: number;
    peakConcurrentTasks: number; meanConcurrentTasks: number;
    duplicateExecutableOwners: number;
    group?: { bundleSizes: number[]; groupSizes: number[]; certifiedBundles: Record<string,{owner:string;taskIds:string[];size:number}>; attempts: Record<string,string[]>; offers: number; proposals: number; rejected: number; refreshes: number; queueRobotTicks: number; queueTasks: number };
  };
  tasks: TaskTrace[];
  /** Per-task time decomposition; the three components sum to flowTime. */
  releaseToAssignmentTicks: number;
  assignmentToPickupTicks: number;
  pickupToCompletionTicks: number;

  /** Fleet-wide robot-ticks, by lifecycle phase, split into moved / not-moved. */
  phaseTicks: Record<"approach" | "loaded" | "charging" | "idle", PhaseTickCounts>;
  /** Movement ticks split by whether they reduced the Manhattan distance to this robot's own goal. */
  progressTicks: { advancing: number; lateral: number; retreating: number };
  /** Histogram of AgentDecision.reason over every active robot-tick. */
  decisionReasons: Record<string, number>;
  /** Concurrency instrumentation: does this workload really put robots on shared paths at the same time? */
  meanInFlightTasks: number | null;
  peakInFlightTasks: number;
  meanMovingRobots: number | null;
  ticksWithTwoOrMoreMovingRobots: number;

  /** Route-guidance instrumentation. Zero for every arm with the layer OFF. */
  guidance: { predictedCells: number; rejectedFeatures: number; replansWithGuidance: number };

  /** Robot-ticks that were neither moving nor holding an assigned task. */
  energyHoldTicks: number;
  reroutes: number;
  replans: number;
  bidAttempts: number;
  bidNonzeroCorrections: number;
  bidDisabledFallbacks: number;
  safety: Record<string, number>;
  centralisedPibtCounters: { conflictCount: number; waitMoves: number; inheritedPriorities: number; backtracks: number };
};

export function runArm(record: ScenarioRecord, armId: ArmId, guidance?: RouteGuidanceModel, allocationMode: "epoch" | "event-single" | "event-grouped" = "epoch"): ArmRun {
  const arm = ARMS.find((a) => a.id === armId)!;
  const map = layoutMap(record.layout);
  const world = scenarioWorld(record, map);
  const runtime = new FleetRuntime(
    world,
    FROZEN.model,
    { motionPolicy: arm.runtime.motionPolicy, allocationMode },
  );
  runtime.aiEnabled = arm.runtime.aiEnabled;
  const guidanceStats = { predictedCells: 0, rejectedFeatures: 0, replansWithGuidance: 0 };
  if (arm.runtime.guidance) {
    if (!guidance) throw new Error(`arm ${armId} needs a route-guidance model`);
    installGuidance(runtime, guidance, guidanceStats);
  }

  const tasks: TaskTrace[] = record.tasks.map((t) => ({
    id: t.id, createdAt: t.createdAt, firstAssignedTick: null, pickedUpTick: null, completedTick: null, finalOwner: null,
  }));
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const phaseTicks = {
    approach: { travel: 0, wait: 0 },
    loaded: { travel: 0, wait: 0 },
    charging: { travel: 0, wait: 0 },
    idle: { travel: 0, wait: 0 },
  };
  const decisionReasons: Record<string, number> = {};
  const progressTicks = { advancing: 0, lateral: 0, retreating: 0 };
  let longestNoProgress = 0, noProgressRun = 0, completedSeen = 0;
  let inFlightSum = 0, peakInFlight = 0, movingSum = 0, concurrentMotionTicks = 0, motionTicks = 0;
  const auctionRounds = new Set<string>(), certifiedRounds = new Set<string>();
  let queueRobotTicks=0, queueTasks=0;
  let concurrentSum = 0, concurrentPeak = 0, duplicateExecutableOwners = 0;
  const pending = record.tasks.filter((t) => t.createdAt > 0);

  for (let tick = 0; tick < record.horizonTicks; tick++) {
    // Release the frozen task schedule. The first task is already present.
    for (const t of pending) {
      if (t.createdAt === runtime.world.tick) runtime.command({ kind: "task", task: taskObject(t) });
    }

    const before = runtime.world.robots.map((r) => ({ x: r.position.x, y: r.position.y }));
    runtime.step();
    const now = runtime.world.tick;
    for(const robot of runtime.world.robots) { queueRobotTicks++;queueTasks+=(robot.queuedTaskIds??[]).length; }
    const concurrent = new Set<string>();
    for (const peer of runtime.peers.values()) {
      const diag = peer.diagnostics();
      for (const [taskId, raw] of Object.entries(diag.auctions)) {
        const auction = raw as { isCandidate: boolean; bidsHeld: number; certificateReached: boolean };
        const key = `${diag.generation}:${taskId}`;
        if (auction.bidsHeld > 0) auctionRounds.add(key);
        if (auction.certificateReached) certifiedRounds.add(key);
        if (auction.isCandidate && !auction.certificateReached) concurrent.add(taskId);
      }
    }
    concurrentSum += concurrent.size;
    concurrentPeak = Math.max(concurrentPeak, concurrent.size);
    for (const task of runtime.world.tasks) {
      if ([...runtime.peers.values()].filter(p=>p.mayExecute(task.id)).length > 1) {
        duplicateExecutableOwners++;
        if(allocationMode === "event-grouped") throw new Error(`Duplicate executable owners: ${task.id}`);
      }
    }

    for (const t of runtime.world.tasks) {
      const trace = byId.get(t.id);
      if (!trace) continue;
      trace.ownershipStages ??= {};
      for (const peer of runtime.peers.values()) {
        for (const [stage, observed] of Object.entries(peer.latency.get(t.id) ?? {})) {
          // Protocol tick t executes during runner step t -> t+1.
          trace.ownershipStages[stage] = Math.min(trace.ownershipStages[stage] ?? Infinity, observed + 1);
        }
      }
      if (trace.firstAssignedTick === null && t.assignedRobotId !== undefined) trace.firstAssignedTick = now;
      if (trace.pickedUpTick === null && t.status === "in_progress") trace.pickedUpTick = now;
      if (trace.completedTick === null && t.status === "completed") trace.completedTick = now;
      if (t.assignedRobotId !== undefined) trace.finalOwner = t.assignedRobotId;
    }

    let progress = false;
    const done = runtime.world.tasks.filter((t) => t.status === "completed").length;
    if (done > completedSeen) { completedSeen = done; progress = true; }

    let movedThisTick = 0;
    runtime.world.robots.forEach((r, i) => {
      const agent = runtime.fleet.getAgent(r.id);
      const decision = agent?.getLastDecision();
      const reason = decision ? decision.reason : "no-move";
      decisionReasons[reason] = (decisionReasons[reason] ?? 0) + 1;
      const moved = before[i].x !== r.position.x || before[i].y !== r.position.y;
      const task = r.currentTaskId ? runtime.world.tasks.find((t) => t.id === r.currentTaskId) : undefined;
      const phase = task ? (task.status === "in_progress" ? "loaded" : "approach")
        : r.status === "charging" ? "charging" : "idle";
      phaseTicks[phase][moved ? "travel" : "wait"]++;
      if (moved) {
        movedThisTick++;
        // Route efficiency, read from the agent's OWN route: a move that reduces
        // the Manhattan distance to its current goal is advancing, one that
        // leaves it unchanged is lateral, one that increases it is retreating.
        // Manhattan is a lower bound on true graph distance in a rack layout, so
        // `advancing / travel` is itself a lower bound on real route efficiency.
        const route = agent?.getLocal().path ?? [];
        const goal = route.length ? route[route.length - 1] : r.position;
        const from = before[i];
        const distBefore = Math.abs(from.x - goal.x) + Math.abs(from.y - goal.y);
        const distAfter = Math.abs(r.position.x - goal.x) + Math.abs(r.position.y - goal.y);
        progressTicks[distAfter < distBefore ? "advancing" : distAfter === distBefore ? "lateral" : "retreating"]++;
      }
    });
    // Concurrency: how many tasks are in flight, and how many robots are moving
    // at the same instant. A workload can have fully overlapping geometric paths
    // and still never put two robots on one, so this is reported per run.
    const inFlight = runtime.world.tasks.filter((t) => t.status === "assigned" || t.status === "in_progress").length;
    inFlightSum += inFlight;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    movingSum += movedThisTick;
    if (movedThisTick >= 2) concurrentMotionTicks++;
    motionTicks++;

    if (progress) noProgressRun = 0;
    else if (done < record.tasksPerRun) { noProgressRun++; if (noProgressRun > longestNoProgress) longestNoProgress = noProgressRun; }
    if (done === record.tasksPerRun) break;
  }

  // ---- metrics ----
  const finished = tasks.filter((t) => t.completedTick !== null);
  const sumTaskCompletionTime = finished.reduce((a, t) => a + (t.completedTick! - t.createdAt), 0);
  const firstCreation = Math.min(...tasks.map((t) => t.createdAt));
  const lastCompletion = finished.length ? Math.max(...finished.map((t) => t.completedTick!)) : null;
  const completed = finished.length === tasks.length;
  const releaseToAssignment = sum(tasks.filter((t) => t.firstAssignedTick !== null && t.completedTick !== null).map((t) => t.firstAssignedTick! - t.createdAt));
  const assignmentToPickup = sum(tasks.filter((t) => t.firstAssignedTick !== null && t.pickedUpTick !== null).map((t) => t.pickedUpTick! - t.firstAssignedTick!));
  const pickupToCompletion = sum(tasks.filter((t) => t.pickedUpTick !== null && t.completedTick !== null).map((t) => t.completedTick! - t.pickedUpTick!));

  const safety = {} as Record<string, number>;
  for (const k of SAFETY_COUNTERS) safety[k] = runtime.safety[k];

  return {
    arm: arm.id,
    armName: arm.name,
    scenarioId: record.id,
    seed: record.seed,
    fleetSize: record.fleetSize,
    layout: record.layout,
    regime: record.regime,
    endpointFamily: record.endpointFamily,
    horizonTicks: record.horizonTicks,
    ticksRun: runtime.world.tick,
    completed,
    tasksCompleted: finished.length,
    tasksTotal: tasks.length,
    sumTaskCompletionTime,
    makespan: completed && lastCompletion !== null ? lastCompletion - firstCreation : null,
    longestNoProgressTicks: longestNoProgress,
    tasks,
    ownershipTelemetry: {
      messages: [...runtime.peers.values()].reduce((s,p)=>s+Object.values(p.sentByKind).reduce((a,b)=>a+b,0),0),
      peerTicks: runtime.world.tick * runtime.peers.size,
      staleRejected: [...runtime.peers.values()].reduce((s,p)=>s+p.metrics.stale,0),
      auctionRounds: auctionRounds.size, certifiedRounds: certifiedRounds.size,
      peakConcurrentTasks: concurrentPeak, meanConcurrentTasks: concurrentSum/runtime.world.tick,
      duplicateExecutableOwners,
      ...(allocationMode === "event-grouped" ? { group: {
        bundleSizes:[...runtime.peers.values()].flatMap(p=>p.groupMetrics.bundleSizes),
        groupSizes:[...runtime.peers.values()].flatMap(p=>p.groupMetrics.groupSizes),
        certifiedBundles:Object.fromEntries([...runtime.peers.values()].flatMap(p=>[...p.certifiedBundles])),
        attempts:Object.fromEntries(record.tasks.map(t=>[t.id,[...new Set([...runtime.peers.values()].flatMap(p=>[...(p.groupAttempts.get(t.id)??[])]))]])),
        offers:[...runtime.peers.values()].reduce((s,p)=>s+p.groupMetrics.bids,0),
        proposals:[...runtime.peers.values()].reduce((s,p)=>s+p.groupMetrics.proposals,0),
        rejected:[...runtime.peers.values()].reduce((s,p)=>s+p.groupMetrics.rejected,0),
        refreshes:[...runtime.peers.values()].reduce((s,p)=>s+p.groupMetrics.refreshes,0),queueRobotTicks,queueTasks
      }} : {}),
    },
    releaseToAssignmentTicks: releaseToAssignment,
    assignmentToPickupTicks: assignmentToPickup,
    pickupToCompletionTicks: pickupToCompletion,
    phaseTicks,
    progressTicks,
    decisionReasons,
    meanInFlightTasks: motionTicks ? inFlightSum / motionTicks : null,
    peakInFlightTasks: peakInFlight,
    meanMovingRobots: motionTicks ? movingSum / motionTicks : null,
    ticksWithTwoOrMoreMovingRobots: concurrentMotionTicks,
    guidance: guidanceStats,
    energyHoldTicks: runtime.metrics.energyHolds,
    reroutes: runtime.metrics.reroutes,
    replans: runtime.world.metrics.replans,
    bidAttempts: runtime.metrics.aiBidAttempts,
    bidNonzeroCorrections: runtime.metrics.nonzeroCorrections,
    bidDisabledFallbacks: runtime.metrics.disabledFallbacks,
    safety,
    centralisedPibtCounters: {
      conflictCount: runtime.world.metrics.conflictCount,
      waitMoves: runtime.world.metrics.waitMoves,
      inheritedPriorities: runtime.world.metrics.inheritedPriorities,
      backtracks: runtime.world.metrics.backtracks,
    },
  };
}

/**
 * Install the experimental congestion-guidance layer on every robot.
 *
 * It is a per-cell ADDITIVE A* cost computed from that robot's own authorised
 * observation, evaluated once per replanning round. A* still picks the route,
 * the agent still resolves immediate conflict and guarantees safety, and
 * ownership, custody, charging and energy admission are untouched. Any throw
 * inside the model is swallowed by Agent/fleet and degrades to the plain
 * deterministic cost, so a broken model cannot change a decision.
 */
function installGuidance(runtime: FleetRuntime, model: RouteGuidanceModel, stats: { predictedCells: number; rejectedFeatures: number; replansWithGuidance: number }) {
  const degrees = new Map<string, Int8Array>();
  for (const robot of runtime.world.robots) {
    const agent = runtime.fleet.getAgent(robot.id);
    if (!agent) continue;
    agent.setTollField((observation) => {
      const deg = degreesFor(observation, degrees);
      const result = routeGuidanceTollField(model, observation, deg);
      stats.predictedCells += result.predicted;
      stats.rejectedFeatures += result.rejected;
      stats.replansWithGuidance++;
      return result.tolls;
    });
  }
}

const degreesFor = (observation: { map: { width: number; height: number; cells: { blocked: boolean }[] } }, cache: Map<string, Int8Array>) => {
  const k = `${observation.map.width}:${observation.map.height}:${observation.map.cells.map((c) => (c.blocked ? "#" : ".")).join("")}`;
  let d = cache.get(k);
  if (!d) { d = degreeField(observation.map as never); cache.set(k, d); }
  return d;
};
