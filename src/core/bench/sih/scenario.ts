// Deterministic workload generation for the SIH acceptance benchmark.
//
// A scenario is a pure function of (seed, fleetSize, endpointFamily). The same
// seed always produces byte-identical robots, tasks, map and horizon, so every
// policy arm is handed exactly the same workload and the benchmark is
// reproducible from the seed alone.
//
// Fairness controls enforced here, not by convention:
//   * the map is createWarehouseMap(), unmodified, for every scenario;
//   * every arm of a scenario is constructed from this same record, and the
//     runner deep-clones it per arm so no arm can mutate another's workload;
//   * robot capabilities, batteries, task weights/priorities, pickup/dropoff
//     cells, release times, movement speed and charging rules are fields of the
//     record, identical across arms;
//   * the only per-arm freedom is the three switches declared in protocol.ts.

import { SHELF_BLOCKS, createWarehouseMap, isTraversable, type ShelfBlock } from "../../map/warehouse";
import { getNeighbors } from "../../map/graph";
import { createInitialWorld } from "../../simulation/state";
import type { Position, Task, WarehouseMap, WorldState } from "../../types";
import { WORKLOAD } from "./protocol";
import { analyseOverlap, classifyRegime, type OverlapAnalysis, type Regime } from "./overlap";

export const MAP_WIDTH = 20;
export const MAP_HEIGHT = 13;

/**
 * Layout families. Both are handed to every arm of a scenario byte-identically;
 * a scenario never mixes layouts, and no arm may alter geometry.
 *
 *   stock   the production warehouse layout (createWarehouseMap(), unmodified).
 *           Its free space is a lattice of ONE-CELL-WIDE corridors: 157 of its
 *           158 open cells are articulation points of the traversable graph, so
 *           any robot standing on a route severs it. This is the harsh case and
 *           it is the layout the whole repository has always been measured on.
 *
 *   wide    a conventional AMR picking warehouse: the same 20x13 footprint with
 *           2-wide racks and 3-to-4-cell aisles, so robots can pass each other.
 *           Without it the benchmark would only ever measure a maze, and the
 *           stop-and-wait baseline would fail for a reason that says nothing
 *           about coordination quality.
 */
export const LAYOUTS: Record<string, ShelfBlock[]> = {
  stock: SHELF_BLOCKS,
  wide: [
    [2, 1, 2, 3], [2, 9, 2, 3],
    [8, 1, 2, 3], [8, 9, 2, 3],
    [14, 1, 2, 3], [14, 9, 2, 3],
  ],
};

export type LayoutId = keyof typeof LAYOUTS;

function buildMap(blocks: ShelfBlock[]): WarehouseMap {
  const blocked = new Set<string>();
  for (const [bx, by, bw, bh] of blocks) {
    for (let dx = 0; dx < bw; dx++) for (let dy = 0; dy < bh; dy++) blocked.add(`${bx + dx},${by + dy}`);
  }
  const cells = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) cells.push({ position: { x, y }, blocked: blocked.has(`${x},${y}`), congestion: 0 });
  }
  return { width: MAP_WIDTH, height: MAP_HEIGHT, cells };
}

export function layoutMap(layout: LayoutId): WarehouseMap {
  return layout === "stock" ? createWarehouseMap() : buildMap(LAYOUTS[layout]);
}

/** Rows that are entirely free: the horizontal aisles of this layout. */
export function aisleRows(map: WarehouseMap): number[] {
  const out: number[] = [];
  for (let y = 0; y < map.height; y++) {
    let all = true;
    for (let x = 0; x < map.width; x++) if (!isTraversable({ x, y }, map)) { all = false; break; }
    if (all) out.push(y);
  }
  return out;
}

/**
 * Vertical corridors with no passing place between the horizontal aisles: a
 * column that is entirely free, and whose non-aisle cells each have at most two
 * traversable neighbours, so a robot standing in the corridor cannot step aside.
 * Derived from the layout rather than hardcoded, so a new layout needs no new
 * constants and cannot silently disagree with its own geometry.
 */
export function singleFileColumns(map: WarehouseMap): number[] {
  const aisles = new Set(aisleRows(map));
  const out: number[] = [];
  for (let x = 0; x < map.width; x++) {
    let usable = true;
    for (let y = 0; y < map.height && usable; y++) {
      const p = { x, y };
      if (!isTraversable(p, map)) { usable = false; break; }
      if (!aisles.has(y) && getNeighbors(p, map).length > 2) usable = false;
    }
    if (usable) out.push(x);
  }
  return out;
}

export type EndpointFamily = keyof typeof WORKLOAD.endpointFamilies;

/** Deterministic LCG. Identical formulation to the frozen v5 acceptance test,
 *  so seeds in the 7xxxxx/9xxxxx development and acceptance blocks are as
 *  reproducible as the 42000 block, while being disjoint from it. */
export function scenarioRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const pick = <T,>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

export type ScenarioRecord = {
  /** Stable identifier: <block>-n<N>-<family>-s<seed>. */
  id: string;
  seed: number;
  block: "development" | "acceptance";
  fleetSize: number;
  endpointFamily: EndpointFamily;
  layout: LayoutId;
  mapId: string;
  horizonTicks: number;
  tasksPerRun: number;
  releaseIntervalTicks: number;
  robots: { id: string; model: string; payloadCapacity: number; start: Position; batteryPercent: number }[];
  tasks: { id: string; pickup: Position; dropoff: Position; weightKg: number; priority: number; createdAt: number }[];
  overlap: OverlapAnalysis;
  regime: Regime;
};

