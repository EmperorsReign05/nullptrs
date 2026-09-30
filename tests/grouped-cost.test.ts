import { it,expect } from 'vitest';
import { bundleOffer,groupBid,orderGroup,bundleExecutionAllowed } from '../src/core/auction/grouped';
import { createInitialWorld } from '../src/core/simulation/state';
import frozen from '../artifacts/bid-energy-v4/model.json';
import type { LocalBidInput } from '../src/core/ml/bidfeatures';
import type { Task } from '../src/core/types';
it('full queued duration changes bundle completion ETA and cost',()=>{
 const world=createInitialWorld(), self={...world.robots[0],position:{x:0,y:0},home:{x:0,y:0},battery:100,currentTaskId:undefined,queuedTaskIds:[],path:[],status:'idle' as const};
 const queued:Task={id:'Q',pickup:{x:2,y:0},dropoff:{x:4,y:0},weight:1,priority:1,createdAt:0,status:'assigned'};
 const task:Task={...queued,id:'J',pickup:{x:5,y:0},dropoff:{x:7,y:0},status:'pending'};
 const input:LocalBidInput={self,task,ownTasks:[],tick:0,geometry:world.map,expectedPeerIds:[],maxPeerAgeTicks:2,receivedPeers:[]};
 const idle=bundleOffer(input,[task],frozen.model,0)!;
 const busy=bundleOffer({...input,self:{...self,queuedTaskIds:['Q']},ownTasks:[queued]},[task],frozen.model,0)!;
 expect(busy.completionEtas[0]).toBe(7);expect(idle.completionEtas[0]).toBe(7);
 // A queued out-and-back job adds all travel, not just queue length.
 const back={...queued,dropoff:{x:0,y:0}};
 const deep=bundleOffer({...input,self:{...self,queuedTaskIds:['Q']},ownTasks:[back]},[task],frozen.model,0)!;
 expect(deep.completionEtas[0]).toBe(11);expect(deep.cost).toBeGreaterThan(idle.cost);
});
it('joint energy and payload feasibility excludes incompatible bundles',()=>{
 const world=createInitialWorld(),self={...world.robots[0],position:{x:0,y:0},battery:22,currentTaskId:undefined,queuedTaskIds:[],path:[],status:'idle' as const};
 const tasks:Task[]=Array.from({length:4},(_,i)=>({id:`J${i}`,pickup:{x:1,y:0},dropoff:{x:7,y:0},priority:1,createdAt:0,weight:1,status:'pending'}));
 const input:LocalBidInput={self,task:tasks[0],ownTasks:[],tick:0,geometry:world.map,expectedPeerIds:[],maxPeerAgeTicks:2,receivedPeers:[]};
 const packet=groupBid(input,tasks,0,frozen.model,0);
 expect(packet.offers.every(o=>o.requiredEnergy<=self.battery)).toBe(true);
 expect(bundleOffer(input,[{...tasks[0],weight:100000}],frozen.model,0)).toBeUndefined();
 expect(orderGroup([...tasks].reverse()).map(t=>t.id)).toEqual(orderGroup(tasks).map(t=>t.id));
});

it('execution uses the 15% reserve, not the 20% new-bid floor',()=>{
 const world=createInitialWorld();
 const task:Task={id:'active',pickup:{x:0,y:0},dropoff:{x:1,y:0},priority:1,createdAt:0,weight:1,status:'in_progress'};
 world.tasks=[task];
 const robot={...world.robots[0],position:{x:0,y:0},battery:19.5,currentTaskId:task.id,queuedTaskIds:[],path:[{x:0,y:0},{x:1,y:0}],status:'assigned' as const};
 expect(bundleExecutionAllowed(robot,{x:1,y:0},world)).toBe(true);
 expect(bundleExecutionAllowed({...robot,battery:15},{x:1,y:0},world)).toBe(false);
});
