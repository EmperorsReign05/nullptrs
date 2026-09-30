/** Development-only reproduction of stalls; no policy modifications. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { loadSuite } from '../src/core/bench/sih/evaluate';
import { layoutMap, scenarioWorld, taskObject } from '../src/core/bench/sih/scenario';
import { FleetRuntime } from '../src/core/distributed/runtime';
import { bundleExecutionAllowed } from '../src/core/auction/grouped';
import { activeTaskAffordable } from '../src/core/distributed/charging';
import type { ArmRun } from '../src/core/bench/sih/runner';
const rows: {event:ArmRun;grouped:ArmRun}[] = JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/phase3/grouped-v4/development/per-scenario.json.gz')).toString());
const ids = new Set(rows.filter(r=>r.grouped.fleetSize===8&&r.event.completed&&!r.grouped.completed).slice(0,3).map(r=>r.grouped.scenarioId));
const out='artifacts/event-grouped/reliability/diagnosis';mkdirSync(out,{recursive:true});
const results=[];
for(const scenario of loadSuite('development').filter(s=>ids.has(s.id))) {
  const runtime=new FleetRuntime(scenarioWorld(scenario,layoutMap(scenario.layout)),undefined,{allocationMode:'event-grouped'});
  const mismatches:Record<string,number>={},examples:unknown[]=[];
  for(let tick=0;tick<scenario.horizonTicks;tick++){
    for(const task of scenario.tasks)if(task.createdAt>0&&task.createdAt===runtime.world.tick)runtime.command({kind:'task',task:taskObject(task)});
    runtime.step();
    for(const task of runtime.world.tasks)if([...runtime.peers.values()].filter(p=>p.mayExecute(task.id)).length>1)throw new Error('duplicate execution');
    for(const robot of runtime.world.robots){
      const task=runtime.world.tasks.find(t=>t.id===robot.currentTaskId);
      if(!task||task.status==='completed')continue;
      const charge=runtime.charging.get(robot.id)!.state;
      if(charge.mode==='work'&&activeTaskAffordable(robot,task,runtime.world)&&!bundleExecutionAllowed(robot,robot.position,runtime.world)){
        const key=task.status==='in_progress'?'loaded':'before-pickup';mismatches[key]=(mismatches[key]??0)+1;
        if(examples.length<10)examples.push({tick,robot:robot.id,battery:robot.battery,position:robot.position,task:task.id,status:task.status,queued:robot.queuedTaskIds,charge});
      }
    }
  }
  const result={scenario:scenario.id,mismatches,examples,safety:runtime.safety};results.push(result);console.log(JSON.stringify(result));
}
writeFileSync(`${out}/charging-budget-mismatch.json`,JSON.stringify(results,null,2)+'\n');
