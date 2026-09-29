import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fitForest, forestScore, reportPredictions, type Forest } from "../src/core/ml/forest";
import { type RiskModel, type Sample, type Report } from "../src/core/ml/predictor";
import { applyStandardizer, predictOne, f1, type Confusion } from "../src/core/ml/logistic";
import { TEMPORAL_FEATURE_NAMES } from "../src/core/ml/temporal";
import { runExperiment } from "../src/core/bench/stopwait";
import { randomSource } from "./ml-corpus";
import { generalizationScenario, temporalCorpus, type TemporalEpisode } from "./ml-generalization-corpus";

type Candidate = { name: string; model: Forest; temporal: boolean };
type Scored = { episode: TemporalEpisode; scores: number[] };
const samples = (episodes: TemporalEpisode[]) => episodes.flatMap((e) => e.samples);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function score(candidate: Candidate, episodes: TemporalEpisode[]): Scored[] {
  return episodes.map((episode) => ({ episode, scores: episode.samples.map((r) => forestScore(candidate.model, r.x)) }));
}
// The public target is still a per-agent prediction. Any-robot episode alarms
// are computed only as an evaluation metric, not as input to a predictor.
function metrics(scored: Scored[], threshold: number) {
  const rows: Sample[] = [], predictions: boolean[] = [];
  let safe = 0, safeAlarms = 0, deadlocks = 0, detected = 0;
  const leadTicks: number[] = [];
  for (const { episode, scores } of scored) {
    const predicted = scores.map((p) => p >= threshold);
    rows.push(...episode.samples); predictions.push(...predicted);
    if (episode.onset === null && episode.completed === episode.total) { safe++; if (predicted.some(Boolean)) safeAlarms++; }
    if (episode.onset !== null) {
      deadlocks++;
      const warnings = episode.samples.filter((r, i) => r.y === 1 && predicted[i]);
      if (warnings.length) { detected++; leadTicks.push(episode.onset - Math.min(...warnings.map((r) => r.tick))); }
    }
  }
  return { ...reportPredictions(rows, predictions), safeEpisodes: safe, safeEpisodesWithAlarm: safeAlarms,
    safeAlarmRate: safe ? safeAlarms / safe : null, deadlockEpisodes: deadlocks, detectedEpisodes: detected, leadTicks };
}
function audit(episodes: TemporalEpisode[]) {
  const rows = samples(episodes), pos = rows.filter((r) => r.y === 1).length;
  expect(rows.length).toBeGreaterThan(0);
  expect(pos / rows.length).toBeGreaterThan(0.05);
  expect(pos / rows.length).toBeLessThan(0.95);
  for (const e of episodes) {
    const sc = generalizationScenario(e.seed, e.family, e.layoutId, e.fleetSize);
    const long = runExperiment(sc.map, sc.robots, sc.tasks, "stop-and-wait", 160);
    expect(long.completed).toBe(e.completed);
    if (e.onset !== null) expect(long.makespan).toBeNull();
    expect(e.samples.every((r) => r.x.length === TEMPORAL_FEATURE_NAMES.length && r.x.every(Number.isFinite))).toBe(true);
  }
  return { episodes: episodes.length, samples: rows.length, positives: pos, positiveRate: pos / rows.length,
    complete: episodes.filter((e) => e.completed === e.total).length,
    deadlock: episodes.filter((e) => e.onset !== null).length,
    censored: episodes.filter((e) => e.onset === null && e.completed < e.total).length };
}
function ambiguity(rows: Sample[]) {
  const groups = new Map<string, { positive: number; negative: number }>();
  for (const row of rows) {
    const key = JSON.stringify(row.x), group = groups.get(key) ?? { positive: 0, negative: 0 };
    if (row.y) group.positive++; else group.negative++;
    groups.set(key, group);
  }
  const conflicting = [...groups.values()].filter((g) => g.positive > 0 && g.negative > 0);
  const minimumErrors = conflicting.reduce((sum, g) => sum + Math.min(g.positive, g.negative), 0);
  const positive = rows.filter((r) => r.y === 1).length;
  // With R>=.90 and P>=.95, errors <= positives*(.10 + .90*.05/.95).
  // If even an in-sample oracle cannot do this, no deterministic model of
  // these identical feature vectors can meet both targets on these rows.
  const targetErrorBudget = positive * (0.10 + 0.90 * 0.05 / 0.95);
  return { identicalVectorsWithBothLabels: conflicting.length,
    samplesInConflictingGroups: conflicting.reduce((sum, g) => sum + g.positive + g.negative, 0),
    minimumErrorsForDeterministicClassifier: minimumErrors, maximumErrorsAllowedByPrecisionRecallTargets: targetErrorBudget,
    precisionRecallTargetsInfeasibleForThisRepresentationOnTheseRows: minimumErrors > targetErrorBudget };
}
function interval(left: Report[], right: Report[]) {
  const random = randomSource(719), deltas: number[] = [];
  for (let draw = 0; draw < 2000; draw++) {
    const a: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 }, b: Confusion = { ...a };
    for (let i = 0; i < left.length; i++) {
      const j = Math.floor(random() * left.length);
      for (const k of ["tp", "fp", "tn", "fn"] as const) { a[k] += left[j].confusion[k]; b[k] += right[j].confusion[k]; }
    }
    deltas.push(f1(a) - f1(b));
  }
  deltas.sort((a, b) => a - b);
  return { low: deltas[50], high: deltas[1949], resamples: 2000, unit: "seed within a fixed layout suite" };
}
function performanceGates(m: ReturnType<typeof metrics>) {
  return { f1: m.f1 >= 0.9, precision: m.precision >= 0.95, recall: m.recall >= 0.9,
    safeEpisodes: m.safeAlarmRate !== null && m.safeAlarmRate <= 0.05 };
}

