// Scenario-suite construction and arm evaluation.
//
//   generate  - build the candidate pool from seeds, classify every candidate
//               by GEOMETRY alone, stratify into the three regimes and FREEZE
//               the result into scenarios.json. Run once, before any arm runs.
//   evaluate  - run the frozen suite under the requested arms and write the
//               per-arm machine-readable results plus the summary.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { RouteGuidanceModel } from "../../ml/routeguidance";
import { SIH_BENCHMARK_VERSION, WORKLOAD, ARMS, type ArmId, benchmarkSpec } from "./protocol";
import { buildScenario, type EndpointFamily, type LayoutId, type ScenarioRecord } from "./scenario";
import { runArm, type ArmRun } from "./runner";
import { pairedStats, reliabilityStats, type MetricName, type PairedStats } from "./stats";

export const ARTIFACT_DIR = "artifacts/sih-acceptance-v1";
const FAMILIES: EndpointFamily[] = ["uniform", "sameAisle", "mirroredCross", "columnTransit"];
const LAYOUT_IDS: LayoutId[] = ["stock", "wide"];
const REGIMES = ["low", "recoverable", "severe"] as const;

/** Candidate pool per (family, fleet size). Chosen before any arm was run. */
export const POOL_PER_FAMILY = 400;
/** Accepted scenarios per (regime, fleet size). Also fixed before any arm ran. */
export const TARGET_PER_REGIME_PER_FLEET: Record<string, number> = { low: 200, recoverable: 300, severe: 160 };

const seedFor = (block: "development" | "acceptance", layoutIndex: number, familyIndex: number, i: number) =>
  (block === "acceptance" ? WORKLOAD.seedSpace.acceptance.seedStart : WORKLOAD.seedSpace.development.seedStart) +
  (layoutIndex * FAMILIES.length + familyIndex) * POOL_PER_FAMILY + i;

export function provenance() {
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    sourceHashes: {
      "src/core/bench/stopwait.ts": sha("src/core/bench/stopwait.ts"),
      "src/core/bench/sih/overlap.ts": sha("src/core/bench/sih/overlap.ts"),
      "src/core/bench/sih/scenario.ts": sha("src/core/bench/sih/scenario.ts"),
      "src/core/bench/sih/runner.ts": sha("src/core/bench/sih/runner.ts"),
      "src/core/bench/sih/stats.ts": sha("src/core/bench/sih/stats.ts"),
      "src/core/distributed/agent.ts": sha("src/core/distributed/agent.ts"),
      "src/core/distributed/fleet.ts": sha("src/core/distributed/fleet.ts"),
      "src/core/distributed/runtime.ts": sha("src/core/distributed/runtime.ts"),
      "src/core/distributed/ownership.ts": sha("src/core/distributed/ownership.ts"),
      "src/core/pathfinding/astar.ts": sha("src/core/pathfinding/astar.ts"),
      "artifacts/bid-energy-v4/model.json": sha("artifacts/bid-energy-v4/model.json"),
    },
  };
}

