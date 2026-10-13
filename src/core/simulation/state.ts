import type { RobotState, Task, WorldState } from "../types";
import { computeCongestion, createWarehouseMap } from "../map/warehouse";
import { ADDVERB_DYNAMO_100, SCOUT_AGILE_2 } from "./robotModels";

// Mock seed data — replace with real fleet/task sourcing when available.
// Robots start with an empty path and an "assigned"/"idle" status; the
// simulation engine's own replanning pass (see engine.ts) plans their first
// A* route on tick 1, so no pathfinding logic needs to live here.
const BASE_PRIORITY = 0;

function createInitialRobots(): RobotState[] {
  return [
    // AMR-01..03 keep their original positions/tasks/battery — the two
    // seeded tasks (T-102, T-103) are still assigned to AMR-02/AMR-03.
    {
      id: "AMR-01",
      position: { x: 1, y: 0 },
      home: { x: 1, y: 0 },
      battery: 87,
      status: "idle",
      model: SCOUT_AGILE_2,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-02",
      position: { x: 10, y: 4 },
      home: { x: 14, y: 0 },
      battery: 62,
      status: "assigned",
      model: ADDVERB_DYNAMO_100,
      currentTaskId: "T-102",
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-03",
      position: { x: 6, y: 8 },
      home: { x: 1, y: 0 },
      battery: 91,
      status: "assigned",
      model: SCOUT_AGILE_2,
      currentTaskId: "T-103",
      path: [],
      priority: BASE_PRIORITY,
    },
    // AMR-04..10: idle, unassigned, spread across open aisle columns —
    // fresh members of the fleet ready to bid once tasks come in. Brings
    // the fleet to 10 total: 5 Scout Agile 2.0, 5 Addverb Dynamo 100.
    {
      id: "AMR-04",
      position: { x: 3, y: 2 },
      home: { x: 3, y: 2 },
      battery: 95,
      status: "idle",
      model: ADDVERB_DYNAMO_100,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-05",
      position: { x: 3, y: 10 },
      home: { x: 3, y: 10 },
      battery: 88,
      status: "idle",
      model: SCOUT_AGILE_2,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-06",
      position: { x: 9, y: 2 },
      home: { x: 9, y: 2 },
      battery: 100,
      status: "idle",
      model: ADDVERB_DYNAMO_100,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-07",
      position: { x: 9, y: 10 },
      home: { x: 9, y: 10 },
      battery: 92,
      status: "idle",
      model: SCOUT_AGILE_2,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-08",
      position: { x: 12, y: 2 },
      home: { x: 12, y: 2 },
      battery: 97,
      status: "idle",
      model: ADDVERB_DYNAMO_100,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-09",
      position: { x: 13, y: 10 },
      home: { x: 13, y: 10 },
      battery: 84,
      status: "idle",
      model: SCOUT_AGILE_2,
      path: [],
      priority: BASE_PRIORITY,
    },
    {
      id: "AMR-10",
      position: { x: 17, y: 4 },
      home: { x: 17, y: 4 },
      battery: 90,
      status: "idle",
      model: ADDVERB_DYNAMO_100,
      path: [],
      priority: BASE_PRIORITY,
    },
  ];
}

/**
 * AMR-11..20, for fleets larger than the seeded ten.
 *
 * Kept out of createInitialWorld on purpose: the central simulator, the SIH
 * benchmark scenario and dozens of measured tests are defined against the
 * seeded ten, and growing that world would silently change their results.
 * Only the dashboard fleet harness, which lets an operator pick 1..20, uses the
 * full roster.
 *
 * Starts are spread over areas the first ten leave empty (the left column, the
 * right-hand aisles, the middle and bottom rows). None is a station, an
 * order-book pickup or dropoff, or a block-aisle cell, and every one is open in
 * the stock layout, so it stays open in every shelf layout (removing racks only
 * unblocks cells). Models alternate, giving ten of each across the twenty.
 */
function createAdditionalRobots(): RobotState[] {
  return [
    { id: "AMR-11", position: { x: 0, y: 2 }, home: { x: 0, y: 2 }, battery: 93, status: "idle", model: SCOUT_AGILE_2, path: [], priority: BASE_PRIORITY },
    { id: "AMR-12", position: { x: 17, y: 2 }, home: { x: 17, y: 2 }, battery: 81, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: BASE_PRIORITY },
    { id: "AMR-13", position: { x: 14, y: 6 }, home: { x: 14, y: 6 }, battery: 99, status: "idle", model: SCOUT_AGILE_2, path: [], priority: BASE_PRIORITY },
    { id: "AMR-14", position: { x: 2, y: 6 }, home: { x: 2, y: 6 }, battery: 86, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: BASE_PRIORITY },
    { id: "AMR-15", position: { x: 6, y: 11 }, home: { x: 6, y: 11 }, battery: 90, status: "idle", model: SCOUT_AGILE_2, path: [], priority: BASE_PRIORITY },
    { id: "AMR-16", position: { x: 17, y: 10 }, home: { x: 17, y: 10 }, battery: 77, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: BASE_PRIORITY },
    { id: "AMR-17", position: { x: 15, y: 8 }, home: { x: 15, y: 8 }, battery: 96, status: "idle", model: SCOUT_AGILE_2, path: [], priority: BASE_PRIORITY },
    { id: "AMR-18", position: { x: 4, y: 4 }, home: { x: 4, y: 4 }, battery: 88, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: BASE_PRIORITY },
    { id: "AMR-19", position: { x: 14, y: 12 }, home: { x: 14, y: 12 }, battery: 83, status: "idle", model: SCOUT_AGILE_2, path: [], priority: BASE_PRIORITY },
    { id: "AMR-20", position: { x: 19, y: 4 }, home: { x: 19, y: 4 }, battery: 94, status: "idle", model: ADDVERB_DYNAMO_100, path: [], priority: BASE_PRIORITY },
  ];
}

/** The full twenty-robot roster: the seeded ten, then AMR-11..20. */
export function createFleetRoster(): RobotState[] {
  return [...createInitialRobots(), ...createAdditionalRobots()];
}

function createInitialTasks(): Task[] {
  return [
    {
      id: "T-102",
      pickup: { x: 3, y: 9 },
      dropoff: { x: 9, y: 1 },
      weight: 15,
      createdAt: 0,
      priority: 1,
      status: "assigned",
      assignedRobotId: "AMR-02",
    },
    {
      id: "T-103",
      pickup: { x: 9, y: 9 },
      dropoff: { x: 13, y: 1 },
      weight: 30,
      createdAt: 1,
      priority: 1,
      status: "assigned",
      assignedRobotId: "AMR-03",
    },
    {
      id: "T-104",
      pickup: { x: 9, y: 5 },
      dropoff: { x: 1, y: 5 },
      // Heavier than Scout Agile 2.0's 50kg capacity on purpose — only an
      // Addverb Dynamo 100 can bid on this one, exercising the payload
      // eligibility gate even in the default seeded world.
      weight: 60,
      createdAt: 2,
      priority: 1,
      status: "pending",
    },
  ];
}

export function createInitialWorld(): WorldState {
  const robots = createInitialRobots();
  const map = computeCongestion(createWarehouseMap(), robots);

  return {
    tick: 0,
    map,
    robots,
    tasks: createInitialTasks(),
    metrics: {
      replans: 0,
      conflictCount: 0,
      waitMoves: 0,
      inheritedPriorities: 0,
      backtracks: 0,
    },
  };
}
