import type { Cell, Position, RobotState, WarehouseMap } from "../types";

// Single source of truth for the warehouse layout. The dashboard and every
// algorithm (auction, A*, PIBT) must read the layout from here — never
// hardcode grid geometry anywhere else.
//
// Invariant: a cell blocked here must be blocked for A* too, and vice versa.

export const WAREHOUSE_WIDTH = 20;
export const WAREHOUSE_HEIGHT = 13;

// Shelf rack rectangles: [x, y, width, height] in grid cells. Every cell
// inside one of these rectangles is blocked (not traversable).
export type ShelfBlock = readonly [x: number, y: number, w: number, h: number];

export const SHELF_BLOCKS: ShelfBlock[] = [
  // Col 1 (x=1,2)
  [1, 1, 2, 3],
  [1, 9, 2, 3],
  // Col 2 (x=4,5)
  [4, 1, 2, 3],
  [4, 5, 2, 3],
  [4, 9, 2, 3],
  // Col 3 (x=7,8)
  [7, 1, 2, 3],
  [7, 5, 2, 3],
  [7, 9, 2, 3],
  // Col 4 (x=10,11)
  [10, 1, 2, 3],
  [10, 5, 2, 3],
  [10, 9, 2, 3],
  // Col 5 (x=15,16)
  [15, 1, 2, 3],
  [15, 5, 2, 3],
  [15, 9, 2, 3],
  // Col 6 (x=18,19)
  [18, 1, 2, 3],
  [18, 5, 2, 3],
  [18, 9, 2, 3],
];

export type NamedLocation = {
  id: string;
  position: Position;
};

// Named locations are display/reference metadata layered on top of the grid.
// They do not block movement by themselves.
export const PICKUP_STATIONS: NamedLocation[] = [
  { id: "P1", position: { x: 1, y: 0 } },
  { id: "P2", position: { x: 14, y: 0 } },
];

export const DROPOFF_STATIONS: NamedLocation[] = [
  { id: "D1", position: { x: 6, y: 12 } },
  { id: "D2", position: { x: 17, y: 12 } },
];

// Where a robot goes when its battery gives out — see
// src/core/simulation/robotModels.ts's needsToCharge and
// src/core/simulation/engine.ts's charging state machine. No reservation
// system: multiple robots can be routed toward the same station, and PIBT
// alone decides who actually occupies it moment to moment.
//
// Four, not two: an instrumented 30-robot stress run against a 2-station
// map showed the fleet spending ~97% of ticks with someone stuck charging
// and a robot that started charging staying in that status for ~5500 of
// 6000 ticks on average — two single-cell stations is a real bottleneck
// once fleet size grows past a handful of robots, not just slow. Going to
// four cut that per-visit stall by more than half (~2200 ticks) and
// raised completed tasks under the same load by ~25%. Placed for spread
// (two corners, two mid-map) rather than clustering, so PIBT congestion at
// any one station doesn't back the others up too.
export const CHARGING_STATIONS: NamedLocation[] = [
  { id: "C1", position: { x: 0, y: 4 } },
  { id: "C2", position: { x: 19, y: 8 } },
  { id: "C3", position: { x: 9, y: 0 } },
  { id: "C4", position: { x: 9, y: 12 } },
];

export type WaitingZone = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const WAITING_ZONES: WaitingZone[] = [
  { id: "W1", x: 1, y: 5, width: 2, height: 3 },
  { id: "W2", x: 12, y: 5, width: 2, height: 3 },
  { id: "W3", x: 12, y: 9, width: 2, height: 3 },
];

/**
 * The cells a robot may occupy to step aside and let another pass, as a set
 * of "x,y" keys ready for direct lookup by the PIBT step-aside rule (see
 * src/core/pathfinding/pibt.ts's PibtOptions).
 *
 * Derived from WAITING_ZONES, which until now were read ONLY by the
 * dashboard's renderer — src/core never referenced them, so the zones were
 * decoration. Making them the engine's designated passing bays is what turns
 * a blocked robot from "sits in the aisle forever" into "steps aside and
 * lets the other one through".
 */
export const WAITING_ZONE_CELLS: ReadonlySet<string> = new Set(
  WAITING_ZONES.flatMap((z) => {
    const cells: string[] = [];
    for (let dx = 0; dx < z.width; dx++) {
      for (let dy = 0; dy < z.height; dy++) cells.push(`${z.x + dx},${z.y + dy}`);
    }
    return cells;
  })
);

