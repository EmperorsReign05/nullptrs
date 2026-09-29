// SIH 2026 acceptance benchmark, version 1.
//
//   generate   freeze the scenario suite (run ONCE, before any arm executes)
//   evaluate   run the frozen suite under the requested arms
//   summarise  recompute every report from ALREADY RECORDED per-scenario rows
//   delay      decompose where the elapsed time actually goes
//   final      assemble final-summary.json from the artifacts, nothing else
//
// `summarise` exists so that a reporting bug can be fixed without re-running a
// single arm. The run is the evidence; the statistic is a reading of it.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { ARTIFACT_DIR, evaluateArms, generateSuite, loadSuite, summariseArm, type Evaluation } from "../src/core/bench/sih/evaluate";
import { ARMS, SIH_BENCHMARK_VERSION, type ArmId } from "../src/core/bench/sih/protocol";
import type { ArmRun } from "../src/core/bench/sih/runner";
import { pairedStats, type PairedStats } from "../src/core/bench/sih/stats";
import { delayBreakdown } from "../src/core/bench/sih/delay";
import { finalSummary } from "../src/core/bench/sih/final";
import { trainGuidanceModel } from "../src/core/bench/sih/guidance";
import type { LayoutId } from "../src/core/bench/sih/scenario";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const block = flag("dev") ? "development" : "acceptance";
const dirFor = (b: string) => (b === "acceptance" ? `${ARTIFACT_DIR}/current` : `${ARTIFACT_DIR}/development`);

