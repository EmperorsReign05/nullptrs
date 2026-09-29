// SIH 2026 acceptance benchmark, version 1 — FROZEN PROTOCOL.
//
// This file is the single source of truth for the benchmark. Everything it
// declares is written verbatim into artifacts/sih-acceptance-v1/benchmark-spec.json
// by scripts/sih-benchmark.ts, and the runners read their parameters from here,
// so the documented protocol and the executed protocol cannot drift apart.
//
// ---------------------------------------------------------------------------
// THE TWO PERCENTAGES ARE NOT THE SAME EXPERIMENT. READ THIS FIRST.
// ---------------------------------------------------------------------------
//
// SIH26123 asks for >= 20% reduction in TOTAL TASK COMPLETION TIME versus
// TRADITIONAL STOP-AND-WAIT, on workloads with OVERLAPPING PATHS, with zero
// inter-robot collisions. That is a SYSTEM-LEVEL comparison: our complete
// proposed decentralized system against a classic coordination baseline.
//
// The 1.56% figure already accepted in this repository is a DIFFERENT
// experiment: same coordination stack, same motion system, deterministic task
// bidding vs the learned bid-refinement MLP, 200 unseen scenarios, 2,800 tasks,
// 43 allocation winners changed, 1.56% aggregate paired completion-time
// improvement. It measures the INCREMENTAL CONTRIBUTION OF THE BID MLP ONLY.
//
//     1.56% = bid-MLP incremental ablation.
//     20%   = whole-system improvement over stop-and-wait.
//     They are different experiments and must never be compared directly.
//
// The 2x2 ablation below exists precisely to keep those apart:
//     A -> C  effect of the distributed traffic/conflict-resolution system
//     C -> D  incremental effect of the Edge-AI bid refinement
//     A -> D  the SIH-relevant whole-system comparison
//     A -> B  whether learned bidding helps even with primitive motion
// ---------------------------------------------------------------------------

export const SIH_BENCHMARK_VERSION = "sih-acceptance-v1";

/** The literal criterion, as a machine-readable structure. */
export const SIH_CRITERION = {
  source: "SIH 2026 (SIH26123) success criterion, as supplied with this task",
  quotedClauses: [
    "zero inter-robot collisions",
    "minimum 20% reduction in TOTAL TASK COMPLETION TIME",
    "compared with traditional STOP-AND-WAIT",
    "specifically while handling OVERLAPPING PATHS",
  ],
  // Stated up front, because the phrase is not mathematically defined by the
  // problem statement and a benchmark that picks one reading after seeing the
  // numbers is not a benchmark.
  ambiguityResolution:
    "'Total task completion time' is not defined mathematically by the problem statement, " +
    "so BOTH reasonable readings are measured and reported separately, never merged: " +
    "(1) sumTaskCompletionTime = SUM over tasks of (completionTick - createdAt), and " +
    "(2) makespan = lastTaskCompletionTick - firstTaskCreationTick. " +
    "The headline number is always named. '20% faster' is never written unqualified.",
  primaryAcceptanceMetric: "sumTaskCompletionTime",
  thresholdPercent: 20,
  headlineRegime: "recoverable",
} as const;

export const CRITICAL_METRIC_DISTINCTION = {
  oneLine: "1.56% = bid-MLP incremental ablation. 20% = whole-system improvement over stop-and-wait. They are different experiments.",
  oneFiveSixPercent: {
    what: "aggregate paired improvement in task completion time from replacing DETERMINISTIC task bidding with the learned bid-refinement MLP, on the SAME distributed coordination stack and the SAME motion/conflict-resolution system",
    scale: "2,800 tasks over 200 unseen scenarios; 43 allocation winners changed",
    verdict: "measures the incremental contribution of the bid MLP only. NOT a SIH comparison.",
  },
  twentyPercent: {
    what: "required reduction in total task completion time of the COMPLETE proposed decentralized system relative to a traditional stop-and-wait coordination baseline, on overlapping-path workloads",
    scale: "whole system: motion coordination + conflict resolution + task allocation + safety + energy admission",
    verdict: "the SIH comparison. Only this number may be compared to the 20% threshold.",
  },
  forbiddenInferences: [
    "Do not write 'our AI needs to reach 20%' unless a benchmark demonstrates the missing component is the AI.",
    "Do not present 1.56% as a partial result towards 20%.",
    "Do not subtract 1.56% from, or add it to, the whole-system number.",
  ],
} as const;

