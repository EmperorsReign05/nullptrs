// The scenario the brief names: "three robots on deliberately crossing
// paths through a single narrow choke point."
//
// Design note on FAIRNESS. The map is built by BLOCKING cells of the
// existing warehouse, not by inventing a new grid, so both arms of the
// experiment see byte-identical geometry. The only variable is the
// conflict-resolution policy.
//
// Every scenario here is verified by tests/bench.test.ts's audit before
// any measurement is trusted: robots and task endpoints must all sit on
// traversable cells, and the geometry is asserted to genuinely force the
// choke point rather than merely being labelled "choke point".

import { createWarehouseMap, WAREHOUSE_WIDTH, WAREHOUSE_HEIGHT } from "../map/warehouse";
import { ROBOT_MODELS } from "../simulation/robotModels";
import type { Cell, Position, RobotState, Task, WarehouseMap } from "../types";

const key = (p: Position) => `${p.x},${p.y}`;

/** Build a map that is open ONLY on the given cells. */
export function mapFromOpen(open: Position[]): WarehouseMap {
  const keep = new Set(open.map(key));
  const cells: Cell[] = [];
  for (let y = 0; y < WAREHOUSE_HEIGHT; y++) {
    for (let x = 0; x < WAREHOUSE_WIDTH; x++) {
      const base = createWarehouseMap().cells.find((c) => c.position.x === x && c.position.y === y)!;
      cells.push({ ...base, blocked: !keep.has(key({ x, y })) });
    }
  }
  return { width: WAREHOUSE_WIDTH, height: WAREHOUSE_HEIGHT, cells };
}

/** Block every cell not in `open`, on top of the stock shelf layout. */
export function blockedMap(cells: Position[]): WarehouseMap {
  const base = createWarehouseMap();
  const blocked = new Set(cells.map(key));
  const out: Cell[] = [];
  for (let y = 0; y < WAREHOUSE_HEIGHT; y++) {
    for (let x = 0; x < WAREHOUSE_WIDTH; x++) {
      const b = base.cells.find((c) => c.position.x === x && c.position.y === y)!;
      out.push({ ...b, blocked: b.blocked || blocked.has(key({ x, y })) });
    }
  }
  return { width: WAREHOUSE_WIDTH, height: WAREHOUSE_HEIGHT, cells: out };
}

function mkRobot(id: string, position: Position, taskId: string): RobotState {
  return { id, position, home: position, battery: 100, status: "assigned", model: ROBOT_MODELS[0], currentTaskId: taskId, path: [], priority: 0 };
}
function mkTask(id: string, pickup: Position, dropoff: Position, assignedRobotId: string): Task {
  return { id, pickup, dropoff, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId };
}

// ---------------------------------------------------------------------------
// SCENARIO A — the headline demo.
//
// A single-file SPINE runs down column 6. Four ALCOVES open off it (one
// cell each), and there is a holding BAY at the top and bottom. Three
// robots start in opposite alcoves and must each traverse the full length
// of the spine in a different direction.
//
// Because the spine is one cell wide, robots physically cannot pass each
// other on it — the ONLY resolutions available are (a) one uses an alcove
// while the other passes, or (b) they use the end bay. A robot that enters
// the spine from the wrong end immediately blocks the corridor for everyone
// else, which is exactly the failure mode the brief asks us to handle.
//
// This is the "narrow aisle / choke point" case, and it is deliberately
// brutal: stop-and-wait cannot resolve it at all without an alcove to use.
// ---------------------------------------------------------------------------

export const SPINE_X = 6;
export const BAY_TOP: Position = { x: 6, y: 0 };
export const BAY_BOTTOM: Position = { x: 6, y: 12 };
export const ALCOVES: Position[] = [
  { x: 5, y: 2 }, // alcove A (west, upper)
  { x: 7, y: 4 }, // alcove B (east, upper)
  { x: 5, y: 8 }, // alcove C (west, lower)
  { x: 7, y: 10 }, // alcove D (east, lower)
];

function spineMap(): WarehouseMap {
  const open: Position[] = [];
  for (let y = 0; y < WAREHOUSE_HEIGHT; y++) open.push({ x: SPINE_X, y }); // the spine
  for (const a of ALCOVES) open.push(a); // the alcoves
  return mapFromOpen(open);
}

export const CHOKE_BAYS: ReadonlySet<string> = new Set(ALCOVES.map(key));

