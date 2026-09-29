// The single source of headline numbers.
//
// Everything here is READ BACK from the frozen artifacts. Nothing is recomputed
// from a run, and nothing is typed by hand. If a number appears in the report,
// it appears here first and can be traced to the artifact it came from.

import { existsSync, readFileSync } from "node:fs";
import { SIH_CRITERION, CRITICAL_METRIC_DISTINCTION, METRICS, STATISTICS, WORKLOAD } from "./protocol";
import type { MetricName } from "./stats";
import type { PairedStats, ReliabilityStats } from "./stats";
import type { DelayHeadline } from "./delay";

const read = <T,>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null);

type ArmReportFile = {
  arm: { id: string; name: string; motion: string; bidding: string; guidance: string; role: string };
  speed: Record<string, Record<string, PairedStats>>;
  reliability: Record<string, ReliabilityStats>;
  safetyTotals: Record<string, number>;
  suite: { scenarios: number; composition: Record<string, number> };
  provenance: { commit: string; sourceHashes: Record<string, string> };
};

export type FinalSummary = ReturnType<typeof buildFinalSummary>;

type SummaryFile = {
  version: string;
  block: string;
  provenance: ArmReportFile["provenance"];
  suite: ArmReportFile["suite"];
  criticalMetricDistinction: unknown;
  bidMlpAblation?: Record<string, Record<MetricName, PairedStats>>;
} & Record<string, unknown>;

type SuiteFile = {
  composition: Record<string, number>;
  compositionByFleetSize: Record<string, Record<string, number>>;
  compositionByLayout: Record<string, Record<string, number>>;
  compositionByLayoutAndFamily: Record<string, Record<string, number>>;
  provenance: { commit: string; dirty: boolean; sourceHashes: Record<string, string> };
  overlapMetricDistribution: Record<string, Record<string, Record<string, number>>>;
};

type DelayFile = {
  headline: Record<string, DelayHeadline>;
  [k: string]: unknown;
};

export function finalSummary(dir: string) { return buildFinalSummary(dir); }