/** The four (later six) policy arms. Motion x Bidding x Guidance. */
export type ArmId = "A" | "B" | "C" | "D" | "E" | "F";
export type ArmSpec = {
  id: ArmId;
  name: string;
  motion: "stop-and-wait" | "distributed";
  bidding: "deterministic" | "edge-ai-bid-refinement";
  guidance: "off" | "predictive-congestion-toll";
  /** What this arm is for in the ablation. */
  role: string;
  /** Which FleetRuntime configuration it selects. */
  runtime: { motionPolicy?: "stop-and-wait"; aiEnabled: boolean; guidance: boolean };
};

export const ARMS: readonly ArmSpec[] = [
  {
    id: "A", name: "stopwait-deterministic",
    motion: "stop-and-wait", bidding: "deterministic", guidance: "off",
    role: "SIH BASELINE. Traditional stop-and-wait coordination with deterministic task bidding.",
    runtime: { motionPolicy: "stop-and-wait", aiEnabled: false, guidance: false },
  },
  {
    id: "B", name: "stopwait-bid-ai",
    motion: "stop-and-wait", bidding: "edge-ai-bid-refinement", guidance: "off",
    role: "Ablation A->B: does learned bidding help even when motion coordination is primitive?",
    runtime: { motionPolicy: "stop-and-wait", aiEnabled: true, guidance: false },
  },
  {
    id: "C", name: "distributed-deterministic",
    motion: "distributed", bidding: "deterministic", guidance: "off",
    role: "Ablation A->C: effect of the distributed traffic/conflict-resolution system alone.",
    runtime: { aiEnabled: false, guidance: false },
  },
  {
    id: "D", name: "distributed-bid-ai",
    motion: "distributed", bidding: "edge-ai-bid-refinement", guidance: "off",
    role: "CURRENT FULL SYSTEM. Ablation C->D isolates the bid MLP; A->D is the SIH comparison.",
    runtime: { aiEnabled: true, guidance: false },
  },
  {
    id: "E", name: "distributed-guidance-only",
    motion: "distributed", bidding: "deterministic", guidance: "predictive-congestion-toll",
    role: "Ablation C->E: incremental effect of route-level congestion-prediction AI.",
    runtime: { aiEnabled: false, guidance: true },
  },
  {
    id: "F", name: "distributed-full-ai",
    motion: "distributed", bidding: "edge-ai-bid-refinement", guidance: "predictive-congestion-toll",
    role: "Ablation D->F: route-level AI on top of the complete system. A->F is the final SIH comparison.",
    runtime: { aiEnabled: true, guidance: true },
  },
];

export const ARM_IDS: readonly ArmId[] = ARMS.map((a) => a.id);

