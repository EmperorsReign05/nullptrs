import { BID_FEATURE_NAMES, extractBidFeatures, correctionFeasible, assessBidEnergy, type BidEnergyAssessment, localBidView, type LocalBidInput } from "./bidfeatures";
import { calculateBid, withBidScorer, type BidScorer, type RobotBid } from "../auction/cost";
import { getBiddingRobots } from "../auction/assign";
import type { RobotState, WorldState } from "../types";

/** One tanh hidden layer, linear scalar output. Lower predicts better allocation.
 * Labels rank counterfactual terminal outcomes, NOT winning IDs.
 * Normalization is fitted on training scenarios only. No class weighting:
 * this is continuous regression, with every action at a decision represented.
 */
export type BidModel = {
  schema: string[]; hidden: number; mean: number[]; scale: number[];
  // Flat parameters: hidden weights, hidden biases, output weights, output bias.
  parameters: number[];
};
export type BidTrainingRow = {
  seed: number; features: number[]; target: number;
  decision?: string; complete?: boolean;
};

/** Strict terminal ordering in supervision: any incomplete rollout is worse
 * than any completed rollout, even if the incomplete rollout stops early.
 * Speed only orders completed outcomes. Incomplete outcomes are ordered by
 * unfinished task fraction; their elapsed time is deliberately irrelevant.
 */
export function terminalCost(completed: number, total: number, ticks: number, horizon: number): number {
  if (total <= 0 || completed < 0 || completed > total || ticks < 0 || ticks > horizon || horizon <= 0)
    throw new Error("Invalid terminal outcome");
  return completed === total ? ticks / horizon : 2 + (total - completed) / total;
}
const D = BID_FEATURE_NAMES.length;
export function bidRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function checkFeatures(x: number[]): void {
  if (x.length !== D || x.some(v => !Number.isFinite(v))) throw new Error("Invalid bid features");
}
function forward(model: BidModel, features: number[]) {
  checkFeatures(features);
  const x = features.map((v, i) => (v - model.mean[i]) / model.scale[i]);
  const h = model.hidden, p = model.parameters;
  const activations = Array.from({ length: h }, (_, j) => {
    let z = p[h * D + j];
    for (let i = 0; i < D; i++) z += p[j * D + i] * x[i];
    return Math.tanh(z);
  });
  let prediction = p[h * D + 2 * h];
  for (let j = 0; j < h; j++) prediction += p[h * D + h + j] * activations[j];
  return { x, activations, prediction };
}
export function predictBid(model: BidModel, features: number[]): number {
  return forward(model, features).prediction;
}