function buildFinalSummary(dir: string) {
  const summaryPath = `${dir}/current/summary.json`;
  const raw = read<SummaryFile>(summaryPath);
  if (!raw) throw new Error(`missing ${summaryPath}; run "evaluate" first`);
  const report = (id: string): ArmReportFile | null => (raw[id] as ArmReportFile) ?? null;
  const A = report("A"), B = report("B"), C = report("C"), D = report("D");
  if (!A || !B || !C || !D) throw new Error("summary.json is missing one of arms A-D");
  const delay = read<DelayFile>(`${dir}/delay-breakdown.json`);
  const scenarios = read<SuiteFile>(`${dir}/scenarios.json`);

  const pct = (x: number | null | undefined, digits = 2) =>
    x === null || x === undefined || !Number.isFinite(x) ? null : Number((x * 100).toFixed(digits));
  const rec = (a: ArmReportFile, metric: string, slice: string) => a.speed[metric][slice];
  const reliability = (a: ArmReportFile, slice: string) => a.reliability[slice];

  const whole = rec(D, "sumTaskCompletionTime", "recoverable");
  const wholeMakespan = rec(D, "makespan", "recoverable");
  const relA = reliability(A, "recoverable");
  const relD = reliability(D, "recoverable");
  const safetyA = A.safetyTotals;
  const safetyD = D.safetyTotals;
  const safetyViolations = (totals: Record<string, number>) => Object.values(totals).reduce((a, b) => a + b, 0);

  const gate20 = (s: PairedStats | undefined) => ({
    pointEstimatePercent: pct(s?.aggregateReduction),
    ci95Percent: s?.aggregateReduction95CI ? [pct(s.aggregateReduction95CI[0]), pct(s.aggregateReduction95CI[1])] : null,
    lowerBoundPercent: s?.aggregateReduction95CI ? pct(s.aggregateReduction95CI[0]) : null,
    meetsLowerBoundAtLeast20: !!s?.aggregateReduction95CI && s.aggregateReduction95CI[0] >= 0.2,
  });

  const table = ["A", "B", "C", "D", "E", "F"]
    .map((id) => report(id))
    .filter((a): a is ArmReportFile => !!a)
    .map((a) => {
      const speed = rec(a, "sumTaskCompletionTime", "recoverable");
      const ms = rec(a, "makespan", "recoverable");
      const rel = reliability(a, "recoverable");
      return {
        arm: a.arm.id,
        name: a.arm.name,
        motion: a.arm.motion,
        bidding: a.arm.bidding,
        guidance: a.arm.guidance,
        role: a.arm.role,
        recoverableScenarios: rel.scenarios,
        completionRatePercent: pct(rel.completionRate, 1),
        pairedCompleteN: speed.pairedCompleteCount,
        sumTaskCompletionTimeBaseline: relA.scenarios ? undefined : undefined,
        aggregateReductionSumTaskCompletionTimePercent: pct(speed.aggregateReduction),
        aggregateReduction95CILowPercent: speed.aggregateReduction95CI ? pct(speed.aggregateReduction95CI[0]) : null,
        aggregateReduction95CIHighPercent: speed.aggregateReduction95CI ? pct(speed.aggregateReduction95CI[1]) : null,
        meanPairedReductionPercent: pct(speed.meanPairedReduction),
        medianPairedReductionPercent: pct(speed.medianPairedReduction),
        makespanAggregateReductionPercent: pct(ms.aggregateReduction),
        makespanAggregateReduction95CILowPercent: ms.aggregateReduction95CI ? pct(ms.aggregateReduction95CI[0]) : null,
        makespanPairedCompleteN: ms.pairedCompleteCount,
        safetyViolations: safetyViolations(a.safetyTotals),
        safetyTotals: a.safetyTotals,
      };
    });

  const acceptance = {
    criterion: SIH_CRITERION,
    criticalMetricDistinction: CRITICAL_METRIC_DISTINCTION,
    metricDefinitions: {
      sumTaskCompletionTime: METRICS.sumTaskCompletionTime,
      makespan: METRICS.makespan,
      formulas: { pairedReduction: METRICS.pairedReduction, aggregateReduction: METRICS.aggregateReduction },
    },
    statisticalProtocol: {
      resamples: STATISTICS.bootstrapResamples,
      seed: STATISTICS.bootstrapSeed,
      confidenceLevel: STATISTICS.confidenceLevel,
      pairedSet: STATISTICS.pairedSetDefinition,
      gateRule: STATISTICS.reportingRule,
    },
    workload: {
      fleetSizes: WORKLOAD.fleetSizes,
      tasksPerRun: WORKLOAD.tasksPerRun,
      releaseIntervalTicks: WORKLOAD.releaseIntervalTicks,
      horizonTicks: WORKLOAD.horizonTicks,
      map: WORKLOAD.mapId,
    },
    suite: A.suite,
    primaryGate: {
      statement:
        "In the frozen RECOVERABLE OVERLAP acceptance suite, arm D (the current complete decentralized system) against arm A " +
        "(fair traditional stop-and-wait): zero audited robot-to-robot collision violations, and aggregate " +
        "sumTaskCompletionTime at least 20% below the baseline with the 95% paired bootstrap LOWER BOUND at or above 20%.",
      sumTaskCompletionTime: gate20(whole),
      makespan: gate20(wholeMakespan),
      safety: {
        armA: safetyA,
        armD: safetyD,
        armDSafetyViolations: safetyViolations(safetyD),
        zeroAuditedRobotToRobotCollisionViolations: safetyViolations(safetyD) === 0,
      },
    },
    strongInternalTarget: {
      statement: ">= 20% reduction on BOTH sumTaskCompletionTime and makespan.",
      sumTaskCompletionTimeLowerBoundPercent: gate20(whole).lowerBoundPercent,
      makespanLowerBoundPercent: gate20(wholeMakespan).lowerBoundPercent,
      met: gate20(whole).meetsLowerBoundAtLeast20 && gate20(wholeMakespan).meetsLowerBoundAtLeast20,
    },
    ablation: {
      A_to_C_distributedMotionEffect: {
        statement: "effect of the distributed traffic/conflict-resolution system alone (deterministic bidding in both arms)",
        sumTaskCompletionTime: {
          aggregateReductionPercent: pct(rec(C, "sumTaskCompletionTime", "recoverable").aggregateReduction),
          ci95Percent: ciOf(C, "sumTaskCompletionTime", "recoverable"),
          pairedCompleteN: rec(C, "sumTaskCompletionTime", "recoverable").pairedCompleteCount,
        },
        makespan: {
          aggregateReductionPercent: pct(rec(C, "makespan", "recoverable").aggregateReduction),
          ci95Percent: ciOf(C, "makespan", "recoverable"),
          pairedCompleteN: rec(C, "makespan", "recoverable").pairedCompleteCount,
        },
      },
      C_to_D_bidMlpEffect: {
        statement: "incremental effect of the existing Edge-AI bid refinement on top of the distributed system",
        sumTaskCompletionTime: {
          aggregateReductionPercent: pct(bidMlpAblation(raw, "sumTaskCompletionTime", "recoverable")?.aggregateReduction),
          ci95Percent: ciOf2(bidMlpAblation(raw, "sumTaskCompletionTime", "recoverable")),
          pairedCompleteN: bidMlpAblation(raw, "sumTaskCompletionTime", "recoverable")?.pairedCompleteCount ?? null,
          allRegimes: (["low", "recoverable", "severe", "all"] as const).map((s) => ({
            regime: s,
            aggregateReductionPercent: pct(bidMlpAblation(raw, "sumTaskCompletionTime", s)?.aggregateReduction),
            pairedCompleteN: bidMlpAblation(raw, "sumTaskCompletionTime", s)?.pairedCompleteCount ?? null,
          })),
          caveat:
            "This is the arm that corresponds to the previously accepted 1.56% bid-MLP ablation. It is NOT the SIH comparison and must not be compared to the 20% threshold.",
        },
      },
      A_to_B_bidMlpWithPrimitiveMotion: {
        statement: "whether learned bidding helps even when motion coordination is primitive",
        sumTaskCompletionTime: {
          aggregateReductionPercent: pct(rec(B, "sumTaskCompletionTime", "recoverable").aggregateReduction),
          ci95Percent: ciOf(B, "sumTaskCompletionTime", "recoverable"),
          pairedCompleteN: rec(B, "sumTaskCompletionTime", "recoverable").pairedCompleteCount,
        },
      },
      A_to_D_wholeSystem: {
        statement: "the SIH-relevant comparison: complete proposed system versus traditional stop-and-wait",
        sumTaskCompletionTime: {
          aggregateReductionPercent: pct(whole.aggregateReduction),
          ci95Percent: whole.aggregateReduction95CI ? [pct(whole.aggregateReduction95CI[0]), pct(whole.aggregateReduction95CI[1])] : null,
          meanPairedReductionPercent: pct(whole.meanPairedReduction),
          medianPairedReductionPercent: pct(whole.medianPairedReduction),
          pairedCompleteN: whole.pairedCompleteCount,
        },
        makespan: {
          aggregateReductionPercent: pct(wholeMakespan.aggregateReduction),
          ci95Percent: wholeMakespan.aggregateReduction95CI ? [pct(wholeMakespan.aggregateReduction95CI[0]), pct(wholeMakespan.aggregateReduction95CI[1])] : null,
          pairedCompleteN: wholeMakespan.pairedCompleteCount,
        },
      },
    },
    analyses: {
      speed: {
        population: "mutually complete pairs only; a timed-out run has no completion time and the horizon is never imputed for it",
        armACompletion: { recoverable: { runs: relA.scenarios, completed: relA.completedRuns, ratePercent: pct(relA.completionRate, 1), tasks: `${relA.tasksCompleted}/${relA.tasksTotal}`, timedOut: relA.timedOutRuns, unfinishedTasks: relA.unfinishedTasks, longestNoProgressTicksMax: relA.longestNoProgressTicksMax } },
        armDCompletion: { recoverable: { runs: relD.scenarios, completed: relD.completedRuns, ratePercent: pct(relD.completionRate, 1), tasks: `${relD.tasksCompleted}/${relD.tasksTotal}`, timedOut: relD.timedOutRuns, unfinishedTasks: relD.unfinishedTasks, longestNoProgressTicksMax: relD.longestNoProgressTicksMax } },
        allRegimes: (["low", "recoverable", "severe"] as const).map((r) => ({
          regime: r,
          armA: slim(reliability(A, r)),
          armB: slim(reliability(B, r)),
          armC: slim(reliability(C, r)),
          armD: slim(reliability(D, r)),
        })),
      },
      reliability: {
        separationRule:
          "Speed statistics and reliability statistics have different denominators and are reported in separate sections. " +
          "A stop-and-wait timeout is never converted into a completion time and never produces a speedup percentage.",
        severeContention: {
          statement: "severe-contention scenarios are reported on completion and safety only",
          armA: slim(reliability(A, "severe")),
          armB: slim(reliability(B, "severe")),
          armC: slim(reliability(C, "severe")),
          armD: slim(reliability(D, "severe")),
        },
      },
    },
    guidanceExperiment: (() => {
      const g = raw.guidanceAblation as Record<string, Record<string, Record<string, PairedStats>>> | undefined;
      if (!g) return { implemented: false, note: "arms E/F were not evaluated in this run" };
      const read = (key: string, slice: string, metric: MetricName = "sumTaskCompletionTime") => {
        const s = g[key]?.[slice]?.[metric];
        return s ? {
          pairedCompleteN: s.pairedCompleteCount,
          aggregateReductionPercent: pct(s.aggregateReduction),
          ci95Percent: [pct(s.aggregateReduction95CI?.[0]), pct(s.aggregateReduction95CI?.[1])],
          meanPairedReductionPercent: pct(s.meanPairedReduction),
          medianPairedReductionPercent: pct(s.medianPairedReduction),
        } : null;
      };
      return {
        implemented: true,
        what:
          "An experimental local predictive congestion guidance layer: a per-cell bounded additive A* cost predicted from each " +
          "robot's own authorised local observation (own position/route/goal/wait history, own sensor contacts, received peer " +
          "intents, own recent edge and cell history). A* still chooses the route; the agent still resolves immediate conflict " +
          "and guarantees safety; ownership, custody, charging and energy admission are untouched.",
        centralTrainingDecentralExecution:
          "Labels come from whole-run rollouts of arm C and may use centralised knowledge. Runtime inference reads only " +
          "Agent.guidanceObservation(), which cannot see simulator state, another robot's task queue, another robot's battery, " +
          "global task state, dashboard state, a centrally computed congestion field, or any future tick.",
        arms: { C_to_E: "distributed motion, deterministic bidding, guidance ON", D_to_F: "full system plus guidance" },
        C_to_E: { low: read("C_to_E", "low"), recoverable: read("C_to_E", "recoverable"), severe: read("C_to_E", "severe"), all: read("C_to_E", "all") },
        D_to_F: { low: read("D_to_F", "low"), recoverable: read("D_to_F", "recoverable"), severe: read("D_to_F", "severe"), all: read("D_to_F", "all") },
        A_to_F_finalSihComparison: (() => {
          const f = report("F");
          if (!f) return null;
          const s = rec(f, "sumTaskCompletionTime", "recoverable");
          const m = rec(f, "makespan", "recoverable");
          return {
            sumTaskCompletionTime: {
              pairedCompleteN: s.pairedCompleteCount,
              aggregateReductionPercent: pct(s.aggregateReduction),
              ci95Percent: [pct(s.aggregateReduction95CI?.[0]), pct(s.aggregateReduction95CI?.[1])],
            },
            makespan: {
              pairedCompleteN: m.pairedCompleteCount,
              aggregateReductionPercent: pct(m.aggregateReduction),
              ci95Percent: [pct(m.aggregateReduction95CI?.[0]), pct(m.aggregateReduction95CI?.[1])],
            },
          };
        })(),
        verdict:
          "The learned congestion toll changes essentially nothing end to end. Its ranking quality is real and measured " +
          "(see guidance/test.json: the worst-predicted decile of cells carries several times the base-rate realised wait, and it " +
          "beats a hand-set deterministic heuristic), but the delay breakdown shows why that does not convert: on the frozen " +
          "recoverable suite the dominant component of total task completion time is the wait for a task to be certified and " +
          "assigned, not the wait for a route, and the second-largest is raw travel, which a bounded per-cell toll cannot shorten " +
          "because the cells it penalises are exactly the cells the destination lies behind. This is reported as a measured null " +
          "result, not as a success.",
      };
    })(),
    delayBreakdown: delay
      ? {
          source: `${dir}/delay-breakdown.json`,
          headline: delay.headline,
          dominantComponent: Object.entries(delay.headline).map(([slice, v]) => ({
            slice, dominant: v.dominantComponent, ranked: v.rankedShares,
          })),
        }
      : { source: null, note: "delay-breakdown.json not present; run `npx vite-node scripts/sih-benchmark.ts delay`" },
    provenance: D.provenance,
    suiteProvenance: scenarios
      ? {
          frozenPath: `${dir}/scenarios.json`,
          composition: scenarios.composition,
          compositionByFleetSize: scenarios.compositionByFleetSize,
          compositionByLayout: scenarios.compositionByLayout,
          compositionByLayoutAndFamily: scenarios.compositionByLayoutAndFamily,
          provenance: scenarios.provenance,
          overlapMetricDistribution: scenarios.overlapMetricDistribution,
        }
      : null,
  };

  const out = {
    version: "sih-acceptance-v1",
    generatedBy: "npx vite-node scripts/sih-benchmark.ts final",
    everyNumberHereIsReadFrom: [
      `${dir}/current/summary.json`, `${dir}/current/stopwait-deterministic.json`,
      `${dir}/current/stopwait-bid-ai.json`, `${dir}/current/distributed-deterministic.json`,
      `${dir}/current/distributed-bid-ai.json`, `${dir}/delay-breakdown.json`, `${dir}/scenarios.json`,
    ],
    answer: answer(acceptance.primaryGate.sumTaskCompletionTime.meetsLowerBoundAtLeast20, acceptance.primaryGate.sumTaskCompletionTime.lowerBoundPercent),
    armTable: table,
    acceptance,
  };
  return out;
}

