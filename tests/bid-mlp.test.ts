import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { calculateBid, withBidScorer, type BidScorer } from "../src/core/auction/cost";
import { getBiddingRobots } from "../src/core/auction/assign";
import { extractBidFeatures, BID_FEATURE_NAMES, correctionFeasible, assessBidEnergy } from "../src/core/ml/bidfeatures";
import { guardedBidScorer, hasReciprocalIntent, type WinnerGuard, type WinnerGuardEvent, terminalCost, bidRandom, trainBidModel, predictBid, bidLossGradient, learnedBidScorer, type BidTrainingRow } from "../src/core/ml/bidmodel";
import { createInitialWorld } from "../src/core/simulation/state";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { computeCongestion } from "../src/core/map/warehouse";
import type { Task, WorldState } from "../src/core/types";

// Frozen before testing: actual warehouse, 4..8 robots, heterogeneous capacity,
// 12..16 tasks released in three bursts, battery 65..100, fixed 400-tick cap.
// Synthetic workload; no claim of coverage of 20-robot saturation or hardware.
const CAP = 400;
const TRAIN = Array.from({ length: 256 }, (_, i) => 10000 + i);
const VALIDATION = [...Array.from({ length: 80 }, (_, i) => 3000 + i), ...Array.from({ length: 20 }, (_, i) => 2000 + i)];
const TEST = Array.from({ length: 100 }, (_, i) => 5000 + i);
function scenario(seed: number) {
  const random = bidRandom(seed), initial = createInitialWorld();
  const open = initial.map.cells.filter(c => !c.blocked).map(c => c.position);
  const pick = () => open[Math.floor(random() * open.length)];
  const occupied = new Set<string>();
  const robots = initial.robots.slice(0, 4 + seed % 5).map(r => {
    let position = pick();
    while (occupied.has(JSON.stringify(position))) position = pick();
    occupied.add(JSON.stringify(position));
    return { ...r, position, home: position, battery: 65 + Math.floor(random() * 36),
      currentTaskId: undefined, queuedTaskIds: [], status: "idle" as const, path: [] };
  });
  const tasks: Task[] = Array.from({ length: 12 + seed % 5 }, (_, i) => {
    const pickup = pick();
    let dropoff = pick();
    while (JSON.stringify(pickup) === JSON.stringify(dropoff)) dropoff = pick();
    return { id: `S${seed}-T${i}`, pickup, dropoff, weight: [20, 40, 60, 80][Math.floor(random() * 4)],
      priority: 1, createdAt: Math.floor(i / 5) * 12, status: "pending" };
  });
  const world: WorldState = { ...initial, robots, tasks: [], map: computeCongestion(initial.map, robots) };
  return { world, tasks };
}
type Safety = { collisions: number; swaps: number; blockedCells: number; zeroBatteryWork: number; overloaded: number; queueOverflow: number };
type Outcome = { safety: Safety; seed: number; completionTime: number | null; cappedTime: number; completed: number; total: number };
function rollout(seed: number, scorer?: BidScorer, start?: WorldState, observe?: (world: WorldState) => void, cap = CAP): Outcome {
  const setup = scenario(seed);
  let world = withBidScorer(start ?? setup.world, scorer);
  const safety: Safety = { collisions: 0, swaps: 0, blockedCells: 0, zeroBatteryWork: 0, overloaded: 0, queueOverflow: 0 };
  while (world.tick < cap) {
    const previous = world;
    const ids = new Set(world.tasks.map(t => t.id));
    const released = setup.tasks.filter(t => t.createdAt <= world.tick && !ids.has(t.id));
    world = runDispatchTick({ ...world, tasks: [...world.tasks, ...released] });
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    safety.collisions += world.robots.length - new Set(world.robots.map(r => key(r.position))).size;
    world.robots.forEach((r, i) => {
      if (world.map.cells[r.position.y * world.map.width + r.position.x]?.blocked !== false) safety.blockedCells++;
      if (r.battery <= 0 && r.currentTaskId) safety.zeroBatteryWork++;
      if ((r.queuedTaskIds?.length ?? 0) > 4) safety.queueOverflow++;
      const job = world.tasks.find(t => t.id === r.currentTaskId);
      if (job && job.weight > r.model.payloadCapacity) safety.overloaded++;
      for (let j = i + 1; j < world.robots.length; j++) {
        if (key(previous.robots[i].position) !== key(r.position) &&
          key(previous.robots[i].position) === key(world.robots[j].position) &&
          key(previous.robots[j].position) === key(r.position)) safety.swaps++;
      }
    });
    observe?.(world);
    if (world.tasks.filter(t => t.status === "completed").length === setup.tasks.length) break;
  }
  const completed = world.tasks.filter(t => t.status === "completed").length;
  return { safety, seed, completionTime: completed === setup.tasks.length ? world.tick : null,
    cappedTime: world.tick, completed, total: setup.tasks.length };
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return (b[Math.floor((b.length - 1) / 2)] + b[Math.floor(b.length / 2)]) / 2; };
function summary(outcomes: Outcome[]) {
  return { seeds: outcomes.length, fullyCompleted: outcomes.filter(o => o.completionTime !== null).length,
    // A timeout is censored, NOT a measured 400-tick completion.
    meanCappedTicks: mean(outcomes.map(o => o.cappedTime)), medianCappedTicks: median(outcomes.map(o => o.cappedTime)),
    meanTasksPerTick: mean(outcomes.map(o => o.completed / o.cappedTime)),
    completedTasks: outcomes.reduce((s, o) => s + o.completed, 0), totalTasks: outcomes.reduce((s, o) => s + o.total, 0) };
}

