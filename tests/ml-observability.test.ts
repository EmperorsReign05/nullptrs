import { describe, it, expect } from "vitest";
import { mapFromOpen } from "../src/core/bench/scenarios";
import { headOnScenario } from "./ml-scenarios";
import { collectRun } from "./ml-sampler";
import { LocalHistory, TEMPORAL_FEATURE_NAMES } from "../src/core/ml/temporal";
import { FEATURE_NAMES, extractFeatures, type FeatureContext } from "../src/core/ml/features";

export function indistinguishableWorld(longRemoteTask: boolean) {
  const sc = headOnScenario(3, 1);
  const open = [1, 15].flatMap((x) => Array.from({ length: 13 }, (_, y) => ({ x, y })));
  sc.map = mapFromOpen(open);
  const starts = [{ x: 1, y: 4 }, { x: 1, y: 6 }, { x: 15, y: 0 }];
  const goals = [{ x: 1, y: 6 }, { x: 1, y: 4 }, { x: 15, y: longRemoteTask ? 12 : 2 }];
  sc.robots.forEach((r, i) => { r.position = starts[i]; r.home = starts[i]; sc.tasks[i].pickup = starts[i]; sc.tasks[i].dropoff = goals[i]; });
  return sc;
}

describe("local observability and causal histories", () => {
  it("constructs identical local observations with opposite three-tick fleet labels", () => {
    const views: FeatureContext[][] = [[], []];
    const runs = [false, true].map((remote, index) => {
      const history = new LocalHistory();
      return collectRun(indistinguishableWorld(remote), index, 100, { observe: (ctx) => {
        if (ctx.local.id === "AMR-01" && ctx.currentTick <= 2) views[index].push(structuredClone(ctx));
        return history.observe(ctx);
      } });
    });
    expect(runs[0].onset).toBe(3);
    expect(runs[1].onset).toBe(13);
    expect(views[0]).toEqual(views[1]);
    const short = runs[0].samples.find((s) => s.tick === 2)!;
    const long = runs[1].samples.find((s) => s.tick === 2)!;
    expect(short.x).toEqual(long.x);
    expect([short.y, long.y]).toEqual([1, 0]);
    console.log("Observability counterexample: identical local histories at tick 2; fleet onset 3 vs 13; labels 1 vs 0.");
  });

  it("keeps the nine-feature prefix, isolates agents, and resets gaps", () => {
    const contexts: FeatureContext[] = [];
    collectRun(indistinguishableWorld(false), 1, 100, { observe: (ctx) => { contexts.push(structuredClone(ctx)); return Array(9).fill(0); } });
    const first = contexts[0], history = new LocalHistory();
    const a = history.observe(first);
    expect(a).toHaveLength(TEMPORAL_FEATURE_NAMES.length);
    expect(a.slice(0, 9)).toEqual(extractFeatures(first).map(Number));
    expect(TEMPORAL_FEATURE_NAMES.slice(0, 9)).toEqual(FEATURE_NAMES);
    expect(a.slice(9, 27)).toEqual(Array(18).fill(0));
    const secondAgent = { ...first, local: { ...first.local, id: "another" } };
    expect(history.observe(secondAgent)).toEqual(a);
    const next = history.observe({ ...first, currentTick: first.currentTick + 1 });
    expect(next.slice(9, 18)).toEqual(a.slice(0, 9));
    const gap = history.observe({ ...first, currentTick: first.currentTick + 3 });
    expect(gap.slice(9, 27)).toEqual(Array(18).fill(0));
    expect(() => history.observe({ ...first, currentTick: first.currentTick + 3 })).toThrow("advance");
    history.reset();
    expect(history.observe(first)).toEqual(a);
  });
  it("separates opposing intents from following and records only past motion", () => {
    const sc = headOnScenario(2, 1);
    const ctx: FeatureContext = {
      local: { id: "ego", position: { x: 6, y: 4 }, path: [{ x: 6, y: 4 }, { x: 6, y: 5 }], priority: 0, docked: false, seq: 0 },
      peers: [{ id: "peer", position: { x: 6, y: 6 }, intent: { x: 6, y: 5 }, priority: 0, docked: false, seq: 0, lastSeenTick: 0 }],
      map: sc.map, bays: new Set(), lastStepAsideTick: -1, currentTick: 0,
    };
    const value = (x: number[], name: string) => x[TEMPORAL_FEATURE_NAMES.indexOf(name)];
    const history = new LocalHistory();
    const first = history.observe(ctx);
    expect(value(first, "opposingIntentFraction")).toBe(1);
    expect(value(first, "nearestOpposingPeer")).toBe(0.5);
    expect(value(first, "stationaryPeerFraction")).toBe(0);
    const second = history.observe({ ...ctx, currentTick: 1 });
    expect(value(second, "stationaryPeerFraction")).toBe(1);
    expect(value(second, "waitStreakNorm")).toBe(0.2);
    const third = history.observe({ ...ctx, currentTick: 2, peers: [{ ...ctx.peers[0], position: { x: 6, y: 5 }, intent: { x: 6, y: 4 } }] });
    expect(value(third, "approachingPeerFraction")).toBe(1);
    expect(value(third, "reciprocalIntent")).toBe(1);
    const following = new LocalHistory().observe({ ...ctx, peers: [{ ...ctx.peers[0], intent: { x: 6, y: 7 } }] });
    expect(value(following, "opposingIntentFraction")).toBe(0);
    expect(value(following, "followingIntentFraction")).toBe(1);
    // Caller mutation after a snapshot must not rewrite its stored history.
    ctx.local.position.y = 3;
    expect(second.slice(9, 18)).toEqual(first.slice(0, 9));
  });

});
