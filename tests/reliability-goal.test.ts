import { expect, it } from "vitest";
import { mapFromOpen } from "../src/core/bench/scenarios";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { createInitialWorld } from "../src/core/simulation/state";
it("local lifecycle goal overrides routing without changing task ownership", () => {
 const world=createInitialWorld(), robot=world.robots[0];
 robot.position={x:0,y:0}; robot.currentTaskId="owned";
 const task={id:"owned",pickup:{x:0,y:3},dropoff:{x:0,y:4},weight:1,priority:1,createdAt:0,status:"assigned" as const,assignedRobotId:robot.id};
 let override: {x:number;y:number}|null|undefined={x:2,y:0};
 const fleet=new DistributedFleet(world.map,[robot],[task],{goalOverride:()=>override,arrivalAllowed:()=>false});
 fleet.advance(0);expect(robot.position).toEqual({x:1,y:0});expect(robot.currentTaskId).toBe("owned");expect(task.status).toBe("assigned");
 override=null;fleet.advance(1);expect(robot.position).toEqual({x:1,y:0});
 override=undefined;fleet.advance(2);expect(fleet.getAgent(robot.id)!.getLocal().path.at(-1)).toEqual(task.pickup);
});

it("an idle parked robot clears a requested goal using only local intent and sensing",()=>{
 const world=createInitialWorld(), mover=world.robots[0], parked=world.robots[1];
 mover.position={x:0,y:0};mover.status="assigned";mover.currentTaskId="job";
 parked.position={x:0,y:1};parked.status="idle";parked.currentTaskId=undefined;parked.queuedTaskIds=[];
 const task={id:"job",pickup:{x:0,y:0},dropoff:{x:0,y:1},weight:1,priority:1,createdAt:0,status:"in_progress" as const,assignedRobotId:mover.id};
 const fleet=new DistributedFleet(world.map,[mover,parked],[task],{localCommit:true});
 for(let tick=0;tick<20;tick++)fleet.advance(tick);
 expect(task.status).toBe("completed");expect(parked.position).not.toEqual(task.dropoff);
});

it.each(["charging", "active-task", "energy-denied", "partition"])("idle courtesy respects %s exclusion", mode=>{
 const world=createInitialWorld(), mover=world.robots[0], parked=world.robots[1];
 mover.position={x:0,y:0};mover.status="assigned";mover.currentTaskId="job";
 parked.position={x:0,y:1};parked.status=mode==="charging"?"charging":"idle";
 parked.currentTaskId=mode==="active-task"?"other":undefined;parked.queuedTaskIds=[];
 const task={id:"job",pickup:{x:0,y:0},dropoff:{x:0,y:1},weight:1,priority:1,createdAt:0,status:"in_progress" as const,assignedRobotId:mover.id};
 const fleet=new DistributedFleet(world.map,[mover,parked],[task],{localCommit:true,
  moveAllowed:robot=>mode!=="energy-denied"||robot.id!==parked.id,
  severed:mode==="partition"?[[mover.id,parked.id]]:[]});
 for(let tick=0;tick<20;tick++)fleet.advance(tick);
 expect(parked.position).toEqual({x:0,y:1});expect(task.status).toBe("in_progress");
});

it("propagates a courtesy request through idle blockers without entering occupied cells",()=>{
 const world=createInitialWorld();
 const n=3; const robots=world.robots.slice(0,n).map((r,i)=>({...r,position:{x:i,y:0},status:"idle" as const,currentTaskId:i===0?"job":undefined,queuedTaskIds:[]}));
 const task={id:"job",pickup:{x:0,y:0},dropoff:{x:1,y:0},weight:1,priority:1,createdAt:0,status:"in_progress" as const,assignedRobotId:robots[0].id};
 const map=mapFromOpen([{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:2,y:1}]);
 const fleet=new DistributedFleet(map,robots,[task],{localCommit:true});
 for(let tick=0;tick<20;tick++){
  fleet.advance(tick);
  expect(new Set(robots.map(r=>`${r.position.x},${r.position.y}`)).size).toBe(n);
 }
 expect(task.status).toBe("completed");
});
