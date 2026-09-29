// Policy-independent overlap and static-capacity measurement.
//
// Everything in this file is a pure function of (map, robot start cells, task
// endpoints). It NEVER observes a policy, a run, an outcome or a metric from any
// arm. That is the whole point: a workload must be classified as low /
// recoverable / severe contention by its GEOMETRY, before anybody moves a
// robot, so that no seed can ever be selected because of how some policy
// happened to behave on it.
//
// The implied leg set
// ------------------
// Any execution of this workload must, for every task i, carry a robot from
// somewhere to pickup_i and then from pickup_i to dropoff_i. Which robot takes
// which task is decided by the auction, which differs per arm, so the only
// policy-independent statements available are:
//
//   DELIVERY legs   D_i = A*(pickup_i -> dropoff_i)          for each task
//   APPROACH legs   A_ri = A*(start_r  -> pickup_i)          for each robot x task
//
// The DELIVERY legs are the paths SIH means by "overlapping paths", and they
// are used as the primary interference index. The APPROACH legs are the
// converging-to-pickups traffic; they depend on fleet size, so they are
// REPORTED as a component and deliberately NOT used to classify, so that a
// scenario's regime label is a property of the workload and not of how many
// robots happen to be running it.
//
// All legs are single-agent, congestion-free A* on the static map.

import { planPath } from "../../pathfinding/astar";
import { getNeighbors } from "../../map/graph";
import type { Position, WarehouseMap, WorldState } from "../../types";
import { OVERLAP_METRIC } from "./protocol";

const key = (p: Position) => `${p.x},${p.y}`;
const parse = (k: string): Position => ({ x: Number(k.split(",")[0]), y: Number(k.split(",")[1]) });

export type OverlapAnalysis = {
  /** Every delivery and approach leg was routable and every endpoint reachable. */
  valid: boolean;
  invalidReason?: string;

  deliveryLegs: number;
  approachLegs: number;

  /** PRIMARY interference index: mean pairwise Jaccard of delivery-leg cell sets. */
  overlapIndex: number;
  /** Fraction of delivery-leg pairs that traverse at least one shared edge in opposite directions. */
  headOnPairShare: number;
  /** Cells used by two or more delivery legs, per delivery leg. */
  contestedCellsPerRoute: number;
  /** Mean delivery-leg length in cells. */
  meanDeliveryLength: number;
  /** Reported only: same Jaccard index over the fleet-size-dependent approach legs. */
  approachOverlapIndex: number;

  /** Fraction of delivery legs admitting a route that avoids every cell it shares with another delivery leg. */
  escapeFraction: number;
  /** Max detour/shortest ratio over the escapable delivery legs, or null when none escapes. */
  maxDetourFactor: number | null;
  /** Fraction of (leg, cell) pairs where the cell has NO traversable neighbour off that leg's own route. */
  zeroSlackRouteFraction: number;
  /** Longest run of consecutive no-passing-place cells on any single delivery leg. */
  maxZeroSlackRun: number;

  /** Static statement: the geometry offers passing opportunities along these routes. */
  staticRecoverable: boolean;
};