const pct = (x: number | null | undefined, digits = 2): string =>
  x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(digits)}%`;

const SLICES = ["all", "low", "recoverable", "severe"];

/** C -> D is the bid-MLP ablation. It is the previously accepted 1.56% experiment
 *  and is kept in its own section so it can never be read as the A -> D SIH result. */
function addBidMlpAblation(summary: Record<string, unknown>, runs: ArmRun[]) {
  const cRuns = runs.filter((r) => r.arm === "C");
  const dRuns = runs.filter((r) => r.arm === "D");
  if (!cRuns.length || !dRuns.length) return;
  const sections: Record<string, Record<string, PairedStats>> = {};
  for (const slice of SLICES) {
    const filter = slice === "all" ? () => true : (r: ArmRun) => r.regime === slice;
    sections[slice] = {
      sumTaskCompletionTime: pairedStats(cRuns.filter(filter), dRuns.filter(filter), "sumTaskCompletionTime"),
      makespan: pairedStats(cRuns.filter(filter), dRuns.filter(filter), "makespan"),
    };
  }
  summary.bidMlpAblation = sections;
  const rec = sections.recoverable.sumTaskCompletionTime;
  console.log(`  ablation C->D (bid MLP only, NOT the SIH comparison): recoverable flow ` +
    `${pct(rec.aggregateReduction)} CI=[${pct(rec.aggregateReduction95CI?.[0])},${pct(rec.aggregateReduction95CI?.[1])}] pairs=${rec.pairedCompleteCount}`);
}

/** Guidance arms E/F are compared against C and D respectively, not against A. */
function addGuidanceAblation(summary: Record<string, unknown>, runs: ArmRun[]) {
  const out: Record<string, unknown> = {};
  const pairUp = (baselineArm: ArmId, guidanceArm: ArmId) => {
    const b = runs.filter((r) => r.arm === baselineArm);
    const t = runs.filter((r) => r.arm === guidanceArm);
    if (!b.length || !t.length) return;
    const sections: Record<string, Record<string, PairedStats>> = {};
    for (const slice of SLICES) {
      const filter = slice === "all" ? () => true : (r: ArmRun) => r.regime === slice;
      sections[slice] = {
        sumTaskCompletionTime: pairedStats(b.filter(filter), t.filter(filter), "sumTaskCompletionTime"),
        makespan: pairedStats(b.filter(filter), t.filter(filter), "makespan"),
      };
    }
    out[`${baselineArm}_to_${guidanceArm}`] = sections;
    const rec = sections.recoverable.sumTaskCompletionTime;
    console.log(`  ablation ${baselineArm}->${guidanceArm} (route-guidance AI): recoverable flow ` +
      `${pct(rec.aggregateReduction)} CI=[${pct(rec.aggregateReduction95CI?.[0])},${pct(rec.aggregateReduction95CI?.[1])}] pairs=${rec.pairedCompleteCount}`);
  };
  pairUp("C", "E");
  pairUp("D", "F");
  if (Object.keys(out).length) summary.guidanceAblation = out;
}

function writeSummaries(evaluation: Evaluation, outDir: string, armIds: ArmId[]) {
  const baseline = evaluation.runs.filter((r) => r.arm === "A");
  const summary: Record<string, unknown> = {
    version: SIH_BENCHMARK_VERSION,
    block: evaluation.block,
    generatedBy: evaluation.generatedBy,
    provenance: evaluation.provenance,
    suite: evaluation.suite,
    arms: ARMS.filter((a) => armIds.includes(a.id)),
    criticalMetricDistinction:
      "1.56% = bid-MLP incremental ablation (C->D). 20% = whole-system improvement over stop-and-wait (A->D). They are different experiments.",
  };
  for (const id of armIds) {
    const report = summariseArm(evaluation, id, baseline);
    writeFileSync(`${outDir}/${report.arm.name}.json`, JSON.stringify(report, null, 1) + "\n");
    const rec = report.speed.sumTaskCompletionTime.recoverable;
    const ms = report.speed.makespan.recoverable;
    const rel = report.reliability.recoverable as Record<string, number>;
    console.log(
      `  arm ${id} ${report.arm.name.padEnd(26)} recoverable: pairs=${String(rec.pairedCompleteCount).padStart(4)} ` +
      `flowAgg=${pct(rec.aggregateReduction).padStart(8)} CI=[${pct(rec.aggregateReduction95CI?.[0])},${pct(rec.aggregateReduction95CI?.[1])}] ` +
      `msAgg=${pct(ms.aggregateReduction).padStart(8)} msPairs=${String(ms.pairedCompleteCount).padStart(4)} ` +
      `completion=${(100 * rel.completionRate).toFixed(1).padStart(5)}% safety=${Object.values(report.safetyTotals).reduce((a, b) => a + b, 0)}`,
    );
    summary[id] = report;
  }
  addBidMlpAblation(summary, evaluation.runs);
  addGuidanceAblation(summary, evaluation.runs);
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 1) + "\n");
  return summary;
}

switch (command) {
  case "generate": {
    generateSuite(block, flag("force"));
    break;
  }
  case "evaluate": {
    const armIds = (value("arms", "A,B,C,D") as string).split(",").map((s) => s.trim()) as ArmId[];
    for (const a of armIds) if (!ARMS.some((x) => x.id === a)) throw new Error(`unknown arm ${a}`);
    if (!armIds.includes("A")) throw new Error("arm A (the stop-and-wait baseline) must be evaluated: every other arm is compared against it");
    const layouts = (value("layouts", "stock,wide") as string).split(",").map((s) => s.trim()) as LayoutId[];
    const model = value("model");
    const outDir = dirFor(block);
    const started = Date.now();
    const evaluation = evaluateArms(block, armIds, outDir, layouts, model, (done, total) =>
      console.log(`  ${done}/${total} arm-runs  (${((Date.now() - started) / 1000).toFixed(0)}s)`));
    console.log(`ran ${evaluation.runs.length} arm-runs in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    writeSummaries(evaluation, outDir, armIds);
    console.log(`wrote ${outDir}/{${armIds.map((a) => ARMS.find((x) => x.id === a)!.name).join(",")}},summary.json`);
    break;
  }
  case "train-guidance": {
    const artifacts = trainGuidanceModel();
    const pctf = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : v.toFixed(4));
    for (const split of ["validation", "test"] as const) {
      const s = artifacts[split] as Record<string, { rows: number; mae: number | null; pearson: number | null; skillVsZero: number | null }>;
      console.log(`${split} (n=${s.rows}): ` + ["linear", "mlp", "deterministicHeuristic"].map((k) =>
        `${k} mae=${pctf(s[k].mae)} r=${pctf(s[k].pearson)} skillVsZero=${pctf(s[k].skillVsZero)}`).join(" | "));
    }
    console.log(`frozen model -> ${ARTIFACT_DIR}/guidance/model.json`);
    break;
  }
  case "summarise": {
    const path = `${dirFor(block)}/per-scenario.json`;
    if (!existsSync(path)) throw new Error(`run evaluate first: ${path} missing`);
    const recorded = JSON.parse(readFileSync(path, "utf8")) as { version: string; block: string; provenance: Evaluation["provenance"]; suite: Evaluation["suite"]; arms: ArmId[]; runs: ArmRun[] };
    const armIds = (value("arms", recorded.arms.join(",")) as string).split(",").map((s) => s.trim()) as ArmId[];
    const evaluation: Evaluation = {
      version: recorded.version, block: recorded.block,
      generatedBy: `npx vite-node scripts/sih-benchmark.ts summarise --block ${block} --arms ${armIds.join(",")}`,
      provenance: recorded.provenance, suite: recorded.suite, arms: armIds, runs: recorded.runs,
    };
    writeSummaries(evaluation, dirFor(block), armIds);
    break;
  }
  case "delay": {
    const path = `${dirFor(block)}/per-scenario.json`;
    if (!existsSync(path)) throw new Error(`run evaluate first: ${path} missing`);
    const evaluation = JSON.parse(readFileSync(path, "utf8")) as { runs: ArmRun[] };
    const suite = loadSuite(block);
    const report = delayBreakdown(suite, evaluation.runs);
    mkdirSync(dirFor(block), { recursive: true });
    writeFileSync(`${ARTIFACT_DIR}/delay-breakdown${block === "acceptance" ? "" : "-development"}.json`, JSON.stringify(report, null, 1) + "\n");
    for (const [slice, v] of Object.entries(report.headline)) {
      console.log(`${slice}: dominant=${v.dominantComponent} ` + v.rankedShares.map((r) => `${r.component}=${(r.share * 100).toFixed(1)}%`).join(" "));
    }
    break;
  }
  case "final": {
    const out = finalSummary(ARTIFACT_DIR);
    writeFileSync(`${ARTIFACT_DIR}/final-summary.json`, JSON.stringify(out, null, 1) + "\n");
    console.log(JSON.stringify(out.answer, null, 2));
    break;
  }
  default:
    console.log("usage: npx vite-node scripts/sih-benchmark.ts <generate|train-guidance|evaluate|summarise|delay|final> [--dev] [--arms A,B,C,D] [--layouts stock,wide] [--model path.json]");
    process.exitCode = 1;
}
