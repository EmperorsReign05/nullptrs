import type { Position, RobotState, Task, WorldState } from "../types";
import type { RobotBid } from "../auction/cost";
import { CHARGING_STATIONS, computeCongestion } from "../map/warehouse";
import { planPath } from "../pathfinding/astar";
import { BATTERY_PERCENT_PER_CELL } from "../simulation/robotModels";

/** Versioned order: models must retain this exact schema. No future outcomes. */
export const BID_FEATURE_NAMES = [
  "travel", "congestion", "batteryCost", "workload", "urgency", "payload",
  "queueDepth", "peerRouteContention", "peerNextIntentContention",
  "chargerDistance", "postTaskChargerDistance", "energyReserveAfterReturn",
  "chargerUnreachable", "activeRouteRemaining", "hasActiveTask", "battery",
] as const;
const key = (p: Position) => `${p.x},${p.y}`;
let cachedGeometry = "";
let chargerDistances = new Map<string, number>();

/** Multi-source BFS: nearest station by traversable distance, ignoring traffic.
 * Cache keys include geometry; congestion changes do not invalidate distances.
 */
function distances(world: WorldState): Map<string, number> {
  const geometry = `${world.map.width}:${world.map.height}:` +
    world.map.cells.map(c => c.blocked ? "#" : ".").join("");
  if (geometry === cachedGeometry) return chargerDistances;
  const open = new Set(world.map.cells.filter(c => !c.blocked).map(c => key(c.position)));
  const result = new Map<string, number>();
  const queue: Position[] = [];
  for (const station of CHARGING_STATIONS) {
    if (open.has(key(station.position))) {
      result.set(key(station.position), 0);
      queue.push(station.position);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: p.x + dx, y: p.y + dy };
      const k = key(next);
      if (open.has(k) && !result.has(k)) {
        result.set(k, result.get(key(p))! + 1);
        queue.push(next);
      }
    }
  }
  cachedGeometry = geometry;
  chargerDistances = result;
  return result;
}

export function extractBidFeatures(
  robot: RobotState, task: Task, world: WorldState, bid: RobotBid,
  candidateRoute?: readonly Position[],
): number[] {
  if (!bid.feasible) throw new Error("Bid features require a feasible bid");
  const route = candidateRoute ?? [
    ...planPath(robot.position, task.pickup, world).path,
    ...planPath(task.pickup, task.dropoff, world).path.slice(1),
  ];
  const cells = new Set(route.map(key));
  const peers = world.robots.filter(p => p.id !== robot.id);
  // Each peer counted once; path[0] is occupancy, path[1:] is intended motion.
  const contention = peers.filter(p => p.path.slice(1).some(p => cells.has(key(p)))).length;
  const nextContention = peers.filter(p => p.path[1] && cells.has(key(p.path[1]))).length;
  const stationDistances = distances(world);
  const here = stationDistances.get(key(robot.position));
  const after = stationDistances.get(key(task.dropoff));
  const unreachable = here === undefined || after === undefined;
  const sentinel = world.map.cells.length;
  return [
    bid.travelCost, bid.congestionCost, bid.batteryCost, bid.workloadCost,
    bid.urgencyCost, bid.payloadCost, robot.queuedTaskIds?.length ?? 0,
    contention, nextContention, here ?? sentinel, after ?? sentinel,
    robot.battery - BATTERY_PERCENT_PER_CELL * (bid.travelCost + (after ?? sentinel)),
    Number(unreachable), Math.max(0, robot.path.length - 1), Number(!!robot.currentTaskId), robot.battery,
  ];
}

/** Conservative admission for LEARNED corrections, not a replacement for the
 * dispatcher's hard eligibility rules. Account for the active job and every
 * queued job before the proposed job, then require a route to a charger with
 * 15% reserve. Unknown/failed commitments cannot receive a learned correction.
 * No promise about future traffic: this is a static feasibility check.
 */