/** Workload parameters. Identical for every arm of a scenario. */
export const WORKLOAD = {
  mapId: "stock-warehouse",
  mapNote:
    "createWarehouseMap() from src/core/map/warehouse.ts, unmodified. Every arm of a scenario " +
    "receives the identical WarehouseMap object contents; no arm may alter geometry.",
  // Workload density. A first development pass with 8 tasks released every 30
  // ticks left the fleet 84% idle, so routes overlapped GEOMETRICALLY but almost
  // never in TIME: Little's law put the number of tasks in flight at ~1.2 for
  // every fleet size. That is not the SIH workload, which is about robots meeting
  // on shared paths. The schedule below releases the whole order book in the
  // opening ticks, so concurrency is bounded by the fleet size rather than by the
  // release rate. tasksPerRun is NOT scaled with fleet size: the workload is
  // byte-identical at N=3, N=5 and N=8, so fleet size is the only variable.
  tasksPerRun: 12,
  releaseIntervalTicks: 6,
  firstTaskCreatedAtTick: 0,
  horizonTicks: 1500,
  initialBatteryPercent: 100,
  taskWeightKg: 1,
  taskPriority: 1,
  robotStartPlacement: "uniform over open cells, without replacement, Fisher-Yates driven by the scenario seed",
  movementSpeed: "one grid cell per robot per tick, every arm; no teleporting, no multi-cell steps",
  batteryDrainPercentPerCell: 0.5,
  chargingRule:
    "identical DistributedCharging lifecycle in every arm (recharge to 50%, 2%/tick, 15% reserve, " +
    "same charger selection, same active-route energy admission)",
  movementCostModel:
    "identical congestion-aware A* (src/core/pathfinding/astar.ts, CONGESTION_WEIGHT=1) in every arm, " +
    "including the stop-and-wait baseline",
  seedSpace: {
    // Disjoint integer blocks. The development block may be inspected; the
    // acceptance block is frozen into scenarios.json BEFORE any policy runs.
    development: { seedStart: 700000, note: "sanity/instrumentation only; never used for a headline number" },
    acceptance: { seedStart: 900000, note: "frozen into scenarios.json before any arm is evaluated" },
  },
  fleetSizes: [3, 5, 8],
  endpointFamilies: {
    uniform:
      "pickup and dropoff are uniform open cells, dropoff != pickup. Control regime: uncorrelated " +
      "demand, low expected path overlap.",
    sameAisle:
      "both endpoints lie in the same horizontal aisle (y in {0,4,8,12}). Short, partly independent legs.",
    mirroredCross:
      "pickup and dropoff are in opposite halves of the map at mirrored coordinates, so every delivery " +
      "must traverse the same central corridors. High opposing-flow overlap by construction.",
    columnTransit:
      "both endpoints lie in the same single-file vertical corridor (identical x, different y). Two-way " +
      "traffic inside a width-1 aisle: the maximum opposing-edge overlap the layout permits.",
  },
} as const;

/**
 * Overlap / static-capacity metric, and the regime thresholds.
 *
 * Every number in `regimeThresholds` was fixed from the GEOMETRIC distribution
 * of the workload generator, measured on the disjoint DEVELOPMENT seed block
 * (700000+) before any policy was executed on it. No policy outcome, runtime,
 * tick count or completion statistic entered their selection. The acceptance
 * seed block (900000+) is a disjoint, larger block that was not inspected while
 * these thresholds were being chosen.
 */
