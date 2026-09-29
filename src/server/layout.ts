// Warehouse layout variants, so the "shelves" control does something real.
//
// The stock map (createWarehouseMap) is six two-cell rack columns at fixed
// positions, which leaves eight traversable columns of varying width. A slider
// claiming to change the number of shelves therefore has to GENERATE layouts.
//
// THE FIRST IMPLEMENTATION WAS A DISHONESTY, AND A TEST CAUGHT IT.
// It "removed" a shelf column by WALLING OFF the traversable aisle beside it,
// which widens nothing: the rack rectangles are a fixed constant, so closing a
// corridor column simply deletes a route and shrinks the warehouse from 158 open
// cells to 145. Fewer shelves, LESS room, while the control promised more passing
// capacity. The label and the effect pointed in opposite directions, which is the
// worst possible combination in front of a jury.
//
// This version does the honest thing: fewer shelf columns means fewer racks, and
// removing a rack means UNBLOCKING its cells. Open floor goes up, aisles genuinely
// widen, and the conflict-resolution layer has measurably more room to work with.
// The two sanity directions are asserted in tests/demo-harness.test.ts.

import { SHELF_BLOCKS, createWarehouseMap } from "../core/map/warehouse";
import type { WarehouseMap } from "../core/types";

export const MAX_SHELF_COLUMNS = 6;
export const MIN_SHELF_COLUMNS = 0;

/**
 * Rack column positions, derived from the layout's own SHELF_BLOCKS rather than
 * re-typed here.
 *
 * An earlier version of this file carried a hand-copied list of the twelve rack
 * rectangles and it was already wrong: the stock layout has seventeen, and the
 * five it omitted are the middle-row racks. The symptom was a "0 shelf columns"
 * layout that was still 20% blocked, which is precisely the class of bug
 * src/core/map/warehouse.ts opens by forbidding hardcoded grid geometry
 * anywhere else. Deriving the columns from the exported constant makes the drift
 * impossible rather than merely unlikely.
 */
const RACK_X: number[] = [...new Set(SHELF_BLOCKS.map(([x]) => x))].sort((a, b) => a - b);

/** Every column covered by a removed rack, honouring each rack's own width. */
function columnsOfRemovedRacks(removedRackX: ReadonlySet<number>): Set<number> {
  const columns = new Set<number>();
  for (const [x, , w] of SHELF_BLOCKS) {
    if (!removedRackX.has(x)) continue;
    for (let dx = 0; dx < w; dx++) columns.add(x + dx);
  }
  return columns;
}

export function clampShelfColumns(count: number): number {
  if (!Number.isFinite(count)) return MAX_SHELF_COLUMNS;
  return Math.max(MIN_SHELF_COLUMNS, Math.min(MAX_SHELF_COLUMNS, Math.floor(count)));
}

/**
 * A warehouse with `shelfColumns` rack columns.
 *
 * The rightmost racks are removed first, so lowering the count opens up the middle
 * of the floor rather than amputating one edge. Their cells become traversable, so
 * the open area and the passing capacity both grow monotonically as the count
 * falls.
 */
export function layoutWithShelfColumns(map: WarehouseMap, shelfColumns: number): WarehouseMap {
  const clamped = clampShelfColumns(shelfColumns);
  if (clamped === MAX_SHELF_COLUMNS) return { ...map };
  // RACK_X is ascending, so slicing the tail removes the rightmost racks.
  const removedRackX = new Set(RACK_X.slice(clamped));
  if (!removedRackX.size) return { ...map };
  const columns = columnsOfRemovedRacks(removedRackX);
  return {
    ...map,
    cells: map.cells.map((cell) => (columns.has(cell.position.x) ? { ...cell, blocked: false } : cell)),
  };
}

/**
 * Passing capacity: the fraction of the floor a robot can stand on.
 *
 * This has taken two wrong shapes already and both are worth recording.
 *   - A vertical run per column. That is 13 in EVERY layout, because every
 *     corridor column spans the full height of the map, so the number never moved
 *     and reported nothing at all.
 *   - A horizontal run per row. That is 20 in every layout, because the top and
 *     bottom rows are always open end to end. Also useless.
 * The quantity the control genuinely changes is how much of the floor is not a
 * rack, and that is monotone by construction: removing a rack unblocks its cells.
 */
export function passingCapacity(map: WarehouseMap): number {
  const open = map.cells.filter((cell) => !cell.blocked).length;
  return map.cells.length === 0 ? 0 : open / map.cells.length;
}

/** The stock layout, for callers that want the default without the import dance. */
export const stockLayout = (): WarehouseMap => createWarehouseMap();
