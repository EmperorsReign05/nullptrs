// Small nonlinear challenger using the unchanged nine local features.
// Bootstrap whole scenario seeds, not correlated individual ticks. Each run
// has equal total weight before class balancing. No runtime fleet integration.
import { FEATURE_COUNT } from "./features";
import { f1, precision, recall, type Confusion } from "./logistic";
import type { Sample, Report } from "./predictor";

export type Tree = { probability: number } | { feature: number; cut: number; left: Tree; right: Tree };
export type Forest = { trees: Tree[]; threshold: number };
export type ForestOptions = { trees: number; depth: number; minLeaf: number; seed: number; featureCount: number; featuresPerSplit: number };
type Weighted = { sample: Sample; weight: number };

function randomSource(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grow(rows: Weighted[], depth: number, opts: ForestOptions, rand: () => number): Tree {
  const total = rows.reduce((sum, r) => sum + r.weight, 0);
  const positive = rows.reduce((sum, r) => sum + r.weight * r.sample.y, 0);
  const leaf = { probability: total ? positive / total : 0 };
  if (depth >= opts.depth || rows.length < 2 * opts.minLeaf || positive < 1e-12 || total - positive < 1e-12) return leaf;
  const features = Array.from({ length: opts.featureCount }, (_, i) => i);
  for (let i = features.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [features[i], features[j]] = [features[j], features[i]];
  }
  // Weighted Gini impurity times node mass; additive over the two children.
  const impurity = (p: number, mass: number) => mass > 0 ? 2 * p * (mass - p) / mass : 0;
  let bestLoss = impurity(positive, total) - 1e-12;
  let split: { feature: number; cut: number } | null = null;
  for (const feature of features.slice(0, opts.featuresPerSplit)) {
    const sorted = [...rows].sort((a, b) => Number(a.sample.x[feature]) - Number(b.sample.x[feature]));
    let leftMass = 0, leftPositive = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      leftMass += sorted[i].weight;
      leftPositive += sorted[i].weight * sorted[i].sample.y;
      if (i + 1 < opts.minLeaf || sorted.length - i - 1 < opts.minLeaf) continue;
      const value = Number(sorted[i].sample.x[feature]);
      const next = Number(sorted[i + 1].sample.x[feature]);
      if (value === next) continue;
      const loss = impurity(leftPositive, leftMass) + impurity(positive - leftPositive, total - leftMass);
      if (loss < bestLoss) { bestLoss = loss; split = { feature, cut: (value + next) / 2 }; }
    }
  }
  if (!split) return leaf;
  const { feature, cut } = split;
  return { feature, cut,
    left: grow(rows.filter((r) => Number(r.sample.x[feature]) <= cut), depth + 1, opts, rand),
    right: grow(rows.filter((r) => Number(r.sample.x[feature]) > cut), depth + 1, opts, rand) };
}

export function forestScore(model: Forest, x: number[]): number {
  let total = 0;
  for (let node of model.trees) {
    while ("feature" in node) node = Number(x[node.feature]) <= node.cut ? node.left : node.right;
    total += node.probability;
  }
  return total / Math.max(1, model.trees.length);
}

export function reportPredictions(rows: Sample[], predictions: boolean[]): Report {
  if (rows.length !== predictions.length) throw new Error("prediction count mismatch");
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  rows.forEach((r, i) => { if (r.y === 1) { if (predictions[i]) c.tp++; else c.fn++; }
    else { if (predictions[i]) c.fp++; else c.tn++; } });
  return { confusion: c, precision: precision(c), recall: recall(c), f1: f1(c),
    positives: rows.reduce((sum, r) => sum + r.y, 0), total: rows.length };
}
export function evaluateForest(model: Forest, rows: Sample[]): Report {
  return reportPredictions(rows, rows.map((r) => forestScore(model, r.x) >= model.threshold));
}

export function fitForest(rows: Sample[], options: Partial<ForestOptions> = {}): Forest {
  if (!rows.length || !rows.some((r) => r.y === 1) || !rows.some((r) => r.y === 0)) throw new Error("training needs both classes");
  const opts: ForestOptions = { trees: 48, depth: 5, minLeaf: 8, seed: 20260929, featureCount: FEATURE_COUNT, featuresPerSplit: 4, ...options };
  if (Object.values(opts).some((v) => !Number.isInteger(v)) || opts.trees < 1 || opts.depth < 1 || opts.minLeaf < 1 || opts.featureCount < 1 || opts.featuresPerSplit < 1 || opts.featuresPerSplit > opts.featureCount) throw new Error("invalid forest options");
  if (rows.some((r) => r.x.length !== opts.featureCount || r.x.some((v) => !Number.isFinite(Number(v))))) throw new Error("invalid feature vector");
  const groups = new Map<number, Sample[]>();
  for (const row of rows) { const group = groups.get(row.seed) ?? []; group.push(row); groups.set(row.seed, group); }
  const runs = [...groups.values()];
  const rand = randomSource(opts.seed);
  const model: Forest = { trees: [], threshold: 0.5 };
  for (let t = 0; t < opts.trees; t++) {
    const bag: Weighted[] = [];
    for (let i = 0; i < runs.length; i++) {
      const group = runs[Math.floor(rand() * runs.length)];
      for (const sample of group) bag.push({ sample, weight: 1 / group.length });
    }
    const pos = bag.reduce((sum, r) => sum + r.weight * r.sample.y, 0);
    const neg = bag.reduce((sum, r) => sum + r.weight * (1 - r.sample.y), 0);
    for (const row of bag) row.weight /= row.sample.y ? pos || 1 : neg || 1;
    model.trees.push(grow(bag, 0, opts, rand));
  }
  // Threshold fitting uses TRAIN only, matching the existing logistic policy.
  const scores = rows.map((r) => forestScore(model, r.x));
  let best = -1;
  for (let i = 1; i <= 19; i++) {
    const threshold = i / 20;
    const value = reportPredictions(rows, scores.map((p) => p >= threshold)).f1;
    if (value > best) { best = value; model.threshold = threshold; }
  }
  return model;
}
