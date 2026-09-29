// Generate the dataset, train, and evaluate — with the split by SEED.
//
// Run:  npx vitest run tests/ml.test.ts
//
// This is the experiment that decides whether the ML component ships. Read
// the verdict line at the bottom before quoting any number.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { headOnScenario } from "./ml-scenarios";
import { FEATURE_NAMES } from "../src/core/ml/features";
import { collectRun, labelFutureSamples, HORIZON, CONFIRM_TICKS, COMM_RANGE } from "./ml-sampler";
import { runExperiment } from "../src/core/bench/stopwait";
import {
  fitModel,
  evaluate,
  ruleBaseline,
  alwaysPositiveBaseline,
  formatReport,
  formatWeights,
  type Sample,
} from "../src/core/ml/predictor";
const scenarioFor = (seed: number) => headOnScenario(3 + seed % 4, seed);
// Different seed numbers can collide on a small map. Reject exact scenario
// duplicates BEFORE observing outcomes so neither split repeats a run.
const seenScenarios = new Set<string>();
function uniqueSeeds(start: number, count: number): number[] {
  const seeds: number[] = [];
  for (let seed = start; seeds.length < count; seed++) {
    const sc = scenarioFor(seed);
    const signature = JSON.stringify(sc.robots.map((r) => r.position));
    if (seenScenarios.has(signature)) continue;
    seenScenarios.add(signature);
    seeds.push(seed);
  }
  return seeds;
}
const TRAIN_SEEDS = uniqueSeeds(1, 40);
const TEST_SEEDS = uniqueSeeds(101, 20);
const collectSamples = (seed: number) => collectRun(scenarioFor(seed), seed).samples;

