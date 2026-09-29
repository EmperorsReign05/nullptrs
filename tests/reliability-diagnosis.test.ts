import { it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createInitialWorld } from "../src/core/simulation/state";
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const protocol = { tasksPerRun: 6 };
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

function runtimeFor(seed: number, baseline=false) {
 return new FleetRuntime(scenario(seed,seed%2?6:3),undefined,baseline?{motionPolicy:"stop-and-wait"}:{});
}

it.skipIf(process.env.RELIABILITY_DIAG !== "1")("inspect ten baseline-only development failures", () => {
 const seeds=process.env.RELIABILITY_SEED?[Number(process.env.RELIABILITY_SEED)]:[26015,26045,26059,26087,26088,26107,26111,26113,26151,26169];
 const results=seeds.map(seed=>{
  const runtime=runtimeFor(seed); const tail:unknown[]=[];
  while(runtime.world.tick<800&&!runtime.world.tasks.every(t=>t.status==="completed")){
   runtime.step();
   tail.push({tick:runtime.world.tick, robots:runtime.world.robots.map(r=>({id:r.id,p:r.position,b:r.battery,task:r.currentTaskId,queue:r.queuedTaskIds,path:r.path,decision:runtime.fleet.getAgent(r.id)?.getLastDecision(),blockers:runtime.fleet.getAgent(r.id)?.getRememberedBlockers()}))});
  }
  return {seed,done:runtime.world.tasks.filter(t=>t.status==="completed").length,metrics:runtime.metrics,safety:runtime.safety,tasks:runtime.world.tasks,tail};
 });
 mkdirSync("artifacts/reliability-development",{recursive:true});
 writeFileSync("/tmp/teamrocket-reliability-diagnosis.json",JSON.stringify(results,null,2));
 console.log(results.map(r=>({seed:r.seed,done:r.done,energyHolds:r.metrics.energyHolds,tail:r.tail.slice(-1)})));
 expect(results).toHaveLength(seeds.length);
},120000);

it("causal single-decision hold replay",()=>{
 const results=[];
 for(const intervention of [false,true]){
  const runtime=runtimeFor(26059);
  const a=runtime.fleet.getAgent("AMR-02")!, original=a.decide.bind(a);
  a.decide=(tick:number)=>{const d=original(tick); if(intervention&&tick===165){const hold={from:d.from,to:d.from,reason:"no-move" as const};a.overrideDecision(hold);return hold;}return d;};
  while(runtime.world.tick<800&&!runtime.world.tasks.every(t=>t.status==="completed"))runtime.step();
  results.push({intervention,tick:runtime.world.tick,done:runtime.world.tasks.filter(t=>t.status==="completed").length,metrics:runtime.metrics,safety:runtime.safety});
 }
 for(const result of results){expect(result.done).toBe(6);expect(Object.values(result.safety)).toEqual([0,0,0,0,0,0]);}
});

it.skipIf(!process.env.RELIABILITY_SWEEP)("development sweep, not untouched acceptance",()=>{
 const results=[];
 for(let seed=26000;seed<26200;seed++){
  const outcomes=[true,false].map(baseline=>{
   const runtime=runtimeFor(seed,baseline);
   while(runtime.world.tick<800&&!runtime.world.tasks.every(t=>t.status==="completed"))runtime.step();
   return {ticks:runtime.world.tick,done:runtime.world.tasks.filter(t=>t.status==="completed").length,safety:runtime.safety,moves:runtime.metrics.moves,energyHolds:runtime.metrics.energyHolds};
  });
  const pair={seed,baseline:outcomes[0],integrated:outcomes[1]};
  results.push(pair);
 }
 mkdirSync("artifacts/reliability-development",{recursive:true});
 writeFileSync(`artifacts/reliability-development/${process.env.RELIABILITY_SWEEP}.json`,JSON.stringify(results));
},180000);
