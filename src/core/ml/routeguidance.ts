// EXPERIMENTAL local predictive congestion guidance.
//
// WHAT THIS IS NOT
//   It does not command motion. It does not choose a direction, a cell or a
//   robot. It emits one bounded non-negative number per grid cell, which the
//   existing A* adds to that cell's already-computed congestion cost:
//
//       edgeCost(u -> v) = baseMoveCost
//                        + CONGESTION_WEIGHT * deterministicCurrentCongestion(v)
//                        + boundedPredictedCongestionToll(v)
//
//   A* still chooses the route. PIBT (here: the agent's sensor-yield,
//   step-aside, clearance and commit-time arbitration) still resolves immediate
//   multi-robot conflict and guarantees safety. Ownership, quorum, custody,
//   charging and energy admission are untouched. The learned component only
//   forecasts how much traffic a cell is about to attract, which is the surface
//   recent MAPF work (learning guidance weights over the navigation graph) uses
//   and which the existing bid-refinement MLP does not touch at all: that model
//   changes WHO does a task, this one changes HOW a robot routes.
//
// THE DECENTRALISED INFERENCE BOUNDARY
//   Runtime inference reads exactly GuidanceObservation from
//   src/core/distributed/agent.ts: the robot's own position, route,
//   destination, route length and stall history, its own sensor contacts, the
//   peer messages it already receives, and its own recent edge/cell history. It
//   never reads the simulator's robot array, another robot's task queue, another
//   robot's battery, global task state, dashboard state, a centrally computed
//   congestion field, or any future ground truth. Centralised Training +
//   Decentralised Execution: the LABELS below come from whole-run rollouts, and
//   only the labels.
//
// THE SAFETY ENVELOPE
//   Optimisation only. A missing model, a malformed model, a NaN, a
//   non-finite feature, an out-of-distribution feature, a stale or incomplete
//   observation, or a prediction outside the allowed range all degrade to a zero
//   toll, i.e. to the plain deterministic base cost. Tolls are clamped to
//   [0, maxToll] so no prediction can make a cell cheaper than a free cell and
//   none can exceed a bounded multiple of a move. A bad model can make a route
//   inefficient. It cannot make an illegal move legal.

import type { Position, WarehouseMap } from "../types";
import { manhattanDistance } from "../map/graph";
import type { GuidanceObservation } from "../distributed/agent";

/** Versioned feature order. A model must retain this exact schema. */
export const ROUTE_GUIDANCE_FEATURES = [
  "isOwnNextCell",            // this cell is the next step of my own route
  "routeRemaining",           // how much of my route is left
  "ownRecentWaitShare",       // my own recent fraction of non-moving ticks
  "ownStallTicks",            // my own consecutive stalled ticks
  "peerIntentIntoCell",       // received peers already claiming this cell
  "peerPreferredIntoCell",    // received peers whose preferred cell is this one
  "peerApproachingMe",        // received peers whose preferred cell is MY cell
  "peerContentionHere",       // received peers whose INTENT is my position
  "sensorContactWithin1",     // a body my own sensor sees on or beside this cell
  "sensorContactWithin2",
  "cellDegree",               // static topology: traversable neighbours
  "isSingleFileCell",         // static choke metadata: no passing place
  "goalDistanceGain",         // signed progress toward my destination
  "ownContentionHistory",     // how often this cell has blocked ME recently
  "ownEdgePressure",          // how often I have recently entered this cell
  "ownAdjacentEdgePressure",  // pressure on the edges leaving this cell
] as const;

export const FEATURE_COUNT = ROUTE_GUIDANCE_FEATURES.length;
const D = FEATURE_COUNT;
const key = (p: Position) => `${p.x},${p.y}`;

