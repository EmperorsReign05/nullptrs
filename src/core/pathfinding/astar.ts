import type { Position, WarehouseMap, WorldState } from "../types";
import { getCell, getCellIndex, isInsideMap } from "../map/warehouse";
import { getNeighbors, manhattanDistance, positionsEqual } from "../map/graph";

// Answers: "what route should ONE robot ideally follow from its current
// position to its goal?" It does not guarantee collision-free simultaneous
// multi-robot execution — that is PIBT's job (src/core/pathfinding/pibt.ts),
// which decides each robot's next SAFE step given the intended path A*
// produced. A* never mutates world state, so it's safe to call repeatedly
// for bid estimation (the future auction layer) without side effects.
export type PathResult = {
  found: boolean;

  // Includes BOTH the start cell and the goal cell. path[0] === start,
  // path[path.length - 1] === goal. A start === goal call returns [start].
  path: Position[];

  // Pure movement distance: count of moves (base cost 1 each), ignoring
  // congestion. Equal to path.length - 1.
  distance: number;

  // Sum of CONGESTION_WEIGHT * congestion(cell) over every cell entered.
  congestionCost: number;

  // g(goal) = distance + congestionCost. What A* actually minimizes.
  totalCost: number;

  // Estimated ticks to arrive. On this grid one tick == one move, so
  // eta === distance (kept as a separate field since ETA is a distinct
  // concept the auction layer bids on, even though the value matches today).
  eta: number;
};

// Edge cost = base movement cost (always 1) + a soft congestion penalty on
// the cell being entered. Congestion is read straight off world.map — it
// reflects CURRENT observable robot occupancy only (see
// src/core/map/warehouse.ts computeCongestion), never predicted/future
// state. A currently-occupied cell is never a hard wall — only shelves are —
// so A* can still route through traffic when that's genuinely the cheapest
// option; PIBT is what actually prevents collisions at execution time.
export const CONGESTION_WEIGHT = 1;
const BASE_MOVE_COST = 1;

function congestionPenalty(position: Position, map: WarehouseMap): number {
  const congestion = getCell(map, position)?.congestion ?? 0;
  return CONGESTION_WEIGHT * congestion;
}

const UNREACHABLE: PathResult = {
  found: false,
  path: [],
  distance: Infinity,
  congestionCost: 0,
  totalCost: Infinity,
  eta: Infinity,
};

/**
 * Congestion-aware A*: f(n) = g(n) + h(n).
 *   g(n) = accumulated (base move cost + congestion penalty) from start
 *   h(n) = Manhattan distance to goal — admissible and consistent here,
 *          since every move costs at least BASE_MOVE_COST (1) and the
 *          congestion term only ever adds non-negative cost.
 *
 * Deterministic: ties break on lowest f, then lowest h, then lowest
 * row-major cell index (y * map.width + x) — never on Map/Set iteration
 * order — so identical (start, goal, world) always returns the identical
 * path.
 */
export function planPath(start: Position, goal: Position, world: WorldState): PathResult {
  const map = world.map;
  const cells = encodeCells(map);
  const key = `${hashCells(cells, map.width, map.height)}|${start.x},${start.y}|${goal.x},${goal.y}`;
  const hit = pathCache.get(key);
  let result: PathResult;
  if (hit && hit.width === map.width && sameCells(hit.cells, cells)) {
    result = hit.result;
  } else {
    result = search(start, goal, map);
    if (pathCache.size >= PATH_CACHE_LIMIT) pathCache.clear();
    pathCache.set(key, { width: map.width, cells, result });
  }
  // Callers own what they receive: a cached path must never be aliased.
  return { ...result, path: result.path.map(p => ({ x: p.x, y: p.y })) };
}

/**
 * Memo of exact A* results.
 *
 * planPath reads the map only by cell index (y * width + x): each cell's
 * `blocked` flag and `congestion`. So width, height and those two values per
 * index fully determine the result. The cache is keyed by a hash of exactly
 * that, and a hit is accepted only after comparing every cell, so it is
 * bit-identical to a fresh search and the planner's behaviour does not change.
 * Object identity is never trusted: the block-aisle command mutates a map in
 * place, and each bid builds a fresh map object with the same contents.
 *
 * Why it matters: at twenty robots every peer bids on every candidate job in the
 * same tick, and one bid plans the same two legs (robot->pickup and
 * pickup->dropoff) up to three times (cost, features, energy). Peers that see the
 * same robot positions also build identical congestion maps. Those duplicate
 * searches were the largest part of a ~430 ms tick once every 32.
 */
