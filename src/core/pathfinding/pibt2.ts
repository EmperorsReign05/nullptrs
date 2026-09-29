// PROTOTYPE of the proposed model. Three invariants, each a hard constraint
// in the right layer — not a cost-function tweak:
//
//   I1  LEGAL STOP        A robot may only come to REST on a designated
//                         cell (waiting zone, dock, or station). In an
//                         aisle it must keep moving. Enforced in the
//                         PIBT candidate generator, because that is the
//                         only place that decides "wait vs move".
//
//   I2  ENERGY FEASIBLE   A robot may only accept a task if it can also
//                         still reach a charger afterwards. This is the
//                         invariant that makes starvation unreachable,
//                         rather than merely unlikely.
//
//   I3  CYCLE RECOVERY   Stationary wait cycles yield when a safe vacancy
//                        chain exists; failed/exhausted blockers can prevent it.
//
// Measured against the baseline, same seed, same workload.
import { isTraversable, WAITING_ZONES, CHARGING_STATIONS, PICKUP_STATIONS, DROPOFF_STATIONS } from "../map/warehouse";
import { getNeighbors, manhattanDistance, positionKey, positionsEqual } from "../map/graph";
import type { Position, RobotState, WarehouseMap, WorldState } from "../types";
import { BATTERY_PERCENT_PER_CELL } from "../simulation/robotModels";

export function inRect(p: Position, r: { x: number; y: number; width: number; height: number }): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

// I1: the set of cells where coming to rest is legal.
export function isLegalStop(p: Position): boolean {
  if (CHARGING_STATIONS.some((s) => positionsEqual(s.position, p))) return true;
  if (PICKUP_STATIONS.some((s) => positionsEqual(s.position, p))) return true;
  if (DROPOFF_STATIONS.some((s) => positionsEqual(s.position, p))) return true;
  return WAITING_ZONES.some((z) => inRect(p, z));
}

// I2: energy needed to get from p to the nearest dock, plus a reserve.
export function energyToNearestDock(p: Position, map: WarehouseMap, perCell: number, reserve: number): number {
  let best = Infinity;
  for (const s of CHARGING_STATIONS) {
    const r = routeDistance(p, s.position, map);
    if (r < best) best = r;
  }
  return best * perCell + reserve;
}

// Plain BFS on the static grid — used for the safety check, where we want
// the true worst-case distance, not a congestion-weighted one.
export function routeDistance(start: Position, goal: Position, map: WarehouseMap): number {
  if (positionsEqual(start, goal)) return 0;
  const seen = new Set<string>([positionKey(start)]);
  let frontier: Position[] = [start];
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: Position[] = [];
    for (const p of frontier) {
      for (const n of getNeighbors(p, map)) {
        const k = positionKey(n);
        if (seen.has(k)) continue;
        if (positionsEqual(n, goal)) return d;
        seen.add(k);
        next.push(n);
      }
    }
    frontier = next;
  }
  return Infinity;
}

export type PlannedMove = { robotId: string; from: Position; to: Position };
export type PIBTMetrics = {
  conflictCount: number;
  waitMoves: number;
  inheritedPriorities: number;
  backtracks: number;
  /** Robots forced to keep moving because their cell is not a legal stop. */
  illegalStopForced: number;
  /** Wait-for cycles detected and broken this tick. */
  cyclesBroken: number;
};
export type PIBTResult = { moves: PlannedMove[]; metrics: PIBTMetrics };

function rowMajorIndex(pos: Position, map: WarehouseMap): number {
  return pos.y * map.width + pos.x;
}