/** A per-cell predicted additional wait, in A* cost units, before clamping. */
export type RouteGuidanceModel = {
  schema: string[];
  kind: "linear" | "mlp";
  hidden?: number;
  mean: number[];
  scale: number[];
  /** linear: D weights + bias. mlp: hidden*D + hidden biases + hidden output weights + bias. */
  parameters: number[];
  /** Hard upper bound on the emitted toll, in A* cost units. */
  maxToll: number;
  /** |z| beyond which a feature is treated as out of distribution. */
  oodZ: number;
  trainedOn: { rows: number; seeds: number; layouts: string[]; label: string };
};

export type GuidanceRow = {
  seed: number;
  layout: string;
  fleetSize: number;
  regime: string;
  robotId: string;
  cell: number;
  features: number[];
  /** Realised additional wait incurred by entering this cell, in ticks. */
  target: number;
};

/** Bound on the standardised distance before a feature is declared OOD. */
export const DEFAULT_OOD_Z = 6;

function featuresFor(
  cell: number,
  obs: GuidanceObservation,
  map: WarehouseMap,
  degrees: Int8Array,
  cells: { x: number; y: number }[],
): number[] {
  const p = cells[cell];
  const here = key(p);
  const goal = obs.goal;
  const next = obs.route.length > 1 ? obs.route[1] : null;
  const myCell = key(obs.position);

  let intent = 0, preferred = 0, peerWantsMyCell = 0, peerOnMyCell = 0;
  for (const peer of obs.peers) {
    if (peer.intent && key(peer.intent) === here) intent++;
    if (peer.preferred && key(peer.preferred) === here) preferred++;
    if (peer.preferred && key(peer.preferred) === myCell) peerWantsMyCell++;
    if (peer.intent && key(peer.intent) === myCell) peerOnMyCell++;
  }
  let c1 = 0, c2 = 0;
  for (const contact of obs.sensorContacts) {
    const d = manhattanDistance(contact, p);
    if (d <= 1) c1++;
    if (d <= 2) c2++;
  }
  const degree = degrees[cell];
  let adjacent = 0;
  for (const n of neighboursOf(p, map)) adjacent += obs.edgeHistory.get(`${p.x},${p.y}>${n.x},${n.y}`) ?? 0;
  return [
    next && key(next) === here ? 1 : 0,
    Math.min(1, obs.routeRemaining / 20),
    obs.recentWaitShare,
    Math.min(1, obs.stallTicks / 8),
    Math.min(1, intent / 3),
    Math.min(1, preferred / 3),
    Math.min(1, peerWantsMyCell / 2),
    Math.min(1, peerOnMyCell / 2),
    Math.min(1, c1 / 3),
    Math.min(1, c2 / 5),
    degree / 4,
    degree <= 2 ? 1 : 0,
    goal ? Math.max(-1, Math.min(1, (manhattanDistance(obs.position, goal) - manhattanDistance(p, goal)) / 8)) : 0,
    Math.min(1, (obs.contentionHistory.get(here) ?? 0) / 4),
    Math.min(1, (obs.edgeHistory.get(`${p.x},${p.y}>${p.x},${p.y}`) ?? 0) / 4),
    Math.min(1, adjacent / 4),
  ];
}

function neighboursOf(p: Position, map: WarehouseMap): Position[] {
  const out: Position[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = { x: p.x + dx, y: p.y + dy };
    if (n.x < 0 || n.y < 0 || n.x >= map.width || n.y >= map.height) continue;
    if (map.cells[n.y * map.width + n.x].blocked) continue;
    out.push(n);
  }
  return out;
}

export function guidanceCells(map: WarehouseMap): Position[] {
  return map.cells.map((c) => ({ x: c.position.x, y: c.position.y }));
}

export function degreeField(map: WarehouseMap): Int8Array {
  const out = new Int8Array(map.cells.length);
  map.cells.forEach((c, i) => { out[i] = map.cells[i].blocked ? 0 : neighboursOf(c.position, map).length; });
  return out;
}

/** Extract the feature vector for every cell, for one agent's observation. */
export function extractFeatures(obs: GuidanceObservation, degrees?: Int8Array): number[][] {
  const cells = guidanceCells(obs.map);
  const deg = degrees ?? degreeField(obs.map);
  return cells.map((_, i) => featuresFor(i, obs, obs.map, deg, cells));
}

