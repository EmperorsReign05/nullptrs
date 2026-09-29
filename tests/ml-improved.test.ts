import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { FEATURE_NAMES } from "../src/core/ml/features";
import { fitModel, evaluate, ruleBaseline, alwaysPositiveBaseline, type Sample, type RiskModel } from "../src/core/ml/predictor";
import { f1, type Confusion } from "../src/core/ml/logistic";
import { evaluateForest, fitForest, forestScore, type Forest } from "../src/core/ml/forest";
import { buildCorpus, randomSource, signature, trafficScenario, type Episode } from "./ml-corpus";
import { headOnScenario } from "./ml-scenarios";
import { runExperiment } from "../src/core/bench/stopwait";

type Candidate = { kind: "forest"; model: Forest; depth: number } | { kind: "logistic"; model: RiskModel };
const report = (candidate: Candidate, rows: Sample[]) => candidate.kind === "forest"
  ? evaluateForest(candidate.model, rows) : evaluate(candidate.model, rows);
const rowsOf = (episodes: Episode[]) => episodes.flatMap((e) => e.samples);
function audit(episodes: Episode[]) {
  for (const episode of episodes) {
    const sc = trafficScenario(episode.seed, episode.family);
    const fullRun = runExperiment(sc.map, sc.robots, sc.tasks, "stop-and-wait", 100);
    expect(fullRun.completed).toBe(episode.completed);
    if (episode.onset !== null) expect(fullRun.makespan).toBeNull();
    else expect(fullRun.makespan).not.toBeNull();
  }
  const rows = rowsOf(episodes);
  const positiveRate = rows.filter((s) => s.y === 1).length / rows.length;
  expect(positiveRate).toBeGreaterThan(0.05);
  expect(positiveRate).toBeLessThan(0.95);
  expect(episodes.every((e) => e.onset !== null || e.completed === e.total)).toBe(true);
  expect(episodes.filter((e) => e.family === "convoy").every((e) => e.completed === e.total)).toBe(true);
  return { episodes: episodes.length, samples: rows.length, positiveRate,
    deadlockEpisodes: episodes.filter((e) => e.onset !== null).length,
    completeEpisodes: episodes.filter((e) => e.completed === e.total).length };
}

function pairedInterval(pairs: { learned: Confusion; baseline: Confusion }[]) {
  const random = randomSource(719);
  const differences: number[] = [];
  for (let draw = 0; draw < 2000; draw++) {
    const left: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
    const right: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[Math.floor(random() * pairs.length)];
      for (const k of ["tp", "fp", "tn", "fn"] as const) { left[k] += p.learned[k]; right[k] += p.baseline[k]; }
    }
    differences.push(f1(left) - f1(right));
  }
  differences.sort((a, b) => a - b);
  return { low: differences[50], high: differences[1949], unit: "scenario seed", resamples: 2000 };
}