export const OVERLAP_METRIC = {
  legs: {
    delivery: "D_i = A*(pickup_i -> dropoff_i) on the static, congestion-free map, for each task i. These are the paths SIH means by 'overlapping paths'.",
    approach: "A_ri = A*(robot start r -> pickup_i). Reported as a component only: it scales with fleet size, so it is deliberately NOT used to classify, which keeps a scenario's regime a property of the workload rather than of the number of robots running it.",
    allRoutes: "single-agent, congestion-free A*, identical planner to every arm",
  },
  overlapIndex:
    "PRIMARY: mean over all unordered delivery-leg pairs of |cells(A) & cells(B)| / |cells(A) | cells(B)|, in [0,1]",
  reportedComponents: {
    headOnPairShare: "fraction of delivery-leg pairs that traverse at least one edge they share in OPPOSITE directions",
    contestedCellsPerRoute: "cells used by two or more delivery legs, divided by the number of delivery legs",
    approachOverlapIndex: "the same Jaccard index computed over the approach legs (fleet-size dependent; reported, not classified)",
    meanDeliveryLength: "mean delivery-leg length in cells",
    escapeFraction: "fraction of delivery legs that admit a route avoiding every cell they share with another delivery leg",
    maxDetourFactor: "max over escapable delivery legs of detourLength / shortestLength, or null when no leg escapes",
    zeroSlackRouteFraction: "fraction of (leg, cell) pairs whose cell has no traversable neighbour outside that leg's own route",
    maxZeroSlackRun: "longest run of consecutive no-passing-place cells on any single delivery leg",
  },
  regimeThresholds: {
    // Control regime: the workload does not meaningfully contend.
    lowMaxOverlapIndex: 0.055,
    // Acceptable band: genuinely interfering, but not by itself disqualifying.
    minOverlapIndex: 0.07,
    // Hard regime: interference this dense is treated as severe regardless of capacity.
    severeMinOverlapIndex: 0.14,
    // Static capacity floor. A route with no passing place on more than this
    // fraction of its cells, or a dead-end stretch longer than this, is a place
    // where a robot provably cannot get out of an opponent's way locally.
    minEscapeFraction: 0.25,
    maxZeroSlackRunLimit: 4,
    maxDetourFactorLimit: 2.5,
  },
  staticRecoverableRule:
    "staticRecoverable = overlapIndex >= minOverlapIndex AND escapeFraction >= minEscapeFraction AND " +
    "maxZeroSlackRun <= maxZeroSlackRunLimit AND maxDetourFactor <= maxDetourFactorLimit. " +
    "This is the static statement 'these routes are mostly along geometry that has passing opportunities, so the workload " +
    "is not inherently impossible'. It is a statement about the warehouse, not about any policy: a robot that meets an " +
    "opponent can always retreat to the nearest passing place and continue, which is exactly what a stop-and-wait agent " +
    "cannot do and what the proposed system can.",
  classificationRule: [
    "1. valid: every delivery leg is routable and every robot start can reach every pickup on the static map. An invalid candidate is not a usable workload and is dropped from every suite.",
    "2. regime = 'low'          if overlapIndex < lowMaxOverlapIndex",
    "3. regime = 'severe'       if overlapIndex >= severeMinOverlapIndex",
    "4. regime = 'severe'       if NOT staticRecoverable",
    "5. regime = 'recoverable'  otherwise",
    "Precedence is exactly the order above. The classification reads only the map, the robot starts and the task endpoints. No arm, no run, no tick and no outcome is an input.",
  ],
} as const;

/** Stop-and-wait baseline: the exact documented policy. */
export const STOP_AND_WAIT_POLICY = {
  implementation: "src/core/bench/stopwait.ts resolveStopAndWait, invoked unchanged by src/core/distributed/fleet.ts when FleetOptions.motionPolicy === 'stop-and-wait'",
  frozenAtCommit: "c4c5b3a38d7afa7be209bbb7b88cf9a314d20435",
  frozenSHA256: "da6c16356705314a4cd758c6e4a3c100fe94883a7ac1d6c75904f821cb91bc86",
  summary: "follow the A* route; if the intended next cell is occupied right now, or was already claimed by another robot this tick, do not move at all; resume as soon as it is free",
  sharedWithTreatment: [
    "the identical congestion-aware A* single-agent route planner (src/core/pathfinding/astar.ts)",
    "the identical static warehouse map",
    "the identical congestion field construction",
    "the identical replanning triggers (goal changed / route crosses a static wall / stranded on a stale goal / route runs into a locally-sensed persistent obstruction)",
    "the identical local obstruction memory learned from the agent's OWN sensor (Agent.noteBlocker) - this makes the baseline STRONGER, not weaker, because A* is then able to route around a parked robot",
    "the identical task ownership, quorum, custody, charging and energy-admission lifecycle",
    "the identical per-robot sensing, peer-intent refresh and one-cell-per-tick movement",
    "the identical simulation horizon and per-tick stall accounting",
  ],
  forbiddenAndAbsent: [
    "PIBT-style priority inheritance",
    "PIBT recursive displacement (pushing a lower-priority occupant)",
    "PIBT backtracking to a progress-reducing alternate cell",
    "safe escape-chain cycle breaking",
    "predictive/learned congestion guidance of any kind",
    "sensor-yield shuffling to a non-progressing neighbour",
    "step-aside into a passing bay or an idle-clearance relocation",
    "reciprocal head-on priority holding",
    "any deadlock-breaking behaviour copied from the proposed system",
  ],
  documentedAdvantageGivenToBaseline:
    "The baseline resolves every conflict SYNCHRONOUSLY with global visibility (it sees all bodies, including " +
    "inactive ones, and the full set of this tick's claims), while the treatment confirms its move locally " +
    "from received intents and a radius-two sensor. That asymmetry favours the BASELINE and is left in place " +
    "deliberately, so the reported improvement cannot be attributed to a stronger information model in the treatment.",
  notPathologicalJustification: [
    "It is given the same congestion-aware A* as the treatment, so it routes around jams by itself.",
    "It is given the same stall-triggered replanning (WAIT_REPLAN_THRESHOLD = 5 consecutive blocked ticks) and the same locally-learned obstruction memory, so a jam does not trap it forever.",
    "It is given the same energy admission, charging lifecycle and ownership protocol.",
    "Its horizon is identical to the treatment's; it is never truncated earlier.",
    "It is not given a shorter horizon, a worse planner, less information, fewer replans, or an earlier cutoff.",
  ],
} as const;

