import { expect, it } from "vitest";
import { Agent, BLOCKER_MEMORY_TICKS } from "../src/core/distributed/agent";
import { createInitialWorld } from "../src/core/simulation/state";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";

function observer() {
 const world=createInitialWorld();
 const a=new Agent("A",{id:"A",position:{x:0,y:0},path:[],seq:0,priority:0,docked:false},world.map,new InMemoryTransport("A",new InMemoryBus()));
 function encounter(tick:number, from:{x:number;y:number}, target:{x:number;y:number}, contacts=[target]) {
  a.updateLocal({...a.getLocal(),position:from,path:[from,target],seq:tick});
  a.setSensorFeed(contacts);a.observeMotion(tick);
 }
 return {a,encounter};
}
it("remembers separate stationary blockers across a retreat loop",()=>{
 const {a,encounter}=observer();
 encounter(0,{x:0,y:0},{x:0,y:1});
 encounter(4,{x:4,y:0},{x:5,y:0});
 encounter(8,{x:0,y:0},{x:0,y:1});
 expect(a.getRememberedBlockers()).toContainEqual({x:0,y:1});
 encounter(12,{x:4,y:0},{x:5,y:0});
 expect(a.getRememberedBlockers()).toContainEqual({x:5,y:0});
});
it("does not turn duplicate observations from one tick into persistent evidence",()=>{
 const {a,encounter}=observer();
 encounter(0,{x:0,y:0},{x:0,y:1});encounter(0,{x:0,y:0},{x:0,y:1});
 expect(a.getRememberedBlockers()).toEqual([]);
});
it("forgets old candidate evidence and resets a cell observed empty",()=>{
 const {a,encounter}=observer();
 encounter(0,{x:0,y:0},{x:0,y:1});
 encounter(1,{x:0,y:0},{x:1,y:0}); // (0,1) is visible and now empty.
 encounter(2,{x:0,y:0},{x:0,y:1});
 expect(a.getRememberedBlockers()).toEqual([]);
 encounter(2+BLOCKER_MEMORY_TICKS,{x:0,y:0},{x:0,y:1});
 expect(a.getRememberedBlockers()).toEqual([]);
});