function predict(model: RouteGuidanceModel, x: number[]): number {
  const p = model.parameters;
  if (model.kind === "linear") {
    let y = p[D];
    for (let i = 0; i < D; i++) y += p[i] * x[i];
    return y;
  }
  const h = model.hidden!;
  let y = p[h * D + 2 * h];
  for (let j = 0; j < h; j++) {
    let z = p[h * D + j];
    for (let i = 0; i < D; i++) z += p[j * D + i] * x[i];
    y += p[h * D + h + j] * Math.tanh(z);
  }
  return y;
}

export function predictRouteGuidance(model: RouteGuidanceModel, features: number[]): number {
  if (JSON.stringify(model.schema) !== JSON.stringify(ROUTE_GUIDANCE_FEATURES)) throw new Error("Route guidance schema mismatch");
  if (!Array.isArray(features) || features.length !== D) throw new Error("Invalid route guidance features");
  const x = new Array<number>(D);
  for (let i = 0; i < D; i++) {
    const f = features[i];
    // Non-finite, or out of distribution on the training distribution, or a
    // degenerate normalisation: refuse to predict rather than invent a number.
    if (!Number.isFinite(f)) return 0;
    if (!Number.isFinite(model.scale[i]) || model.scale[i] <= 0) return 0;
    const z = (f - model.mean[i]) / model.scale[i];
    if (!Number.isFinite(z) || Math.abs(z) > model.oodZ) return 0;
    x[i] = z;
  }
  const y = predict(model, x);
  if (!Number.isFinite(y)) return 0;
  return Math.max(0, Math.min(model.maxToll, y));
}

export type TollFieldResult = { tolls: Float64Array; rejected: number; predicted: number };

/**
 * One per-cell toll field for one agent's replanning round.
 *
 * Every failure path returns an all-zero field, which is exactly the frozen
 * deterministic cost. `agent.ts` and `fleet.ts` both treat a throw or a
 * wrong-length array as "no guidance" as well, so a corrupt model cannot reach
 * a decision even if this function were bypassed.
 */
export function routeGuidanceTollField(
  model: RouteGuidanceModel,
  obs: GuidanceObservation,
  degrees?: Int8Array,
): TollFieldResult {
  const zero = () => ({ tolls: new Float64Array(obs.map.cells.length), rejected: 0, predicted: 0 });
  if (!model || !Array.isArray(model.parameters) || !Array.isArray(model.mean) || !Array.isArray(model.scale)) return zero();
  if (model.parameters.length !== (model.kind === "linear" ? D + 1 : model.hidden! * D + 2 * model.hidden! + 1)) return zero();
  if (!Number.isFinite(model.maxToll) || model.maxToll <= 0 || model.maxToll > 8) return zero();
  if (model.mean.length !== D || model.scale.length !== D) return zero();
  if (!obs || !obs.map || !Array.isArray(obs.map.cells) || !obs.position) return zero();
  if (obs.goal && !obs.route.length) return zero();
  const deg = degrees ?? degreeField(obs.map);
  const cells = guidanceCells(obs.map);
  const tolls = new Float64Array(cells.length);
  let rejected = 0, predicted = 0;
  for (let i = 0; i < cells.length; i++) {
    if (obs.map.cells[i].blocked) continue;
    const f = featuresFor(i, obs, obs.map, deg, cells);
    if (f.length !== D) { rejected++; continue; }
    const before = tolls[i];
    const t = predictRouteGuidance(model, f);
    tolls[i] = Math.max(before, t);
    if (t > 0) predicted++;
  }
  return { tolls, rejected, predicted };
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export function guidanceRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 };
}