// I1 lives here: WAIT is only offered as a candidate when the robot is
// standing somewhere it is allowed to be stationary. A robot mid-aisle
// with no legal stop MUST take a neighbour instead, which is what turns a
// deadlock into a flow.
function getCandidates(robot: RobotState, map: WarehouseMap, callerPosition: Position | null): Position[] {
  const from = robot.position;
  const preferred = robot.path.length > 1 ? robot.path[1] : undefined;
  const beingPushed = callerPosition !== null;
  const waitAllowed = isLegalStop(from);

  if (!preferred && !beingPushed) {
    return waitAllowed ? [from] : getNeighbors(from, map);
  }

  const goal = robot.path.length > 0 ? robot.path[robot.path.length - 1] : from;
  const currentDistance = manhattanDistance(from, goal);

  let alternates = getNeighbors(from, map).filter((n) => !preferred || !positionsEqual(n, preferred));
  if (preferred && !beingPushed) {
    alternates = alternates.filter((n) => manhattanDistance(n, goal) < currentDistance);
  }

  const pushDir = callerPosition ? { x: from.x - callerPosition.x, y: from.y - callerPosition.y } : null;
  const isCollinearRetreat = (n: Position) => pushDir !== null && n.x - from.x === pushDir.x && n.y - from.y === pushDir.y;

  const ranked = alternates.sort((a, b) => {
    const da = manhattanDistance(a, goal);
    const db = manhattanDistance(b, goal);
    if (da !== db) return da - db;
    const aR = isCollinearRetreat(a) ? 1 : 0;
    const bR = isCollinearRetreat(b) ? 1 : 0;
    if (aR !== bR) return aR - bR;
    return rowMajorIndex(a, map) - rowMajorIndex(b, map);
  });

  const candidates: Position[] = [];
  if (preferred) candidates.push(preferred);
  candidates.push(...ranked);
  // Only ever offer WAIT where resting is legal.
  if (waitAllowed) candidates.push(from);
  return candidates;
}

type ResolutionState = {
  map: WarehouseMap;
  robotsById: Map<string, RobotState>;
  occupantByCell: Map<string, string>;
  decided: Map<string, PlannedMove>;
  reservedNext: Map<string, string>;
  inProgress: Set<string>;
  metrics: PIBTMetrics;
};

function resolveCandidate(robotId: string, callerId: string | null, state: ResolutionState): boolean {
  const existing = state.decided.get(robotId);
  if (existing) return !positionsEqual(existing.from, existing.to);
  if (state.inProgress.has(robotId)) return false;

  const robot = state.robotsById.get(robotId)!;
  state.inProgress.add(robotId);

  const callerPosition = callerId ? state.robotsById.get(callerId)!.position : null;
  const candidates = getCandidates(robot, state.map, callerPosition);
  const waitAllowed = isLegalStop(robot.position);
  let chosen: Position | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isWait = positionsEqual(candidate, robot.position);
    if (isWait) { chosen = candidate; break; }
    if (i > 0) state.metrics.backtracks += 1;
    if (!isTraversable(candidate, state.map) || manhattanDistance(candidate, robot.position) !== 1) continue;
    if (callerPosition && positionsEqual(candidate, callerPosition)) continue;

    const destKey = positionKey(candidate);
    const reservedBy = state.reservedNext.get(destKey);
    if (reservedBy && reservedBy !== robotId) { state.metrics.conflictCount += 1; continue; }

    const occupant = state.occupantByCell.get(destKey);
    if (occupant && occupant !== robotId && !state.decided.has(occupant)) {
      state.metrics.inheritedPriorities += 1;
      const vacated = resolveCandidate(occupant, robotId, state);
      if (!vacated) { state.metrics.conflictCount += 1; continue; }
    }
    chosen = candidate;
    break;
  }

  state.inProgress.delete(robotId);
  const to = chosen ?? robot.position;

  // I1 accounting: we ended up stationary somewhere resting is not allowed.
  if (positionsEqual(to, robot.position)) {
    state.metrics.waitMoves += 1;
    if (!waitAllowed) state.metrics.illegalStopForced += 1;
  }

  const move: PlannedMove = { robotId, from: robot.position, to };
  state.decided.set(robotId, move);
  state.reservedNext.set(positionKey(to), robotId);
  return !positionsEqual(to, robot.position);
}