export function buildSuite(block: "development" | "acceptance"): { records: ScenarioRecord[]; poolStats: unknown } {
  const perFleetTargets = TARGET_PER_REGIME_PER_FLEET;
  const records: ScenarioRecord[] = [];
  const poolStats: Record<string, unknown> = {};
  for (const fleetSize of WORKLOAD.fleetSizes) {
    // Bucket every candidate by regime, per family, in ascending seed order.
    const buckets: Record<string, ScenarioRecord[]> = { low: [], recoverable: [], severe: [] };
    const familyBuckets: Record<string, Record<string, ScenarioRecord[]>> = {};
    for (let li = 0; li < LAYOUT_IDS.length; li++) {
      for (let fi = 0; fi < FAMILIES.length; fi++) {
        const family = FAMILIES[fi];
        const cell = `${LAYOUT_IDS[li]}/${family}`;
        familyBuckets[cell] = { low: [], recoverable: [], severe: [] };
        for (let i = 0; i < POOL_PER_FAMILY; i++) {
          const rec = buildScenario(seedFor(block, li, fi, i), fleetSize, family, LAYOUT_IDS[li], block);
          if (!rec.overlap.valid) continue;
          familyBuckets[cell][rec.regime].push(rec);
          buckets[rec.regime].push(rec);
        }
      }
    }
    poolStats[`n${fleetSize}`] = {
      poolPerFamily: POOL_PER_FAMILY,
      byLayoutAndFamily: Object.fromEntries(Object.keys(familyBuckets).map((f) => [f, {
        low: familyBuckets[f].low.length,
        recoverable: familyBuckets[f].recoverable.length,
        severe: familyBuckets[f].severe.length,
      }])),
      poolTotals: Object.fromEntries(REGIMES.map((r) => [r, buckets[r].length])),
    };

    for (const regime of REGIMES) {
      const target = perFleetTargets[regime];
      // Round-robin across families so no regime is monopolised by one demand
      // pattern, then fill any shortfall from the remaining families in seed
      // order. Deterministic and independent of any policy outcome.
      const queues = Object.keys(familyBuckets).map((f) => [...familyBuckets[f][regime]]);
      const chosen: ScenarioRecord[] = [];
      let progressed = true;
      while (chosen.length < target && progressed) {
        progressed = false;
        for (const q of queues) {
          if (chosen.length >= target) break;
          const next = q.shift();
          if (!next) continue;
          chosen.push(next);
          progressed = true;
        }
      }
      records.push(...chosen);
    }
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { records, poolStats };
}

export function generateSuite(block: "development" | "acceptance" = "acceptance", force = false) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const path = `${ARTIFACT_DIR}/scenarios${block === "acceptance" ? "" : "-development"}.json`;
  // The spec is a pure projection of protocol.ts, so it is always rewritten from
  // the code. The FROZEN SUITE is not: once scenarios.json exists, regenerating it
  // would silently re-draw the acceptance seeds, so that is refused.
  writeFileSync(`${ARTIFACT_DIR}/benchmark-spec.json`, JSON.stringify(benchmarkSpec(), null, 2) + "\n");
  if (existsSync(path) && !force) {
    console.log(`spec refreshed from protocol.ts; scenarios already frozen at ${path} and left untouched.`);
    return path;
  }
  const { records, poolStats } = buildSuite(block);
  const composition = {
    low: records.filter((r) => r.regime === "low").length,
    recoverable: records.filter((r) => r.regime === "recoverable").length,
    severe: records.filter((r) => r.regime === "severe").length,
  };
  const payload = {
    version: SIH_BENCHMARK_VERSION,
    block,
    frozen: true,
    generatedBy: "npx vite-node scripts/sih-benchmark.ts generate",
    provenance: provenance(),
    protocol: {
      mapId: WORKLOAD.mapId,
      tasksPerRun: WORKLOAD.tasksPerRun,
      releaseIntervalTicks: WORKLOAD.releaseIntervalTicks,
      horizonTicks: WORKLOAD.horizonTicks,
      initialBatteryPercent: WORKLOAD.initialBatteryPercent,
      fleetSizes: WORKLOAD.fleetSizes,
      endpointFamilies: WORKLOAD.endpointFamilies,
      poolPerFamily: POOL_PER_FAMILY,
      targetPerRegimePerFleetSize: TARGET_PER_REGIME_PER_FLEET,
      selection: "round-robin across the four endpoint families within each (regime, fleetSize) cell, ascending seed order, stopping at the target count. No policy has been executed at this point and none can influence selection.",
    },
    composition,
    compositionByFleetSize: Object.fromEntries(WORKLOAD.fleetSizes.map((n) => [n, {
      low: records.filter((r) => r.fleetSize === n && r.regime === "low").length,
      recoverable: records.filter((r) => r.fleetSize === n && r.regime === "recoverable").length,
      severe: records.filter((r) => r.fleetSize === n && r.regime === "severe").length,
    }])),
    compositionByLayout: Object.fromEntries(LAYOUT_IDS.map((l) => [l, {
      low: records.filter((r) => r.layout === l && r.regime === "low").length,
      recoverable: records.filter((r) => r.layout === l && r.regime === "recoverable").length,
      severe: records.filter((r) => r.layout === l && r.regime === "severe").length,
    }])),
    compositionByLayoutAndFamily: Object.fromEntries(Object.keys(familyBucketsAll(records)).map((f) => [f, {
      low: records.filter((r) => `${r.layout}/${r.endpointFamily}` === f && r.regime === "low").length,
      recoverable: records.filter((r) => `${r.layout}/${r.endpointFamily}` === f && r.regime === "recoverable").length,
      severe: records.filter((r) => `${r.layout}/${r.endpointFamily}` === f && r.regime === "severe").length,
    }])),
    overlapMetricDistribution: overlapDistribution(records),
    poolStats,
    scenarios: records.map(packRecord),
  };
  // Compact: 1800 frozen workloads with their geometric analysis. Rounded to six
  // decimals, which is far finer than any threshold the classification uses.
  writeFileSync(path, JSON.stringify(round(payload, 6)) + "\n");
  // A small human-readable index beside the frozen manifest: the manifest itself
  // is a single compact line, this one is meant to be skimmed and diffed.
  writeFileSync(path.replace(/\.json$/, "-index.json"), JSON.stringify({
    version: SIH_BENCHMARK_VERSION, block, generatedBy: payload.generatedBy,
    note: "Compact index of the frozen suite. scenarios.json holds every seed, start, endpoint, release time and geometric analysis; this file is the skim view.",
    composition, compositionByFleetSize: payload.compositionByFleetSize,
    compositionByLayout: payload.compositionByLayout, compositionByLayoutAndFamily: payload.compositionByLayoutAndFamily,
    index: records.map((r) => ({
      id: r.id, seed: r.seed, fleetSize: r.fleetSize, layout: r.layout, endpointFamily: r.endpointFamily, regime: r.regime,
      overlapIndex: Number(r.overlap.overlapIndex.toFixed(4)),
      headOnPairShare: Number(r.overlap.headOnPairShare.toFixed(4)),
      contestedCellsPerRoute: Number(r.overlap.contestedCellsPerRoute.toFixed(3)),
      approachOverlapIndex: Number(r.overlap.approachOverlapIndex.toFixed(4)),
      escapeFraction: Number(r.overlap.escapeFraction.toFixed(3)),
      maxZeroSlackRun: r.overlap.maxZeroSlackRun,
      staticRecoverable: r.overlap.staticRecoverable,
    })),
  }, null, 1) + "\n");
  console.log(`froze ${records.length} scenarios -> ${path}`);
  console.log(`  composition: ${JSON.stringify(composition)}`);
  console.log(`  by fleet size: ${JSON.stringify(payload.compositionByFleetSize)}`);
  console.log(`  by layout: ${JSON.stringify(payload.compositionByLayout)}`);
  return path;
}