export function correctionFeasible(robot: RobotState, task: Task, world: WorldState): boolean {
  if (robot.status === "failed" || robot.status === "charging" || robot.battery < 20 ||
      (robot.queuedTaskIds?.length ?? 0) >= 4 || task.weight > robot.model.payloadCapacity) return false;
  let position = robot.position, distance = 0;
  const jobs = [...(robot.currentTaskId ? [robot.currentTaskId] : []), ...(robot.queuedTaskIds ?? [])];
  const waypoints: Position[] = [];
  for (const id of jobs) {
    const job = world.tasks.find(t => t.id === id);
    if (!job || job.status === "completed" || job.weight > robot.model.payloadCapacity) return false;
    if (job.status !== "in_progress") waypoints.push(job.pickup);
    waypoints.push(job.dropoff);
  }
  waypoints.push(task.pickup, task.dropoff);
  for (const destination of waypoints) {
    const leg = planPath(position, destination, world);
    if (!leg.found) return false;
    distance += leg.distance;
    position = destination;
  }
  const charger = distances(world).get(key(position));
  return charger !== undefined && robot.battery - (distance + charger) * BATTERY_PERCENT_PER_CELL >= 15;
}

export type BidEnergyAssessment = {
  admitted: boolean; reason: string; activeRouteCertified: boolean;
  battery: number; committedDistance: number; chargingDistance: number;
  requiredEnergy: number; reserve: number; margin: number; charger: Position | null;
};

/** Energy admission certificate for an MLP winner change. Uses the actual
 * committed active route, exact dispatch queue order, and the charger selected
 * by the existing engine (Manhattan nearest, stable station-order tie-break).
 * Missing/stale active intent is uncertainty, not zero workload. No route or
 * simulator state is changed. This is a static certificate, not a guarantee
 * against unbounded future detours or another agent blocking the charger.
 */
export function assessBidEnergy(robot: RobotState, task: Task, world: WorldState): BidEnergyAssessment {
  const reserve = 15;
  const out: BidEnergyAssessment = { admitted: false, reason: "eligibility", activeRouteCertified: !robot.currentTaskId,
    battery: robot.battery, committedDistance: 0, chargingDistance: 0, requiredEnergy: reserve,
    reserve, margin: robot.battery - reserve, charger: null };
  if (!Number.isFinite(robot.battery) || robot.status === "failed" || robot.status === "charging" || robot.battery < 20 ||
      (robot.queuedTaskIds?.length ?? 0) >= 4 || task.weight > robot.model.payloadCapacity) return out;
  const eq = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
  let position = robot.position;
  const follow = (destination: Position) => {
    const leg = planPath(position, destination, world);
    if (!leg.found) return false;
    out.committedDistance += leg.distance;
    position = destination;
    return true;
  };
  const checkChargingPrefix = () => {
    const station = [...CHARGING_STATIONS].sort((a, b) =>
      Math.abs(a.position.x - position.x) + Math.abs(a.position.y - position.y) -
      Math.abs(b.position.x - position.x) - Math.abs(b.position.y - position.y))[0];
    if (!station) { out.reason = "no-charger"; return false; }
    const route = planPath(position, station.position, world);
    if (!route.found) { out.reason = "unreachable-charger"; return false; }
    const required = (out.committedDistance + route.distance) * BATTERY_PERCENT_PER_CELL + reserve;
    if (required > out.requiredEnergy) {
      out.requiredEnergy = required; out.chargingDistance = route.distance; out.charger = station.position;
    }
    out.margin = robot.battery - out.requiredEnergy;
    if (out.margin < 0) { out.reason = "insufficient-energy"; return false; }
    return true;
  };
  if (robot.currentTaskId) {
    const active = world.tasks.find(t => t.id === robot.currentTaskId);
    if (!active || active.status === "completed" || active.weight > robot.model.payloadCapacity) {
      out.reason = "invalid-active-task"; return out;
    }
    const goal = active.status === "in_progress" ? active.dropoff : active.pickup;
    const path = robot.path;
    const valid = path.length > 0 && eq(path[0], position) && eq(path[path.length - 1], goal) &&
      path.every((p, i) => world.map.cells.some(c => eq(c.position, p) && !c.blocked) &&
        (i === 0 || Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) === 1));
    if (!valid) { out.reason = "uncertified-active-route"; return out; }
    out.activeRouteCertified = true;
    out.committedDistance += path.length - 1;
    position = goal;
    if (active.status !== "in_progress" && !follow(active.dropoff)) { out.reason = "unreachable-active-dropoff"; return out; }
    if (!checkChargingPrefix()) return out;
  }
  const queued = (robot.queuedTaskIds ?? []).map(id => world.tasks.find(t => t.id === id));
  if (queued.some(t => !t || t.status === "completed" || t.weight > robot.model.payloadCapacity)) {
    out.reason = "invalid-queued-task"; return out;
  }
  // Dispatch installs the candidate immediately when no current task exists,
  // even if there is a queue; otherwise it appends the candidate to that queue.
  const jobs = robot.currentTaskId ? [...queued, task] : [task, ...queued];
  for (const job of jobs) {
    if (!job || !follow(job.pickup) || !follow(job.dropoff)) { out.reason = "unreachable-commitment"; return out; }
    if (!checkChargingPrefix()) return out;
  }
  out.admitted = true; out.reason = "certified";
  return out;
}