export function trainRouteGuidance(
  rows: readonly GuidanceRow[],
  options: { kind?: "linear" | "mlp"; hidden?: number; epochs?: number; learningRate?: number; l2?: number; seed?: number; maxToll?: number } = {},
): RouteGuidanceModel {
  if (!rows.length) throw new Error("Empty route guidance training data");
  const kind = options.kind ?? "linear";
  const h = options.hidden ?? 8;
  const maxToll = options.maxToll ?? 2;
  const n = rows.length;
  const mean = new Array<number>(D).fill(0);
  for (const r of rows) for (let i = 0; i < D; i++) {
    if (!Number.isFinite(r.features[i]) || r.features.length !== D) throw new Error("Invalid route guidance training row");
    mean[i] += r.features[i];
  }
  for (let i = 0; i < D; i++) mean[i] /= n;
  const scale = mean.map((m, i) => Math.sqrt(rows.reduce((a, r) => a + (r.features[i] - m) ** 2, 0) / n) || 1);
  const random = guidanceRandom(options.seed ?? 7);
  const size = kind === "linear" ? D + 1 : h * D + 2 * h + 1;
  const parameters = Array.from({ length: size }, (_, i) =>
    i < (kind === "linear" ? D : h * D) ? (random() * 2 - 1) * 0.1 : kind === "linear" ? 0 : (random() * 2 - 1) * 0.05);

  const forward = (x: number[]) => {
    if (kind === "linear") {
      let y = parameters[D];
      for (let i = 0; i < D; i++) y += parameters[i] * x[i];
      return { x, a: [] as number[], y };
    }
    const a: number[] = [];
    let y = parameters[h * D + 2 * h];
    for (let j = 0; j < h; j++) {
      let z = parameters[h * D + j];
      for (let i = 0; i < D; i++) z += parameters[j * D + i] * x[i];
      a.push(Math.tanh(z));
      y += parameters[h * D + h + j] * a[j];
    }
    return { x, a, y };
  };
  const std = (r: GuidanceRow) => r.features.map((v, i) => (v - mean[i]) / scale[i]);
  const epochs = options.epochs ?? (kind === "linear" ? 400 : 600);
  const lr = options.learningRate ?? 0.05;
  const l2 = options.l2 ?? 1e-4;
  const m = new Array<number>(size).fill(0);
  const v = new Array<number>(size).fill(0);
  const gradient = new Array<number>(size).fill(0);
  for (let epoch = 1; epoch <= epochs; epoch++) {
    gradient.fill(0);
    for (const r of rows) {
      const { x, a, y } = forward(std(r));
      const err = y - r.target;
      if (kind === "linear") {
        gradient[D] += err / n;
        for (let i = 0; i < D; i++) gradient[i] += (err / n) * x[i];
      } else {
        gradient[h * D + 2 * h] += err / n;
        for (let j = 0; j < h; j++) gradient[h * D + h + j] += (err / n) * a[j];
        for (let j = 0; j < h; j++) {
          const dz = (err / n) * parameters[h * D + h + j] * (1 - a[j] * a[j]);
          gradient[h * D + j] += dz;
          for (let i = 0; i < D; i++) gradient[j * D + i] += dz * x[i];
        }
      }
    }
    for (let k = 0; k < size; k++) {
      gradient[k] += l2 * parameters[k];
      m[k] = 0.9 * m[k] + 0.1 * gradient[k];
      v[k] = 0.999 * v[k] + 0.001 * gradient[k] * gradient[k];
      parameters[k] -= lr * (m[k] / (1 - 0.9 ** epoch)) / (Math.sqrt(v[k] / (1 - 0.999 ** epoch)) + 1e-8);
    }
  }
  if (parameters.some((x) => !Number.isFinite(x))) throw new Error("Route guidance training diverged");
  return {
    schema: [...ROUTE_GUIDANCE_FEATURES], kind, hidden: kind === "mlp" ? h : undefined,
    mean, scale, parameters, maxToll, oodZ: DEFAULT_OOD_Z,
    trainedOn: {
      rows: n, seeds: new Set(rows.map((r) => r.seed)).size,
      layouts: [...new Set(rows.map((r) => r.layout))].sort(),
      label: "realised additional wait (ticks) incurred by entering the cell, from whole-run rollouts of the current system",
    },
  };
}

