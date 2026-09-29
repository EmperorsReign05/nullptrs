import { it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { resolveStopAndWait } from "../src/core/bench/stopwait";
import { createInitialWorld } from "../src/core/simulation/state";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const protocol = {
  version: 2, seedStart: 25000, seeds: 200, fleetSizes: [3, 6], tasksPerRun: 6,
  horizon: 800, map: "stock warehouse", battery: 100, taskWeight: 1,
  release: "all six pending tasks announced at tick zero",
  starts: "uniform open cells without replacement",
  endpoints: "uniform open cells; pickup differs from dropoff",
  communications: "connected, zero simulated latency",
  ai: "identical frozen model and guarded 10% correction in both arms",
  comparator: "unchanged resolveStopAndWait, including all stationary bodies; shared obstruction observation and replanning",
  asymmetry: "baseline has synchronous global conflict resolution; treatment confirms locally. No packet-loss claims.",
  performance: "jointly completed pairs only; bootstrap paired seeds, 10000 resamples, 95% percentile interval",
  limitations: ["shared simulation clock", "one Node process", "no charging lifecycle", "six tasks admitted serially by existing ownership epochs", "not an AI ablation"],
};
function scenario(seed: number, n: number) {
  const w = createInitialWorld(), random = rng(seed);
  const cells = w.map.cells.filter(c => !c.blocked).map(c => c.position);
  const shuffled = cells.map(p => ({ ...p }));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  w.tick = 0;
  w.robots = w.robots.slice(0, n).map((r, i) => ({
    ...r, position: shuffled[i], home: shuffled[i], battery: 100, status: "idle",
    currentTaskId: undefined, queuedTaskIds: [], path: [],
  }));
  w.tasks = Array.from({ length: protocol.tasksPerRun }, (_, i) => {
    const a = Math.floor(random() * cells.length);
    const b = (a + 1 + Math.floor(random() * (cells.length - 1))) % cells.length;
    return { id: `M-${i}`, pickup: { ...cells[a] }, dropoff: { ...cells[b] },
      weight: 1, priority: 1, createdAt: 0, status: "pending" as const };
  });
  return w;
}
function run(seed: number, n: number, stopwait: boolean) {
  const runtime = new FleetRuntime(scenario(seed, n), undefined, stopwait ? { motionPolicy: "stop-and-wait" } : {});
  while (runtime.world.tick < protocol.horizon && !runtime.world.tasks.every(t => t.status === "completed")) runtime.step();
  const completedTasks = runtime.world.tasks.filter(t => t.status === "completed").length;
  return { completed: completedTasks === protocol.tasksPerRun, completedTasks, ticks: runtime.world.tick,
    safety: runtime.safety, metrics: runtime.metrics,
    unfinished: runtime.world.tasks.filter(t => t.status !== "completed").map(t => ({ id: t.id, status: t.status, owner: t.assignedRobotId })) };
}
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) { const a = [...xs].sort((x,y) => x-y), k = Math.floor(a.length/2); return a.length ? a.length % 2 ? a[k] : (a[k-1]+a[k])/2 : null; }
type Pair = { seed: number; n: number; baseline: ReturnType<typeof run>; integrated: ReturnType<typeof run> };
function summarize(rows: Pair[]) {
  const complete = rows.filter(r => r.baseline.completed && r.integrated.completed);
  const differences = complete.map(r => r.baseline.ticks-r.integrated.ticks);
  const random = rng(984521), intervals: number[] = [], percentages: number[] = [];
  if (complete.length) for (let b = 0; b < 10000; b++) {
    let delta = 0, base = 0;
    for (let i = 0; i < complete.length; i++) {
      const p = complete[Math.floor(random()*complete.length)];
      delta += p.baseline.ticks-p.integrated.ticks; base += p.baseline.ticks;
    }
    intervals.push(delta/complete.length); percentages.push(100*delta/base);
  }
  intervals.sort((a,b) => a-b); percentages.sort((a,b)=>a-b);
  const totals = (key: "baseline" | "integrated") => ({
    completedRuns: rows.filter(r => r[key].completed).length,
    completedTasks: rows.reduce((a,r) => a+r[key].completedTasks,0),
    safety: Object.fromEntries(Object.keys(rows[0][key].safety).map(k => [k, rows.reduce((a,r) => a+r[key].safety[k as keyof typeof r.baseline.safety],0)])),
    nonzeroBidCorrections: rows.reduce((a,r)=>a+r[key].metrics.nonzeroCorrections,0),
  });
  const bm = mean(complete.map(r=>r.baseline.ticks)), im = mean(complete.map(r=>r.integrated.ticks));
  return { seeds: rows.length, baseline: totals("baseline"), integrated: totals("integrated"),
    paired: { count: complete.length, baselineMeanTicks: bm, integratedMeanTicks: im,
      baselineMedianTicks: median(complete.map(r=>r.baseline.ticks)), integratedMedianTicks: median(complete.map(r=>r.integrated.ticks)),
      meanTicksSaved: mean(differences), medianTicksSaved: median(differences),
      aggregateImprovementPercent: bm === null || im === null ? null : 100*(bm-im)/bm,
      ticksSaved95CI: intervals.length ? [intervals[250],intervals[9750]] : null,
      improvementPercent95CI: percentages.length ? [percentages[250],percentages[9750]] : null,
      wins: differences.filter(x=>x>0).length, ties: differences.filter(x=>x===0).length, losses: differences.filter(x=>x<0).length },
    baselineOnlyComplete: rows.filter(r=>r.baseline.completed&&!r.integrated.completed).map(r=>r.seed),
    integratedOnlyComplete: rows.filter(r=>!r.baseline.completed&&r.integrated.completed).map(r=>r.seed) };
}