function collect(seed: number) {
  const snapshots = new Map<string, { world: WorldState; task: Task }>();
  const baseline = rollout(seed, (_r, task, world, bid) => {
    // Snapshot at the first remaining pending task: replay must not re-auction
    // earlier infeasible tasks and increment their battery streak a second time.
    if (world.tasks.find(t => t.status === "pending")?.id === task.id) {
      const id = `${world.tick}:${task.id}`;
      if (!snapshots.has(id)) snapshots.set(id, { world: withBidScorer(world), task });
    }
    return bid.totalCost;
  });
  const decisions = [...snapshots.values()].filter(s => getBiddingRobots(s.task, s.world.robots, s.world).length > 1);
  // All eligible decisions (not ticks); every feasible eligible action
  // at each selected decision receives its own baseline-continuation rollout.
  const chosen = decisions;
  const rows: BidTrainingRow[] = [];
  let censored = 0, informative = 0;
  for (const { world, task } of chosen) {
    // Replaying a decision snapshot under the original policy must produce
    // the original outcome; otherwise counterfactual labels are not comparable.
    const replay = rollout(seed, undefined, world);
    expect([replay.completionTime, replay.completed]).toEqual([baseline.completionTime, baseline.completed]);
    const bids = getBiddingRobots(task, world.robots, world);
    const actions = bids.map(bid => {
      const outcome = rollout(seed, (robot, t, w, original) =>
        w.tick === world.tick && t.id === task.id ? (robot.id === bid.robotId ? -1 : 1) : original.totalCost, world);
      if (outcome.completionTime === null) censored++;
      return { features: extractBidFeatures(world.robots.find(r => r.id === bid.robotId)!, task, world, bid), cost: terminalCost(outcome.completed, outcome.total, outcome.cappedTime, CAP), complete: outcome.completionTime !== null };
    });
    if (new Set(actions.map(a => a.cost)).size > 1) informative++;
    const completeCosts = actions.filter(a => a.complete).map(a => a.cost);
    const low = Math.min(...completeCosts), high = Math.max(...completeCosts);
    for (const action of actions) rows.push({ seed, decision: `${world.tick}:${task.id}`,
      features: action.features, complete: action.complete,
      // Completed actions occupy [-1,1], failures [3,4], irrespective of speed.
      target: action.complete ? (high > low ? 2 * (action.cost - low) / (high - low) - 1 : 0) : action.cost + 1 });
  }
  return { rows, censored, informative, decisions: chosen.length, baseline };
}

describe("learned auction scorer mechanics", () => {
  it("exposes queue, peer intent and reachable charger energy margin", () => {
    const world = scenario(100).world;
    const task = { ...scenario(100).tasks[0], weight: 1 };
    const robot = { ...world.robots[0], battery: 100, queuedTaskIds: ["q1", "q2"] };
    const peer = { ...world.robots[1], path: [world.robots[1].position, task.pickup] };
    world.robots = [robot, peer];
    const bid = calculateBid(robot, task, world);
    const f = extractBidFeatures(robot, task, world, bid);
    expect(f[BID_FEATURE_NAMES.indexOf("queueDepth")]).toBe(2);
    expect(f[BID_FEATURE_NAMES.indexOf("peerRouteContention")]).toBe(1);
    expect(f[BID_FEATURE_NAMES.indexOf("peerNextIntentContention")]).toBe(1);
    expect(f[BID_FEATURE_NAMES.indexOf("chargerDistance")]).toBeGreaterThanOrEqual(0);
    expect(f[BID_FEATURE_NAMES.indexOf("energyReserveAfterReturn")]).toBeLessThan(100);
    expect(f.every(Number.isFinite)).toBe(true);
    const lowCharge = { ...robot, battery: robot.battery - 10 };
    const lower = extractBidFeatures(lowCharge, task, world, calculateBid(lowCharge, task, world));
    expect(lower[BID_FEATURE_NAMES.indexOf("energyReserveAfterReturn")]).toBe(
      f[BID_FEATURE_NAMES.indexOf("energyReserveAfterReturn")] - 10);
    const noStations = { ...world, map: { ...world.map, cells: world.map.cells.map(c => ({
      ...c, blocked: c.blocked || [[0, 4], [19, 8], [9, 0], [9, 12]].some(([x, y]) => c.position.x === x && c.position.y === y),
    })) } };
    // Explicit unavailable-station flag and finite sentinel, never Infinity
    // fed into a neural network. Reuse the already feasible route's bid here.
    const unavailable = extractBidFeatures(robot, task, noStations, bid, [task.pickup]);
    expect(unavailable[BID_FEATURE_NAMES.indexOf("chargerUnreachable")]).toBe(1);
    expect(unavailable.every(Number.isFinite)).toBe(true);
  });
  it("keeps scorer world-local, preserves feasibility, and falls back on NaN", () => {
    const { world, tasks } = scenario(100), robot = world.robots[0];
    const task = { ...tasks[0], weight: 1 };
    const baseline = calculateBid(robot, task, world);
    const custom = withBidScorer(world, () => -99);
    expect(calculateBid(robot, task, custom).totalCost).toBe(-99);
    expect(calculateBid(robot, task, world)).toEqual(baseline);
    expect(calculateBid(robot, task, withBidScorer(world, () => NaN))).toEqual(baseline);
    expect(calculateBid(robot, { ...task, weight: 1000 }, custom).feasible).toBe(false);
    expect(calculateBid({ ...robot, battery: 0 }, task, custom).infeasibleReason).toBe("battery");
    expect(rollout(100, (_r, _t, _w, bid) => bid.totalCost)).toEqual(rollout(100));
  });
  it("strictly orders terminal outcomes and verifies the terminal-first gradient", () => {
    expect(terminalCost(10, 10, 400, 400)).toBeLessThan(terminalCost(9, 10, 1, 400));
    expect(terminalCost(9, 10, 1, 400)).toBe(terminalCost(9, 10, 399, 400));
    const features = BID_FEATURE_NAMES.map(() => 0);
    const rows: BidTrainingRow[] = [
      { seed: 1, decision: "d", features, target: 0.9, complete: true },
      { seed: 1, decision: "d", features: features.map((_, i) => Number(i === 6)), target: 3.1, complete: false },
    ];
    const model = trainBidModel(rows, { hidden: 4, epochs: 0 });
    model.parameters.fill(0.05);
    const { gradient } = bidLossGradient(model, rows);
    // When terminal order is violated, changing speed targets has no effect.
    expect(bidLossGradient(model, rows.map(r => ({ ...r, target: -100 }))).gradient).toEqual(gradient);
    for (let i = 0; i < model.parameters.length; i++) {
      const old = model.parameters[i], e = 1e-5;
      model.parameters[i] = old + e;
      const plus = bidLossGradient(model, rows).loss;
      model.parameters[i] = old - e;
      const minus = bidLossGradient(model, rows).loss;
      model.parameters[i] = old;
      expect(gradient[i]).toBeCloseTo((plus - minus) / (2 * e), 6);
    }
  });
  it("bounds corrections, gates committed energy, and preserves zero-bound parity", () => {
    const { world, tasks } = scenario(100);
    const robot = { ...world.robots[0], battery: 100 }, task = { ...tasks[0], weight: 1 };
    const bid = calculateBid(robot, task, world);
    const features = extractBidFeatures(robot, task, world, bid);
    const model = trainBidModel([{ seed: 1, features, target: -100 }], { epochs: 0 });
    model.parameters[model.parameters.length - 1] = -100;
    for (const bound of [0.05, 0.1, 0.15, 0.2]) {
      const scored = calculateBid(robot, task, withBidScorer(world, learnedBidScorer(model, bound)));
      expect(scored.totalCost).toBeGreaterThanOrEqual(bid.totalCost * (1 - bound) - 1e-9);
      expect(scored.totalCost).toBeLessThanOrEqual(bid.totalCost + 1e-9);
    }
    const unknownQueue = { ...robot, queuedTaskIds: ["unknown"] };
    expect(correctionFeasible(unknownQueue, task, world)).toBe(false);
    expect(calculateBid(unknownQueue, task, withBidScorer(world, learnedBidScorer(model))).totalCost)
      .toBe(calculateBid(unknownQueue, task, world).totalCost);
    expect(correctionFeasible({ ...robot, status: "charging" }, task, world)).toBe(false);
    expect(correctionFeasible({ ...robot, battery: 20 }, task, world)).toBe(false);
    expect(rollout(100, learnedBidScorer(model, 0))).toEqual(rollout(100));
    expect(() => learnedBidScorer(model, 0.21)).toThrow();
  });
  it("manual backprop matches finite differences and training is deterministic", () => {
    const random = bidRandom(5);
    const rows = Array.from({ length: 20 }, () => {
      const features = BID_FEATURE_NAMES.map(() => random() * 2 - 1);
      return { seed: 1, features, target: features[0] * features[1] + features[6] };
    });
    const model = trainBidModel(rows, { hidden: 4, epochs: 0 });
    const { gradient, loss } = bidLossGradient(model, rows, 0.01);
    for (let i = 0; i < model.parameters.length; i++) {
      const original = model.parameters[i], eps = 1e-5;
      model.parameters[i] = original + eps;
      const plus = bidLossGradient(model, rows, 0.01).loss;
      model.parameters[i] = original - eps;
      const minus = bidLossGradient(model, rows, 0.01).loss;
      model.parameters[i] = original;
      expect(gradient[i]).toBeCloseTo((plus - minus) / (2 * eps), 6);
    }
    const trained = trainBidModel(rows, { hidden: 4 });
    expect(bidLossGradient(trained, rows, 0.01).loss).toBeLessThan(loss / 3);
    expect(trainBidModel(rows, { hidden: 4 })).toEqual(trained);
    expect(predictBid(trained, rows[0].features)).toBeTypeOf("number");
  });
});