function staticWorld(map: WarehouseMap): WorldState {
  return {
    tick: 0,
    map: { ...map, cells: map.cells.map((c) => ({ ...c, congestion: 0 })) },
    robots: [],
    tasks: [],
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
}

function walledWorld(base: WorldState, walls: ReadonlySet<string>): WorldState {
  return {
    ...base,
    map: {
      ...base.map,
      cells: base.map.cells.map((c) => (walls.has(key(c.position)) && !c.blocked ? { ...c, blocked: true } : c)),
    },
  };
}

const INVALID = (reason: string): OverlapAnalysis => ({
  valid: false, invalidReason: reason, deliveryLegs: 0, approachLegs: 0, overlapIndex: 0,
  headOnPairShare: 0, contestedCellsPerRoute: 0, meanDeliveryLength: 0, approachOverlapIndex: 0,
  escapeFraction: 0, maxDetourFactor: null, zeroSlackRouteFraction: 1, maxZeroSlackRun: Number.MAX_SAFE_INTEGER,
  staticRecoverable: false,
});

export type OverlapInput = {
  map: WarehouseMap;
  /** Robot start cells, in fleet order. */
  starts: Position[];
  tasks: { id: string; pickup: Position; dropoff: Position }[];
};

export function analyseOverlap(input: OverlapInput): OverlapAnalysis {
  const world = staticWorld(input.map);

  const deliveryPaths: Position[][] = [];
  for (const task of input.tasks) {
    const res = planPath(task.pickup, task.dropoff, world);
    if (!res.found) return INVALID(`delivery leg of ${task.id} is not routable on the static map`);
    deliveryPaths.push(res.path);
  }
  const approachPaths: Position[][] = [];
  for (let r = 0; r < input.starts.length; r++) {
    for (const task of input.tasks) {
      const res = planPath(input.starts[r], task.pickup, world);
      if (!res.found) return INVALID(`robot start ${r} cannot reach the pickup of ${task.id} on the static map`);
      approachPaths.push(res.path);
    }
  }

  const dSets = deliveryPaths.map((p) => new Set(p.map(key)));
  const aSets = approachPaths.map((p) => new Set(p.map(key)));

  const meanJaccard = (sets: ReadonlySet<string>[]) => {
    let sum = 0, n = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        let inter = 0;
        for (const c of sets[i]) if (sets[j].has(c)) inter++;
        sum += (sets[i].size + sets[j].size - inter) === 0 ? 0 : inter / (sets[i].size + sets[j].size - inter);
        n++;
      }
    }
    return n === 0 ? 0 : sum / n;
  };
  const overlapIndex = meanJaccard(dSets);
  const approachOverlapIndex = meanJaccard(aSets);

  // head-on pair share: opposing traversal of at least one shared edge
  const directed = (p: Position[]) => {
    const out = new Set<string>();
    for (let i = 1; i < p.length; i++) out.add(`${key(p[i - 1])}>${key(p[i])}`);
    return out;
  };
  const dDirected = deliveryPaths.map(directed);
  let headOn = 0, pairs = 0;
  for (let i = 0; i < dSets.length; i++) {
    for (let j = i + 1; j < dSets.length; j++) {
      pairs++;
      let opposing = false;
      for (const e of dDirected[i]) {
        const [a, b] = e.split(">");
        if (dDirected[j].has(`${b}>${a}`)) { opposing = true; break; }
      }
      if (opposing) headOn++;
    }
  }

  const load = new Map<string, number>();
  for (const s of dSets) for (const c of s) load.set(c, (load.get(c) ?? 0) + 1);
  let contested = 0;
  for (const v of load.values()) if (v >= 2) contested++;

  // static passing capacity: a cell with no traversable neighbour outside its
  // own route is a place where a robot cannot get out of anybody's way.
  let zeroSlack = 0, cellOccurrences = 0, maxZeroSlackRun = 0;
  dSets.forEach((s) => {
    let run = 0;
    for (const c of s) {
      cellOccurrences++;
      const hasEscape = getNeighbors(parse(c), input.map).some((n) => !s.has(key(n)));
      if (hasEscape) { run = 0; continue; }
      zeroSlack++;
      run++;
      if (run > maxZeroSlackRun) maxZeroSlackRun = run;
    }
  });

  let escapable = 0, maxDetourFactor = 0;
  for (let i = 0; i < dSets.length; i++) {
    const shared = new Set([...dSets[i]].filter((c) => (load.get(c) ?? 0) >= 2));
    const detour = planPath(input.tasks[i].pickup, input.tasks[i].dropoff, walledWorld(world, shared));
    if (!detour.found) continue;
    escapable++;
    const shortest = Math.max(1, deliveryPaths[i].length - 1);
    maxDetourFactor = Math.max(maxDetourFactor, detour.distance / shortest);
  }

  const escapeFraction = dSets.length === 0 ? 0 : escapable / dSets.length;
  const zeroSlackRouteFraction = cellOccurrences === 0 ? 1 : zeroSlack / cellOccurrences;
  const { minOverlapIndex, minEscapeFraction, maxZeroSlackRunLimit, maxDetourFactorLimit } =
    OVERLAP_METRIC.regimeThresholds;

  const staticRecoverable =
    overlapIndex >= minOverlapIndex &&
    escapeFraction >= minEscapeFraction &&
    maxZeroSlackRun <= maxZeroSlackRunLimit &&
    maxDetourFactor !== null &&
    maxDetourFactor <= maxDetourFactorLimit;

  return {
    valid: true,
    deliveryLegs: dSets.length,
    approachLegs: aSets.length,
    overlapIndex,
    headOnPairShare: pairs === 0 ? 0 : headOn / pairs,
    contestedCellsPerRoute: dSets.length === 0 ? 0 : contested / dSets.length,
    meanDeliveryLength: deliveryPaths.length === 0 ? 0 : deliveryPaths.reduce((a, p) => a + p.length - 1, 0) / deliveryPaths.length,
    approachOverlapIndex,
    escapeFraction,
    maxDetourFactor: escapable === 0 ? null : maxDetourFactor,
    zeroSlackRouteFraction,
    maxZeroSlackRun,
    staticRecoverable,
  };
}

export type Regime = "low" | "recoverable" | "severe";

/**
 * The regime label. Reads ONLY the geometric analysis: no policy result, no
 * run, no timing, no outcome. Precedence is fixed by the spec.
 */
export function classifyRegime(overlap: OverlapAnalysis): Regime {
  if (!overlap.valid) return "severe";
  const { lowMaxOverlapIndex, severeMinOverlapIndex } = OVERLAP_METRIC.regimeThresholds;
  if (overlap.overlapIndex < lowMaxOverlapIndex) return "low";
  if (overlap.overlapIndex >= severeMinOverlapIndex) return "severe";
  if (!overlap.staticRecoverable) return "severe";
  return "recoverable";
}