/**
 * On-disk form of a scenario. Positions become [x, y] tuples and the per-record
 * protocol fields that are identical for every scenario (block, map, horizon,
 * task count, release interval) are stated once in the file's `protocol`
 * section instead of 1800 times. Nothing measurable is dropped: the record still
 * carries every seed, every start, every endpoint, every release time and the
 * complete geometric analysis.
 */
type PackedRecord = Omit<ScenarioRecord, "block" | "mapId" | "horizonTicks" | "tasksPerRun" | "releaseIntervalTicks" | "robots" | "tasks"> & {
  robots: { id: string; model: string; payloadCapacity: number; start: [number, number]; batteryPercent: number }[];
  tasks: { id: string; pickup: [number, number]; dropoff: [number, number]; weightKg: number; priority: number; createdAt: number }[];
};

function packRecord(r: ScenarioRecord): PackedRecord {
  return {
    id: r.id, seed: r.seed, fleetSize: r.fleetSize, layout: r.layout, endpointFamily: r.endpointFamily, regime: r.regime,
    overlap: r.overlap,
    robots: r.robots.map((x) => ({ ...x, start: [x.start.x, x.start.y] as [number, number] })),
    tasks: r.tasks.map((t) => ({ ...t, pickup: [t.pickup.x, t.pickup.y] as [number, number], dropoff: [t.dropoff.x, t.dropoff.y] as [number, number] })),
  };
}

function unpackRecord(p: PackedRecord, block: "development" | "acceptance"): ScenarioRecord {
  return {
    ...p,
    block,
    mapId: WORKLOAD.mapId,
    horizonTicks: WORKLOAD.horizonTicks,
    tasksPerRun: WORKLOAD.tasksPerRun,
    releaseIntervalTicks: WORKLOAD.releaseIntervalTicks,
    robots: p.robots.map((r) => ({ ...r, start: { x: r.start[0], y: r.start[1] } })),
    tasks: p.tasks.map((t) => ({ ...t, pickup: { x: t.pickup[0], y: t.pickup[1] }, dropoff: { x: t.dropoff[0], y: t.dropoff[1] } })),
  };
}