// Historical failure is development data from this point forward.
it.skipIf(process.env.BID_DIAG !== "1")("diagnoses historical unrestricted scorer failure", () => {
  const model = JSON.parse(readFileSync("/tmp/bid-mlp-v1.json", "utf8"));
  const scorer: BidScorer = (r, t, w, b, route) => predictBid(model, extractBidFeatures(r, t, w, b, route));
  const snapshots: unknown[] = [];
  const outcome = rollout(2009, scorer, undefined, w => {
    if ((w.tick >= 95 && w.tick <= 105) || [1, 13, 25, 200, 400, 1000, 2000].includes(w.tick)) snapshots.push(w);
  }, 2000);
  const baseline = rollout(2009);
  // Causal ablation: revert one task's auction to deterministic scoring while
  // retaining the old learned scorer for every other task and the same engine.
  const ablations = scenario(2009).tasks.map(task => ({ taskId: task.id,
    outcome: rollout(2009, (r, t, w, b, route) => t.id === task.id ? b.totalCost : scorer(r, t, w, b, route)),
  }));
  writeFileSync("/tmp/bid-failure-diagnosis.json", JSON.stringify({ baseline, outcome, snapshots, ablations }, null, 2));
  console.log("DIAG", baseline, outcome);
});

/** Paired bootstrap on whole seeds. Positive CI lower bound is required;
 * never resample ticks or discard failures. Statistics only used after 100%
 * terminal completion; otherwise no mean-completion claim is permitted. */
function pairedCI(differences: number[]) {
  const random = bidRandom(717), samples: number[] = [];
  for (let b = 0; b < 10000; b++) {
    let sum = 0;
    for (let i = 0; i < differences.length; i++) sum += differences[Math.floor(random() * differences.length)];
    samples.push(sum / differences.length);
  }
  samples.sort((a, b) => a - b);
  return [samples[250], samples[9749]];
}
function safeRelative(baseline: Outcome[], learned: Outcome[]) {
  return learned.every((o, i) => (Object.keys(o.safety) as (keyof Safety)[]).every(k => o.safety[k] <= baseline[i].safety[k]));
}

