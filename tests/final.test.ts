import { describe, it } from "vitest";
import { runExperiment } from "../src/core/bench/stopwait";
import { scenarioChokePoint, scenarioTJunction, scenarioOpenFloor } from "../src/core/bench/scenarios";
import type { Position, RobotState, Task, WarehouseMap } from "../src/core/types";

const k = (p: Position) => p.x + "," + p.y;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function report(name: string, build: () => { map: WarehouseMap; robots: RobotState[]; tasks: Task[] }) {
  const g = build();
  console.log("=== " + name + " ===");
  for (const policy of ["stop-and-wait", "pibt"] as const) {
    const r = runExperiment(g.map, clone(g.robots), clone(g.tasks), policy, 600);
    console.log(
      "  " + policy.padEnd(14) + " makespan=" + String(r.makespan ?? "TIMEOUT") +
      " completed=" + r.completed + "/" + r.total +
      " timeline=[" + r.timeline.map((x) => x.completed + "@" + x.tick).join(" ") + "]"
    );
  }
}

describe("D: final state of the runs that did not finish", () => {
  it("D1: choke-point, 600 ticks", () => {
    const g = scenarioChokePoint();
    for (const policy of ["stop-and-wait", "pibt"] as const) {
      // re-run but capture the END state
      const r = runExperiment(g.map, clone(g.robots), clone(g.tasks), policy, 600);
      console.log(`D1 ${policy}: makespan=${r.makespan ?? "TIMEOUT"} completed=${r.completed}/${r.total}`);
      console.log(`D1   timeline ${r.timeline.map((x) => x.completed + "@t" + x.tick).join(" ")}`);
    }
  });

  it("D2: t-junction, 600 ticks", () => {
    report("t-junction", scenarioTJunction);
  });

  it("D3: open floor, 600 ticks", () => {
    report("open-floor", scenarioOpenFloor);
  });

  it("D4: is the third choke-point task even reachable? trace PIBT to the end", () => {
    const g = scenarioChokePoint();
    const r = runExperiment(g.map, clone(g.robots), clone(g.tasks), "pibt", 600);
    console.log(`D4 pibt completed ${r.completed}/${r.total}; incomplete task ids: T1 T2 T3 minus ${r.completed}`);
    // Which robot never finished?
    console.log(`D4 goal for T3 is the TOP bay; T1's is the BOTTOM bay.`);
  });
});
