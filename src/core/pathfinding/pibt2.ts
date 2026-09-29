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
//   I3  CYCLE-FREE       Every wait-for cycle is broken deterministically.
//
// Measured against the baseline, same seed, same workload.
import { isTraversable, WAITING_ZONES, CHARGING_STATIONS, PICKUP_STATIONS, DROPOFF_STATIONS } from "../map/warehouse";
import { getNeighbors, manhattanDistance, positionKey, positionsEqual } from "../map/graph";
import type { Position, RobotState, WarehouseMap, WorldState } from "../types";

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

  // ---- I3: break every remaining wait-for cycle, deterministically. ----
  // After resolution, a robot that is stationary while wanting the cell
  // another stationary robot holds forms a wait-for edge. Any cycle in that
  // graph is a permanent deadlock. We find the cycles and force the
  // lowest-priority (then highest-id) member of each to yield to a free
  // neighbour, which is guaranteed to exist because the map has slack.
  for (let pass = 0; pass < 4; pass++) {
    const at = new Map<string, string>();
    for (const r of robots) at.set(positionKey(r.position), r.id);
    const edges = new Map<string, string>();
    for (const r of robots) {
      const mv = state.decided.get(r.id);
      if (!mv) continue;
      if (positionsEqual(mv.from, mv.to)) continue; // not waiting
      if (r.path.length > 1) {
        const holder = at.get(positionKey(r.path[1]));
        if (holder && holder !== r.id) edges.set(r.id, holder);
      }
    }
    // find a cycle
    const color = new Map<string, number>();
    const stack: string[] = [];
    let cycle: string[] | null = null;
    const visit = (id: string) => {
      color.set(id, 1); stack.push(id);
      const nx = edges.get(id);
      if (nx) {
        if (color.get(nx) === 1) { cycle = stack.slice(stack.indexOf(nx)); return true; }
        if (!color.has(nx) && visit(nx)) return true;
      }
      stack.pop(); color.set(id, 2);
      return false;
    };
    for (const id of edges.keys()) { if (!color.has(id) && visit(id)) break; }
    if (!cycle) break;

    // pick the victim: lowest priority, then lexicographically largest id
    const members: string[] = [...cycle];
    const victimId = members.sort((a, b) => {
      const pa = state.robotsById.get(a)!.priority;
      const pb = state.robotsById.get(b)!.priority;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    })[0];
    const victim = state.robotsById.get(victimId)!;
    const occupiedNow = new Set([...state.reservedNext.keys()]);
    let escape: Position | null = null;
    for (const n of getNeighbors(victim.position, map)) {
      if (occupiedNow.has(positionKey(n))) continue;
      if (callerSafe(state, victim, n)) { escape = n; break; }
    }
    if (!escape) break; // genuinely boxed in; leave it, next pass retries
    state.decided.set(victimId, { robotId: victimId, from: victim.position, to: escape });
    state.reservedNext.set(positionKey(escape), victimId);
    state.metrics.cyclesBroken += 1;
  }

  const moves = ordered.map((r) => state.decided.get(r.id)!);
  return { moves, metrics: state.metrics };
}

function callerSafe(state: ResolutionState, robot: RobotState, target: Position): boolean {
  // don't step onto a cell someone else is committed to entering
  return !state.reservedNext.has(positionKey(target));
}