function sourceHashes() {
  return Object.fromEntries([
    "src/core/auction/cost.ts", "src/core/auction/assign.ts", "src/core/ml/bidfeatures.ts", "src/core/ml/bidmodel.ts",
    "src/core/simulation/dispatch.ts", "src/core/simulation/engine.ts", "src/core/simulation/robotModels.ts",
    "src/core/map/warehouse.ts", "src/core/pathfinding/astar.ts", "src/core/pathfinding/pibt.ts", "src/core/bench/stopwait.ts",
  ].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
}

// V2 measured result (2026-09-29): 15,268 actions / 256 training seeds,
// 100 development seeds, 100 fresh acceptance seeds. Discounts capped at 10%
// (400 epochs) selected on development only. Acceptance: deterministic 97/100
// runs, learned 98/100; both 1394/1400 tasks. No audited safety regression.
// NOT ACCEPTED: incomplete runs prevent a mean-completion/CI claim. Remaining
// failures persist at 1000 ticks, involving occupied dead-end cells in both
// policies. Historical unrestricted failure 2009 now completes in 121 ticks.
// BID_RESIDUAL_EXPERIMENT=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
// Former held-out seeds are now DEVELOPMENT ONLY. 5000..5099 are fresh locked
// acceptance seeds. All four bounds are swept on validation, not on acceptance.
it.skipIf(process.env.BID_RESIDUAL_EXPERIMENT !== "1")("large counterfactual corpus and bounded residual acceptance", () => {
  const fingerprints = sourceHashes();
  expect(new Set([...TRAIN, ...VALIDATION, ...TEST]).size).toBe(TRAIN.length + VALIDATION.length + TEST.length);
  const rows: BidTrainingRow[] = process.env.BID_RESIDUAL_CACHE === "1"
    ? JSON.parse(readFileSync("/tmp/bid-residual-training.json", "utf8"))
    : TRAIN.flatMap((seed, i) => {
      const c = collect(seed);
      if (i % 16 === 0) process.stdout.write(`corpus ${i + 1}/${TRAIN.length}: ${c.rows.length} actions\n`);
      return c.rows;
    });
  expect([...new Set(rows.map(r => r.seed))].sort((a, b) => a - b)).toEqual(TRAIN);
  expect(rows.every(r => r.decision !== undefined && r.complete !== undefined)).toBe(true);
  writeFileSync("/tmp/bid-residual-training.json", JSON.stringify(rows));
  expect(rows.length).toBeGreaterThan(591 * 10);
  const baselineValidation = VALIDATION.map(seed => rollout(seed));
  process.stdout.write(`validation baseline: ${JSON.stringify(summary(baselineValidation))}\n`);
  const candidates = [];
  for (const epochs of [400, 1200]) {
    process.stdout.write(`training ${rows.length} rows, ${epochs} epochs\n`);
    const model = trainBidModel(rows, { epochs });
    for (const bound of [0.05, 0.1, 0.15, 0.2]) {
      const outcomes = VALIDATION.map(seed => rollout(seed, learnedBidScorer(model, bound)));
      const valid = outcomes.every(o => o.completionTime !== null) && safeRelative(baselineValidation, outcomes);
      process.stdout.write(`validation ${epochs} / ${bound}: ${JSON.stringify(summary(outcomes))}; valid=${valid}\n`);
      candidates.push({ epochs, bound, model, outcomes, valid });
    }
  }
  // Completion/safety dominate speed; no incomplete candidate can win on ticks.
  candidates.sort((a, b) => Number(b.valid) - Number(a.valid) ||
    summary(b.outcomes).fullyCompleted - summary(a.outcomes).fullyCompleted ||
    mean(a.outcomes.map(o => o.cappedTime)) - mean(b.outcomes.map(o => o.cappedTime)) || a.bound - b.bound);
  const selected = candidates[0];
  writeFileSync("/tmp/bid-residual-locked-model.json", JSON.stringify({ model: selected.model, bound: selected.bound }));
  const baseline = TEST.map(seed => rollout(seed));
  const learned = TEST.map(seed => rollout(seed, learnedBidScorer(selected.model, selected.bound)));
  const allComplete = [...baseline, ...learned].every(o => o.completionTime !== null);
  const safe = safeRelative(baseline, learned);
  const savings = baseline.map((b, i) => b.cappedTime - learned[i].cappedTime);
  const ci = allComplete ? pairedCI(savings) : null;
  expect(sourceHashes()).toEqual(fingerprints);
  const report = { sourceHashes: fingerprints, protocol: "v2 bounded residual; terminal-first labels and per-decision loss; validation-only bound/epoch selection",
    trainSeeds: TRAIN, validationSeeds: VALIDATION, testSeeds: TEST, cap: CAP, rows: rows.length,
    censoredTrainingRollouts: rows.filter(r => !r.complete).length,
    informativeDecisions: new Set(rows.filter(r => r.target !== 0).map(r => `${r.seed}:${r.decision}`)).size,
    selected: { epochs: selected.epochs, bound: selected.bound, validationEligible: selected.valid },
    baselineValidation: summary(baselineValidation), baselineValidationFailures: baselineValidation.filter(o => o.completionTime === null), baseline: summary(baseline), learned: summary(learned), allComplete, noSafetyRegression: safe,
    meanCompletionTicksSaved: allComplete ? mean(savings) : null,
    pairedMeanSavings95CI: ci,
    accepted: selected.valid && allComplete && safe && ci !== null && ci[0] > 0,
    validation: candidates.map(c => ({ epochs: c.epochs, bound: c.bound, valid: c.valid, ...summary(c.outcomes), failures: c.outcomes.filter(o => o.completionTime === null) })),
    perSeed: baseline.map((b, i) => ({ baseline: b, learned: learned[i] })),
    caveat: "Synthetic 4..8-robot warehouse workload. No claim of universal completion, hardware safety or stop-and-wait improvement. Failed runs are censored, never removed. Correction feasibility gating falls back to deterministic scoring; it does not certify future traffic." };
  writeFileSync("/tmp/bid-residual-report.json", JSON.stringify(report, null, 2));
  console.log("RESIDUAL RESULT", JSON.stringify({ ...report, trainSeeds: undefined, validationSeeds: undefined, testSeeds: undefined, perSeed: undefined }, null, 2));
}, 1_800_000);

it.skipIf(process.env.BID_RESIDUAL_DIAG !== "1")("traces residual and deterministic terminal failures", () => {
  const artifact = JSON.parse(readFileSync("/tmp/bid-residual-locked-model.json", "utf8"));
  const records = [2009, 3009, 3014, 5064, 5069].map(seed => {
    const arms = [undefined, learnedBidScorer(artifact.model, artifact.bound)].map(scorer => {
      const states: unknown[] = [];
      const result = rollout(seed, scorer, undefined, world => {
        if ([100, 200, 400, 1000].includes(world.tick)) states.push({ tick: world.tick,
          robots: world.robots, tasks: world.tasks.filter(t => t.status !== "completed") });
      }, 1000);
      return { result, states };
    });
    return { seed, baseline: arms[0], learned: arms[1] };
  });
  writeFileSync("/tmp/bid-residual-diagnosis.json", JSON.stringify(records, null, 2));
});

function traceScorer(raw: BidScorer, changes: Record<string, any>[], revert?: string): BidScorer {
  const seen = new Set<string>();
  return (robot, task, world, bid, route) => {
    const decision = `${world.tick}:${task.id}`;
    if (!seen.has(decision)) {
      seen.add(decision);
      const plain = withBidScorer(world);
      const bidders = getBiddingRobots(task, world.robots, plain).map(b => {
        const r = world.robots.find(r => r.id === b.robotId)!;
        const final = calculateBid(r, task, withBidScorer(plain, raw)).totalCost;
        const features = extractBidFeatures(r, task, plain, b);
        return { robotId: r.id, deterministicBid: b.totalCost, correction: final - b.totalCost, finalBid: final,
          battery: r.battery, queueDepth: r.queuedTaskIds?.length ?? 0, routeCost: b.travelCost,
          chargingFeasible: correctionFeasible(r, task, plain), robot: r,
          features: Object.fromEntries(BID_FEATURE_NAMES.map((n, i) => [n, features[i]])) };
      });
      const rank = (field: "deterministicBid" | "finalBid") => [...bidders].sort((a, b) => a[field] - b[field] || a.robotId.localeCompare(b.robotId))[0]?.robotId;
      if (rank("deterministicBid") !== rank("finalBid")) changes.push({ decision, tick: world.tick, task,
        deterministicWinner: rank("deterministicBid"), learnedWinner: rank("finalBid"), bidders });
    }
    return revert === decision ? bid.totalCost : raw(robot, task, world, bid, route);
  };
}
it.skipIf(process.env.BID_GUARD_DIAG !== "1")("audits divergent seeds and isolates the first causal regression decision", () => {
  const { model, bound } = JSON.parse(readFileSync("artifacts/bid-guard-v3/model.json", "utf8"));
  const raw = learnedBidScorer(model, bound);
  const records = TEST.map(seed => {
    const changes: Record<string, any>[] = [];
    const baseline = rollout(seed), learned = rollout(seed, traceScorer(raw, changes));
    const divergent = baseline.completed !== learned.completed || baseline.completionTime !== learned.completionTime;
    const reversions = seed === 5069 ? changes.map(c => ({ decision: c.decision,
      result: rollout(seed, traceScorer(raw, [], c.decision)) })) : [];
    return { seed, divergent, baseline, learned, changes, reversions };
  });
  writeFileSync("/tmp/bid-divergent-diagnosis.json", JSON.stringify(records, null, 2));
  console.log("DIVERGENT", records.filter(r => r.divergent).map(r => r.seed));
  console.log("CAUSAL", JSON.stringify(records.find(r => r.seed === 5069), null, 2));
});

function pairedPerformance(base: Outcome[], learned: Outcome[]) {
  const pairs = base.flatMap((b, i) => b.completionTime !== null && learned[i].completionTime !== null ? [{ seed: b.seed, baseline: b.completionTime, learned: learned[i].completionTime! }] : []);
  const delta = pairs.map(p => p.baseline - p.learned);
  return { pairedSeeds: pairs.length, meanTicksSaved: mean(delta), medianTicksSaved: median(delta),
    meanBaselineTicks: mean(pairs.map(p => p.baseline)), meanLearnedTicks: mean(pairs.map(p => p.learned)),
    medianBaselineTicks: median(pairs.map(p => p.baseline)), medianLearnedTicks: median(pairs.map(p => p.learned)),
    meanPairedPercentImprovement: mean(pairs.map(p => 100 * (p.baseline - p.learned) / p.baseline)),
    aggregatePercentImprovement: 100 * mean(delta) / mean(pairs.map(p => p.baseline)),
    wins: delta.filter(d => d > 0).length, ties: delta.filter(d => d === 0).length, losses: delta.filter(d => d < 0).length,
    meanTicksSaved95CI: pairedCI(delta), pairs };
}
function auditGuard(seed: number, model: Parameters<typeof guardedBidScorer>[0], bound: number, guard: WinnerGuard) {
  const events = new Map<string, WinnerGuardEvent>();
  const scorer = guardedBidScorer(model, bound, guard, event => events.set(`${event.tick}:${event.taskId}`, event));
  const auctions = new Set<string>();
  const outcome = rollout(seed, (r, t, w, b, route) => {
    auctions.add(`${w.tick}:${t.id}`);
    return scorer(r, t, w, b, route);
  });
  return { outcome, events: [...events.values()], auctionDecisions: auctions.size };
}
function compareOutcome(a: Outcome, b: Outcome) {
  if ((a.completionTime !== null) !== (b.completionTime !== null)) return a.completionTime !== null ? 1 : -1;
  if (a.completed !== b.completed) return Math.sign(a.completed - b.completed);
  return a.completionTime !== null && b.completionTime !== null ? Math.sign(b.completionTime - a.completionTime) : 0;
}
function causalChanges(seed: number, scorer: BidScorer, outcome: Outcome, changes: { tick: number; taskId: string }[]) {
  return changes.map(c => {
    const reverted = rollout(seed, (r, t, w, b, route) => w.tick === c.tick && t.id === c.taskId ? b.totalCost : scorer(r, t, w, b, route));
    return { ...c, effect: compareOutcome(outcome, reverted), reverted };
  });
}
const sumSafety = (outcomes: Outcome[]) => Object.fromEntries((Object.keys(outcomes[0].safety) as (keyof Safety)[]).map(k => [k, outcomes.reduce((s, o) => s + o.safety[k], 0)]));

it.skipIf(process.env.BID_GUARD_DEVELOPMENT !== "1")("selects a winner guard using development seeds only", () => {
  const { model, bound } = JSON.parse(readFileSync("artifacts/bid-guard-v3/model.json", "utf8"));
  const seeds = [...VALIDATION, ...TEST];
  const base = seeds.map(seed => rollout(seed));
  const raw = learnedBidScorer(model, bound);
  const rawRecords = seeds.map(seed => {
    const changes: Record<string, any>[] = [];
    const outcome = rollout(seed, traceScorer(raw, changes));
    const causal = causalChanges(seed, raw, outcome, changes.map(c => ({ tick: c.tick, taskId: c.task.id })));
    return { seed, outcome, changes, causal };
  });
  const candidates = (["reciprocal", "contention", "workload"] as WinnerGuard[]).map(guard => {
    const records = seeds.map(seed => auditGuard(seed, model, bound, guard));
    const outcomes = records.map(r => r.outcome);
    const events = records.flatMap(r => r.events);
    let beneficialPreserved = 0, beneficialSuppressed = 0, beneficialNotReencountered = 0;
    rawRecords.forEach((rawRecord, i) => rawRecord.causal.filter(c => c.effect > 0).forEach(c => {
      const event = records[i].events.find(e => e.tick === c.tick && e.taskId === c.taskId &&
        e.proposedWinner === rawRecord.changes.find(x => x.tick === c.tick && x.task.id === c.taskId)?.learnedWinner);
      if (!event) beneficialNotReencountered++;
      else if (event.suppressed) beneficialSuppressed++;
      else beneficialPreserved++;
    }));
    const reliability = summary(outcomes);
    const eligible = reliability.fullyCompleted >= summary(base).fullyCompleted && reliability.completedTasks >= summary(base).completedTasks && safeRelative(base, outcomes);
    const performance = pairedPerformance(base, outcomes);
    return { guard, eligible, reliability, safety: sumSafety(outcomes), performance, proposedChanges: events.length,
      allowedChanges: events.filter(e => !e.suppressed).length, suppressedChanges: events.filter(e => e.suppressed).length,
      beneficialPreserved, beneficialSuppressed, beneficialNotReencountered, records };
  });
  // Frozen selection: reliability and safety gate, then paired mean tick saving;
  // exact ties prefer the least restrictive guard (declaration order).
  candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.performance.meanTicksSaved - a.performance.meanTicksSaved);
  const selected = candidates[0];
  expect(selected.records[seeds.indexOf(5069)].outcome.completed).toBe(13);
  const report = { seeds, baseline: summary(base), baselineSafety: sumSafety(base), rawRecords, selected: selected.guard, candidates };
  writeFileSync("/tmp/bid-guard-development.json", JSON.stringify(report, null, 2));
  writeFileSync("/tmp/bid-guard-frozen.json", JSON.stringify({ model, bound, guard: selected.guard,
    acceptanceSeeds: Array.from({ length: 200 }, (_, i) => 6000 + i), sourceHashes: sourceHashes() }));
  console.log("GUARD DEVELOPMENT", candidates.map(({ records, performance, ...c }) => ({ ...c, performance: { ...performance, pairs: undefined } })));
}, 1_800_000);