describe("ML expanded experiment", () => {
  it("selects on development seeds, then evaluates a frozen candidate on fresh seeds", () => {
    const seen = new Set<string>();
    // Keep previously inspected head-on fixtures out of the new experiment.
    for (let seed = 1; seed <= 120; seed++) for (let n = 2; n <= 8; n++) seen.add(signature(headOnScenario(n, seed)));
    const train = buildCorpus(1000, 60, seen);
    const validation = buildCorpus(10000, 20, seen);
    const trainingAudit = audit(train), validationAudit = audit(validation);
    console.log("Expanded pre-fit label audit:", { train: trainingAudit, validation: validationAudit });
    if (process.env.ML_DIAGNOSTICS_ONLY === "1") return;
    const trainRows = rowsOf(train), validationRows = rowsOf(validation);
    const logistic: Candidate = { kind: "logistic", model: fitModel(trainRows) };
    const candidates: Candidate[] = [logistic, ...[3, 5, 7].map((depth): Candidate => ({
      kind: "forest", depth, model: fitForest(trainRows, { depth }),
    }))];
    const selection = candidates.map((c) => ({ kind: c.kind, depth: c.kind === "forest" ? c.depth : null,
      threshold: c.model.threshold, validation: report(c, validationRows) }));
    let chosen = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (report(candidate, validationRows).f1 > report(chosen, validationRows).f1) chosen = candidate;
    }
    console.log("Development selection:", JSON.stringify(selection));
    const frozenHash = createHash("sha256").update(JSON.stringify(chosen)).digest("hex");
    console.log(`Frozen candidate: ${chosen.kind}, sha256=${frozenHash}`);
    // Default execution never opens the final holdout. No refitting or tuning
    // after this point. Repeated reproduction is not a new independent trial.
    if (process.env.ML_FINAL !== "1") return;
    const test = buildCorpus(20000, 40, seen);
    const testAudit = audit(test);
    const all = [...train, ...validation, ...test];
    expect(new Set(all.map((e) => e.seed)).size).toBe(all.length);
    expect(new Set(all.map((e) => e.signature)).size).toBe(all.length);
    const testRows = rowsOf(test);
    const legacy = JSON.parse(readFileSync("artifacts/ml/deadlock-risk-experiment.json", "utf8")) as { model: RiskModel };
    const learned = report(chosen, testRows);
    const comparisons = { originalLogistic: evaluate(legacy.model, testRows), retrainedLogistic: report(logistic, testRows),
      rule: ruleBaseline(testRows), alwaysPositive: alwaysPositiveBaseline(testRows) };
    const perSeed = test.map((e) => ({ seed: e.seed, family: e.family, onset: e.onset, completed: e.completed, total: e.total,
      learned: report(chosen, e.samples), originalLogistic: evaluate(legacy.model, e.samples),
      retrainedLogistic: report(logistic, e.samples), rule: ruleBaseline(e.samples), alwaysPositive: alwaysPositiveBaseline(e.samples) }));
    const intervals = Object.fromEntries((Object.keys(comparisons) as (keyof typeof comparisons)[]).map((name) => [name,
      pairedInterval(perSeed.map((e) => ({ learned: e.learned.confusion, baseline: e[name].confusion })))]));
    const byFamily = ["head-on", "convoy", "mixed"].map((family) => {
      const episodes = test.filter((e) => e.family === family);
      const rows = rowsOf(episodes);
      const result = report(chosen, rows);
      const safe = episodes.filter((e) => e.onset === null);
      return { family, episodes: episodes.length, learned: result,
        originalLogistic: evaluate(legacy.model, rows), retrainedLogistic: report(logistic, rows),
        rule: ruleBaseline(rows), alwaysPositive: alwaysPositiveBaseline(rows),
        safeEpisodes: safe.length, safeEpisodesWithAnyFalseAlarm: safe.filter((e) => report(chosen, e.samples).confusion.fp > 0).length };
    });
    const gatePassed = learned.f1 > comparisons.rule.f1 && learned.f1 > comparisons.alwaysPositive.f1;
    const improvesBothLogistics = learned.f1 > comparisons.originalLogistic.f1 && learned.f1 > comparisons.retrainedLogistic.f1;
    const forecast = test.filter((e) => e.onset !== null).map((e) => {
      const positiveTicks = [...new Set(e.samples.filter((r) => r.y === 1 && report(chosen, [r]).confusion.tp > 0).map((r) => r.tick))];
      return { seed: e.seed, detected: positiveTicks.length > 0, leadTicks: positiveTicks.length ? e.onset! - Math.min(...positiveTicks) : 0 };
    });
    const latency: number[] = [];
    if (chosen.kind === "forest") {
      for (let repeat = 0; repeat < 25; repeat++) {
        const before = performance.now();
        for (const row of testRows) forestScore(chosen.model, row.x);
        latency.push((performance.now() - before) * 1000 / testRows.length);
      }
      latency.sort((a, b) => a - b);
    }
    const result = { schemaVersion: 2, target: "fleet deadlock onset in next 1–3 ticks, pre-onset active agents",
      policy: "unchanged fair stop-and-wait", featureNames: FEATURE_NAMES,
      train: trainingAudit, validation: validationAudit, test: testAudit,
      seeds: { train: train.map((e) => e.seed), validation: validation.map((e) => e.seed), test: test.map((e) => e.seed) },
      datasetSha256: createHash("sha256").update(JSON.stringify(all)).digest("hex"),
      selection, frozenHash, gatePassed, improvesBothLogistics, deploymentReady: false,
      model: gatePassed ? chosen : null, learned, comparisons, intervals, byFamily, perSeed, forecast,
      scoreMicrosecondsPerSampleMedian: latency.length ? latency[Math.floor(latency.length / 2)] : null,
      scoreTimingMethod: "median of 25 batch means; score computation only, not end-to-end agent cost",
      limitations: ["One fixed choke geometry, 3–6 robots; synthetic traffic mixture is not deployment prevalence.",
        "Fresh peer messages; no distributed-policy or completion-time intervention evaluation.",
        "Target is fleet-wide onset: a local observation can lack evidence of a remote jam.",
        "Bootstrap intervals describe seed variation in this generator, not unseen geometries."] };
    expect(createHash("sha256").update(JSON.stringify(chosen)).digest("hex")).toBe(frozenHash);
    console.log("FINAL expanded result:", JSON.stringify({ test: testAudit, learned, comparisons, intervals, byFamily,
      gatePassed, improvesBothLogistics, forecastDetected: forecast.filter((e) => e.detected).length, forecastTotal: forecast.length,
      scoreMicrosecondsPerSampleMedian: result.scoreMicrosecondsPerSampleMedian }));
    if (process.env.ML_IMPROVED_REPORT) {
      mkdirSync(dirname(process.env.ML_IMPROVED_REPORT), { recursive: true });
      writeFileSync(process.env.ML_IMPROVED_REPORT, JSON.stringify(result, null, 2) + "\n");
      const saved = JSON.parse(readFileSync(process.env.ML_IMPROVED_REPORT, "utf8"));
      if (gatePassed) expect(report(saved.model, testRows)).toEqual(learned);
      else expect(saved.model).toBeNull();
    }
  }, 120000);
});
