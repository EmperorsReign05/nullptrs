// Logistic regression, implemented from scratch.
//
// No dependencies, deterministic, and small enough to read in one sitting —
// which matters here, because a model you cannot inspect is a model you
// cannot defend to a judge. The whole model is FEATURE_COUNT weights and one
// bias; the file that trains it fits on the page.

import { FEATURE_COUNT } from "./features";

export type Weights = { w: number[]; b: number };

export function zeros(): Weights {
  return { w: new Array(FEATURE_COUNT).fill(0), b: 0 };
}

export function sigmoid(z: number): number {
  // Numerically stable: exp overflows for large positive z.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predictOne(model: Weights, x: number[]): number {
  let z = model.b;
  for (let i = 0; i < FEATURE_COUNT; i++) z += model.w[i] * (x[i] ?? 0);
  return sigmoid(z);
}

export type Standardizer = { mean: number[]; std: number[] };

/** Zero-variance features get std 1 so they contribute 0 rather than NaN. */
export function fitStandardizer(rows: number[][]): Standardizer {
  const mean = new Array(FEATURE_COUNT).fill(0);
  for (const r of rows) for (let i = 0; i < FEATURE_COUNT; i++) mean[i] += r[i] ?? 0;
  for (let i = 0; i < FEATURE_COUNT; i++) mean[i] /= Math.max(1, rows.length);

  const std = new Array(FEATURE_COUNT).fill(0);
  for (const r of rows) {
    for (let i = 0; i < FEATURE_COUNT; i++) {
      const d = (r[i] ?? 0) - mean[i];
      std[i] += d * d;
    }
  }
  for (let i = 0; i < FEATURE_COUNT; i++) std[i] = Math.sqrt(std[i] / Math.max(1, rows.length)) || 1;
  return { mean, std };
}

export function applyStandardizer(s: Standardizer, x: number[]): number[] {
  const out = new Array(FEATURE_COUNT);
  for (let i = 0; i < FEATURE_COUNT; i++) out[i] = ((x[i] ?? 0) - s.mean[i]) / s.std[i];
  return out;
}

export type TrainOptions = {
  epochs?: number;
  learningRate?: number;
  /**
   * Per-class weight. Deadlock-risk data is heavily imbalanced — most ticks
   * are fine. Without this the optimiser just learns to predict "fine" and
   * reports a high accuracy while being useless, which is precisely the
   * failure this whole exercise is meant to avoid.
   */
  positiveWeight?: number;
  l2?: number;
};

export function train(rows: number[][], labels: number[], opts: TrainOptions = {}): Weights {
  const epochs = opts.epochs ?? 4000;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 1e-4;
  const n = rows.length;
  if (n === 0) return zeros();

  const positives = labels.reduce((a, l) => a + l, 0);
  const negatives = n - positives;
  // Total weight per class, equalised.
  const posWeight = positives > 0 ? n / (2 * positives) : 1;
  const negWeight = negatives > 0 ? n / (2 * negatives) : 1;
  void opts.positiveWeight;

  const model = zeros();
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(FEATURE_COUNT).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const x = rows[i];
      const p = predictOne(model, x);
      const w = labels[i] === 1 ? posWeight : negWeight;
      const err = (p - labels[i]) * w;
      gradB += err;
      for (let j = 0; j < FEATURE_COUNT; j++) grad[j] += err * (x[j] ?? 0);
    }
    model.b -= (lr * gradB) / n;
    for (let j = 0; j < FEATURE_COUNT; j++) {
      model.w[j] -= (lr * grad[j]) / n + l2 * model.w[j];
    }
  }
  return model;
}

export type Confusion = { tp: number; fp: number; tn: number; fn: number };

export function confusion(model: Weights, rows: number[][], labels: number[], threshold = 0.5): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (let i = 0; i < rows.length; i++) {
    const p = predictOne(model, rows[i]) >= threshold;
    const y = labels[i] === 1;
    if (p && y) c.tp++;
    else if (p && !y) c.fp++;
    else if (!p && y) c.fn++;
    else c.tn++;
  }
  return c;
}

export function precision(c: Confusion): number {
  return c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
}
export function recall(c: Confusion): number {
  return c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
}
export function f1(c: Confusion): number {
  const p = precision(c);
  const r = recall(c);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}
export function accuracy(c: Confusion): number {
  const total = c.tp + c.fp + c.tn + c.fn;
  return total === 0 ? 0 : (c.tp + c.tn) / total;
}

/** Threshold that maximises F1 on the given set. Chosen on TRAIN data only. */
export function bestThreshold(model: Weights, rows: number[][], labels: number[]): number {
  let best = 0.5;
  let bestF = -1;
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    const f = f1(confusion(model, rows, labels, t));
    if (f > bestF) {
      bestF = f;
      best = t;
    }
  }
  return best;
}

export function describe(model: Weights, names: readonly string[]): string {
  const pairs = model.w
    .map((w, i) => ({ name: names[i] ?? `f${i}`, w }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return pairs.map((p) => `${p.name}=${p.w.toFixed(3)}`).join("  ") + `  (bias=${model.b.toFixed(3)})`;
}
