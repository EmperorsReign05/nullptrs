import { expect, it } from "vitest";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createInitialWorld } from "../src/core/simulation/state";
import { RECHARGE_TARGET_PERCENT } from "../src/core/simulation/robotModels";

function world() {
  const w = createInitialWorld(); w.robots = w.robots.slice(0,3); w.tasks = [];
  w.map.cells.forEach(c => c.blocked = false);
  const starts = [{x:2,y:4},{x:18,y:10},{x:18,y:12}];
  w.robots.forEach((r,i) => { r.position={...starts[i]};r.home={...starts[i]};r.battery=100; });
  return w;
}
it("a low-battery idle peer reaches charging and resumes without zero-battery work", () => {
  const w=world();w.robots[0].battery=19; const runtime=new FleetRuntime(w);
  let reached=false,resumed=false;
  for(let tick=0;tick<160;tick++){
    runtime.step();const r=runtime.world.robots[0],charging=runtime.charging.get(r.id)!;
    reached ||= charging.state.mode==="charging";
    resumed ||= reached && !charging.active && r.battery>=RECHARGE_TARGET_PERCENT-1;
  }
  expect(reached).toBe(true);expect(resumed).toBe(true);
  expect(Object.values(runtime.safety).every(v=>v===0)).toBe(true);
});
it("pre-pickup recharge preserves the lease and task, then completes the delivery", () => {
  const w=world();w.tasks=[{id:"CHARGE-JOB",pickup:{x:5,y:4},dropoff:{x:10,y:4},weight:1,priority:1,createdAt:0,status:"pending"}];
  const runtime=new FleetRuntime(w);let forced=false,charged=false,owner="";
  for(let tick=0;tick<240;tick++){
    runtime.step();const task=runtime.world.tasks[0];
    if(!forced&&task.status==="assigned"&&task.assignedRobotId){
      owner=task.assignedRobotId;runtime.world.robots.find(r=>r.id===owner)!.battery=19;forced=true;
    }
    if(forced){
      const c=runtime.charging.get(owner)!; charged ||= c.state.mode==="charging";
      if(c.active)expect(task.status).not.toBe("in_progress");
      if(task.assignedRobotId)expect(task.assignedRobotId).toBe(owner);
    }
    if(task.status==="completed")break;
  }
  expect(forced).toBe(true);expect(charged).toBe(true);expect(runtime.world.tasks[0].status).toBe("completed");
  expect(Object.values(runtime.safety).every(v=>v===0)).toBe(true);
});