/** Round every float in a value to `digits` decimals, recursively. */
function round(value: unknown, digits: number): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
  if (Array.isArray(value)) return value.map((v) => round(v, digits));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, round(v, digits)]));
  }
  return value;
}

function familyBucketsAll(records: ScenarioRecord[]): Record<string, ScenarioRecord[]> {
  const out: Record<string, ScenarioRecord[]> = {};
  for (const r of records) { const k = `${r.layout}/${r.endpointFamily}`; (out[k] ??= []).push(r); }
  return out;
}

function overlapDistribution(records: ScenarioRecord[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const regime of REGIMES) {
    const rs = records.filter((r) => r.regime === regime);
    const stat = (xs: number[]) => {
      const a = [...xs].sort((x, y) => x - y);
      return {
        min: a[0], p25: a[Math.floor(a.length * 0.25)], median: a[Math.floor(a.length * 0.5)],
        p75: a[Math.floor(a.length * 0.75)], max: a[a.length - 1],
        mean: a.reduce((s, v) => s + v, 0) / a.length,
      };
    };
    out[regime] = {
      count: rs.length,
      overlapIndex: stat(rs.map((r) => r.overlap.overlapIndex)),
      headOnPairShare: stat(rs.map((r) => r.overlap.headOnPairShare)),
      contestedCellsPerRoute: stat(rs.map((r) => r.overlap.contestedCellsPerRoute)),
      approachOverlapIndex: stat(rs.map((r) => r.overlap.approachOverlapIndex)),
      escapeFraction: stat(rs.map((r) => r.overlap.escapeFraction)),
      maxZeroSlackRun: stat(rs.map((r) => r.overlap.maxZeroSlackRun)),
      meanDeliveryLength: stat(rs.map((r) => r.overlap.meanDeliveryLength)),
    };
  }
  return out;
}

export function loadSuite(block: "development" | "acceptance" = "acceptance"): ScenarioRecord[] {
  const path = `${ARTIFACT_DIR}/scenarios${block === "acceptance" ? "" : "-development"}.json`;
  if (!existsSync(path)) throw new Error(`frozen suite missing: ${path}. Run "generate" first.`);
  const file = JSON.parse(readFileSync(path, "utf8")) as { scenarios: PackedRecord[] };
  return file.scenarios.map((p) => unpackRecord(p, block));
}

export function suiteDescriptor(records: { regime: string; layout: string; fleetSize: number }[]) {
  return {
    scenarios: records.length,
    composition: Object.fromEntries(REGIMES.map((r) => [r, records.filter((s) => s.regime === r).length])),
    compositionByLayout: Object.fromEntries(LAYOUT_IDS.map((l) => [l, records.filter((s) => s.layout === l).length])),
  };
}

export type Evaluation = {
  version: string;
  block: string;
  generatedBy: string;
  provenance: ReturnType<typeof provenance>;
  suite: {
    path: string;
    scenarios: number;
    composition: Record<string, number>;
    compositionByLayout: Record<string, number>;
    layoutsEvaluated: string[];
    guidanceModel: string | null;
  };
  arms: ArmId[];
  /** per-scenario rows, one entry per (arm, scenario). */
  runs: ArmRun[];
};

export type EvaluateOptions = {
  layouts?: LayoutId[];
  /** Frozen route-guidance model, required by arms E and F. */
  modelPath?: string;
  onProgress?: (done: number, total: number) => void;
};

