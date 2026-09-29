import { describe, it, expect } from "vitest";
import { fitForest, forestScore, evaluateForest } from "../src/core/ml/forest";
import type { Sample } from "../src/core/ml/predictor";

describe("seed-bootstrap forest", () => {
  const rows: Sample[] = Array.from({ length: 80 }, (_, seed) => {
    const a = seed % 2, b = Math.floor(seed / 2) % 2;
    return { seed, tick: 0, x: [a, b, 0, 0, 0, 0, 0, 0, 0], y: a ^ b };
  });
  it("learns a nonlinear interaction and survives JSON roundtrip", () => {
    const model = fitForest(rows, { minLeaf: 2, depth: 4 });
    const unseen = rows.slice(0, 4).map((s) => ({ ...s, seed: s.seed + 1000 }));
    expect(evaluateForest(model, unseen).f1).toBe(1);
    const copy = JSON.parse(JSON.stringify(model));
    expect(evaluateForest(copy, unseen)).toEqual(evaluateForest(model, unseen));
    expect(unseen.map((s) => forestScore(model, s.x)).every((p) => p >= 0 && p <= 1)).toBe(true);
  });
  it("is deterministic and does not mutate samples", () => {
    const before = JSON.stringify(rows);
    expect(fitForest(rows, { trees: 4 })).toEqual(fitForest(rows, { trees: 4 }));
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("rejects empty or single-class training instead of producing a vacuous model", () => {
    expect(() => fitForest([])).toThrow("both classes");
    expect(() => fitForest(rows.filter((s) => s.y === 1))).toThrow("both classes");
    expect(() => fitForest(rows, { trees: 0 })).toThrow("invalid");
  });
  it("accepts an explicit extended schema and rejects malformed training vectors", () => {
    const extended = rows.map((r) => ({ ...r, x: [...r.x, r.y] }));
    const model = fitForest(extended, { featureCount: 10, featuresPerSplit: 10, trees: 4, minLeaf: 2 });
    expect(evaluateForest(model, extended).f1).toBe(1);
    expect(() => fitForest(extended)).toThrow("feature vector");
    expect(() => fitForest(rows, { trees: 2.5 })).toThrow("invalid");
    expect(() => fitForest(rows, { featuresPerSplit: 10 })).toThrow("invalid");
  });

});