export function scenarioChokePoint(): { map: WarehouseMap; robots: RobotState[]; tasks: Task[] } {
  const robots = [
    mkRobot("AMR-01", ALCOVES[0], "T1"), // west-upper
    mkRobot("AMR-02", ALCOVES[3], "T2"), // east-lower
    mkRobot("AMR-03", ALCOVES[2], "T3"), // west-lower
  ];
  // NOTE: all three goals are DISTINCT. An earlier version of this scenario
  // sent two tasks to the same bay cell, which deadlocked the second robot
  // against the first for a reason that had nothing to do with conflict
  // resolution (one cell holds one robot) and would have made the benchmark
  // look like an algorithmic failure. T3 crosses the full width of the map,
  // west alcove to east alcove, so all three paths still have to share the
  // single-file spine.
  const tasks = [
    mkTask("T1", ALCOVES[0], BAY_BOTTOM, "AMR-01"),
    mkTask("T2", ALCOVES[3], BAY_TOP, "AMR-02"),
    mkTask("T3", ALCOVES[2], ALCOVES[1], "AMR-03"),
  ];
  return { map: spineMap(), robots, tasks };
}

export const T_BAYS: ReadonlySet<string> = new Set(["9,5", "9,7", "8,6", "10,6"]);

// ---------------------------------------------------------------------------
// SCENARIO B — a T-junction with a throat and holding bays.
// ---------------------------------------------------------------------------

export function scenarioTJunction(): { map: WarehouseMap; robots: RobotState[]; tasks: Task[] } {
  const open: Position[] = [];
  for (let x = 2; x <= 17; x++) open.push({ x, y: 6 }); // horizontal bar
  for (let y = 2; y <= 10; y++) open.push({ x: 9, y }); // vertical stem
  // Holding bays flanking the throat so a yielding robot has somewhere legal to go.
  for (const p of [{ x: 8, y: 6 }, { x: 10, y: 6 }, { x: 9, y: 5 }, { x: 9, y: 7 }]) open.push(p);
  return mapFromOpen(open).width
    ? {
        map: mapFromOpen(open),
        robots: [
          mkRobot("AMR-01", { x: 2, y: 6 }, "T1"),
          mkRobot("AMR-02", { x: 17, y: 6 }, "T2"),
          mkRobot("AMR-03", { x: 9, y: 2 }, "T3"),
        ],
        tasks: [
          mkTask("T1", { x: 2, y: 6 }, { x: 17, y: 6 }, "AMR-01"),
          mkTask("T2", { x: 17, y: 6 }, { x: 2, y: 6 }, "AMR-02"),
          mkTask("T3", { x: 9, y: 2 }, { x: 9, y: 10 }, "AMR-03"),
        ],
        // distinct goals, bays at the throat
      }
    : ({} as never);
}

// ---------------------------------------------------------------------------
// SCENARIO C — open floor, heavy crossing traffic, no choke point. Isolates
// raw conflict-resolution throughput from geometry effects.
// ---------------------------------------------------------------------------

export function scenarioOpenFloor(): { map: WarehouseMap; robots: RobotState[]; tasks: Task[] } {
  const open: Position[] = [];
  // Perimeter corridor.
  for (let x = 1; x <= 18; x++) { open.push({ x, y: 1 }); open.push({ x, y: 11 }); }
  for (let y = 1; y <= 11; y++) { open.push({ x: 1, y }); open.push({ x: 18, y }); }
  // A few interior crossings so paths genuinely intersect.
  for (let x = 4; x <= 15; x += 5) for (let y = 2; y <= 10; y++) open.push({ x, y });
  for (let y = 3; y <= 9; y += 3) for (let x = 2; x <= 17; x++) open.push({ x, y });

  const starts: Position[] = [
    { x: 1, y: 1 }, { x: 18, y: 1 }, { x: 1, y: 11 }, { x: 18, y: 11 }, { x: 10, y: 1 }, { x: 10, y: 11 },
  ];
  const goals: Position[] = [
    { x: 18, y: 11 }, { x: 1, y: 11 }, { x: 18, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 6 }, { x: 18, y: 6 },
  ];
  return {
    map: mapFromOpen(open),
    robots: starts.map((p, i) => mkRobot(`AMR-0${i + 1}`, p, `T${i + 1}`)),
    tasks: starts.map((p, i) => mkTask(`T${i + 1}`, p, goals[i], `AMR-0${i + 1}`)),
  };
}
