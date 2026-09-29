import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createInitialWorld } from "../src/core/simulation/state";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const protocol = {
  version: 5, seedStart: 42000, seeds: 200, fleetSizes: [3, 6], tasksPerRun: 6,
  horizon: 800, map: "stock warehouse", battery: 100, taskWeight: 1,
  release: "all six pending tasks announced at tick zero",
  starts: "uniform open cells without replacement",
  endpoints: "uniform open cells; pickup differs from dropoff",
  communications: "connected, zero simulated latency",
  ai: "identical frozen model and guarded 10% correction in both arms",
  comparator: "unchanged resolveStopAndWait, including all stationary bodies; shared obstruction observation and replanning",
  asymmetry: "baseline has synchronous global conflict resolution; treatment confirms locally. No packet-loss claims.",
  performance: "jointly completed pairs only; bootstrap paired seeds, 10000 resamples, 95% percentile interval",
  charging: "same local charging lifecycle and active-job energy reserve in both arms",
  limitations: ["shared simulation clock", "one Node process", "six tasks admitted serially by existing ownership epochs", "not an AI ablation"],
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

it.skipIf(process.env.RUN_ACCEPTANCE_V5 !== "1")("frozen integrated acceptance on 200 untouched seeds", () => {
  const dir="artifacts/integrated-stopwait-v5";
  if (existsSync(`${dir}/report.json`) || existsSync(`${dir}/rows.json`)) throw new Error("Acceptance already recorded; preserve it and create a new protocol for subsequent evaluations.");
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {encoding:"utf8"}).trim();
  if (dirty) throw new Error("Commit the frozen implementation before acceptance.");
  mkdirSync(dir,{recursive:true});
  const provenance={commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
    baselineSHA256:createHash("sha256").update(readFileSync("src/core/bench/stopwait.ts")).digest("hex"),
    modelSHA256:createHash("sha256").update(readFileSync("artifacts/bid-energy-v4/model.json")).digest("hex")};
  writeFileSync(`${dir}/protocol.json`,JSON.stringify({protocol,provenance},null,2)+"\n");
  const rows:Pair[]=[];
  for(let i=0;i<protocol.seeds;i++){
    const seed=protocol.seedStart+i,n=protocol.fleetSizes[i%protocol.fleetSizes.length];
    rows.push({seed,n,baseline:run(seed,n,true),integrated:run(seed,n,false)});
    if((i+1)%20===0)console.log(`fresh acceptance ${i+1}/${protocol.seeds}`);
  }
  const overall=summarize(rows);
  const result={protocol,provenance,overall,byFleetSize:protocol.fleetSizes.map(n=>({n,...summarize(rows.filter(r=>r.n===n))})),
    gates:{reliability:overall.integrated.completedRuns>=overall.baseline.completedRuns&&overall.integrated.completedTasks>=overall.baseline.completedTasks,
      safety:Object.keys(overall.baseline.safety).every(k=>overall.integrated.safety[k]<=overall.baseline.safety[k]),
      twentyPercent:!!overall.paired.improvementPercent95CI&&overall.paired.improvementPercent95CI[0]>=20}};
  writeFileSync(`${dir}/rows.json`,JSON.stringify(rows,null,2)+"\n");
  writeFileSync(`${dir}/report.json`,JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
  expect(rows).toHaveLength(200); // A failed outcome remains a result, not discarded data.
},1800000);
