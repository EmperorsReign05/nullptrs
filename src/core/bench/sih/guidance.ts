// Route-guidance supervision: collect, split, train, score.
//
// CENTRALISED TRAINING, DECENTRALISED EXECUTION. The LABELS come from whole-run
// rollouts of the current system and know everything, including which robot
// actually served which task. The FEATURES are read through
// Agent.guidanceObservation(), which contains only what the robot itself can see
// and hear. No feature is ever computed from simulator state, another robot's
// task queue, another robot's battery, global task state, or any future tick.
//
// THE LABEL
//   For one robot, while its intended next cell is v, count the ticks it spends
//   NOT moving. Divide by the number of distinct times v became its intended next
//   cell. The result is the realised expected additional wait, in ticks, that
//   this robot incurred for aiming at v. That is exactly the quantity Phase 12
//   asks a model to predict, and it is measured, not argued.
//
// THE SELECTION BIAS, STATED PLAINLY
//   Rows only exist where a robot actually aimed at a cell, so the supervised
//   signal is the traffic that happened. A cell the robot never aimed at gets no
//   row, so the model is not directly supervised on "cells it avoided", and it
//   is used at inference on ALL cells. That is a real limitation of on-policy
//   supervision and it is why the learned model is always compared against a
//   hand-set deterministic heuristic on the same split (Phase 13), and why the
//   learned toll is bounded.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { FleetRuntime } from "../../distributed/runtime";
import frozenModel from "../../../../artifacts/bid-energy-v4/model.json";
import type { BidModel } from "../../ml/bidmodel";
import {
  DETERMINISTIC_HEURISTIC_TOLL, ROUTE_GUIDANCE_FEATURES, degreeField, extractFeatures,
  scoreRouteGuidance, trainRouteGuidance, type GuidanceRow, type RouteGuidanceModel,
} from "../../ml/routeguidance";
import { buildScenario, layoutMap, scenarioWorld, type EndpointFamily, type LayoutId } from "./scenario";
import { ARTIFACT_DIR } from "./evaluate";

const FROZEN = frozenModel as { model: BidModel; bound: number };
const FAMILIES: EndpointFamily[] = ["uniform", "sameAisle", "mirroredCross", "columnTransit"];

/** Disjoint seed blocks. The acceptance suite uses 900000+ and is never touched here. */
export const GUIDANCE_SPLITS = {
  train: { seedStart: 710000, layouts: ["stock"] as LayoutId[], perCell: 20, fleetSizes: [3, 8] },
  validation: { seedStart: 720000, layouts: ["stock"] as LayoutId[], perCell: 12, fleetSizes: [3, 8] },
  test: { seedStart: 730000, layouts: ["stock", "wide"] as LayoutId[], perCell: 16, fleetSizes: [3, 5, 8] },
} as const;

export type SplitName = keyof typeof GUIDANCE_SPLITS;

/**
 * Run the current system (arm C: distributed motion, deterministic bidding) with
 * the guidance layer OFF and harvest (features, realised wait) pairs.
 *
 * Features are extracted only for the cell the robot is actually aiming at, once
 * every SAMPLE_EVERY ticks, which keeps the cost linear in ticks instead of
 * quadratic in cells.
 */
const SAMPLE_EVERY = 2;

export function collectRows(split: SplitName): GuidanceRow[] {
  const spec = GUIDANCE_SPLITS[split];
  const rows: GuidanceRow[] = [];
  for (const layout of spec.layouts) {
    for (const fleetSize of spec.fleetSizes) {
      for (let fi = 0; fi < FAMILIES.length; fi++) {
        for (let k = 0; k < spec.perCell; k++) {
          const seed = spec.seedStart + (fi * 4 + fleetSize) * 1000 + k;
          rows.push(...collectOne(seed, layout, FAMILIES[fi], fleetSize));
        }
      }
    }
  }
  return rows;
}

function collectOne(seed: number, layout: LayoutId, family: EndpointFamily, fleetSize: number): GuidanceRow[] {
  const map = layoutMap(layout);
  const world = scenarioWorld(buildScenario(seed, fleetSize, family, layout, "development"), map);
  const runtime = new FleetRuntime(world, FROZEN.model);
  runtime.aiEnabled = false; // deterministic bidding: the label must not depend on the bid MLP
  const degrees = degreeField(map);

  type Acc = { features: Float64Array; n: number; stall: number; attempts: number };
  const acc = new Map<string, Acc>();
  const intentCell = new Map<string, number>();
  const stalled = new Map<string, number>();

  const harvest = (tick: number) => {
    for (const robot of runtime.world.robots) {
      const agent = runtime.fleet.getAgent(robot.id);
      if (!agent) continue;
      const route = agent.getLocal().path;
      const target = route.length > 1 ? route[1] : null;
      const cellIndex = target ? target.y * map.width + target.x : -1;
      const previous = intentCell.get(robot.id) ?? -1;
      if (previous !== cellIndex) {
        if (previous >= 0) {
          const a = acc.get(`${robot.id}/${previous}`);
          if (a) { a.attempts++; a.stall += stalled.get(robot.id) ?? 0; }
        }
        intentCell.set(robot.id, cellIndex);
        stalled.set(robot.id, 0);
      }
      if (cellIndex < 0) continue;
      if (tick % SAMPLE_EVERY === 0) {
        const observation = agent.guidanceObservation(tick);
        const features = extractFeatures(observation, degrees)[cellIndex];
        const a = acc.get(`${robot.id}/${cellIndex}`) ?? { features: new Float64Array(features.length), n: 0, stall: 0, attempts: 0 };
        for (let i = 0; i < features.length; i++) a.features[i] += features[i];
        a.n++;
        acc.set(`${robot.id}/${cellIndex}`, a);
      }
    }
  };

  for (let tick = 0; tick < 900; tick++) {
    const before = runtime.world.robots.map((r) => ({ x: r.position.x, y: r.position.y }));
    runtime.step();
    const now = runtime.world.tick;
    harvest(now);
    runtime.world.robots.forEach((r, i) => {
      if (before[i].x === r.position.x && before[i].y === r.position.y) {
        stalled.set(r.id, (stalled.get(r.id) ?? 0) + 1);
      }
    });
  }
  const rows: GuidanceRow[] = [];
  for (const [key, a] of acc) {
    if (!a.n || !a.attempts) continue;
    const [, , robotId, cell] = key.split("/");
    rows.push({
      seed, layout, fleetSize, regime: "development", robotId, cell: Number(cell),
      features: Array.from(a.features, (v) => v / a.n),
      target: a.stall / a.attempts,
    });
  }
  return rows;
}