const guardArtifact = () => JSON.parse(readFileSync("artifacts/bid-guard-v3/model.json", "utf8"));
describe("winner-change guard", () => {
  it("detects reciprocal intent rather than penalizing queue depth alone", () => {
    const world = scenario(100).world;
    const a = { ...world.robots[0], position: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    const b = { ...world.robots[1], position: { x: 1, y: 0 }, path: [{ x: 1, y: 0 }, { x: 0, y: 0 }] };
    expect(hasReciprocalIntent(a, { ...world, robots: [a, b] })).toBe(true);
    expect(hasReciprocalIntent(a, { ...world, robots: [a, { ...b, path: [b.position, { x: 2, y: 0 }] }] })).toBe(false);
  });
  it("reproduces 5069 and causally removes only the learned-specific regression", () => {
    const { model, bound, guard } = guardArtifact();
    const raw = learnedBidScorer(model, bound);
    const changes: Record<string, any>[] = [];
    const learned = rollout(5069, traceScorer(raw, changes));
    expect(learned.completed).toBe(12);
    expect(changes.map(c => c.decision)).toEqual(["24:S5069-T11"]);
    const reverted = rollout(5069, traceScorer(raw, [], "24:S5069-T11"));
    expect(reverted.completed).toBe(13);
    const guarded = auditGuard(5069, model, bound, guard);
    expect(guarded.outcome).toEqual(reverted);
    expect(guarded.events).toContainEqual(expect.objectContaining({ tick: 24, taskId: "S5069-T11",
      deterministicWinner: "AMR-04", proposedWinner: "AMR-08", finalWinner: "AMR-04",
      suppressed: true, reason: "reciprocal-intent" }));
    // The external planner defect remains; this is not a claim of full recovery.
    expect(guarded.outcome.completionTime).toBeNull();
  });
  it("preserves learned recovery of development seed 5076", () => {
    const { model, bound, guard } = guardArtifact();
    expect(rollout(5076).completed).toBe(12);
    const result = auditGuard(5076, model, bound, guard);
    expect(result.outcome.completed).toBe(13);
    expect(result.outcome.completionTime).toBe(156); // v4 preserves recovery, with a later safe winner change
    expect(result.events.some(e => !e.suppressed)).toBe(true);
  });
});

// This is the ONLY final-acceptance entrypoint. Read the precommitted seed list
// and source hashes; reject any changed production code before touching seeds.
// BID_GUARD_ACCEPTANCE=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
it.skipIf(process.env.BID_GUARD_ACCEPTANCE !== "1" && process.env.BID_ENERGY_ACCEPTANCE !== "1")("evaluates the frozen winner guard on untouched paired seeds", () => {
  const energyRun = process.env.BID_ENERGY_ACCEPTANCE === "1";
  const artifact = energyRun ? JSON.parse(readFileSync("artifacts/bid-energy-v4/model.json", "utf8")) : guardArtifact();
  expect(sourceHashes()).toEqual(artifact.sourceHashes);
  const seeds: number[] = artifact.acceptanceSeeds;
  expect(seeds.length).toBeGreaterThanOrEqual(100);
  expect(seeds.every(seed => ![...TRAIN, ...VALIDATION, ...TEST].includes(seed))).toBe(true);
  if (energyRun) {
    expect(seeds.every(seed => !guardArtifact().acceptanceSeeds.includes(seed))).toBe(true);
    expect(artifact.model).toEqual(guardArtifact().model); // no retraining
  }
  const baseline = seeds.map(seed => rollout(seed));
  const records = seeds.map(seed => auditGuard(seed, artifact.model, artifact.bound, artifact.guard));
  const learned = records.map(r => r.outcome);
  const performance = pairedPerformance(baseline, learned);
  // After outcomes are locked, single-decision reversions measure local causal
  // usefulness. These diagnostics do not select/retrain/change the frozen model.
  const interventions = records.flatMap((r, i) => causalChanges(seeds[i],
    guardedBidScorer(artifact.model, artifact.bound, artifact.guard), r.outcome,
    r.events.filter(e => !e.suppressed)).map(c => ({ seed: seeds[i], ...c })));
  const proposed = records.flatMap(r => r.events);
  if (energyRun) for (const e of proposed.filter(e => !e.suppressed)) {
    expect(e.energy?.admitted).toBe(true);
    expect(e.energy!.margin).toBeGreaterThanOrEqual(0);
    expect(e.baselineActiveRouteCertified).toBe(true);
  }
  const b = summary(baseline), l = summary(learned);
  const reliabilityPass = l.fullyCompleted >= b.fullyCompleted && l.completedTasks >= b.completedTasks;
  const safetyPass = safeRelative(baseline, learned);
  const report = { protocol: energyRun ? "v4 frozen hard energy admission, unchanged MLP, fresh 200-seed evaluation" : "Frozen 10% MLP discounts plus development-selected winner guard; paired complete-run performance only",
    modelSHA256: createHash("sha256").update(JSON.stringify(artifact.model)).digest("hex"),
    sourceHashes: sourceHashes(), guard: artifact.guard, bound: artifact.bound, seeds,
    trainingActions: 15268, trainingSeeds: 256, developmentSeeds: energyRun ? 400 : 200, retrained: false,
    baseline: b, learned: l, reliabilityPass, safetyPass,
    safety: { baseline: sumSafety(baseline), learned: sumSafety(learned) },
    performance, performancePass: performance.meanTicksSaved95CI[0] > 0,
    usefulness: { evaluatedAuctions: records.reduce((s, r) => s + r.auctionDecisions, 0),
      proposedWinnerChanges: proposed.length, allowedWinnerChanges: proposed.filter(e => !e.suppressed).length,
      suppressedWinnerChanges: proposed.filter(e => e.suppressed).length,
      causallyHelpful: interventions.filter(c => c.effect > 0).length,
      causallyHarmful: interventions.filter(c => c.effect < 0).length,
      causallyNeutral: interventions.filter(c => c.effect === 0).length,
      interpretation: "Single-decision reversion under the same frozen downstream policy; effects interact and must not be added as independent savings." },
    accepted: reliabilityPass && safetyPass && performance.meanTicksSaved95CI[0] > 0,
    perSeed: baseline.map((b, i) => ({ baseline: b, learned: learned[i], events: records[i].events })), interventions,
    limitations: "Synthetic 4..8 robot, 12..16 task workload; 400-tick reliability horizon. Performance is conditional on both policies completing. Shared planner failures are not fixed. No hardware or universal safety/completion guarantee. Core deterministic default is unchanged." };
  expect(sourceHashes()).toEqual(artifact.sourceHashes);
  writeFileSync(energyRun ? "artifacts/bid-energy-v4/acceptance.json" : "artifacts/bid-guard-v3/acceptance.json", JSON.stringify(report, null, 2));
  console.log("GUARDED ACCEPTANCE", JSON.stringify({ ...report, seeds: undefined, sourceHashes: undefined,
    performance: { ...performance, pairs: undefined }, perSeed: undefined, interventions: undefined }, null, 2));
}, 1_800_000);

it.skipIf(process.env.BID_ENERGY_DIAG !== "1")("diagnoses all v3 acceptance battery and reliability regressions before changing feasibility", () => {
  const artifact = guardArtifact();
  const report = JSON.parse(readFileSync("artifacts/bid-guard-v3/acceptance.json", "utf8"));
  const failures = report.perSeed.filter((p: any) => p.learned.completed < p.baseline.completed ||
    (p.baseline.completionTime !== null && p.learned.completionTime === null) ||
    p.baseline.safety.zeroBatteryWork > 0 || p.learned.safety.zeroBatteryWork > 0);
  const records = failures.map((p: any) => {
    const seed = p.baseline.seed;
    const baselineBatteryEvents: unknown[] = [];
    const baselineReplay = rollout(seed, undefined, undefined, w => {
      for (const r of w.robots) if (r.battery <= 0 && r.currentTaskId) baselineBatteryEvents.push({ tick: w.tick, robot: r, task: w.tasks.find(t => t.id === r.currentTaskId) });
    });
    expect(baselineReplay).toEqual(p.baseline);
    const policy = guardedBidScorer(artifact.model, artifact.bound, artifact.guard, undefined, false);
    const changes: Record<string, any>[] = [], decisions: unknown[] = [], batteryEvents: unknown[] = [], timeline: unknown[] = [];
    const seen = new Set<string>();
    const traced = traceScorer(policy, changes);
    const result = rollout(seed, (r, t, w, b, route) => {
      const decision = `${w.tick}:${t.id}`;
      if (!seen.has(decision)) { seen.add(decision); decisions.push({ decision, task: t, world: withBidScorer(w) }); }
      return traced(r, t, w, b, route);
    }, undefined, w => {
      for (const r of w.robots) if (r.battery <= 0 && r.currentTaskId) batteryEvents.push({ tick: w.tick, robot: r,
        task: w.tasks.find(t => t.id === r.currentTaskId) });
      timeline.push({ tick: w.tick, robots: w.robots, completed: w.tasks.filter(t => t.status === "completed").length });
    });
    expect(result).toEqual(p.learned);
    const reversions = changes.map(c => ({ decision: c.decision,
      result: rollout(seed, traceScorer(policy, [], c.decision)) }));
    return { seed, baseline: p.baseline, learned: result, changes, reversions, baselineBatteryEvents, batteryEvents, decisions, timeline };
  });
  writeFileSync("artifacts/bid-energy-v4/diagnosis.json", JSON.stringify(records, null, 2));
  console.log("ENERGY DIAG", records.map((r: any) => ({ seed: r.seed, changes: r.changes, reversions: r.reversions,
    batteryEventCount: r.batteryEvents.length, firstBatteryEvent: r.batteryEvents[0] })));
});

describe("hard learned-promotion energy admission", () => {
  it("requires task energy plus the engine charging route and reserve at the exact boundary", () => {
    const world = scenario(100).world;
    const robot = { ...world.robots[0], position: { x: 0, y: 0 }, battery: 25, currentTaskId: undefined, queuedTaskIds: [], path: [] };
    const task = { ...scenario(100).tasks[0], weight: 1, pickup: robot.position, dropoff: { x: 0, y: 12 } };
    const exact = assessBidEnergy(robot, task, world);
    expect(exact.admitted).toBe(true);
    expect(exact.requiredEnergy).toBe(25);
    expect(exact.margin).toBe(0);
    expect(assessBidEnergy({ ...robot, battery: 24.9 }, task, world).reason).toBe("insufficient-energy");
  });
  it("charges for the committed detour and fails closed on missing active intent", () => {
    const world = scenario(100).world;
    const active: Task = { ...scenario(100).tasks[0], id: "active", weight: 1, status: "in_progress", dropoff: { x: 0, y: 2 } };
    world.tasks = [active];
    const path = [[0,0],[1,0],[2,0],[3,0],[3,1],[3,2],[3,3],[3,4],[2,4],[1,4],[0,4],[0,3],[0,2]].map(([x,y]) => ({x,y}));
    const robot = { ...world.robots[0], battery: 21, position: path[0], currentTaskId: active.id, path, queuedTaskIds: [] };
    const task = { ...active, id: "candidate", status: "pending" as const, pickup: { x: 0, y: 2 }, dropoff: { x: 0, y: 3 } };
    expect(correctionFeasible(robot, task, world)).toBe(true); // old optimistic replanning check
    expect(assessBidEnergy(robot, task, world).reason).toBe("insufficient-energy");
    expect(assessBidEnergy({ ...robot, battery: 100, path: [] }, task, world).activeRouteCertified).toBe(false);
  });
  it("uses candidate-before-queue order when the dispatcher has no active task", () => {
    const world = scenario(100).world;
    const queued: Task = { ...scenario(100).tasks[0], id: "queued", status: "assigned", weight: 1,
      pickup: { x: 0, y: 10 }, dropoff: { x: 0, y: 12 } };
    world.tasks = [queued];
    const robot = { ...world.robots[0], battery: 100, position: { x: 0, y: 0 }, currentTaskId: undefined, path: [], queuedTaskIds: [queued.id] };
    const task = { ...queued, id: "candidate", status: "pending" as const, pickup: { x: 0, y: 1 }, dropoff: { x: 0, y: 2 } };
    const result = assessBidEnergy(robot, task, world);
    expect(result.admitted).toBe(true);
    expect(result.committedDistance).toBe(12);
  });
  it("removes both causal v3 regressions without changing the trained model", () => {
    const { model, bound, guard } = guardArtifact();
    for (const [seed, ticks] of [[6017, 149], [6199, 117]]) {
      const old = rollout(seed, guardedBidScorer(model, bound, guard, undefined, false));
      expect(old.completionTime).toBeNull();
      const current = auditGuard(seed, model, bound, guard);
      expect(current.outcome.completionTime).toBe(ticks);
      expect(current.outcome.safety.zeroBatteryWork).toBe(0);
      for (const e of current.events.filter(e => !e.suppressed)) {
        expect(e.energy?.admitted).toBe(true);
        expect(e.energy!.margin).toBeGreaterThanOrEqual(0);
        expect(e.baselineActiveRouteCertified).toBe(true);
      }
    }
  });
});

it.skipIf(process.env.BID_ENERGY_DEVELOPMENT !== "1")("validates hard energy admission on retired acceptance seeds", () => {
  const artifact = guardArtifact();
  const seeds: number[] = artifact.acceptanceSeeds; // 6000..6199 are DEVELOPMENT now
  const base = seeds.map(seed => rollout(seed));
  const records = seeds.map(seed => auditGuard(seed, artifact.model, artifact.bound, artifact.guard));
  const learned = records.map(r => r.outcome);
  const oldReport = JSON.parse(readFileSync("artifacts/bid-guard-v3/acceptance.json", "utf8"));
  let preserved = 0, suppressed = 0, notReencountered = 0;
  for (const c of oldReport.interventions.filter((c: any) => c.effect > 0)) {
    const old = oldReport.perSeed.find((p: any) => p.baseline.seed === c.seed).events.find((e: any) => e.tick === c.tick && e.taskId === c.taskId);
    const event = records[seeds.indexOf(c.seed)].events.find(e => e.tick === c.tick && e.taskId === c.taskId && e.proposedWinner === old.proposedWinner);
    if (!event) notReencountered++;
    else if (event.suppressed) suppressed++;
    else preserved++;
  }
  const result = { seeds, baseline: summary(base), learned: summary(learned), safety: { baseline: sumSafety(base), learned: sumSafety(learned) },
    reliabilityPass: summary(learned).fullyCompleted >= summary(base).fullyCompleted && summary(learned).completedTasks >= summary(base).completedTasks,
    safetyPass: safeRelative(base, learned), performance: pairedPerformance(base, learned),
    helpfulV3Changes: { preserved, suppressed, notReencountered },
    allowed: records.flatMap(r => r.events).filter(e => !e.suppressed).length,
    suppressed: records.flatMap(r => r.events).filter(e => e.suppressed).length,
    perSeed: base.map((b, i) => ({ baseline: b, learned: learned[i], events: records[i].events })) };
  for (const e of records.flatMap(r => r.events).filter(e => !e.suppressed)) {
    expect(e.energy?.admitted).toBe(true); expect(e.energy!.margin).toBeGreaterThanOrEqual(0);
    expect(e.baselineActiveRouteCertified).toBe(true);
  }
  writeFileSync("artifacts/bid-energy-v4/development.json", JSON.stringify(result, null, 2));
  writeFileSync("artifacts/bid-energy-v4/model.json", JSON.stringify({ ...artifact,
    acceptanceSeeds: Array.from({ length: 200 }, (_, i) => 7000 + i), sourceHashes: sourceHashes(),
    retrained: false, hardEnergyGate: true }));
  console.log("ENERGY DEVELOPMENT", { ...result, seeds: undefined, perSeed: undefined, performance: { ...result.performance, pairs: undefined } });
}, 1_800_000);
