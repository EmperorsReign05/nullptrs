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


it("terminal aisle regression and causal one-tick intervention",()=>{
 const outcomes=[];
 for(const seed of [31015,31042])for(const intervention of [false,true]){
  const runtime=runtimeFor(seed);
  const mover=seed===31015?"AMR-06":"AMR-01", parked=seed===31015?"AMR-04":"AMR-03";
  const at=seed===31015?177:91, y=seed===31015?12:0;
  for(const id of [mover,parked]){
   const a=runtime.fleet.getAgent(id)!, original=a.decide.bind(a);
   a.decide=(tick:number)=>{
    const d=original(tick);
    if(intervention&&tick===at){
     const adjusted={from:d.from,to:id===mover?d.from:{x:17,y},reason:id===mover?"no-move" as const:"step-aside" as const};
     a.overrideDecision(adjusted);return adjusted;
    }return d;
   };
  }
  while(runtime.world.tick<800&&!runtime.world.tasks.every(t=>t.status==="completed"))runtime.step();
  outcomes.push({seed,intervention,ticks:runtime.world.tick,done:runtime.world.tasks.filter(t=>t.status==="completed").length,metrics:runtime.metrics,safety:runtime.safety});
 }
 for (const result of outcomes) {
  const expected = process.env.REPLAY_ORIGINAL === "1" && !result.intervention ? (result.seed === 31015 ? 5 : 4) : 6;
  expect(result.done).toBe(expected);
  expect(Object.values(result.safety)).toEqual([0,0,0,0,0,0]);
 }
 console.log(JSON.stringify(outcomes));
 if (process.env.REPLAY_ORIGINAL === "1") { mkdirSync("artifacts/reliability-v5-development",{recursive:true});
 writeFileSync("artifacts/reliability-v5-development/causal-original.json",JSON.stringify(outcomes,null,2)); }
 expect(outcomes).toHaveLength(4);
});
