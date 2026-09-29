// CLI entry point for ONE agent as ONE OS process.
//
//   node --experimental-strip-types worker.js --id=AMR-01 --port=5001 \
//        --peers=5001,5002,5003 --x=0 --y=1 --pickup=0,1 --dropoff=6,12
//
// There is no server to connect to and no process that knows about the
// others. Each agent opens its own socket and broadcasts to the peer port
// list. Run N of these and you have a decentralised fleet.
//
// The simulation clock is local: each agent advances its own tick counter
// at a fixed wall-clock period. No agent is synchronised to any other
// beyond the datagrams they exchange.

import { createWarehouseMap, WAITING_ZONES, isTraversable } from "../map/warehouse";
import { computeCongestion } from "../map/warehouse";
import { planPath } from "../pathfinding/astar";
import { positionsEqual } from "../map/graph";
import { Agent } from "./agent";
import { UdpTransport } from "./transport";
import { DEFAULT_COMM_RANGE, type LocalState } from "./protocol";
import type { Position, RobotState, Task, WorldState } from "../types";

function arg(name: string, fallback = ""): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function parsePos(s: string): Position {
  const [x, y] = s.split(",").map(Number);
  return { x, y };
}

async function main() {
  const id = arg("id", "AMR-01");
  const port = Number(arg("port", "5001"));
  const peerList = arg("peers", String(port)).split(",").map(Number);
  const periodMs = Number(arg("period", "100"));
  const commRange = Number(arg("range", String(DEFAULT_COMM_RANGE)));

  const peers: Record<string, number> = {};
  const ids = arg("ids", "AMR-01,AMR-02,AMR-03").split(",");
  ids.forEach((pid, i) => {
    if (pid !== id) peers[pid] = peerList[i] ?? peerList[0];
  });

  const position = parsePos(arg("pos", "0,0"));
  const pickup = parsePos(arg("pickup", arg("pos", "0,0")));
  const dropoff = parsePos(arg("dropoff", arg("pos", "0,0")));

  // The demo spine and its passing bays are supplied as an explicit cell
  // list rather than taken from the stock warehouse: the stock layout has
  // shelves at (5,3) and (7,3), so bays declared there would be untraversable
  // and the step-aside rule would silently never fire. Verified by the
  // worker asserting every declared bay is actually open.
  if (process.env.DEBUG_ARGS) console.error(`worker argv=${JSON.stringify(process.argv.slice(2))} bays=${JSON.stringify(arg("bays", ""))}`);
  // Semicolon-separated: each entry is itself an "x,y" pair, so a comma
  // cannot double as the list separator.
  const declaredBays = arg("bays", "").split(";").filter(Boolean);
  const extraOpen = new Set(declaredBays);
  const map = createWarehouseMap(extraOpen);
  const transport = new UdpTransport(id, port, peers);
  await transport.bind();

  const local: LocalState = { id, position, path: [], priority: 0, docked: false, seq: 0 };
  // Bays are derived from the static map, which is a public constant every
  // agent already holds — no negotiation required.
  const bayCells = new Set<string>();
  for (const z of WAITING_ZONES) {
    for (let dx = 0; dx < z.width; dx++) for (let dy = 0; dy < z.height; dy++) bayCells.add(`${z.x + dx},${z.y + dy}`);
  }
  for (const c of declaredBays) bayCells.add(c);
  for (const c of declaredBays) {
    const parts = c.split(",");
    if (parts.length !== 2 || parts.some((v) => !Number.isInteger(Number(v)))) {
      console.error(`worker: malformed bay "${c}" (expected "x,y")`);
      process.exit(2);
    }
    const [bx, by] = parts.map(Number);
    if (!isTraversable({ x: bx, y: by }, map)) {
      // Fail loudly rather than ship a step-aside rule that can never fire.
      console.error(`worker: declared bay ${c} is not traversable in this map`);
      process.exit(2);
    }
  }
  const agent = new Agent(id, local, map, transport, commRange, bayCells);

  const robot: RobotState = {
    id, position, home: position, battery: 100, status: "assigned",
    model: { model: "worker", payloadCapacity: 100 },
    currentTaskId: `${id}-T`, path: [], priority: 0,
  };
  const task: Task = {
    id: `${id}-T`, pickup, dropoff, weight: 10, createdAt: 0,
    priority: 1, status: "assigned", assignedRobotId: id,
  };

  let tick = 0;
  let lastGoal: Position | null = null;

  const report = (extra: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify({ id, tick, position: agent.getLocal().position, ...extra }) + "\n");
  };

  const timer = setInterval(() => {
    const t0 = process.hrtime.bigint();
    const goal = task.status === "in_progress" ? dropoff : pickup;

    // Re-plan our own route. Congestion comes from what we can hear, not a
    // global field.
    const peerPositions = agent.getPeers().map((p) => p.position);
    const observedRobots: RobotState[] = [
      { ...robot, position: agent.getLocal().position },
      ...peerPositions.map((p, i) => ({ ...robot, id: `p${i}`, position: p })),
    ];
    const world: WorldState = {
      tick,
      map: computeCongestion(map, observedRobots),
      robots: [{ ...robot, position: agent.getLocal().position }],
      tasks: [],
      metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    };

    const l = agent.getLocal();
    const goalChanged = !lastGoal || !positionsEqual(lastGoal, goal);
    if (goalChanged || l.path.length === 0) {
      const res = planPath(l.position, goal, world);
      agent.updateLocal({ ...l, path: res.found ? res.path : [] });
      lastGoal = goal;
    }

    const decision = agent.decide(tick);
    agent.tick(tick);

    if (!positionsEqual(decision.to, l.position)) {
      const nextPath = l.path.length > 1 ? l.path.slice(1) : [];
      agent.commit(decision, nextPath, false);
    }

    // Arrival is detected from POSITION, never from "did I move". An earlier
    // version only advanced the task lifecycle inside the moved branch, so a
    // robot that STARTED on its pickup could never register the pickup and
    // sat there forever. Found by the three-process test, not by any
    // in-process test, because nothing else runs a robot from its own start.
    const here = agent.getLocal().position;
    if (task.status === "assigned" && positionsEqual(here, pickup)) task.status = "in_progress";
    if (task.status === "in_progress" && positionsEqual(here, dropoff)) task.status = "completed";

    const t1 = process.hrtime.bigint();
    const decideUs = Number(t1 - t0) / 1000;
    report({
      moved: !positionsEqual(decision.to, l.position),
      reason: decision.reason,
      peers: agent.getPeers().length,
      taskStatus: task.status,
      decideUs: Math.round(decideUs),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    });

    tick++;
    if (task.status === "completed" || tick > 2000) {
      clearInterval(timer);
      report({ done: true, taskStatus: task.status });
      transport.close();
      process.exit(0);
    }
  }, periodMs);
}

main();