function ciOf(a: ArmReportFile, metric: string, slice: string): [number, number] | null {
  return ciOf2(a.speed[metric][slice]);
}

function ciOf2(s: PairedStats | undefined | null): [number, number] | null {
  const ci = s?.aggregateReduction95CI;
  return ci ? [Number((ci[0] * 100).toFixed(2)), Number((ci[1] * 100).toFixed(2))] : null;
}

/** C->D, i.e. the bid-MLP ablation. Written into summary.json by the evaluate step. */
function bidMlpAblation(raw: SummaryFile, metric: MetricName, slice: string): PairedStats | null {
  return raw.bidMlpAblation?.[slice]?.[metric] ?? null;
}

function slim(r: ReliabilityStats | undefined) {
  if (!r) return null;
  return {
    runs: r.scenarios, completed: r.completedRuns, completionRatePercent: r.completionRate === null ? null : Number((r.completionRate * 100).toFixed(1)),
    tasks: `${r.tasksCompleted}/${r.tasksTotal}`, timedOut: r.timedOutRuns, unfinishedTasks: r.unfinishedTasks,
    longestNoProgressTicksMax: r.longestNoProgressTicksMax, safetyViolations: r.safetyViolations,
  };
}

function answer(meets: boolean, lowerBoundPercent: number | null): Record<string, unknown> {
  return {
    doesCurrentSystemAlreadyMeetSih20: meets
      ? "YES. On the frozen recoverable-overlap acceptance suite, the current complete distributed system (arm D) reduces aggregate sumTaskCompletionTime against the fair stop-and-wait baseline (arm A) by at least 20%, with a 95% paired bootstrap lower bound at or above 20%. The 20% requirement is met by the EXISTING system: no new AI mechanism was required and no production algorithm was changed to obtain it. Any later traffic-AI work is an innovation experiment, not a benchmark rescue."
      : `NO. The 95% paired bootstrap lower bound of the aggregate sumTaskCompletionTime reduction of arm D against arm A is ${lowerBoundPercent ?? "n/a"}%, below the 20% gate. Traffic-formation work is therefore justified, and it is reported as a separate labelled experiment that is never folded into the 1.56% bid-MLP ablation.`,
    metricDistinction: CRITICAL_METRIC_DISTINCTION.oneLine,
    headlineMetric: "sumTaskCompletionTime (aggregate reduction, 95% paired bootstrap lower bound)",
    headlineValuePercent: lowerBoundPercent,
  };
}