/**
 * Held-out scoring.
 *
 * Plain MAE is the WRONG headline for this target. The realised wait is strongly
 * zero-inflated: most cells a robot aims at are free, so a model that predicts a
 * small positive toll everywhere is penalised by MAE for being useful, and
 * "MAE beats predicting zero" would argue for never adding a toll at all. What
 * matters is RANKING: does the model put the cells that actually cost this robot
 * time above the ones that did not? So the reported metrics are:
 *
 *   pearson         rank agreement on all rows
 *   maePositive     MAE restricted to rows whose realised wait was above zero
 *   liftAtTopDecile mean realised wait of the worst-predicted 10% of cells,
 *                   divided by the mean realised wait of all cells. 1.0 means the
 *                   model cannot tell a jam from an open aisle; > 1 means the top
 *                   decile really is worse than average. This is the number a
 *                   router acts on.
 */
export function scoreRouteGuidance(model: RouteGuidanceModel, rows: readonly GuidanceRow[]) {
  const predicted: { y: number; target: number }[] = [];
  for (const r of rows) predicted.push({ y: predictRouteGuidance(model, r.features), target: r.target });
  const n = predicted.length;
  if (!n) return { rows: 0, mae: null, maePositive: null, pearson: null, zeroBaselineMae: null, skillVsZero: null, liftAtTopDecile: null, baseRate: null };
  let absError = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, baselineAbsError = 0;
  let posAbs = 0, posN = 0;
  for (const { y, target } of predicted) {
    absError += Math.abs(y - target);
    baselineAbsError += Math.abs(target);
    if (target > 0) { posAbs += Math.abs(y - target); posN++; }
    sx += y; sy += target; sxx += y * y; syy += target * target; sxy += y * target;
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2;
  const topK = Math.max(1, Math.floor(n * 0.1));
  const worst = [...predicted].sort((a, b) => b.y - a.y).slice(0, topK);
  const baseRate = sy / n;
  return {
    rows: n,
    mae: absError / n,
    maePositive: posN ? posAbs / posN : null,
    pearson: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null,
    zeroBaselineMae: baselineAbsError / n,
    skillVsZero: baselineAbsError > 0 ? 1 - (absError / n) / (baselineAbsError / n) : null,
    liftAtTopDecile: baseRate > 0 ? (worst.reduce((a, p) => a + p.target, 0) / topK) / baseRate : null,
    baseRate,
    positiveRows: posN,
  };
}

/**
 * The deterministic comparator Phase 13 requires: no learning at all, just a
 * hand-set sum of the three observations a human would actually weigh.
 */
export const DETERMINISTIC_HEURISTIC_TOLL: RouteGuidanceModel = {
  schema: [...ROUTE_GUIDANCE_FEATURES],
  kind: "linear",
  mean: new Array<number>(D).fill(0),
  scale: new Array<number>(D).fill(1),
  parameters: (() => {
    const w = new Array<number>(D).fill(0);
    w[ROUTE_GUIDANCE_FEATURES.indexOf("peerIntentIntoCell")] = 1.5;
    w[ROUTE_GUIDANCE_FEATURES.indexOf("peerApproachingMe")] = 1.5;
    w[ROUTE_GUIDANCE_FEATURES.indexOf("ownContentionHistory")] = 0.8;
    w[ROUTE_GUIDANCE_FEATURES.indexOf("isSingleFileCell")] = 0.4;
    w[ROUTE_GUIDANCE_FEATURES.indexOf("sensorContactWithin1")] = 0.6;
    return [...w, 0];
  })(),
  maxToll: 2,
  oodZ: Number.POSITIVE_INFINITY,
  trainedOn: { rows: 0, seeds: 0, layouts: [], label: "hand-set deterministic heuristic, no training" },
};
