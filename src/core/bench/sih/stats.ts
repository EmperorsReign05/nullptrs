// Statistics for the SIH acceptance benchmark.
//
// Every formula here is fixed in src/core/bench/sih/protocol.ts and was written
// before any arm was executed. None of them is chosen, reweighted or reselected
// after seeing a result.
//
// Two analyses, two denominators, never combined:
//   SPEED      - mutually complete pairs only. A scenario that timed out has no
//                completion time, and the horizon is never imputed for it.
//   RELIABILITY - every frozen scenario in the regime, conditioned on nothing.

import { ANALYSES, METRICS, STATISTICS } from "./protocol";
import type { ArmRun } from "./runner";

export type MetricName = "sumTaskCompletionTime" | "makespan";

export const metricOf = (run: ArmRun, metric: MetricName): number | null => {
  const value = run[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** Deterministic LCG for the bootstrap, seeded by the frozen spec. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const k = Math.floor(a.length / 2);
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
}
const quantile = (sorted: number[], q: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.min(sorted.length - 1, q)))] : null;

export type PairedSample = {
  scenarioId: string;
  seed: number;
  fleetSize: number;
  regime: string;
  endpointFamily: string;
  baseline: number;
  treatment: number;
  reduction: number;
};

export type PairedStats = {
  metric: string;
  definition: string;
  /** MUTUALLY COMPLETE pairs only. Always reported next to the interval. */
  pairedCompleteCount: number;
  candidates: number;
  baselineOnlyComplete: number;
  treatmentOnlyComplete: number;
  neitherComplete: number;
  baselineTotal: number;
  treatmentTotal: number;
  baselineMean: number | null;
  treatmentMean: number | null;
  baselineMedian: number | null;
  treatmentMedian: number | null;
  /** 1 - SUM(treatment) / SUM(baseline) over the paired-complete set. */
  aggregateReduction: number | null;
  aggregateReduction95CI: [number, number] | null;
  meanPairedReduction: number | null;
  meanPairedReduction95CI: [number, number] | null;
  medianPairedReduction: number | null;
  medianPairedReduction95CI: [number, number] | null;
  wins: number;
  ties: number;
  losses: number;
  bootstrapResamples: number;
};

const pair = (baseline: ArmRun[], treatment: ArmRun[], metric: MetricName): PairedSample[] => {
  const byId = new Map(treatment.map((r) => [r.scenarioId, r]));
  const out: PairedSample[] = [];
  for (const b of baseline) {
    const t = byId.get(b.scenarioId);
    if (!t) continue;
    // MUTUALLY COMPLETE, and the test is `completed`, never `isFinite(value)`.
    //
    // sumTaskCompletionTime is a finite number even for a run that retired no
    // task at all (it is the sum over an empty set), so a finiteness test silently
    // admits timed-out runs and then reports them as if their horizon were a
    // completion time. That is precisely the imputation this benchmark forbids,
    // and it is invisible in the output because the aggregate stays plausible.
    // makespan is null for a timed-out run and would have caught it; the two
    // metrics must not be gated differently.
    if (!b.completed || !t.completed) continue;
    const bv = metricOf(b, metric), tv = metricOf(t, metric);
    if (bv === null || tv === null) continue;
    out.push({
      scenarioId: b.scenarioId, seed: b.seed, fleetSize: b.fleetSize, regime: b.regime,
      endpointFamily: b.endpointFamily, baseline: bv, treatment: tv,
      reduction: bv === 0 ? 0 : (bv - tv) / bv,
    });
  }
  return out;
};

/** Fixed 95% paired bootstrap percentile interval. */
function bootstrap(samples: PairedSample[]) {
  const [lo, hi] = STATISTICS.percentileIndices as [number, number];
  const n = samples.length;
  if (!n) return null;
  const random = rng(STATISTICS.bootstrapSeed);
  const aggregate: number[] = [], means: number[] = [], medians: number[] = [];
  for (let b = 0; b < STATISTICS.bootstrapResamples; b++) {
    let sumB = 0, sumT = 0, sumR = 0;
    const drawn: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = samples[Math.floor(random() * n)];
      sumB += s.baseline; sumT += s.treatment; sumR += s.reduction; drawn.push(s.reduction);
    }
    aggregate.push(1 - sumT / sumB);
    means.push(sumR / n);
    drawn.sort((x, y) => x - y);
    medians.push(n % 2 ? drawn[(n - 1) >> 1] : (drawn[n / 2 - 1] + drawn[n / 2]) / 2);
  }
  aggregate.sort((a, b) => a - b); means.sort((a, b) => a - b); medians.sort((a, b) => a - b);
  return {
    aggregateReduction95CI: [quantile(aggregate, lo)!, quantile(aggregate, hi)!] as [number, number],
    meanPairedReduction95CI: [quantile(means, lo)!, quantile(means, hi)!] as [number, number],
    medianPairedReduction95CI: [quantile(medians, lo)!, quantile(medians, hi)!] as [number, number],
  };
}