export const INTERSECTIONS: Position[] = [
  { x: 6, y: 4 },
  { x: 6, y: 8 },
  { x: 13, y: 4 },
  { x: 13, y: 8 },
];

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function buildBlockedSet(): Set<string> {
  const blocked = new Set<string>();
  for (const [bx, by, bw, bh] of SHELF_BLOCKS) {
    for (let dx = 0; dx < bw; dx++) {
      for (let dy = 0; dy < bh; dy++) {
        blocked.add(key(bx + dx, by + dy));
      }
    }
  }
  return blocked;
}

const BLOCKED_CELLS = buildBlockedSet();

function buildCells(): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < WAREHOUSE_HEIGHT; y++) {
    for (let x = 0; x < WAREHOUSE_WIDTH; x++) {
      cells.push({
        position: { x, y },
        blocked: BLOCKED_CELLS.has(key(x, y)),
        congestion: 0,
      });
    }
  }
  return cells;
}

// Creates a fresh WarehouseMap instance (fresh cells array, so callers can
// mutate congestion per-tick without aliasing shared state).
//
// `extraOpen` un-blocks specific cells that are shelves in the stock layout.
// Needed by the distributed worker, whose demo spine has passing bays at
// cells the warehouse shelves (5,3), (7,3) and so on. Without it a declared
// bay is untraversable and the step-aside rule silently never fires — which
// is exactly the failure this parameter exists to prevent, so the worker
// asserts every declared bay is open and exits non-zero if not.
export function createWarehouseMap(extraOpen: ReadonlySet<string> = new Set()): WarehouseMap {
  const cells = buildCells();
  if (extraOpen.size > 0) {
    for (const cell of cells) {
      if (!extraOpen.has(`${cell.position.x},${cell.position.y}`)) continue;
      cell.blocked = false;
    }
  }
  return {
    width: WAREHOUSE_WIDTH,
    height: WAREHOUSE_HEIGHT,
    cells,
  };
}

export function isInsideMap(position: Position, map: WarehouseMap): boolean {
  return (
    position.x >= 0 &&
    position.x < map.width &&
    position.y >= 0 &&
    position.y < map.height
  );
}

export function getCellIndex(map: WarehouseMap, position: Position): number {
  return position.y * map.width + position.x;
}

export function getCell(map: WarehouseMap, position: Position): Cell | undefined {
  if (!isInsideMap(position, map)) return undefined;
  return map.cells[getCellIndex(map, position)];
}

export function isBlocked(position: Position, map: WarehouseMap): boolean {
  const cell = getCell(map, position);
  // Outside the map counts as blocked — nothing traverses off-grid.
  return cell ? cell.blocked : true;
}

export function isTraversable(position: Position, map: WarehouseMap): boolean {
  return isInsideMap(position, map) && !isBlocked(position, map);
}

// Congestion is derived purely from CURRENT robot occupancy — never from
// predicted/future intent. Definition:
//   - a cell a robot currently occupies gets CONGESTION_OCCUPIED_WEIGHT
//   - each orthogonal neighbor of an occupied cell gets
//     CONGESTION_NEIGHBOR_WEIGHT of "local pressure" radiated onto it
//   - multiple robots contribute additively (a busy junction with several
//     robots nearby reads as more congested than one robot alone)
//
// Recomputed from scratch each call (not cumulative across ticks), so it
// stays deterministic for a given set of robot positions regardless of
// simulation history.
export const CONGESTION_OCCUPIED_WEIGHT = 3;
export const CONGESTION_NEIGHBOR_WEIGHT = 1;

const CONGESTION_NEIGHBOR_OFFSETS: Position[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

export function computeCongestion(map: WarehouseMap, robots: RobotState[]): WarehouseMap {
  const pressure = new Map<string, number>();

  const addPressure = (x: number, y: number, amount: number) => {
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return;
    const k = key(x, y);
    pressure.set(k, (pressure.get(k) ?? 0) + amount);
  };

  for (const robot of robots) {
    addPressure(robot.position.x, robot.position.y, CONGESTION_OCCUPIED_WEIGHT);
    for (const offset of CONGESTION_NEIGHBOR_OFFSETS) {
      addPressure(
        robot.position.x + offset.x,
        robot.position.y + offset.y,
        CONGESTION_NEIGHBOR_WEIGHT
      );
    }
  }

  return {
    ...map,
    cells: map.cells.map((cell) => ({
      ...cell,
      congestion: pressure.get(key(cell.position.x, cell.position.y)) ?? 0,
    })),
  };
}