/** Metric definitions, written once and reused by every report. */
export const METRICS = {
  flowTime:
    "flowTime(task) = completionTick(task) - createdAt(task), in ticks. Measured for completed tasks only.",
  sumTaskCompletionTime:
    "sumTaskCompletionTime = SUM over COMPLETED tasks of flowTime. Total time all tasks collectively spent " +
    "from release to completion. This is the PRIMARY SIH metric and is always reported by this name.",
  makespan:
    "makespan = lastTaskCompletionTick - firstTaskCreationTick, in ticks. How long the fleet took to finish " +
    "the whole workload. Reported as the SECOND reading, never merged with the sum.",
  pairedReduction:
    "reduction_i = (T_stopwait_i - T_system_i) / T_stopwait_i, for paired scenario i, with T being the named metric.",
  aggregateReduction:
    "aggregateReduction = 1 - SUM(T_system_i) / SUM(T_stopwait_i) over the paired-complete set, for the named metric. FIXED before results were seen.",
  meanPairedReduction: "arithmetic mean of reduction_i over paired-complete scenarios",
  medianPairedReduction: "median of reduction_i over paired-complete scenarios",
  bootstrap:
    "95% paired bootstrap percentile interval: 10000 resamples with replacement of the paired-complete scenario set, " +
    "seeded by the fixed RNG seed declared in this spec, percentiles [250, 9750].",
  completion:
    "a scenario is COMPLETE for an arm when every task in the scenario reached status 'completed' before the horizon.",
  reliability:
    "reported over ALL scenarios in a regime, never only over the ones that succeeded: completion rate, tasks " +
    "completed of total, timed-out runs, unfinished tasks, longest no-progress period, safety counters.",
  prohibition:
    "A timed-out or deadlocked run has NO genuine completion time. The timeout horizon is never used as its " +
    "completion time in a headline percentage. Speed statistics and reliability statistics are reported separately " +
    "and are never combined into one number.",
} as const;

/** Statistical protocol, fixed up front. */
export const STATISTICS = {
  bootstrapResamples: 10000,
  bootstrapSeed: 20260923,
  confidenceLevel: 0.95,
  percentileIndices: [250, 9750],
  pairedSetDefinition:
    "Speed analysis uses MUTUALLY COMPLETE scenarios only: scenarios where BOTH the stop-and-wait arm A and the " +
    "arm under test completed every task. The paired count is always reported next to the interval.",
  reliabilitySetDefinition:
    "Reliability analysis uses ALL frozen scenarios in the regime, for every arm, with no conditioning on success.",
  multiplicity:
    "No seed may be added, removed or re-weighted after results are observed. Scenario count per cell is fixed " +
    "by this spec.",
  reportingRule:
    "The 20% gate is evaluated on the LOWER bound of the 95% paired bootstrap interval of the aggregate " +
    "reduction in sumTaskCompletionTime over the recoverable-overlap acceptance suite. The point estimate alone " +
    "never passes the gate.",
} as const;

/** Safety counters audited in every arm, every scenario. */
export const SAFETY_COUNTERS = [
  "overlaps", "swaps", "blockedCells", "zeroBatteryWork", "queueOverflow", "payloadViolations",
] as const;