// A cycle can be boxed in by other stationary robots even when there is
// room farther down the aisle. Shift a shortest chain into one free cell;
// every robot still moves only one edge and no swap/overlap is introduced.
function escapeChain(victim: RobotState, state: ResolutionState): Position[] | null {
  const queue: Position[][] = [[victim.position]];
  const seen = new Set([positionKey(victim.position)]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    for (const next of getNeighbors(path[path.length - 1], state.map)) {
      const key = positionKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      const reserved = state.reservedNext.get(key);
      if (!reserved) {
        const tail = path[path.length - 1];
        if ([...state.decided.values()].some(move =>
          positionsEqual(move.from, next) && positionsEqual(move.to, tail))) continue;
        return [...path, next];
      }
      const holder = state.robotsById.get(reserved)!;
      const move = state.decided.get(reserved)!;
      if (holder.status === "failed" || holder.battery < BATTERY_PERCENT_PER_CELL ||
          !positionsEqual(move.from, move.to)) continue;
      queue.push([...path, next]);
    }
  }
  return null;
}

export function resolvePIBT(robots: RobotState[], world: WorldState): PIBTResult {
  const map = world.map;
  const state: ResolutionState = {
    map,
    robotsById: new Map(robots.map((r) => [r.id, r])),
    occupantByCell: new Map(robots.map((r) => [positionKey(r.position), r.id])),
    decided: new Map(),
    reservedNext: new Map(),
    inProgress: new Set(),
    metrics: { conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0, illegalStopForced: 0, cyclesBroken: 0 },
  };

  for (const robot of robots) {
    if (robot.status === "failed") {
      state.decided.set(robot.id, { robotId: robot.id, from: robot.position, to: robot.position });
      state.reservedNext.set(positionKey(robot.position), robot.id);
      state.metrics.waitMoves += 1;
    }
  }

  const ordered = [...robots].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
  for (const robot of ordered) {
    if (!state.decided.has(robot.id)) resolveCandidate(robot.id, null, state);
  }

  // Break actual stationary wait cycles. Moving robots' old paths are not
  // wait dependencies. A free cell elsewhere on the map does not guarantee
  // that every cycle member has an adjacent escape, so try each member.
  for (let pass = 0; pass < robots.length; pass++) {
    const edges = new Map<string, string>();
    for (const r of robots) {
      const move = state.decided.get(r.id)!;
      if (!positionsEqual(move.from, move.to) || r.path.length < 2) continue;
      const holder = state.occupantByCell.get(positionKey(r.path[1]));
      const heldMove = holder ? state.decided.get(holder) : undefined;
      if (holder && holder !== r.id && heldMove && positionsEqual(heldMove.from, heldMove.to)) {
        edges.set(r.id, holder);
      }
    }
    const cycles: string[][] = [];
    const done = new Set<string>();
    for (const start of edges.keys()) {
      const chain: string[] = [];
      let id: string | undefined = start;
      while (id && !done.has(id)) {
        const index = chain.indexOf(id);
        if (index >= 0) { cycles.push(chain.slice(index)); break; }
        chain.push(id);
        id = edges.get(id);
      }
      for (const member of chain) done.add(member);
    }
    let changed = false;
    for (const cycle of cycles) {
      // An earlier escape chain can also have cleared this cycle.
      if (cycle.some(id => {
        const move = state.decided.get(id)!;
        return !positionsEqual(move.from, move.to);
      })) continue;
      const victims = cycle.map(id => state.robotsById.get(id)!)
        .filter(r => r.status !== "failed" && r.battery >= BATTERY_PERCENT_PER_CELL)
        .sort((a, b) => a.priority - b.priority || b.id.localeCompare(a.id));
      for (const victim of victims) {
        const chain = escapeChain(victim, state);
        if (!chain) continue;
        // Clear all old stationary reservations before claiming the shifted
        // destinations; otherwise later writes could erase a new reservation.
        const shifted = chain.slice(0, -1).map(position => state.occupantByCell.get(positionKey(position))!);
        for (const id of shifted) state.reservedNext.delete(positionKey(state.robotsById.get(id)!.position));
        for (let i = 0; i < shifted.length; i++) {
          const robot = state.robotsById.get(shifted[i])!;
          state.decided.set(robot.id, { robotId: robot.id, from: robot.position, to: chain[i + 1] });
          state.reservedNext.set(positionKey(chain[i + 1]), robot.id);
          state.metrics.waitMoves -= 1;
          if (!isLegalStop(robot.position)) state.metrics.illegalStopForced -= 1;
        }
        state.metrics.cyclesBroken += 1;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  const moves = ordered.map((r) => state.decided.get(r.id)!);
  return { moves, metrics: state.metrics };
}