/** Explicit received data, not a handle to the fleet or simulator. Static
 * geometry carries no live congestion; pressure is rebuilt from received poses.
 * Training may be centralized. Inference sees only this contract.
 */
export type PeerBidBeacon = {
  senderId: string; sequence: number; observedTick: number;
  position: Position; path: readonly Position[];
};
export type LocalBidInput = {
  tick: number; self: RobotState; task: Task; ownTasks: readonly Task[];
  geometry: Pick<WorldState["map"], "width" | "height"> & {
    cells: readonly Pick<WorldState["map"]["cells"][number], "position" | "blocked">[];
  };
  receivedPeers: readonly PeerBidBeacon[];
  expectedPeerIds: readonly string[];
  maxPeerAgeTicks: number;
};

export function localBidView(input: LocalBidInput): { world: WorldState; completePeerKnowledge: boolean } {
  if (!Number.isInteger(input.tick) || input.tick < 0 || !Number.isInteger(input.maxPeerAgeTicks) || input.maxPeerAgeTicks < 0)
    throw new Error("Invalid local observation time");
  const expected = new Set(input.expectedPeerIds.filter(id => id !== input.self.id));
  const validPosition = (p: Position) => Number.isInteger(p.x) && Number.isInteger(p.y) &&
    p.x >= 0 && p.y >= 0 && p.x < input.geometry.width && p.y < input.geometry.height &&
    input.geometry.cells.some(c => c.position.x === p.x && c.position.y === p.y && !c.blocked);
  const latest = new Map<string, PeerBidBeacon>();
  const conflicted = new Set<string>();
  for (const message of input.receivedPeers) {
    if (!expected.has(message.senderId) || !Number.isInteger(message.sequence) || message.sequence < 0 ||
        !Number.isInteger(message.observedTick) || message.observedTick < 0 || message.observedTick > input.tick ||
        !validPosition(message.position) || !message.path.every(validPosition) ||
        input.tick - message.observedTick > input.maxPeerAgeTicks) continue;
    const old = latest.get(message.senderId);
    if (old && old.sequence === message.sequence && JSON.stringify([old.position, old.path]) !== JSON.stringify([message.position, message.path]))
      conflicted.add(message.senderId);
    if (!old || message.sequence > old.sequence) latest.set(message.senderId, message);
  }
  const peers: RobotState[] = [...latest.values()].filter(m => !conflicted.has(m.senderId)).sort((a, b) => a.senderId.localeCompare(b.senderId)).map(m => ({
    // Only position and intent are used by congestion/features. No peer private
    // battery, task queue, payload, or unreceived route is reconstructed.
    id: m.senderId, position: { ...m.position }, home: { ...m.position }, path: m.path.map(p => ({ ...p })),
    battery: 0, status: "idle", model: { model: "received-intent-only", payloadCapacity: 0 }, priority: 0,
  }));
  const self = { ...input.self, position: { ...input.self.position }, home: { ...input.self.home },
    path: input.self.path.map(p => ({ ...p })), queuedTaskIds: [...(input.self.queuedTaskIds ?? [])] };
  const knownTaskIds = new Set([self.currentTaskId, ...(self.queuedTaskIds ?? []), input.task.id]);
  const tasks = input.ownTasks.filter(t => knownTaskIds.has(t.id) && t.id !== input.task.id).map(t => ({ ...t }));
  tasks.push({ ...input.task });
  const robots = [self, ...peers];
  const map = { width: input.geometry.width, height: input.geometry.height,
    cells: input.geometry.cells.map(c => ({ position: { ...c.position }, blocked: c.blocked, congestion: 0 })) };
  return { world: { tick: input.tick, robots, tasks, map: computeCongestion(map, robots),
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } },
    completePeerKnowledge: peers.length === expected.size };
}