/** The two analyses that must never be merged. */
export const ANALYSES = {
  speed:
    "POPULATION: mutually complete pairs only. ANSWERS: 'when both coordination schemes finish the workload, " +
    "how much less total task completion time does the proposed system take?' A timeout horizon is never imputed here.",
  reliability:
    "POPULATION: all frozen scenarios in the regime. ANSWERS: 'how often does each scheme finish at all, how many " +
    "tasks does it retire, and does it stay collision-free?' If stop-and-wait fails where the proposed system " +
    "completes, that is a RELIABILITY result and is reported as such. It is NOT a speedup of any percentage, and " +
    "in particular a failure is never scored as an infinite or 500% improvement.",
  separation:
    "These two are reported in separate sections with separate denominators. Neither is allowed to stand in for the other.",
} as const;

/** The full machine-readable spec, written to artifacts/sih-acceptance-v1/benchmark-spec.json. */
export function benchmarkSpec() {
  return {
    version: SIH_BENCHMARK_VERSION,
    frozen: true,
    criterion: SIH_CRITERION,
    criticalMetricDistinction: CRITICAL_METRIC_DISTINCTION,
    workload: WORKLOAD,
    overlapMetric: OVERLAP_METRIC,
    stopAndWaitBaseline: STOP_AND_WAIT_POLICY,
    arms: ARMS,
    metrics: METRICS,
    statistics: STATISTICS,
    analyses: ANALYSES,
    safetyCounters: SAFETY_COUNTERS,
    acceptance: {
      primary:
        "In the frozen RECOVERABLE OVERLAP acceptance suite, with the full system (arm D) measured against the fair " +
        "stop-and-wait baseline (arm A): zero audited robot-to-robot collision violations AND aggregate " +
        "sumTaskCompletionTime at least 20% below the baseline, with the 95% paired bootstrap lower bound of the " +
        "reduction at or above 20%.",
      strongInternal:
        ">= 20% reduction on BOTH sumTaskCompletionTime and makespan.",
      reliabilityRule:
        "Severe-contention scenarios are reported separately, always. A stop-and-wait timeout is never converted " +
        "into a completion time.",
      nonGoals: [
        "no redesign of ownership, quorum, custody, charging, transport or N-robot configuration without evidence from this benchmark",
        "no loosening of quorum or raising of safety thresholds to gain speed",
        "no retraining of the frozen bid MLP merely to chase 20%",
        "no centralisation of planning, no global traffic coordinator, no dashboard influence on robot decisions",
        "ML never replaces PIBT, never bypasses deterministic safety",
        "no cherry-picked benchmark seeds and no tuning on the final acceptance suite",
        "no modification of historical evidence",
      ],
    },
    regeneration: {
      note:
        "`generate` MUST be run before `evaluate`, and on the acceptance block it refuses to regenerate an existing frozen suite. " +
        "`--dev` selects the disjoint 700000+ development block; every command in this list defaults to the acceptance block.",
      writeSpec: "npx vite-node scripts/sih-benchmark.ts generate",
      regenerateDevSuite: "npx vite-node scripts/sih-benchmark.ts generate --dev --force",
      trainGuidance: "npx vite-node scripts/sih-benchmark.ts train-guidance",
      evaluateArmsAD: "npx vite-node scripts/sih-benchmark.ts evaluate --arms A,B,C,D",
      evaluateAllSix: "npx vite-node scripts/sih-benchmark.ts evaluate --arms A,B,C,D,E,F --model artifacts/sih-acceptance-v1/guidance/model.json",
      recomputeReportsWithoutRerunning: "npx vite-node scripts/sih-benchmark.ts summarise",
      delayBreakdown: "npx vite-node scripts/sih-benchmark.ts delay",
      finalSummary: "npx vite-node scripts/sih-benchmark.ts final",
      benchmarkTests: "npx vitest run tests/sih-benchmark.test.ts",
      headlineNumberInTheReport: "acceptance.primaryGate.sumTaskCompletionTime in artifacts/sih-acceptance-v1/final-summary.json",
    },
  };
}