export function loadGuidanceModel(path: string): RouteGuidanceModel {
  if (!existsSync(path)) throw new Error(`route guidance model not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { model: RouteGuidanceModel };
  return parsed.model;
}

export function evaluateArms(
  block: "development" | "acceptance",
  arms: ArmId[],
  outDir: string,
  layoutsOrOptions?: LayoutId[] | EvaluateOptions,
  modelPath?: string,
  onProgress?: (done: number, total: number) => void,
): Evaluation {
  const options: EvaluateOptions = Array.isArray(layoutsOrOptions)
    ? { layouts: layoutsOrOptions, modelPath, onProgress }
    : (layoutsOrOptions ?? {});
  const suite = loadSuite(block).filter((s) => !options.layouts || options.layouts.includes(s.layout));
  const guidance = arms.some((a) => ARMS.find((x) => x.id === a)!.runtime.guidance) ? options.modelPath : undefined;
  if (arms.some((a) => ARMS.find((x) => x.id === a)!.runtime.guidance) && !guidance) {
    throw new Error("arms E/F require a frozen route-guidance model: pass --model <path>");
  }
  const runs: ArmRun[] = [];
  const total = suite.length * arms.length;
  let done = 0;
  for (const record of suite) {
    for (const arm of arms) {
      runs.push(runArm(record, arm, guidance ? loadGuidanceModel(guidance) : undefined));
      done++;
      if (options.onProgress && done % 200 === 0) options.onProgress(done, total);
    }
  }
  mkdirSync(outDir, { recursive: true });
  const evaluation: Evaluation = {
    version: SIH_BENCHMARK_VERSION,
    block,
    generatedBy: `npx vite-node scripts/sih-benchmark.ts evaluate --block ${block} --arms ${arms.join(",")}`,
    provenance: provenance(),
    suite: {
      path: `${ARTIFACT_DIR}/scenarios${block === "acceptance" ? "" : "-development"}.json`,
      ...suiteDescriptor(suite),
      layoutsEvaluated: options.layouts ?? LAYOUT_IDS,
      guidanceModel: guidance ?? null,
    },
    arms,
    runs,
  };
  writeFileSync(`${outDir}/per-scenario.json`, JSON.stringify(evaluation, null, 1) + "\n");
  return evaluation;
}

export type ArmReport = {
  version: string;
  block: string;
  generatedBy: string;
  provenance: ReturnType<typeof provenance>;
  suite: Evaluation["suite"];
  arm: { id: ArmId; name: string; motion: string; bidding: string; guidance: string; role: string };
  /** SPEED analysis. Mutually complete pairs against arm A, per regime / fleet size / all. */
  speed: Record<MetricName, Record<string, PairedStats>>;
  /** RELIABILITY analysis. Every frozen scenario, no conditioning on success. */
  reliability: Record<string, unknown>;
  safetyTotals: Record<string, number>;
};

const SLICES: { name: string; filter: (r: { regime: string; fleetSize: number; endpointFamily: string }) => boolean }[] = [
  { name: "all", filter: () => true },
  ...REGIMES.map((r) => ({ name: r, filter: (x: { regime: string }) => x.regime === r })),
  ...REGIMES.flatMap((r) => WORKLOAD.fleetSizes.map((n) => ({ name: `${r}-n${n}`, filter: (x: { regime: string; fleetSize: number }) => x.regime === r && x.fleetSize === n }))),
  ...WORKLOAD.fleetSizes.map((n) => ({ name: `n${n}`, filter: (x: { fleetSize: number }) => x.fleetSize === n })),
];

export function summariseArm(evaluation: Evaluation, armId: ArmId, baseline: ArmRun[]): ArmReport {
  const spec = ARMS.find((a) => a.id === armId)!;
  const mine = evaluation.runs.filter((r) => r.arm === armId);
  const speed = {} as Record<MetricName, Record<string, PairedStats>>;
  for (const metric of ["sumTaskCompletionTime", "makespan"] as MetricName[]) {
    speed[metric] = {};
    for (const slice of SLICES) {
      const filter = slice.filter;
      const bRuns = baseline.filter(filter);
      const tRuns = mine.filter(filter);
      speed[metric][slice.name] = pairedStats(bRuns, tRuns, metric);
    }
  }
  const reliability: Record<string, unknown> = {};
  for (const slice of SLICES) reliability[slice.name] = reliabilityStats(mine.filter(slice.filter));
  const safetyTotals: Record<string, number> = {};
  for (const r of mine) for (const [k, v] of Object.entries(r.safety)) safetyTotals[k] = (safetyTotals[k] ?? 0) + v;
  return {
    version: SIH_BENCHMARK_VERSION,
    block: evaluation.block,
    generatedBy: evaluation.generatedBy,
    provenance: evaluation.provenance,
    suite: evaluation.suite,
    arm: { id: spec.id, name: spec.name, motion: spec.motion, bidding: spec.bidding, guidance: spec.guidance, role: spec.role },
    speed,
    reliability,
    safetyTotals,
  };
}
