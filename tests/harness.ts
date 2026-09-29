// Instrumented 20-AMR load harness. Replicates the exact dashboard
// scenario (fleet slider -> 20 AMRs, then Start Sim) and drives sustained
// task load on top. Records per-subsystem health every tick so the
// failure modes can be attributed to mechanisms, not guessed at.
import { createInitialWorld } from "../src/core/simulation/state";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { ROBOT_MODELS, MIN_BATTERY_TO_BID_PERCENT } from "../src/core/simulation/robotModels";
import { CHARGING_STATIONS, isTraversable } from "../src/core/map/warehouse";
import type { Position, Task, WorldState } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

// EXACT copy of the dashboard's handleRobotCountChange spawn list/growth.
const SAFE_SPAWNS: Position[] = [
  { x: 0, y: 0 }, { x: 0, y: 8 }, { x: 0, y: 12 },
  { x: 3, y: 6 }, { x: 6, y: 1 }, { x: 6, y: 11 },
  { x: 9, y: 7 }, { x: 9, y: 12 }, { x: 12, y: 1 },
  { x: 13, y: 12 }, { x: 14, y: 6 }, { x: 17, y: 9 },
];

export function growFleet(world: WorldState, newCount: number): WorldState {
  if (newCount <= world.robots.length) return world;
  const startIndex = world.robots.length;
  const newRobots = [...world.robots];
  for (let i = startIndex; i < newCount; i++) {
    const spawnIdx = (i - startIndex) % SAFE_SPAWNS.length;
    const pos = SAFE_SPAWNS[spawnIdx];
    newRobots.push({
      id: `AMR-${(i + 1).toString().padStart(2, "0")}`,
      position: pos,
      home: pos,
      battery: 70,
      status: "idle",
      model: ROBOT_MODELS[i % ROBOT_MODELS.length],
      path: [],
      priority: 0,
    });
  }
  return { ...world, robots: newRobots };
}

export function openCells(world: WorldState): Position[] {
  return world.map.cells.filter((c) => !c.blocked).map((c) => c.position);
}

export function makeLoadTasks(world: WorldState, startIdx: number, count: number, open: Position[]): Task[] {
  const out: Task[] = [];
  for (let i = 0; i < count; i++) {
    const n = startIdx + i;
    const pickup = open[(n * 7 + 3) % open.length];
    const dropoff = open[(n * 13 + 5) % open.length];
    if (pickup.x === dropoff.x && pickup.y === dropoff.y) continue;
    out.push({
      id: `L${n}`,
      pickup,
      dropoff,
      weight: (n % 9) * 10 + 10,
      createdAt: world.tick,
      priority: 1,
      status: "pending",
    });
  }
  return out;
}

export type TickSample = {
  tick: number;
  charging: number;
  waiting: number;
  moving: number;
  idle: number;
  assigned: number;
  avgBattery: number;
  minBattery: number;
  pending: number;
  inProgress: number;
  assignedTasks: number;
  completed: number;
  duplicateOccupancy: number;
  onBlockedCell: number;
  robotsAtStation: number;
  zeroBatteryWorking: number;
  at0AndCharging: number;
  taskOwnerless: number;
  metrics: WorldState["metrics"];
};

export function sample(world: WorldState): TickSample {
  const statusCount: Record<string, number> = {};
  for (const r of world.robots) statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;

  const cells = new Map<string, number>();
  let onBlocked = 0;
  let zeroBatteryWorking = 0;
  let atStation = 0;
  let at0Charging = 0;
  let totalBattery = 0;
  let minBattery = 100;

  for (const r of world.robots) {
    const k = key(r.position);
    cells.set(k, (cells.get(k) ?? 0) + 1);
    totalBattery += r.battery;
    minBattery = Math.min(minBattery, r.battery);
    if (!isTraversable(r.position, world.map)) onBlocked++;
    if (r.battery === 0 && (r.status === "moving" || r.status === "assigned" || r.status === "waiting")) zeroBatteryWorking++;
    if (r.battery === 0 && r.status === "charging") at0Charging++;
    if (CHARGING_STATIONS.some((s) => s.position.x === r.position.x && s.position.y === r.position.y)) atStation++;
  }
  let dupes = 0;
  for (const [, n] of cells) if (n > 1) dupes += n - 1;

  const owners = new Set<string>();
  for (const r of world.robots) {
    if (r.currentTaskId) owners.add(r.currentTaskId);
    for (const q of r.queuedTaskIds ?? []) owners.add(q);
  }
  let ownerless = 0;
  for (const t of world.tasks) {
    if ((t.status === "assigned" || t.status === "in_progress") && !owners.has(t.id)) ownerless++;
  }

  return {
    tick: world.tick,
    charging: statusCount["charging"] ?? 0,
    waiting: statusCount["waiting"] ?? 0,
    moving: statusCount["moving"] ?? 0,
    idle: statusCount["idle"] ?? 0,
    assigned: statusCount["assigned"] ?? 0,
    avgBattery: totalBattery / world.robots.length,
    minBattery,
    pending: world.tasks.filter((t) => t.status === "pending").length,
    inProgress: world.tasks.filter((t) => t.status === "in_progress").length,
    assignedTasks: world.tasks.filter((t) => t.status === "assigned").length,
    completed: world.tasks.filter((t) => t.status === "completed").length,
    duplicateOccupancy: dupes,
    onBlockedCell: onBlocked,
    robotsAtStation: atStation,
    zeroBatteryWorking,
    at0AndCharging: at0Charging,
    taskOwnerless: ownerless,
    metrics: world.metrics,
  };
}

export function createLoadWorld(robotCount: number, initialTasks: number): WorldState {
  let world = createInitialWorld();
  world = growFleet(world, robotCount);
  const open = openCells(world);
  world = { ...world, tasks: [...world.tasks, ...makeLoadTasks(world, 0, initialTasks, open)] };
  return world;
}