/** Analytic MSE gradient, exposed for numerical gradient verification. */
export function bidLossGradient(model: BidModel, rows: BidTrainingRow[], l2 = 0) {
  if (!rows.length) throw new Error("Empty training data");
  const p = model.parameters, h = model.hidden;
  const gradient = p.map(() => 0);
  let loss = 0;
  const states = rows.map(row => forward(model, row.features));
  const deltas = rows.map(() => 0);
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    if (row.decision !== undefined) {
      const key = `${row.seed}:${row.decision}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
  });
  const terminalViolations = new Set<number>();
  // Lexicographic within a decision: while any complete/incomplete ordering
  // violates the margin, speed regression for that entire decision is OFF.
  // Finite penalty weights cannot buy a faster-but-incomplete preference.
  for (const indices of groups.values()) {
    const complete = indices.filter(i => rows[i].complete === true);
    const incomplete = indices.filter(i => rows[i].complete === false);
    for (const good of complete) for (const bad of incomplete) {
      const violation = 1 + states[good].prediction - states[bad].prediction;
      if (violation <= 0) continue;
      indices.forEach(i => terminalViolations.add(i));
      loss += violation * violation / (2 * rows.length);
      deltas[good] += violation / rows.length;
      deltas[bad] -= violation / rows.length;
    }
  }
  rows.forEach((row, i) => {
    if (terminalViolations.has(i)) return;
    const error = states[i].prediction - row.target;
    loss += error * error / (2 * rows.length);
    deltas[i] += error / rows.length;
  });
  states.forEach(({ x, activations: a }, index) => {
    const delta = deltas[index];
    gradient[h * D + 2 * h] += delta;
    for (let j = 0; j < h; j++) {
      gradient[h * D + h + j] += delta * a[j];
      const dz = delta * p[h * D + h + j] * (1 - a[j] * a[j]);
      gradient[h * D + j] += dz;
      for (let i = 0; i < D; i++) gradient[j * D + i] += dz * x[i];
    }
  });
  for (let k = 0; k < p.length; k++) {
    gradient[k] += l2 * p[k];
    loss += l2 * p[k] * p[k] / 2;
  }
  return { loss, gradient };
}

export function trainBidModel(rows: BidTrainingRow[], options: {
  hidden?: number; epochs?: number; learningRate?: number; l2?: number; seed?: number;
} = {}): BidModel {
  if (!rows.length || rows.some(r => !Number.isFinite(r.target))) throw new Error("Invalid training data");
  rows.forEach(r => checkFeatures(r.features));
  const h = options.hidden ?? 16;
  if (!Number.isInteger(h) || h < 1 || h > 64) throw new Error("Hidden width must be 1..64");
  const mean = Array.from({ length: D }, (_, i) => rows.reduce((s, r) => s + r.features[i], 0) / rows.length);
  const scale = mean.map((m, i) => Math.sqrt(rows.reduce((s, r) => s + (r.features[i] - m) ** 2, 0) / rows.length) || 1);
  const random = bidRandom(options.seed ?? 37);
  const parameters = Array.from({ length: h * D + 2 * h + 1 }, (_, i) =>
    i < h * D ? (random() * 2 - 1) * Math.sqrt(6 / (D + h)) :
      i >= h * D + h && i < h * D + 2 * h ? (random() * 2 - 1) / Math.sqrt(h) : 0);
  const model: BidModel = { schema: [...BID_FEATURE_NAMES], hidden: h, mean, scale, parameters };
  const m = parameters.map(() => 0), v = parameters.map(() => 0);
  for (let epoch = 1; epoch <= (options.epochs ?? 800); epoch++) {
    const { gradient } = bidLossGradient(model, rows, options.l2 ?? 0.001);
    for (let i = 0; i < parameters.length; i++) {
      const g = gradient[i];
      m[i] = 0.9 * m[i] + 0.1 * g;
      v[i] = 0.999 * v[i] + 0.001 * g * g;
      parameters[i] -= (options.learningRate ?? 0.005) * (m[i] / (1 - 0.9 ** epoch)) /
        (Math.sqrt(v[i] / (1 - 0.999 ** epoch)) + 1e-8);
    }
  }
  if (parameters.some(p => !Number.isFinite(p))) throw new Error("Training diverged");
  return model;
}

/** Bounded rank correction. Invalid/OOD/commitment-infeasible inputs fall
 * back to the deterministic score. Feasibility is necessary, not a guarantee
 * of terminal completion; the latter is an empirical acceptance criterion.
 */
export function learnedBidScorer(model: BidModel, bound = 0.1): BidScorer {
  if (JSON.stringify(model.schema) !== JSON.stringify(BID_FEATURE_NAMES)) throw new Error("Bid schema mismatch");
  if (!Number.isFinite(bound) || bound < 0 || bound > 0.2) throw new Error("Correction bound must be 0..20%");
  return (robot, task, world, bid, route) => {
    if (!bid.feasible || !Number.isFinite(bid.totalCost) || bound === 0 || !correctionFeasible(robot, task, world)) return bid.totalCost;
    const features = extractBidFeatures(robot, task, world, bid, route);
    if (features.some((x, i) => !Number.isFinite(x) || Math.abs((x - model.mean[i]) / model.scale[i]) > 6)) return bid.totalCost;
    // Discounts only: an unchecked candidate cannot newly beat a formerly
    // cheaper checked candidate by having the latter's price increased.
    const correction = -0.5 * (1 - Math.tanh(predictBid(model, features)));
    return Number.isFinite(correction) ? bid.totalCost + Math.abs(bid.totalCost) * bound * correction : bid.totalCost;
  };
}

export type WinnerGuard = "reciprocal" | "contention" | "workload";
export type WinnerGuardEvent = {
  tick: number; taskId: string; deterministicWinner: string; proposedWinner: string;
  finalWinner: string; suppressed: boolean; reason: string; gap: number;
  energy?: BidEnergyAssessment; baselineActiveRouteCertified?: boolean;
};

/** An observed failure involved an otherwise lightly loaded robot waiting in
 * a reciprocal next-cell conflict. Queue depth alone misread it as available.
 * This guard declines that winner substitution; it does not resolve traffic.
 */
export function hasReciprocalIntent(robot: RobotState, world: WorldState): boolean {
  const next = robot.path[1];
  if (!next) return false;
  return world.robots.some(peer => peer.id !== robot.id &&
    peer.position.x === next.x && peer.position.y === next.y && peer.path[1]?.x === robot.position.x &&
    peer.path[1]?.y === robot.position.y);
}

/** Atomic auction guard implemented at the scorer boundary. All feasible bids
 * are evaluated on the SAME state. Rejection restores ALL deterministic bids,
 * preventing a rejected runner-up from accidentally making a third robot win.
 * Default core scorer/eligibility/tie-break remain untouched.
 */
export function guardedBidScorer(model: BidModel, bound = 0.1,
  guard: WinnerGuard = "reciprocal", observe?: (event: WinnerGuardEvent) => void,
  /** false is only for historical diagnosis of the retired v3 guard. */
  hardEnergy = true): BidScorer {
  const raw = learnedBidScorer(model, bound);
  const cache = new WeakMap<WorldState, Map<string, { fallback: boolean }>>();
  return (robot, task, world, bid, route) => {
    let taskCache = cache.get(world);
    if (!taskCache) { taskCache = new Map(); cache.set(world, taskCache); }
    let result = taskCache.get(task.id);
    if (!result) {
      const plain = withBidScorer(world);
      const entries = getBiddingRobots(task, world.robots, plain).map(base => {
        const r = world.robots.find(r => r.id === base.robotId)!;
        const final = calculateBid(r, task, withBidScorer(plain, raw));
        return { robot: r, base, final, features: extractBidFeatures(r, task, plain, base) };
      });
      const baseline = [...entries].sort((a, b) => a.base.totalCost - b.base.totalCost || (a.robot.id < b.robot.id ? -1 : 1))[0];
      const proposal = [...entries].sort((a, b) => a.final.totalCost - b.final.totalCost || (a.robot.id < b.robot.id ? -1 : 1))[0];
      let reason = "unchanged";
      if (baseline && proposal && baseline.robot.id !== proposal.robot.id) {
        const a = baseline.robot, b = proposal.robot;
        const gap = proposal.base.totalCost - baseline.base.totalCost;
        const energy = hardEnergy ? assessBidEnergy(b, task, plain) : undefined;
        const baselineEnergy = hardEnergy ? assessBidEnergy(a, task, plain) : undefined;
        // Derived directly from the correction budget, not a fitted seed cutoff:
        // an alternative must be able to close the gap within its allowed discount.
        if (gap > bound * Math.abs(proposal.base.totalCost)) reason = "score-gap";
        // Both bids passed the unchanged hard eligibility checks above. The
        // challenger must additionally cover its whole commitment and charger.
        // A baseline winner's overcommitted queue must not veto a safer change:
        // development ablation showed that veto discarded a recovered run.
        else if (!baseline.base.feasible || !proposal.base.feasible || !correctionFeasible(b, task, plain)) reason = "commitment-feasibility";
        else if (hasReciprocalIntent(b, plain)) reason = "reciprocal-intent";
        else if (guard === "contention" && proposal.features[8] > baseline.features[8]) reason = "intent-pressure";
        else if (guard === "workload" && (b.queuedTaskIds?.length ?? 0) > (a.queuedTaskIds?.length ?? 0) &&
          proposal.features[13] >= baseline.features[13]) reason = "workload-pressure";
        // A switch changes both robots' commitments. If either active route
        // is unobserved/stale, do not infer an executable energy budget from a
        // fresh optimistic A* path. The incumbent need not pass the stronger
        // total-energy check: moving away from its overloaded queue can help.
        else if (hardEnergy && !baselineEnergy?.activeRouteCertified) reason = "incumbent-route-uncertified";
        else if (hardEnergy && !energy?.admitted) reason = `energy:${energy?.reason}`;
        else reason = "allowed";
        const suppressed = reason !== "allowed";
        observe?.({ tick: world.tick, taskId: task.id, deterministicWinner: a.id,
          proposedWinner: b.id, finalWinner: suppressed ? a.id : b.id, suppressed, reason, gap, ...(hardEnergy ? { energy, baselineActiveRouteCertified: baselineEnergy?.activeRouteCertified } : {}) });
      }
      result = { fallback: reason !== "allowed" && reason !== "unchanged" };
      taskCache.set(task.id, result);
    }
    return result.fallback ? bid.totalCost : raw(robot, task, world, bid, route);
  };
}

export type LocalBidPacket = {
  robotId: string; taskId: string; tick: number;
  bid: RobotBid | null; features: number[]; mlCost: number | null;
  energy: BidEnergyAssessment; reciprocalIntent: boolean; completePeerKnowledge: boolean;
};

/** Local scoring boundary: no WorldState argument, callback, global fleet
 * lookup, or simulator clock. Returned values are JSON-serializable bid data.
 */
export function makeLocalBid(input: LocalBidInput, model: BidModel, bound = 0.1): LocalBidPacket {
  const { world, completePeerKnowledge } = localBidView(input);
  const self = world.robots[0];
  const base = calculateBid(self, input.task, world);
  const eligible = base.feasible && self.status !== "failed" && self.status !== "charging" &&
    self.battery >= 20 && (self.queuedTaskIds?.length ?? 0) < 4;
  const energy = assessBidEnergy(self, input.task, world);
  const features = eligible ? extractBidFeatures(self, input.task, world, base) : [];
  const mlCost = !eligible ? null : !completePeerKnowledge ? base.totalCost :
    calculateBid(self, input.task, withBidScorer(world, learnedBidScorer(model, bound))).totalCost;
  return { robotId: self.id, taskId: input.task.id, tick: input.tick,
    bid: eligible ? base : null, features, mlCost, energy,
    reciprocalIntent: hasReciprocalIntent(self, world), completePeerKnowledge };
}

/** Pure guard over explicitly received bid packets. This is not a consensus
 * protocol: the caller must provide one agreed auction round and ownership.
 * Implementing distributed agreement is outside the learned scorer's scope.
 */
export function selectLocalBid(packets: readonly LocalBidPacket[], bound = 0.1) {
  if (!Number.isFinite(bound) || bound < 0 || bound > 0.2) throw new Error("Invalid bound");
  const seen = new Set<string>();
  for (const p of packets) {
    if (seen.has(p.robotId) || p.tick !== packets[0].tick || p.taskId !== packets[0].taskId)
      throw new Error("Mixed or duplicate bid round");
    seen.add(p.robotId);
  }
  const viable = packets.filter((p): p is LocalBidPacket & { bid: RobotBid; mlCost: number } =>
    p.bid !== null && p.bid.feasible && p.mlCost !== null && Number.isFinite(p.mlCost) && Number.isFinite(p.bid.totalCost));
  const rank = (field: (p: typeof viable[number]) => number) => [...viable].sort((a, b) => field(a) - field(b) || (a.robotId < b.robotId ? -1 : 1))[0];
  const base = rank(p => p.bid.totalCost);
  if (!base) return { winner: null, deterministicWinner: null, proposedWinner: null, suppressed: false, reason: "no-bids" };
  const proposed = rank(p => p.mlCost)!;
  let reason = "unchanged";
  if (base.robotId !== proposed.robotId) {
    if (viable.some(p => p.features.length !== BID_FEATURE_NAMES.length || p.features.some(x => !Number.isFinite(x)))) reason = "invalid-features";
    else if (viable.some(p => !p.completePeerKnowledge)) reason = "incomplete-peer-view";
    else if (viable.some(p => p.mlCost > p.bid.totalCost || p.mlCost < p.bid.totalCost - bound * Math.abs(p.bid.totalCost) - 1e-9)) reason = "invalid-correction";
    else if (proposed.bid.totalCost - base.bid.totalCost > bound * Math.abs(proposed.bid.totalCost)) reason = "score-gap";
    else if (proposed.reciprocalIntent) reason = "reciprocal-intent";
    else if (proposed.features[6] > base.features[6] && proposed.features[13] >= base.features[13]) reason = "workload-pressure";
    else if (!base.energy.activeRouteCertified || !proposed.energy.admitted || !Number.isFinite(proposed.energy.margin) || proposed.energy.margin < 0) reason = "energy-admission";
    else reason = "allowed";
  }
  const suppressed = reason !== "unchanged" && reason !== "allowed";
  return { winner: suppressed ? base.robotId : proposed.robotId, deterministicWinner: base.robotId,
    proposedWinner: proposed.robotId, suppressed, reason };
}