describe("ML strict targets and unseen-layout evaluation", () => {
  it("audits, fits on training only, selects on development, and gates a frozen final evaluation", () => {
    const train = temporalCorpus(100000, [0, 1, 2], [3, 4, 6], 8);
    const validation = temporalCorpus(200000, [3], [3, 4, 6], 8);
    const trainAudit = audit(train), validationAudit = audit(validation);
    console.log("PRE-FIT", JSON.stringify({ train: trainAudit, validation: validationAudit,
      trainAmbiguity: ambiguity(samples(train)) }));
    if (process.env.ML_DIAGNOSTICS_ONLY === "1") return;
    const candidates: Candidate[] = [];
    for (const temporal of [false, true]) for (const depth of [5, 8]) {
      const rows = samples(train).map((r) => ({ ...r, x: temporal ? r.x : r.x.slice(0, 9) }));
      const model = fitForest(rows, { depth, trees: 48, minLeaf: 8,
        featureCount: temporal ? TEMPORAL_FEATURE_NAMES.length : 9, featuresPerSplit: temporal ? 8 : 4 });
      const base: Candidate = { name: `${temporal ? "history" : "snapshot"}-d${depth}`, model, temporal };
      // Threshold candidates are chosen entirely on TRAIN. One maximizes F1;
      // another maximizes recall subject to precision and episode-alarm targets.
      const scored = score(base, train);
      const operatingPoints = Array.from({ length: 100 }, (_, i) => {
        const threshold = (i + 1) / 100;
        return { threshold, result: metrics(scored, threshold) };
      });
      const constrained = operatingPoints.filter((p) => p.result.precision >= 0.95 && p.result.safeAlarmRate !== null && p.result.safeAlarmRate <= 0.05)
        .sort((a, b) => b.result.recall - a.result.recall)[0];
      const bestF1 = [...operatingPoints].sort((a, b) => b.result.f1 - a.result.f1)[0];
      candidates.push({ ...base, name: `${base.name}-f1`, model: { ...model, threshold: bestF1.threshold } });
      if (constrained) candidates.push({ ...base, name: `${base.name}-precision`, model: { ...model, threshold: constrained.threshold } });
    }
    const selection = candidates.map((c) => ({ name: c.name, threshold: c.model.threshold, metrics: metrics(score(c, validation), c.model.threshold) }));
    // Prefer candidates meeting every target. If none do, retain the highest
    // F1 candidate as a rejected research result; never loosen the gate.
    const rank = (i: number) => Object.values(performanceGates(selection[i].metrics)).every(Boolean) ? 1 : 0;
    const order = candidates.map((_, i) => i).sort((a, b) => rank(b) - rank(a) || selection[b].metrics.f1 - selection[a].metrics.f1);
    const chosen = candidates[order[0]];
    const frozenHash = hash(chosen);
    console.log("SELECTION", JSON.stringify(selection));
    console.log("FROZEN", chosen.name, frozenHash);
    const development = { trainAudit, validationAudit, selection, chosen: chosen.name, frozenHash };
    if (process.env.ML_TARGETS_DEVELOPMENT) writeFileSync(process.env.ML_TARGETS_DEVELOPMENT, JSON.stringify(development, null, 2) + "\n");
    if (process.env.ML_TARGETS_FINAL !== "1") return;
    const test = temporalCorpus(300000, [4, 5, 6], [3, 6, 8, 10], 12);
    const testAudit = audit(test);
    expect(new Set([...train, ...validation, ...test].map((e) => e.seed)).size).toBe(train.length + validation.length + test.length);
    expect(test.every((e) => !train.some((t) => t.layoutId === e.layoutId) && !validation.some((v) => v.layoutId === e.layoutId))).toBe(true);
    const legacy = JSON.parse(readFileSync("artifacts/ml/deadlock-risk-experiment.json", "utf8")) as { model: RiskModel };
    const previous = JSON.parse(readFileSync("artifacts/ml/deadlock-risk-expanded.json", "utf8")) as { model: { model: Forest } };
    const scored = score(chosen, test);
    const alternatives: Record<string, Scored[]> = {
      originalLogistic: test.map((episode) => ({ episode, scores: episode.samples.map((r) => predictOne(legacy.model.weights, applyStandardizer(legacy.model.standardizer, r.x.slice(0, 9)))) })),
      previousForest: test.map((episode) => ({ episode, scores: episode.samples.map((r) => forestScore(previous.model.model, r.x.slice(0, 9))) })),
      rule: test.map((episode) => ({ episode, scores: episode.samples.map((r) => Number(r.x[0] > 0)) })),
      alwaysPositive: test.map((episode) => ({ episode, scores: episode.samples.map(() => 1) })),
    };
    const thresholds: Record<string, number> = { originalLogistic: legacy.model.threshold, previousForest: previous.model.model.threshold, rule: 0.5, alwaysPositive: 0.5 };
    const learned = metrics(scored, chosen.model.threshold);
    const comparisons = Object.fromEntries(Object.entries(alternatives).map(([name, s]) => [name, metrics(s, thresholds[name])]));
    const perSeed = scored.map((s, i) => ({ seed: s.episode.seed, layout: s.episode.layoutId, family: s.episode.family,
      fleetSize: s.episode.fleetSize, learned: metrics([s], chosen.model.threshold),
      comparisons: Object.fromEntries(Object.entries(alternatives).map(([name, values]) => [name, metrics([values[i]], thresholds[name])])) }));
    const intervals = Object.fromEntries(Object.keys(alternatives).map((name) => [name, interval(perSeed.map((e) => e.learned), perSeed.map((e) => e.comparisons[name]))]));
    const groups = [
      ...["head-on", "convoy", "mixed"].map((family) => ({ name: `traffic:${family}`, filter: (e: TemporalEpisode) => e.family === family })),
      ...[4, 5, 6].map((id) => ({ name: `layout:${id}`, filter: (e: TemporalEpisode) => e.layoutId === id })),
      ...[3, 6, 8, 10].map((n) => ({ name: `fleet:${n}`, filter: (e: TemporalEpisode) => e.fleetSize === n })),
    ].map(({ name, filter }) => {
      const subset = scored.filter((s) => filter(s.episode)), results = perSeed.filter((_, i) => filter(test[i]));
      const outcome = metrics(subset, chosen.model.threshold);
      const baselines = Object.fromEntries(Object.entries(alternatives).map(([key, s]) => [key, metrics(s.filter((r) => filter(r.episode)), thresholds[key])]));
      const bounds = Object.fromEntries(["rule", "alwaysPositive"].map((key) => [key, interval(results.map((r) => r.learned), results.map((r) => r.comparisons[key]))]));
      return { name, learned: outcome, comparisons: baselines, intervals: bounds,
        baselineGate: outcome.positives > 0 ? outcome.f1 > baselines.rule.f1 && outcome.f1 > baselines.alwaysPositive.f1 && bounds.rule.low > 0 && bounds.alwaysPositive.low > 0 : null };
    });
    const strict = { ...performanceGates(learned), perRegimeF1: groups.every((g) => !g.learned.positives || g.learned.f1 >= 0.85),
      everyRegimeBeatsBaselines: groups.every((g) => g.baselineGate !== false),
      aggregateBaselines: intervals.rule.low > 0 && intervals.alwaysPositive.low > 0 };
    const gatePassed = Object.values(strict).every(Boolean);
    expect(hash(chosen)).toBe(frozenHash);
    // Test serialization even for rejected candidates; deployment model omitted.
    expect(metrics(score(JSON.parse(JSON.stringify(chosen)), test), chosen.model.threshold)).toEqual(learned);
    const result = { schemaVersion: 3, target: "unchanged fleet deadlock onset within next 1–3 ticks", horizonTicks: 3,
      featureNames: TEMPORAL_FEATURE_NAMES, development, testAudit,
      seeds: { train: train.map((e) => e.seed), validation: validation.map((e) => e.seed), test: test.map((e) => e.seed) },
      corpusHash: hash([...train, ...validation, ...test]), frozenHash, learned, comparisons, intervals, groups, perSeed,
      trainingAmbiguity: ambiguity(samples(train)), testAmbiguity: ambiguity(samples(test)),
      gates: strict, gatePassed, deploymentReady: false, deploymentModel: gatePassed ? chosen : null,
      researchCandidate: chosen,
      intervention: { status: gatePassed ? "eligible for separate intervention experiment" : "not run: prediction acceptance gate failed", completionTimeBenefit: null },
      limitations: ["Synthetic layouts and traffic; final layouts are unseen but the generator is shared.",
        "Fresh peer messages only; no real-hardware or communication-failure validation.",
        "A regression test proves identical local histories can have opposite fleet-wide target labels.",
        "Bootstrap resamples seeds within a fixed layout suite; it does not establish arbitrary-layout guarantees."] };
    console.log("FINAL", JSON.stringify({ testAudit, learned, comparisons, intervals, groups, strict, gatePassed }));
    if (process.env.ML_TARGETS_REPORT) {
      mkdirSync(dirname(process.env.ML_TARGETS_REPORT), { recursive: true });
      writeFileSync(process.env.ML_TARGETS_REPORT, JSON.stringify(result, null, 2) + "\n");
    }
    // A scientifically valid failure passes this harness, but saves no deployment model.
  }, 240000);
});