it("stop-and-wait adapter matches the unchanged resolver and shares obstruction learning", () => {
  const w = scenario(42, 3);
  w.robots.forEach((r,i)=> { r.position={x:3,y:2+i}; r.path=[r.position,{x:3,y:3+i}]; });
  w.tasks=[];
  const expected = resolveStopAndWait(w.robots,w).moves;
  const fleet = new DistributedFleet(w.map,w.robots,[],{localCommit:true,motionPolicy:"stop-and-wait"});
  for (const r of w.robots) { const a = fleet.getAgent(r.id)!; a.updateLocal({ ...a.getLocal(), path: r.path }); }
  // Exercise only motion: avoid changing the prepared path in the route planner.
  const step = fleet as unknown as { step(t:number): unknown; applyMoves(t:number): void };
  step.step(0);
  for(const m of expected) expect(fleet.getAgent(m.robotId)!.getLastDecision()!.to).toEqual(m.to);
  step.step(1);
  expect(fleet.getAgent(w.robots[0].id)!.getRememberedBlockers()).toContainEqual({x:3,y:3});
});

it.skipIf(process.env.MEASURE_INTEGRATED !== "1")("200 paired integrated runtime seeds, frozen protocol", () => {
  const dir = "artifacts/integrated-stopwait-v2";
  mkdirSync(dir,{recursive:true});
  writeFileSync(`${dir}/protocol.json`,JSON.stringify(protocol,null,2)+"\n");
  const rows: Pair[]=[];
  for(let i=0;i<protocol.seeds;i++) {
    const seed=protocol.seedStart+i,n=protocol.fleetSizes[i%protocol.fleetSizes.length];
    rows.push({seed,n,baseline:run(seed,n,true),integrated:run(seed,n,false)});
    if((i+1)%10===0) console.log(`measured ${i+1}/${protocol.seeds}`);
  }
  const report={protocol, overall:summarize(rows), byFleetSize:protocol.fleetSizes.map(n=>({n,...summarize(rows.filter(r=>r.n===n))})),rows};
  writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({overall:report.overall,byFleetSize:report.byFleetSize},null,2));
  // Failed throughput/safety targets are results, not grounds to discard rows.
  expect(rows.length).toBe(200);
}, 1800000);

it.skipIf(process.env.DIAGNOSE_INTEGRATED !== "1")("diagnose every measured battery-exhaustion run without changing policy", () => {
  const report = JSON.parse(readFileSync("artifacts/integrated-stopwait-v2/report.json", "utf8")) as { rows: Pair[] };
  const rows = report.rows.filter(r => r.integrated.safety.zeroBatteryWork || r.baseline.completed && !r.integrated.completed);
  const results = rows.map(row => {
    const runtime = new FleetRuntime(scenario(row.seed,row.n));
    let underpoweredMoves = 0;
    const history: unknown[] = [], depletions: unknown[] = [];
    while(runtime.world.tick < protocol.horizon && !runtime.world.tasks.every(t=>t.status==="completed")) {
      const before = structuredClone(runtime.world.robots);
      runtime.step();
      history.push({tick:runtime.world.tick, robots:runtime.world.robots.map(r=>({id:r.id,position:r.position,battery:r.battery,task:r.currentTaskId,
        phase:runtime.world.tasks.find(t=>t.id===r.currentTaskId)?.status}))});
      if(history.length>64) history.shift();
      runtime.world.robots.forEach((r,i)=>{
        const moved=r.position.x!==before[i].position.x || r.position.y!==before[i].position.y;
        if(moved && before[i].battery<0.5) underpoweredMoves++;
        if(r.battery===0 && before[i].battery>0) depletions.push({
          tick:runtime.world.tick,robotId:r.id,task:r.currentTaskId,phase:runtime.world.tasks.find(t=>t.id===r.currentTaskId)?.status,
          last64Ticks:structuredClone(history),
        });
      });
    }
    expect(runtime.world.tasks.filter(t=>t.status==="completed").length).toBe(row.integrated.completedTasks);
    expect(runtime.world.tick).toBe(row.integrated.ticks);
    expect(runtime.safety).toEqual(row.integrated.safety);
    return {seed:row.seed,n:row.n,underpoweredMoves,depletions,
      finalRobots:runtime.world.robots, finalTasks:runtime.world.tasks, safety:runtime.safety};
  });
  writeFileSync("artifacts/integrated-stopwait-v2/energy-diagnosis.json",JSON.stringify({
    scope:"all exhaustion and baseline-only completion seeds from the v2 report; diagnostic replay, no policy tuning",
    counterDefinition:"zeroBatteryWork counts robot-ticks at zero battery with a current task, including stationary holds",
    results,
  },null,2)+"\n");
}, 120000);
