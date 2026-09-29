import type { RobotState, Task, WarehouseMap } from "../types";
import type { EdgeConfig } from "../distributed/edge-peer";

/** Two rooms joined by exactly one traversable bridge cell (9,6).
 * Charger stubs at (9,0)/(9,12) connect only to the west room.
 * Opposing pickup-to-dropoff journeys must cross the bridge.
 */
export function edgeChokeScenario(seed: number, policy: EdgeConfig["policy"]) {
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const map: WarehouseMap = { width: 20, height: 13, cells: [] };
  for (let y = 0; y < 13; y++) for (let x = 0; x < 20; x++) map.cells.push({
    position: { x, y }, congestion: 0,
    blocked: x === 9 && ![0,6,12].includes(y) || x === 10 && [0,12].includes(y),
  });
  const y1 = 2 + Math.floor(random()*4), y2 = 7 + Math.floor(random()*4), y3 = 4 + Math.floor(random()*5);
  const positions = [{x:4,y:y1},{x:4,y:y2},{x:14,y:y3}];
  const robots: RobotState[] = positions.map((position,i) => ({
    id: `AMR-0${i+1}`, position, home: position, battery: 100, status: "idle", path: [],
    queuedTaskIds: [], priority: 0, model: { model: "edge-demo", payloadCapacity: 100 },
  }));
  const tasks: Task[] = robots.map((r,i) => ({
    id: `CHOKE-${i+1}`, pickup: r.position, dropoff: {x:i===2?2:17,y:i===0?2:i===1?10:6},
    weight: 1, createdAt: 0, priority: 1, status: "pending",
  }));
  const members = robots.map(r=>r.id);
  const configs: EdgeConfig[] = robots.map((self,i)=>({
    self, members, map, tasks:i===0?tasks:[], motionStartTick:112, policy,
  }));
  return { map, robots, tasks, configs, bridge:{x:9,y:6}, horizon:512 };
}
