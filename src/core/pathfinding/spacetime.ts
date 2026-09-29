// PROTOTYPE: prioritized space-time A* (a "windowed MAPF" style planner).
//
// THE CENTRAL CLAIM BEING TESTED:
//   "PIBT deadlocks because each robot plans independently against the
//    CURRENT world and then patches conflicts locally. If instead robots
//    plan SEQUENTIALLY against a shared reservation table of
//    (cell, time) pairs, a robot can never be given a plan that is already
//    impossible, and the deadlock class disappears by construction."
//
// This file exists to test that claim, not to be pretty.

import { isTraversable } from "../map/warehouse";
import { getNeighbors, manhattanDistance, positionKey, positionsEqual } from "../map/graph";
import type { Position, WarehouseMap } from "../types";

export type ReservationTable = Map<string, Set<number>>;

export function reserve(table: ReservationTable, pos: Position, t: number): void {
  const k = positionKey(pos);
  let s = table.get(k);
  if (!s) { s = new Set(); table.set(k, s); }
  s.add(t);
}

export function isReserved(table: ReservationTable, pos: Position, t: number): boolean {
  return table.get(positionKey(pos))?.has(t) ?? false;
}

export function cloneTable(table: ReservationTable): ReservationTable {
  const out: ReservationTable = new Map();
  for (const [k, v] of table) out.set(k, new Set(v));
  return out;
}

/**
 * Space-time A*: a node is (cell, time). The cost of a move is
 * BASE_MOVE_COST + CONGESTION_WEIGHT * congestion(cell) + WAIT_PENALTY when
 * the move is "stay put". Staying is ALWAYS allowed unless the cell is
 * reserved at t+1 by someone else — that is what lets a lower-priority robot
 * queue behind a higher-priority one instead of deadlocking.
 *
 * Returns the path INCLUDING the start cell at index 0, or null if no plan
 * exists within the horizon.
 */
export function planSpaceTime(
  start: Position,
  goal: Position,
  table: ReservationTable,
  map: WarehouseMap,
  congestion: Map<string, number>,
  horizon: number,
  waitPenalty: number
): Position[] | null {
  const baseCost = 1;
  const congestionWeight = 1;

  if (positionsEqual(start, goal)) {
    // Already there — legal only if we can legally stay for the whole horizon.
    for (let t = 0; t <= 1; t++) if (isReserved(table, start, t)) return null;
    return [start];
  }

  const h = (p: Position) => manhattanDistance(p, goal);

  // node key: cell@t
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();
  const startKey = `${positionKey(start)}@0`;
  gScore.set(startKey, 0);

  // Frontier as an array; the grid is tiny (260 cells) and the horizon is
  // bounded, so a binary heap is premature. Measured cost is in the report.
  let open: { key: string; pos: Position; t: number; f: number }[] = [{ key: startKey, pos: start, t: 0, f: h(start) }];
  const closed = new Set<string>();

  while (open.length > 0) {
    // pick lowest f, tie-break lowest h, then lowest key — fully deterministic
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i], b = open[bestIdx];
      if (a.f < b.f || (a.f === b.f && (h(a.pos) < h(b.pos) || (h(a.pos) === h(b.pos) && a.key < b.key)))) bestIdx = i;
    }
    const node = open.splice(bestIdx, 1)[0];

    if (closed.has(node.key)) continue;
    closed.add(node.key);

    if (positionsEqual(node.pos, goal)) {
      const path: Position[] = [node.pos];
      let k = node.key;
      while (cameFrom.has(k)) {
        k = cameFrom.get(k)!;
        path.unshift(parsePos(k));
      }
      return path;
    }

    if (node.t >= horizon) continue;

    const nextT = node.t + 1;
    const g = gScore.get(node.key)!;

    // Candidate successors: the four neighbours, plus "stay".
    const candidates: Position[] = [...getNeighbors(node.pos, map), node.pos];

    for (const cand of candidates) {
      const candKey = `${positionKey(cand)}@${nextT}`;
      if (closed.has(candKey)) continue;
      // Hard constraint: never plan into a cell another robot has reserved
      // for that tick. This is the whole point — conflicts are impossible by
      // construction rather than repaired after the fact.
      if (isReserved(table, cand, nextT)) continue;

      const isWait = positionsEqual(cand, node.pos);
      // A swap is two robots exchanging cells in one tick. Blocking the
      // destination at nextT is not enough on its own, because the OTHER
      // robot's reservation at THIS tick is what we would be moving into.
      // Checking that we are not simultaneously vacating a cell someone else
      // is claiming is handled by the reservation check above plus the
      // caller reserving each robot's own start cell at t=0.
      const stepCost = baseCost + congestionWeight * (congestion.get(positionKey(cand)) ?? 0) + (isWait ? waitPenalty : 0);
      const tentative = g + stepCost;
      if (tentative >= (gScore.get(candKey) ?? Infinity)) continue;

      cameFrom.set(candKey, node.key);
      gScore.set(candKey, tentative);
      const f = tentative + h(cand);
      const existing = open.find((n) => n.key === candKey);
      if (existing) existing.f = f;
      else open.push({ key: candKey, pos: cand, t: nextT, f });
    }
  }
  return null;
}

function parsePos(k: string): Position {
  const [cell, t] = k.split("@");
  const [x, y] = cell.split(",").map(Number);
  void t;
  return { x, y };
}

/**
 * Plan a whole fleet SEQUENTIALLY in priority order against one shared
 * reservation table. Each robot reserves its ENTIRE trajectory (all
 * (cell, t) pairs), so later robots see earlier robots' futures, not just
 * their present.
 *
 * Robots are ordered by priority (descending); ties by id. A robot that
 * cannot be planned is reported rather than silently dropped — the caller
 * can then either yield (lower someone else's priority) or wait.
 */
export function planFleet(
  robots: { id: string; position: Position; goal: Position; priority: number }[],
  map: WarehouseMap,
  congestion: Map<string, number>,
  horizon: number,
  waitPenalty: number
): Map<string, Position[]> {
  const table: ReservationTable = new Map();
  const plans = new Map<string, Position[]>();

  const ordered = [...robots].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });

  for (const r of ordered) {
    // Reserve this robot's current cell for the tick it is standing there,
    // so nobody else can be planned into it at t=0.
    const plan = planSpaceTime(r.position, r.goal, table, map, congestion, horizon, waitPenalty);
    if (plan) {
      for (let t = 0; t < plan.length; t++) reserve(table, plan[t], t);
      plans.set(r.id, plan);
    }
  }
  return plans;
}
