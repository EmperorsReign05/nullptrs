import type { RobotState, Task, WarehouseMap } from "../types";
import type { EdgeConfig } from "../distributed/edge-peer";
import { loadFleetConfig, mapHeightFor, type FleetRobot } from "../fleet/config";

/** Two rooms joined by exactly one traversable bridge cell (9,6).
 * Charger stubs at (9,0)/(9,12) connect only to the west room.
 * Opposing pickup-to-dropoff journeys must cross the bridge.
 *
 * `fleetSize` generalises the fixture to N robots. At N=3 the generated world is
 * byte-identical to the original three-robot fixture, so frozen evidence that
 * used it stays reproducible. Extra robots extend the map along the origin pitch
 * and join the same two opposing flows.
 */
export function edgeChokeScenario(
  seed: number,
  policy: EdgeConfig["policy"],
  fleetSize = 3,
  roster?: FleetRobot[],
) {
  if (!Number.isInteger(fleetSize) || fleetSize < 1) {
    throw new Error(`fleetSize must be a positive integer, got ${fleetSize}`);
  }
  const members = roster ?? loadFleetConfig().robots;
  if (members.length < fleetSize) {
    throw new Error(
      `Fleet config declares ${members.length} robots but the scenario needs ${fleetSize}. ` +
        `Run: npm run fleet:n -- --robots ${fleetSize}`,
    );
  }
  const fleet = members.slice(0, fleetSize);

  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const height = mapHeightFor(fleetSize);
  const map: WarehouseMap = { width: 20, height, cells: [] };
  for (let y = 0; y < height; y++) for (let x = 0; x < 20; x++) map.cells.push({
    position: { x, y }, congestion: 0,
    blocked: x === 9 && ![0, 6, 12].includes(y) || x === 10 && [0, 12].includes(y),
  });

  // West column hosts the eastbound flow, east column the westbound return.
  // Draws happen in index order so the N=3 seed stream is unchanged.
  const taken = new Set<string>();
  const place = (x: number, y: number) => {
    taken.add(`${x},${y}`);
    return { x, y };
  };
  const free = (x: number, from: number) => {
    for (let y = from; ; y++) if (!taken.has(`${x},${y}`) && y < height) return y;
  };
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < fleetSize; i++) {
    if (i === 0) positions.push(place(4, 2 + Math.floor(random() * 4)));
    else if (i === 1) positions.push(place(4, 7 + Math.floor(random() * 4)));
    else if (i === 2) positions.push(place(14, 4 + Math.floor(random() * 5)));
    else positions.push(place(i % 2 === 0 ? 14 : 4, free(i % 2 === 0 ? 14 : 4, 2)));
  }

  const robots: RobotState[] = positions.map((position, i) => ({
    id: fleet[i].id, position, home: position, battery: 100, status: "idle", path: [],
    queuedTaskIds: [], priority: 0, model: { model: "edge-demo", payloadCapacity: 100 },
  }));
  const tasks: Task[] = robots.map((r, i) => ({
    id: `CHOKE-${i + 1}`, pickup: r.position,
    dropoff: i < 2 ? { x: 17, y: i === 0 ? 2 : 10 } : { x: 2, y: 6 + (i - 2) * 2 },
    weight: 1, createdAt: 0, priority: 1, status: "pending",
  }));
  const memberIds = robots.map((r) => r.id);
  const configs: EdgeConfig[] = robots.map((self, i) => ({
    self, members: memberIds, map, tasks: i === 0 ? tasks : [], motionStartTick: 112, policy,
  }));
  return { map, robots, tasks, configs, bridge: { x: 9, y: 6 }, horizon: 512 + 128 * Math.max(0, fleetSize - 3) };
}