const PATH_CACHE_LIMIT = 4096;
const pathCache = new Map<string, { width: number; cells: Float64Array; result: PathResult }>();

/** Blocked cells encode as -1, open cells as their congestion. */
function encodeCells(map: WorldState["map"]): Float64Array {
  const out = new Float64Array(map.cells.length);
  for (let i = 0; i < map.cells.length; i++) {
    const cell = map.cells[i];
    out[i] = cell.blocked ? -1 : cell.congestion ?? 0;
  }
  return out;
}

function hashCells(cells: Float64Array, width: number, height: number): number {
  let h = (Math.imul(width, 73856093) ^ Math.imul(height, 19349663)) >>> 0;
  for (let i = 0; i < cells.length; i++) h = (Math.imul(h ^ Math.round(cells[i] * 1024 + 7), 16777619) + i) >>> 0;
  return h;
}

function sameCells(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function search(start: Position, goal: Position, map: WorldState["map"]): PathResult {

  if (positionsEqual(start, goal)) {
    return { found: true, path: [start], distance: 0, congestionCost: 0, totalCost: 0, eta: 0 };
  }

  if (!isInsideMap(start, map) || !isInsideMap(goal, map)) {
    return UNREACHABLE;
  }

  const startIdx = getCellIndex(map, start);
  const goalIdx = getCellIndex(map, goal);

  const posByIdx = new Map<number, Position>([[startIdx, start]]);
  const cameFrom = new Map<number, number>();
  const distanceScore = new Map<number, number>([[startIdx, 0]]);
  const congestionScore = new Map<number, number>([[startIdx, 0]]);
  const gScore = new Map<number, number>([[startIdx, 0]]);
  const hScore = new Map<number, number>([[startIdx, manhattanDistance(start, goal)]]);
  const fScore = new Map<number, number>([[startIdx, manhattanDistance(start, goal)]]);

  const open = new Set<number>([startIdx]);
  const closed = new Set<number>();

  while (open.size > 0) {
    let currentIdx = -1;
    let bestF = Infinity;
    let bestH = Infinity;

    for (const idx of open) {
      const f = fScore.get(idx) ?? Infinity;
      const h = hScore.get(idx) ?? Infinity;
      const better =
        f < bestF ||
        (f === bestF && h < bestH) ||
        (f === bestF && h === bestH && (currentIdx === -1 || idx < currentIdx));
      if (better) {
        bestF = f;
        bestH = h;
        currentIdx = idx;
      }
    }

    if (currentIdx === goalIdx) {
      const path: Position[] = [posByIdx.get(currentIdx)!];
      let idx = currentIdx;
      while (cameFrom.has(idx)) {
        idx = cameFrom.get(idx)!;
        path.unshift(posByIdx.get(idx)!);
      }
      const distance = distanceScore.get(currentIdx) ?? path.length - 1;
      const congestionCost = congestionScore.get(currentIdx) ?? 0;
      const totalCost = gScore.get(currentIdx) ?? distance + congestionCost;
      return { found: true, path, distance, congestionCost, totalCost, eta: distance };
    }

    open.delete(currentIdx);
    closed.add(currentIdx);

    const currentPos = posByIdx.get(currentIdx)!;
    for (const neighbor of getNeighbors(currentPos, map)) {
      const nIdx = getCellIndex(map, neighbor);
      if (closed.has(nIdx)) continue;

      const penalty = congestionPenalty(neighbor, map);
      const tentativeDistance = (distanceScore.get(currentIdx) ?? Infinity) + BASE_MOVE_COST;
      const tentativeCongestion = (congestionScore.get(currentIdx) ?? Infinity) + penalty;
      const tentativeG = tentativeDistance + tentativeCongestion;

      if (tentativeG < (gScore.get(nIdx) ?? Infinity)) {
        cameFrom.set(nIdx, currentIdx);
        distanceScore.set(nIdx, tentativeDistance);
        congestionScore.set(nIdx, tentativeCongestion);
        gScore.set(nIdx, tentativeG);
        const h = manhattanDistance(neighbor, goal);
        hScore.set(nIdx, h);
        fScore.set(nIdx, tentativeG + h);
        posByIdx.set(nIdx, neighbor);
        open.add(nIdx);
      }
    }
  }

  return UNREACHABLE;
}