export function pairedStats(baseline: ArmRun[], treatment: ArmRun[], metric: MetricName): PairedStats {
  const samples = pair(baseline, treatment, metric);
  const bIds = new Map(baseline.map((r) => [r.scenarioId, r]));
  const candidates = treatment.length;
  let baselineOnlyComplete = 0, treatmentOnlyComplete = 0, neitherComplete = 0;
  for (const t of treatment) {
    const b = bIds.get(t.scenarioId);
    const bok = !!b && b.completed;
    const tok = t.completed;
    if (bok && tok) continue;
    if (bok) baselineOnlyComplete++;
    else if (tok) treatmentOnlyComplete++;
    else neitherComplete++;
  }
  const ci = bootstrap(samples);
  const sumB = samples.reduce((a, s) => a + s.baseline, 0);
  const sumT = samples.reduce((a, s) => a + s.treatment, 0);
  return {
    metric: METRICS[metric as keyof typeof METRICS] as unknown as string,
    definition: metric === "sumTaskCompletionTime" ? METRICS.sumTaskCompletionTime : METRICS.makespan,
    pairedCompleteCount: samples.length,
    candidates,
    baselineOnlyComplete,
    treatmentOnlyComplete,
    neitherComplete,
    baselineTotal: sumB,
    treatmentTotal: sumT,
    baselineMean: mean(samples.map((s) => s.baseline)),
    treatmentMean: mean(samples.map((s) => s.treatment)),
    baselineMedian: median(samples.map((s) => s.baseline)),
    treatmentMedian: median(samples.map((s) => s.treatment)),
    aggregateReduction: sumB === 0 ? null : 1 - sumT / sumB,
    aggregateReduction95CI: ci?.aggregateReduction95CI ?? null,
    meanPairedReduction: mean(samples.map((s) => s.reduction)),
    meanPairedReduction95CI: ci?.meanPairedReduction95CI ?? null,
    medianPairedReduction: median(samples.map((s) => s.reduction)),
    medianPairedReduction95CI: ci?.medianPairedReduction95CI ?? null,
    wins: samples.filter((s) => s.reduction > 0).length,
    ties: samples.filter((s) => s.reduction === 0).length,
    losses: samples.filter((s) => s.reduction < 0).length,
    bootstrapResamples: STATISTICS.bootstrapResamples,
  };
}

export type ReliabilityStats = {
  arm: string;
  scenarios: number;
  completedRuns: number;
  completionRate: number;
  tasksCompleted: number;
  tasksTotal: number;
  timedOutRuns: number;
  unfinishedTasks: number;
  longestNoProgressTicksMax: number;
  longestNoProgressTicksMean: number | null;
  /** Ticks spent, reported so a timeout is visible as effort rather than as a time. */
  ticksRunTotal: number;
  safetyTotals: Record<string, number>;
  safetyViolations: number;
  bidNonzeroCorrections: number;
  definition: string;
};

export function reliabilityStats(runs: ArmRun[]): ReliabilityStats {
  const safetyTotals: Record<string, number> = {};
  let violations = 0;
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.safety)) {
      safetyTotals[k] = (safetyTotals[k] ?? 0) + v;
      violations += v;
    }
  }
  const timedOut = runs.filter((r) => !r.completed);
  return {
    arm: runs[0]?.armName ?? "?",
    scenarios: runs.length,
    completedRuns: runs.length - timedOut.length,
    completionRate: runs.length ? (runs.length - timedOut.length) / runs.length : null as unknown as number,
    tasksCompleted: runs.reduce((a, r) => a + r.tasksCompleted, 0),
    tasksTotal: runs.reduce((a, r) => a + r.tasksTotal, 0),
    timedOutRuns: timedOut.length,
    unfinishedTasks: runs.reduce((a, r) => a + (r.tasksTotal - r.tasksCompleted), 0),
    longestNoProgressTicksMax: runs.length ? Math.max(...runs.map((r) => r.longestNoProgressTicks)) : 0,
    longestNoProgressTicksMean: mean(runs.map((r) => r.longestNoProgressTicks)),
    ticksRunTotal: runs.reduce((a, r) => a + r.ticksRun, 0),
    safetyTotals,
    safetyViolations: violations,
    bidNonzeroCorrections: runs.reduce((a, r) => a + r.bidNonzeroCorrections, 0),
    definition: ANALYSES.reliability,
  };
}

export function subset(runs: ArmRun[], filter: Partial<Pick<ArmRun, "regime" | "fleetSize" | "endpointFamily">>): ArmRun[] {
  return runs.filter((r) =>
    (filter.regime === undefined || r.regime === filter.regime) &&
    (filter.fleetSize === undefined || r.fleetSize === filter.fleetSize) &&
    (filter.endpointFamily === undefined || r.endpointFamily === filter.endpointFamily));
}

export function pairedSamples(baseline: ArmRun[], treatment: ArmRun[], metric: MetricName): PairedSample[] {
  return pair(baseline, treatment, metric);
}
