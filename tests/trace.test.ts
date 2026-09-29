import { describe, it } from "vitest";
import { resolveStopAndWait, replanAll, applyMoves, withCongestion } from "../src/core/bench/stopwait";
import { resolvePIBT } from "../src/core/pathfinding/pibt";
import { scenarioChokePoint, scenarioTJunction, ALCOVES, BAY_TOP, BAY_BOTTOM } from "../src/core/bench/scenarios";
import type { Position, RobotState, Task, WarehouseMap, WorldState } from "../src/core/types";

const k = (p: Position) => p.x + "," + p.y;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function trace(
  name: string,
  map: WarehouseMap,
  robots: RobotState[],
  tasks: Task[],
  policy: "stop-and-wait" | "pibt",
  ticks: number
) {
  let state: WorldState = {
    tick: 0,
    map: withCongestion(map, robots),
    robots,
    tasks,
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
  console.log("--- " + name + " / " + policy + " ---");
  const stalled = new Map<string, number>();
  for (let t = 0; t < ticks; t++) {
    const routed = replanAll(state, state.robots, state.tasks, stalled);
    state = { ...state, robots: routed };
    const moves = policy === "pibt" ? resolvePIBT(routed, state).moves : resolveStopAndWait(routed, state).moves;
    for (const r of routed) {
      const m = moves.find((x) => x.robotId === r.id);
      const moved = m ? m.from.x !== m.to.x || m.from.y !== m.to.y : false;
      stalled.set(r.id, moved ? 0 : (stalled.get(r.id) ?? 0) + 1);
    }
    const res = applyMoves(routed, state.tasks, moves);
    const done = res.tasks.filter((x) => x.status === "completed").length;
    state = { ...state, tick: t + 1, robots: res.robots, tasks: res.tasks, map: withCongestion(state.map, res.robots) };
    const desc = res.robots
      .map((r) => {
        const g = r.path.length ? k(r.path[r.path.length - 1]) : "-";
        return r.id + "@" + k(r.position) + ">" + g + "/" + r.status;
      })
      .join("  ");
    console.log("  t=" + String(t + 1).padStart(3) + " [" + res.tasks.map((x) => x.status[0]).join("") + "] " + desc);
    if (done === tasks.length) {
      console.log("  ALL DONE at t=" + (t + 1));
      return;
    }
  }
  console.log("  never finished in " + ticks + " ticks");
}

describe("C: trace the failures", () => {
  it("C1: is the spine really single-file?", () => {
    const g = scenarioChokePoint();
    const open = g.map.cells.filter((c) => !c.blocked).map((c) => c.position);
    for (const a of ALCOVES) {
      const nbrs = open.filter((p) => Math.abs(p.x - a.x) + Math.abs(p.y - a.y) === 1);
      console.log("C3 alcove " + k(a) + " neighbours: " + nbrs.map(k).join(" ") + "  (must be exactly 1 = the spine)");
    }
    console.log("C3 bay top " + k(BAY_TOP) + "  bay bottom " + k(BAY_BOTTOM));
  });

  it("C2: choke point, both policies", () => {
    const g = scenarioChokePoint();
    console.log("tasks: " + g.tasks.map((t) => t.id + " " + t.assignedRobotId + " " + k(t.pickup) + "->" + k(t.dropoff)).join(" | "));
    trace("choke-point", g.map, clone(g.robots), clone(g.tasks), "stop-and-wait", 20);
    trace("choke-point", g.map, clone(g.robots), clone(g.tasks), "pibt", 20);
  });

  it("C3: t-junction, both policies", () => {
    const g = scenarioTJunction();
    trace("t-junction", g.map, clone(g.robots), clone(g.tasks), "stop-and-wait", 15);
    trace("t-junction", g.map, clone(g.robots), clone(g.tasks), "pibt", 15);
  });
});
