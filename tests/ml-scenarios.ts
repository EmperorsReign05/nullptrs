import { mapFromOpen } from "../src/core/bench/scenarios";
import { ROBOT_MODELS } from "../src/core/simulation/robotModels";
import type { Position, RobotState, Task, WarehouseMap } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

export const ALL_BAYS: ReadonlySet<string> = new Set(["5,2", "7,4", "5,8", "7,10", "5,5", "7,6"]);

/**
 * A grid of `width`-wide corridors.
 *
 * The earlier version used the stock 20x13 map, where a width-1 lattice
 * blocks only cells where BOTH x and y are even — leaving mostly-open
 * floor. Robots simply walked around each other, contention was ~0%, and
 * the deadlock label was positive on 0% of ticks, so the model had nothing
 * to learn. The fix is not a different formula, it is a SMALLER map: fewer
 * corridors means robots are forced to share them.
 *
 * Open iff the cell lies in a vertical corridor OR a horizontal one.
 */
function lattice(width: number, side = 9): WarehouseMap {
  const open: Position[] = [];
  const period = width + 1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const inWallColumn = x % period === width;
      const inWallRow = y % period === width;
      if (!(inWallColumn && inWallRow)) open.push({ x, y });
    }
  }
  return mapFromOpen(open);
}

export function latticeScenario(width: number, n: number, seed: number, side = 9) {
  const map = lattice(width, side);
  const open = map.cells.filter((c) => !c.blocked).map((c) => c.position);
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const sh = [...open];
  for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
  const used = new Set<string>(); const starts: Position[] = [];
  for (const c of sh) { if (used.has(key(c))) continue; used.add(key(c)); starts.push(c); if (starts.length >= n * 2) break; }
  const robots: RobotState[] = []; const tasks: Task[] = []; const taken = new Set<string>();
  for (let i = 0; i < n; i++) {
    const s = starts[i];
    let best: Position | null = null; let bd = -1;
    for (const c of starts.slice(n)) { if (taken.has(key(c))) continue; const d = Math.abs(c.x - s.x) + Math.abs(c.y - s.y); if (d > bd) { bd = d; best = c; } }
    if (!best) best = { x: s.x, y: s.y };
    taken.add(key(best));
    const id = "AMR-" + String(i + 1).padStart(2, "0");
    robots.push({ id, position: { ...s }, home: { ...s }, battery: 100, status: "assigned", model: ROBOT_MODELS[0], currentTaskId: "T" + (i + 1), path: [], priority: 0 });
    tasks.push({ id: "T" + (i + 1), pickup: { ...s }, dropoff: { ...(best as Position) }, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: id });
  }
  return { map, robots, tasks };
}

/**
 * A single-file spine with robots that MUST pass head-on.
 *
 * The lattice grid produced convoy behaviour — robots follow each other and
 * forward motion is never blocked, so `intentOccupied` was 0% and the
 * deadlock label fired on 0% of ticks. Real contention requires opposing
 * directions on the same corridor, which is exactly the choke-point case
 * already proven to deadlock the stop-and-wait baseline (0/3 forever).
 */
export function headOnScenario(n: number, seed: number) {
  const spineX = 6;
  const open: Position[] = [];
  for (let y = 0; y < 13; y++) open.push({ x: spineX, y });
  // Alcove/bay cells: some scenarios enable them, some do not.
  const bays: Position[] = [{ x: 5, y: 2 }, { x: 7, y: 4 }, { x: 5, y: 8 }, { x: 7, y: 10 }];
  for (const b of bays) open.push(b);
  const map = mapFromOpen(open);

  if (n < 2 || n > 8) throw new Error("head-on fleet must contain 2–8 robots");
  // Seed changes actual geometry of the encounter, not just a sample ID.
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = (rows: number[]) => {
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows;
  };
  const top = shuffle([0, 1, 2, 3, 4]);
  const bottom = shuffle([8, 9, 10, 11, 12]);
  const robots: RobotState[] = [];
  const tasks: Task[] = [];
  for (let i = 0; i < n; i++) {
    const startRow = i % 2 === 0 ? top[Math.floor(i / 2)] : bottom[Math.floor(i / 2)];
    const start: Position = { x: spineX, y: startRow };
    // Reflection gives distinct goals on the opposite side for every robot.
    const end: Position = { x: spineX, y: 12 - startRow };
    const id = "AMR-" + String(i + 1).padStart(2, "0");
    robots.push({ id, position: { ...start }, home: { ...start }, battery: 100, status: "assigned", model: ROBOT_MODELS[0], currentTaskId: "T" + (i + 1), path: [], priority: 0 });
    tasks.push({ id: "T" + (i + 1), pickup: { ...start }, dropoff: { ...end }, weight: 10, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: id });
  }
  return { map, robots, tasks };
}
