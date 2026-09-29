import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { EdgeSimulation, startAgents } from "./edge-sim.mjs";
import { buildEndpoints, loadFleetConfig } from "./fleet-config.mjs";
const fleet=loadFleetConfig();
const endpoints=buildEndpoints(fleet,Number(process.env.SMOKE_EDGE_PORT_BASE??19401),"127.0.0.1",{executors:false});
// Constructed development fault timeline pinned to the three-robot edge
// deployment. For arbitrary N use `npm run fleet:n -- --robots N`.
if(fleet.robots.length!==3)throw new Error(`smoke-edge is a fixed three-robot fault fixture; run npm run fleet:n -- --robots ${fleet.robots.length} instead`);
const agents=await startAgents(endpoints),sim=new EdgeSimulation(endpoints);
let killed=null,reassigned=false,blocked=null,rerouted=false,partitionStopped=false;
try{
  await sim.initialize(23003,"negotiated",`fault-smoke-${Date.now()}`,scenario=>{
    // Failure before pickup must not leave the failed body's position as the
    // pickup cell. Fault fixture differs from (and is excluded from) benchmark.
    scenario.tasks.forEach(t=>{t.pickup={x:t.pickup.x+3,y:t.pickup.y};});
  });
  const pids=sim.states.map(s=>s.pid);assert.equal(new Set(pids).size,sim.states.length);
  for(let tick=0;tick<512;tick++){
    if(tick===130){
      const live=endpoints.filter((_,i)=>!sim.failed.has(i));
      await sim.command({kind:"link",a:live[0].id,b:live[1].id,reachable:false});
    }
    if(tick===176){await sim.command({kind:"heal"});await sim.command({kind:"ai-off"});}
    if(tick===208)await sim.command({kind:"ai-on"});
    if(tick===128&&blocked)await sim.command({kind:"block",position:blocked.position,blocked:false});
    await sim.step();
    if(killed===null){
      const i=sim.states.findIndex(s=>s.state.robot.currentTaskId&&s.state.tasks.find(t=>t.id===s.state.robot.currentTaskId)?.status==="assigned");
      if(i>=0){killed={index:i,id:endpoints[i].id,task:sim.states[i].state.robot.currentTaskId,tick:sim.tick};
        await sim.command({kind:"fail",robotId:killed.id});agents.children[i].kill();}
    }else{
      reassigned ||=sim.states.some((s,i)=>i!==killed.index&&s.state.robot.currentTaskId===killed.task);
    }
    if(tick===113){
      for(let i=0;i<sim.states.length;i++){
        if(sim.failed.has(i))continue;
        const path=sim.states[i].state.robot.path;
        const candidate=path.slice(2).find(p=>p.x!==9&&!sim.states.some(s=>s.state.robot.position.x===p.x&&s.state.robot.position.y===p.y)&&
          !sim.scenario.tasks.some(t=>[t.pickup,t.dropoff].some(e=>e.x===p.x&&e.y===p.y)));
        if(candidate){blocked={position:candidate,robotId:sim.states[i].id};await sim.command({kind:"block",position:candidate,blocked:true});break;}
      }
    }
    if(tick===114&&blocked){
      const s=sim.states.find(s=>s.id===blocked.robotId);
      rerouted=!s.state.robot.path.some(p=>p.x===blocked.position.x&&p.y===blocked.position.y);
    }
    if(tick===170)partitionStopped=sim.states.filter((_,i)=>!sim.failed.has(i)).every(s=>s.state.robot.status==="waiting");
    if(tick>208&&sim.snapshot().world.tasks.every(t=>t.status==="completed"))break;
  }
  const result={killed,reassigned,blocked,rerouted,partitionStopped,pids,result:sim.result()};
  const output=process.env.FAULT_SMOKE_DIR ?? "artifacts/edge-choke-v1";
  await mkdir(output,{recursive:true});
  await writeFile(`${output}/fault-smoke.json`,JSON.stringify(result,null,2)+"\n");
  assert.ok(sim.result().completed);
  assert.ok(killed);assert.ok(reassigned);assert.ok(blocked);assert.ok(rerouted);assert.ok(partitionStopped);
  assert.ok(sim.states.some(s=>s.state.metrics.corrections>0));
  assert.ok(sim.states.some(s=>s.state.metrics.fallbacks>0));
  assert.ok(Object.values(sim.safety).every(x=>x===0));
  console.log(JSON.stringify({killed,reassigned,rerouted,partitionStopped,completed:sim.result().completed,ticks:sim.tick,safety:sim.safety}));
}finally{await agents.close();}
