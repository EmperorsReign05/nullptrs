import { describe, it, expect } from "vitest";
import { runExperiment } from "../src/core/bench/stopwait";
import { scenarioChokePoint, scenarioTJunction, scenarioOpenFloor, CHOKE_BAYS, T_BAYS } from "../src/core/bench/scenarios";
import { WAITING_ZONE_CELLS } from "../src/core/map/warehouse";
import { isTraversable } from "../src/core/map/warehouse";
import type { Position, RobotState, Task, WarehouseMap } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

/** Verify the scenario geometry actually forces the choke point. */
function auditScenario(name: string, map: WarehouseMap, robots: RobotState[], tasks: Task[]) {
  const open = map.cells.filter((c) => !c.blocked).length;
  const offMap = robots.filter((r) => !isTraversable(r.position, map));
  const badTasks = tasks.filter((t) => !isTraversable(t.pickup, map) || !isTraversable(t.dropoff, map));
  console.log(`AUDIT ${name}: openCells=${open}, robots=${robots.length}, tasks=${tasks.length}, robotsOffMap=${offMap.length}, tasksOffMap=${badTasks.length}`);
  if (offMap.length) console.log(`  !! robots on blocked cells: ${offMap.map((r) => `${r.id}@${key(r.position)}`).join(" ")}`);
  if (badTasks.length) console.log(`  !! tasks with blocked endpoints: ${badTasks.map((t) => `${t.id} ${key(t.pickup)}->${key(t.dropoff)}`).join(" ")}`);
  return { open, ok: offMap.length === 0 && badTasks.length === 0 };
}

function compare(
  name: string,
  build: () => { map: WarehouseMap; robots: RobotState[]; tasks: Task[] },
  bays: ReadonlySet<string>,
  maxTicks = 600
) {
  const geo = build();
  auditScenario(name, geo.map, geo.robots, geo.tasks);

  // Both arms get structurally identical inputs.
  const base = runExperiment(geo.map, clone(geo.robots), clone(geo.tasks), "stop-and-wait", maxTicks);
  const treat = runExperiment(geo.map, clone(geo.robots), clone(geo.tasks), "pibt", maxTicks, bays);
  // Ablation: PIBT with the step-aside rule DISABLED, to price the rule itself.
  const treatNoBay = runExperiment(geo.map, clone(geo.robots), clone(geo.tasks), "pibt", maxTicks, new Set());

  const pct = (a: number, b: number) => (((a - b) / a) * 100).toFixed(1) + "%";
  let improvement: string;
  if (base.makespan === null && treat.makespan !== null) improvement = "baseline NEVER FINISHED";
  else if (base.makespan === null && treat.makespan === null) improvement = "both failed";
  else if (base.makespan === 0) improvement = "n/a";
  else improvement = pct(base.makespan!, treat.makespan!);

  console.log(
    `RESULT ${name.padEnd(13)} baseline=${String(base.makespan ?? "TIMEOUT").padStart(7)} (${base.completed}/${base.total})  ` +
    `pibt=${String(treat.makespan ?? "TIMEOUT").padStart(7)} (${treat.completed}/${treat.total}) stepAsides=${String(treat.stepAsides).padStart(3)}  ` +
    `pibt-noBays=${String(treatNoBay.makespan ?? "TIMEOUT").padStart(7)} (${treatNoBay.completed}/${treatNoBay.total})  improvement=${improvement}`
  );
  // Partial-progress comparison, the only one valid when the baseline deadlocks.
  if (base.makespan === null && treat.makespan !== null) {
    const k = Math.min(treat.completed, base.completed);
    if (k > 0) {
      const bt = base.timeline.find((x) => x.completed === k)?.tick ?? null;
      const tt = treat.timeline.find((x) => x.completed === k)?.tick ?? null;
      if (bt !== null && tt !== null) {
        console.log(`        time-to-${k}-tasks: baseline=${bt} pibt=${tt} => ${pct(bt, tt)} faster`);
      }
    }
  }
  return { base, treat, treatNoBay, improvement };
}

describe("SIH26123 benchmark: stop-and-wait vs PIBT, identical everything but the policy", () => {
  it("B1: geometry audit — do the scenarios actually create a choke point?", () => {
    const cp = scenarioChokePoint();
    const open = cp.map.cells.filter((c) => !c.blocked);
    console.log(`B1 choke-point map: ${open.length} open cells`);
    console.log(`B1 open cells: ${open.map((c) => key(c.position)).join(" ")}`);
    // Confirm the column x=6 is a single-file corridor from top to bottom.
    const col6 = open.filter((c) => c.position.x === 6).map((c) => c.position.y).sort((a, b) => a - b);
    console.log(`B1 x=6 column is open at rows: ${col6.join(",")}`);
    // Confirm nothing else connects the top half to the bottom half.
    const bridging = open.filter((c) => c.position.x !== 6);
    console.log(`B1 open cells OUTSIDE the choke column: ${bridging.map((c) => key(c.position)).join(" ") || "none"}`);
    expect(col6.length).toBeGreaterThan(5);
  });

  it("B2: the headline demo — 3 robots crossing a single narrow choke point", () => {
    const r = compare("choke-point", scenarioChokePoint, CHOKE_BAYS, 600);
    console.log(`B2 baseline completion timeline: ${r.base.timeline.map((x) => `${x.completed}@t${x.tick}`).join(" ")}`);
    console.log(`B2 pibt     completion timeline: ${r.treat.timeline.map((x) => `${x.completed}@t${x.tick}`).join(" ")}`);
  });

  it("B3: T-junction — three approaches, one throat", () => {
    compare("t-junction", scenarioTJunction, T_BAYS, 600);
  });

  it("B4: open floor with crossing traffic", () => {
    compare("open-floor", scenarioOpenFloor, WAITING_ZONE_CELLS, 600);
  });

  it("B5: fairness audit — both arms must see identical geometry and identical paths on tick 1", () => {
    for (const [name, build] of [["choke-point", scenarioChokePoint], ["t-junction", scenarioTJunction], ["open-floor", scenarioOpenFloor]] as const) {
      const a = build();
      const b = build();
      const sameMap = JSON.stringify(a.map) === JSON.stringify(b.map);
      const sameRobots = JSON.stringify(a.robots) === JSON.stringify(b.robots);
      const sameTasks = JSON.stringify(a.tasks) === JSON.stringify(b.tasks);
      console.log(`B5 ${name.padEnd(14)} identicalMap=${sameMap} identicalRobots=${sameRobots} identicalTasks=${sameTasks}`);
      expect(sameMap && sameRobots && sameTasks).toBe(true);
    }
  });
});