describe("ML: deadlock-risk prediction", () => {
  it("M0: seeded opposing routes deadlock under the unchanged fair baseline", () => {
    const signatures = new Set<string>();
    for (const seed of [...TRAIN_SEEDS, ...TEST_SEEDS]) {
      const sc = scenarioFor(seed);
      signatures.add(JSON.stringify(sc.robots.map((r) => r.position)));
      expect(new Set(sc.robots.map((r) => JSON.stringify(r.position))).size).toBe(sc.robots.length);
      expect(new Set(sc.tasks.map((t) => JSON.stringify(t.dropoff))).size).toBe(sc.tasks.length);
      expect(sc.tasks.every((t) => (t.pickup.y < 6) !== (t.dropoff.y < 6))).toBe(true);
      const run = collectRun(sc, seed);
      expect(run.onset).not.toBeNull();
      expect(run.samples.every((s) => s.tick < run.onset!)).toBe(true);
      expect(run.samples.some((s) => s.y === 1)).toBe(true);
      const baseline = runExperiment(sc.map, sc.robots, sc.tasks, "stop-and-wait", 100);
      expect(baseline.completed).toBe(run.completed);
      expect(baseline.completed).toBeLessThan(sc.tasks.length);
      expect(baseline.makespan).toBeNull();
    }
    expect(signatures.size).toBe(TRAIN_SEEDS.length + TEST_SEEDS.length);
    console.log(`M0: ${signatures.size} distinct seeded runs; unfinished tasks persist through 100 ticks in every run`);
  });

  it("a completing convoy supplies negatives, not a deadlock", () => {
    const sc = headOnScenario(2, 1);
    for (let i = 0; i < 2; i++) {
      const start = { x: 6, y: i * 3 };
      sc.robots[i].position = start;
      sc.robots[i].home = start;
      sc.tasks[i].pickup = start;
      sc.tasks[i].dropoff = { x: 6, y: 9 + i * 3 };
    }
    const run = collectRun(sc, 1);
    expect(run.onset).toBeNull();
    expect(run.completed).toBe(2);
    expect(run.samples.length).toBeGreaterThan(0);
    expect(run.samples.every((s) => s.y === 0)).toBe(true);
  });

  it("future labels exclude onset and censor unobserved timeout tails", () => {
    const rows = Array.from({ length: 20 }, (_, tick) => ({ seed: 1, tick, x: Array(9).fill(0) }));
    const labelled = labelFutureSamples(rows, 10, 20, false);
    expect(labelled.filter((s) => s.y).map((s) => s.tick)).toEqual([7, 8, 9]);
    expect(labelled.at(-1)?.tick).toBe(9);
    expect(labelFutureSamples(rows, null, 20, false).map((s) => s.tick)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(labelFutureSamples(rows, null, 20, true)).toHaveLength(20);
  });

  it("M1: collect a dataset, train on train seeds, evaluate on HELD-OUT seeds", () => {
    expect(TRAIN_SEEDS.some((s) => TEST_SEEDS.includes(s))).toBe(false);
    console.log(`M1 seeds train=${TRAIN_SEEDS.join(",")} test=${TEST_SEEDS.join(",")}`);
    const trainSamples = TRAIN_SEEDS.flatMap(collectSamples);
    const testSamples = TEST_SEEDS.flatMap(collectSamples);

    const posRate = (a: Sample[]) => (a.reduce((x, s) => x + s.y, 0) / Math.max(1, a.length)) * 100;
    console.log(`M1 train: ${trainSamples.length} samples, ${posRate(trainSamples).toFixed(1)}% positive`);
    console.log(`M1 test : ${testSamples.length} samples, ${posRate(testSamples).toFixed(1)}% positive`);

    // Abort BEFORE fitting if this is still an empty/single-class experiment.
    for (const rows of [trainSamples, testSamples]) {
      expect(posRate(rows)).toBeGreaterThan(5);
      expect(posRate(rows)).toBeLessThan(95);
    }
    console.log(`M1 target: fleet deadlock onset within ${HORIZON} ticks; confirmation=${CONFIRM_TICKS}; pre-onset samples only`);
    console.log(`M1 nonzero features (train): ${FEATURE_NAMES.map((name, i) => `${name}=${(100 * trainSamples.filter((s) => s.x[i] > 0).length / trainSamples.length).toFixed(1)}%`).join(" ")}`);
    if (process.env.ML_DIAGNOSTICS_ONLY === "1") return;

    const model = fitModel(trainSamples);
    console.log(`M1 weights: ${formatWeights(model)}`);
    console.log(`M1 threshold chosen on train: ${model.threshold.toFixed(2)}`);

    const always = alwaysPositiveBaseline(testSamples);
    const rule = ruleBaseline(testSamples);
    const ml = evaluate(model, testSamples);

    console.log(`M1 ${formatReport("always-positive", always)}`);
    console.log(`M1 ${formatReport("rule (agent.ts)", rule)}`);
    console.log(`M1 ${formatReport("learned model", ml)}`);

    let wins = 0;
    const perSeed = [];
    for (const seed of TEST_SEEDS) {
      const rows = testSamples.filter((s) => s.seed === seed);
      const reports = { seed, model: evaluate(model, rows), rule: ruleBaseline(rows), always: alwaysPositiveBaseline(rows) };
      perSeed.push(reports);
      const learned = reports.model.f1;
      const heuristic = ruleBaseline(rows).f1;
      const trivial = alwaysPositiveBaseline(rows).f1;
      if (learned > heuristic && learned > trivial) wins++;
      console.log(`M1 seed=${seed} n=${rows.length} F1 model=${learned.toFixed(3)} rule=${heuristic.toFixed(3)} always=${trivial.toFixed(3)}`);
    }
    const ships = ml.f1 > rule.f1 && ml.f1 > always.f1;
    console.log(`M1 held-out per-seed wins against BOTH: ${wins}/${TEST_SEEDS.length}`);
    console.log(`M1 VERDICT: ${ships ? "MODEL WINS on this stop-and-wait dataset; deployment benefit untested" : "DO NOT SHIP: model fails the strict two-baseline gate"}`);
    // Explicit opt-in writes an experiment artifact, never a runtime import.
    // Losing models are omitted, including when overwriting an earlier report.
    if (process.env.ML_REPORT_PATH) {
      const report = {
        schemaVersion: 1,
        policy: "stop-and-wait",
        target: "fleet deadlock onset in the next 1–3 ticks; pre-onset active agents only",
        horizonTicks: HORIZON, confirmationTicks: CONFIRM_TICKS, commRange: COMM_RANGE,
        featureNames: FEATURE_NAMES, trainSeeds: TRAIN_SEEDS, testSeeds: TEST_SEEDS,
        datasetSha256: createHash("sha256").update(JSON.stringify({ trainSamples, testSamples })).digest("hex"),
        trainSamples: trainSamples.length, trainPositiveRate: posRate(trainSamples) / 100,
        testPositiveRate: posRate(testSamples) / 100,
        gatePassed: ships, model: ships ? model : null,
        evaluation: { learned: ml, rule, always, perSeed, winsAgainstBoth: wins },
        limitations: [
          "All measured episodes eventually deadlock; negatives are earlier time windows, not safe episodes.",
          "One choke-point geometry, 3–6 robots, fresh range-limited peer messages.",
          "Ten-tick stall confirmation; persistence checked through 100 ticks, not a proof of infinite deadlock.",
          "No distributed-policy validation, intervention experiment, or completion-time improvement measured.",
        ],
      };
      mkdirSync(dirname(process.env.ML_REPORT_PATH), { recursive: true });
      writeFileSync(process.env.ML_REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
      const saved = JSON.parse(readFileSync(process.env.ML_REPORT_PATH, "utf8"));
      expect(saved.featureNames).toEqual(FEATURE_NAMES);
      if (ships) expect(evaluate(saved.model, testSamples)).toEqual(ml);
      else expect(saved.model).toBeNull();
    }
    // A valid negative experiment passes the test; it does not authorize deployment.
  }, 600000);

  it("M2: the split must be by seed — verify a random tick split leaks", () => {
    // Demonstrates WHY the seed split matters, using the same sampler. A random
    // tick split is the single most common way to report a meaningless
    // accuracy for time-series data.
    const all: Sample[] = [];
    for (const s of [1, 2, 3, 4]) {
      all.push(...collectSamples(s));
    }
    const shuffled = [...all].sort((a, b) => ((a.seed * 31 + a.tick * 17) % 97) - ((b.seed * 31 + b.tick * 17) % 97));
    const cut = Math.floor(shuffled.length * 0.7);
    const leakyTrain = shuffled.slice(0, cut);
    const leakyTest = shuffled.slice(cut);
    expect(leakyTrain.some((s) => leakyTest.some((t) => t.seed === s.seed))).toBe(true);
    const leakyModel = fitModel(leakyTrain);
    const leaky = evaluate(leakyModel, leakyTest);

    const seeds = [...new Set(all.map((s) => s.seed))];
    const properTrain = all.filter((s) => seeds.indexOf(s.seed) < 2);
    const properTest = all.filter((s) => seeds.indexOf(s.seed) >= 2);
    expect(properTrain.some((s) => properTest.some((t) => t.seed === s.seed))).toBe(false);
    const properModel = fitModel(properTrain);
    const proper = evaluate(properModel, properTest);

    console.log(`M2 LEAKY  random tick split: P=${leaky.precision.toFixed(3)} R=${leaky.recall.toFixed(3)} F1=${leaky.f1.toFixed(3)}`);
    console.log(`M2 PROPER seed split:        P=${proper.precision.toFixed(3)} R=${proper.recall.toFixed(3)} F1=${proper.f1.toFixed(3)}`);
    console.log(`M2 => seed overlap is leakage even if its F1 is not higher; use M1 held-out results.`);
  }, 600000);
});