const openCells = (map: WarehouseMap): Position[] =>
  map.cells.filter((c) => !c.blocked).map((c) => ({ x: c.position.x, y: c.position.y }));

function endpoints(
  family: EndpointFamily,
  random: () => number,
  cells: Position[],
  map: WarehouseMap,
): { pickup: Position; dropoff: Position } {
  const aisles = aisleRows(map);
  const columns = singleFileColumns(map);
  if (family === "uniform") {
    const a = pick(random, cells);
    const b = pick(random, cells.filter((p) => p.x !== a.x || p.y !== a.y));
    return { pickup: { ...a }, dropoff: { ...b } };
  }
  if (family === "sameAisle") {
    const y = pick(random, aisles);
    const row = cells.filter((c) => c.y === y);
    const a = pick(random, row);
    const b = pick(random, row.filter((p) => p.x !== a.x));
    return { pickup: { ...a }, dropoff: { ...b } };
  }
  if (family === "mirroredCross") {
    // Left half to the mirror point in the right half, on a possibly different
    // aisle. The straight-line x and the independent y force every delivery
    // through the same handful of vertical corridors, in both directions.
    const y1 = pick(random, aisles), y2 = pick(random, aisles);
    const x1 = Math.floor(random() * Math.ceil(MAP_WIDTH / 2));
    return { pickup: { x: x1, y: y1 }, dropoff: { x: MAP_WIDTH - 1 - x1, y: y2 } };
  }
  // columnTransit: two-way traffic inside one corridor that has no passing place.
  const usable = columns.length ? columns : aisles;
  const x = pick(random, usable);
  const y1 = pick(random, aisles);
  const others = aisles.filter((y) => y !== y1);
  return { pickup: { x, y: y1 }, dropoff: { x, y: pick(random, others) } };
}

export function buildScenario(
  seed: number,
  fleetSize: number,
  family: EndpointFamily,
  layout: LayoutId = "stock",
  block: "development" | "acceptance" = "acceptance",
): ScenarioRecord {
  const map = layoutMap(layout);
  const cells = openCells(map);
  const random = scenarioRandom(seed);

  // Fisher-Yates over open cells without replacement, exactly as the frozen v5
  // generator does, so start placement is uniform and seed-reproducible.
  const shuffled = cells.map((p) => ({ ...p }));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Robot identities and capabilities come from the production seed world, so
  // the benchmark exercises the real heterogeneous fleet (Scout 50kg / Addverb
  // 100kg), not a homogeneous invention.
  const templates = createInitialWorld().robots.slice(0, fleetSize);
  const robots = templates.map((r, i) => ({
    id: r.id,
    model: r.model.model,
    payloadCapacity: r.model.payloadCapacity,
    start: { ...shuffled[i] },
    batteryPercent: WORKLOAD.initialBatteryPercent,
  }));

  const tasks = Array.from({ length: WORKLOAD.tasksPerRun }, (_, i) => {
    const { pickup, dropoff } = endpoints(family, random, cells, map);
    return {
      id: `M-${i}`,
      pickup,
      dropoff,
      weightKg: WORKLOAD.taskWeightKg,
      priority: WORKLOAD.taskPriority,
      createdAt: WORKLOAD.firstTaskCreatedAtTick + i * WORKLOAD.releaseIntervalTicks,
    };
  });

  const overlap = analyseOverlap({
    map,
    starts: robots.map((r) => r.start),
    tasks: tasks.map((t) => ({ id: t.id, pickup: t.pickup, dropoff: t.dropoff })),
  });
  const regime = classifyRegime(overlap);

  return {
    id: `${block}-${layout}-n${fleetSize}-${family}-s${seed}`,
    seed,
    block,
    fleetSize,
    endpointFamily: family,
    layout,
    mapId: WORKLOAD.mapId,
    horizonTicks: WORKLOAD.horizonTicks,
    tasksPerRun: WORKLOAD.tasksPerRun,
    releaseIntervalTicks: WORKLOAD.releaseIntervalTicks,
    robots,
    tasks,
    overlap,
    regime,
  };
}

/**
 * Reconstruct the WorldState a given arm must receive. Identical inputs for all
 * arms; the caller deep-clones it per arm.
 */
export function scenarioWorld(record: ScenarioRecord, map: WarehouseMap): WorldState {
  const templates = createInitialWorld().robots.slice(0, record.fleetSize);
  return {
    tick: 0,
    map,
    robots: templates.map((t, i) => ({
      id: t.id,
      position: { ...record.robots[i].start },
      home: { ...record.robots[i].start },
      battery: record.robots[i].batteryPercent,
      status: "idle" as const,
      model: t.model,
      path: [],
      priority: 0,
    })),
    // Only the first task is present at tick 0; the rest are injected at their
    // createdAt tick by the runner, so flowTime = completionTick - createdAt is
    // a real per-task quantity rather than an artefact of a zero release time.
    tasks: [taskObject(record.tasks[0])],
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
}

export function taskObject(t: ScenarioRecord["tasks"][number]): Task {
  return {
    id: t.id,
    pickup: { ...t.pickup },
    dropoff: { ...t.dropoff },
    weight: t.weightKg,
    priority: t.priority,
    createdAt: t.createdAt,
    status: "pending",
  };
}