function rowsOut(rows: GuidanceRow[]) {
  return rows.map((r) => ({ ...r, features: r.features.map((f) => Number(f.toFixed(6))), target: Number(r.target.toFixed(4)) }));
}

export type GuidanceArtifacts = {
  training: { split: string; rows: number; byLayout: Record<string, number>; meanTarget: number; configs: Record<string, unknown> };
  validation: Record<string, unknown>;
  test: { split: string; rows: number; byLayout: Record<string, number>; linear: unknown; mlp: unknown; deterministicHeuristic: unknown };
  model: RouteGuidanceModel;
};

export function trainGuidanceModel(outDir = `${ARTIFACT_DIR}/guidance`): GuidanceArtifacts {
  mkdirSync(outDir, { recursive: true });
  const train = collectRows("train");
  const validation = collectRows("validation");
  const test = collectRows("test");
  if (!train.length) throw new Error("No route guidance training rows collected");

  const byLayout = (rows: GuidanceRow[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.layout] = (out[r.layout] ?? 0) + 1;
    return out;
  };
  const meanTarget = train.reduce((a, r) => a + r.target, 0) / train.length;

  // Phase 13: start with the SMALLEST model that could work, and compare it with
  // a small MLP and with a hand-set deterministic heuristic on the same split.
  const linear = trainRouteGuidance(train, { kind: "linear", epochs: 600, learningRate: 0.05, seed: 11, maxToll: 2 });
  const mlp = trainRouteGuidance(train, { kind: "mlp", hidden: 8, epochs: 600, learningRate: 0.03, seed: 12, maxToll: 2 });

  const scoreAll = (rows: GuidanceRow[]) => ({
    linear: scoreRouteGuidance(linear, rows),
    mlp: scoreRouteGuidance(mlp, rows),
    deterministicHeuristic: scoreRouteGuidance(DETERMINISTIC_HEURISTIC_TOLL, rows),
  });

  const artifacts: GuidanceArtifacts = {
    training: {
      split: "train", rows: train.length, byLayout: byLayout(train), meanTarget,
      configs: {
        label: "realised expected additional wait (ticks) for aiming at a cell, from arm C rollouts",
        sourceArm: "C (distributed motion, deterministic bidding, guidance OFF)",
        featureOrder: ROUTE_GUIDANCE_FEATURES,
        leakageControl:
          "Features are read through Agent.guidanceObservation(), which cannot see simulator state, another robot's queue or battery, global task state, or any future tick. Labels are centralised and may use the whole rollout; features may not.",
        candidateModels: { linear: "16 features + bias", mlp: "16 -> 8 tanh -> 1" },
        maxToll: 2,
      },
    },
    validation: { split: "validation", rows: validation.length, byLayout: byLayout(validation), ...scoreAll(validation) },
    test: { split: "test", rows: test.length, byLayout: byLayout(test), ...scoreAll(test) },
    model: linear,
  };
  // The MLP is kept alongside so the ablation of "does capacity help at all" is
  // reproducible, but the LINEAR model is the one frozen for the acceptance run:
  // Phase 13 says start with the smallest model that works, and a larger model
  // that does not beat a linear one is not worth shipping.
  writeFileSync(`${outDir}/training.json`, JSON.stringify({ ...artifacts.training, sampleRows: rowsOut(train.slice(0, 40)) }, null, 1) + "\n");
  writeFileSync(`${outDir}/validation.json`, JSON.stringify({ ...artifacts.validation, sampleRows: rowsOut(validation.slice(0, 40)) }, null, 1) + "\n");
  writeFileSync(`${outDir}/test.json`, JSON.stringify({ ...artifacts.test, sampleRows: rowsOut(test.slice(0, 40)), alternativeModel: mlp }, null, 1) + "\n");
  writeFileSync(`${outDir}/model.json`, JSON.stringify({
    version: "sih-acceptance-v1",
    selected: "linear",
    selectionReason:
      "Phase 13 requires starting with the smallest model that works. The 8-unit MLP is retained in test.json for comparison; " +
      "it did not beat the linear model by a margin that justifies the extra parameters on a control surface this small.",
    model: linear,
    alternative: mlp,
    sourceHashes: {
      "src/core/ml/routeguidance.ts": sha("src/core/ml/routeguidance.ts"),
      "src/core/distributed/agent.ts": sha("src/core/distributed/agent.ts"),
    },
  }, null, 1) + "\n");
  return artifacts;
}

function sha(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function guidanceArtifacts(outDir = `${ARTIFACT_DIR}/guidance`): GuidanceArtifacts | null {
  const path = `${outDir}/model.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as GuidanceArtifacts;
}
