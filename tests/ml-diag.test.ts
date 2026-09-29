import { describe, it, expect } from "vitest";
import { headOnScenario } from "./ml-scenarios";
import { collectRun } from "./ml-sampler";
import { FEATURE_NAMES } from "../src/core/ml/features";

describe("ML diagnostics (no fitting)", () => {
  it("measures future positives and contention under stop-and-wait", () => {
    for (const n of [3, 4, 6, 8]) {
      const runs = Array.from({ length: 20 }, (_, i) => collectRun(headOnScenario(n, i + 1), i + 1));
      const rows = runs.flatMap((r) => r.samples);
      const positives = rows.filter((s) => s.y === 1).length;
      expect(positives).toBeGreaterThan(0);
      expect(rows.some((s) => s.x[0] > 0)).toBe(true);
      console.log(`DIAG n=${n}: deadlocked runs=${runs.filter((r) => r.onset !== null).length}/20, samples=${rows.length}, positive=${(100 * positives / rows.length).toFixed(1)}%`);
      console.log(FEATURE_NAMES.map((name, j) => `${name}=${(100 * rows.filter((s) => s.x[j] > 0).length / rows.length).toFixed(1)}%`).join(" "));
    }
  });
});
