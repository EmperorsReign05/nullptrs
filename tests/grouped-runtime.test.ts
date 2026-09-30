import { it,expect } from 'vitest';
import { FleetRuntime } from '../src/core/distributed/runtime';
import { createInitialWorld } from '../src/core/simulation/state';
import type { Task } from '../src/core/types';
function setup(groupedQueueRecharge=false){
 const world=createInitialWorld();world.robots=world.robots.slice(0,3).map((r,i)=>({...r,position:{x:[0,10,15][i],y:0},home:{x:[0,10,15][i],y:0},battery:100,model:{...r.model,payloadCapacity:i===0?100:0}}));
 world.tasks=[{id:'A',pickup:{x:2,y:0},dropoff:{x:5,y:0},weight:1,createdAt:0,priority:2,status:'pending'},{id:'B',pickup:{x:3,y:0},dropoff:{x:7,y:0},weight:1,createdAt:0,priority:1,status:'pending'}] as Task[];
 return new FleetRuntime(world,undefined,{allocationMode:'event-grouped',groupedQueueRecharge});
}
function safe(runtime:FleetRuntime){for(const task of runtime.world.tasks)expect([...runtime.peers.values()].filter(p=>p.mayExecute(task.id)).length).toBeLessThanOrEqual(1);for(const r of runtime.world.robots)expect((r.queuedTaskIds??[]).length).toBeLessThanOrEqual(4);expect(runtime.safety.overlaps+runtime.safety.swaps).toBe(0);}
it('changing energy after certificate cannot pick up an unaffordable bundle',()=>{
 const runtime=setup();let reached=false;
 for(let t=0;t<20;t++){runtime.step();safe(runtime);const robot=runtime.world.robots[0];if(robot.position.x===2&&runtime.world.tasks[0].status!=='in_progress'){reached=true;robot.battery=19.5;break;}}
 expect(reached).toBe(true);
 for(let t=0;t<5;t++){runtime.step();safe(runtime);expect(runtime.world.tasks[0].status).not.toBe('in_progress');}
 // The intent written on first arrival is conservative and must remain sticky.
 expect(runtime.peers.get(runtime.world.robots[0].id)!.phase('A')).toBe('custody');
});
it('whole certified bundle completes in its certified order',()=>{
 const runtime=setup();const picked:string[]=[];
 for(let t=0;t<200&&!runtime.world.tasks.every(t=>t.status==='completed');t++){
  runtime.step();safe(runtime);
  for(const task of runtime.world.tasks)if(task.status==='in_progress'&&!picked.includes(task.id))picked.push(task.id);
 }
 expect(picked).toEqual(['A','B']);expect(runtime.world.tasks.every(t=>t.status==='completed')).toBe(true);
 expect([...runtime.peers.values()].some(p=>[...p.certifiedBundles.values()].some(b=>b.size===2))).toBe(true);
});
it('queue-aware recharge preserves custody and completes a temporarily unaffordable bundle',()=>{
 const runtime=setup(true);let reduced=false,recharged=false;
 for(let tick=0;tick<200&&!runtime.world.tasks.every(t=>t.status==='completed');tick++){
  runtime.step();safe(runtime);const robot=runtime.world.robots[0];
  if(!reduced&&robot.position.x===2&&runtime.world.tasks[0].status!=='in_progress'){
   robot.battery=20;reduced=true;
  }
  if(reduced&&runtime.world.tasks[0].status!=='completed'&&runtime.charging.get(robot.id)!.active){
   recharged=true;expect(runtime.world.tasks[0].status).not.toBe('in_progress');
   expect(runtime.peers.get(robot.id)!.phase('A')).toBe('custody');
  }
 }
 expect(reduced).toBe(true);expect(recharged).toBe(true);
 expect(runtime.world.tasks.every(t=>t.status==='completed')).toBe(true);
});
it('queue-aware recharge leaves unaffordable loaded cargo fenced for recovery',()=>{
 const runtime=setup(true);let loaded=false;
 for(let tick=0;tick<30;tick++){
  runtime.step();safe(runtime);
  if(runtime.world.tasks[0].status==='in_progress'){loaded=true;break;}
 }
 expect(loaded).toBe(true);const robot=runtime.world.robots[0];
 const position={...robot.position};robot.battery=17;
 for(let tick=0;tick<12;tick++){
  runtime.step();safe(runtime);
  expect(runtime.charging.get(robot.id)!.state.reason).toBe('cargo-recovery-required');
  expect(robot.position).toEqual(position);
  expect(runtime.world.tasks[0].status).toBe('in_progress');
  expect(runtime.peers.get(robot.id)!.phase('A')).toBe('custody');
  expect([...runtime.peers.values()].filter(p=>p.mayExecute('A')).every(p=>p.id===robot.id)).toBe(true);
 }
});
