import { describe,it,expect } from 'vitest';
import { OwnershipPeer, type OwnershipMessage } from '../src/core/distributed/ownership';
import { InMemoryBus,InMemoryTransport } from '../src/core/distributed/transport';
import { groupIdentity,orderGroup,selectGroup,type GroupBid } from '../src/core/auction/grouped';
import type { Task } from '../src/core/types';
function rig(n:number) {
 const ids=Array.from({length:n},(_,i)=>`R${i}`),bus=new InMemoryBus<OwnershipMessage>();
 const channels=ids.map(id=>{const t=new InMemoryTransport(id,bus);ids.filter(x=>x!==id).forEach(x=>t.addPeer(x));return t;});
 const tasks:Task[]=Array.from({length:8},(_,i)=>({id:`T${i}`,pickup:{x:i,y:0},dropoff:{x:i,y:2},createdAt:0,priority:1,weight:1,status:'pending'}));
 const eligible=ids.map(()=>true),extra=ids.map(()=>[] as string[]),dead=new Set<number>();
 let peers:OwnershipPeer[]=[];
 const offer=(i:number,ts:Task[],tick:number):GroupBid=>{
  const own=tasks.filter(t=>peers[i]?.ownership(t.id)?.owner===ids[i]&&!peers[i].completed(t.id)).map(t=>t.id);
  const commitments=[...new Set([...own,...extra[i]])],ordered=orderGroup(ts),offers=[];
  for(let mask=1;mask<1<<ordered.length;mask++){
   const chosen=ordered.filter((_,j)=>mask&(1<<j));
   if(eligible[i]&&commitments.length+chosen.length<=5)offers.push({taskIds:chosen.map(t=>t.id),cost:chosen.length*10+1+i,requiredEnergy:25,battery:100,completionEtas:chosen.map((_,j)=>j+5)});
  }
  return {robotId:ids[i],generation:Math.floor(tick/32),groupId:groupIdentity(Math.floor(tick/32),ts),taskIds:ordered.map(t=>t.id),tick,commitmentIds:commitments,offers};
 };
 peers=ids.map((id,i)=>new OwnershipPeer(id,ids,channels[i],(task,tick)=>({robotId:id,taskId:task.id,tick,bid:null,features:[],mlCost:null,energy:{admitted:false,reason:'test',activeRouteCertified:false,battery:100,committedDistance:0,chargingDistance:0,requiredEnergy:15,reserve:15,margin:85,charger:null},reciprocalIntent:false,completePeerKnowledge:true}),'event-grouped',(ts,tick)=>offer(i,ts,tick)));
 tasks.forEach((t,i)=>peers[i%n].announce(t));let tick=0;
 function advance(count=1,shuffle=false){for(let t=0;t<count;t++,tick++){
  peers.forEach((p,i)=>{
   if(dead.has(i))return;
   if(shuffle){const messages=bus.take(ids[i]);for(const m of messages.reverse()){bus.post(ids[i],m);bus.post(ids[i],m);}}
   p.tick(tick,{x:i,y:0},[]);
  });
  for(const task of tasks)expect(peers.filter((p,i)=>!dead.has(i)&&p.mayExecute(task.id)).length,`${task.id}@${tick}`).toBeLessThanOrEqual(1);
  for(const p of peers)expect(tasks.filter(t=>p.mayExecute(t.id)).length).toBeLessThanOrEqual(5);
 }}
 function partition(a:number[]){for(const i of a)for(let j=0;j<n;j++)if(!a.includes(j)){channels[i].setReachable(ids[j],false);channels[j].setReachable(ids[i],false);}}
 function heal(){channels.forEach((c,i)=>ids.forEach((id,j)=>{if(i!==j)c.setReachable(id,true);}));}
 return {peers,ids,tasks,bus,channels,advance,partition,heal,eligible,extra,dead,get tick(){return tick;}};
}
describe('atomic grouped ownership',()=>{
 for(const n of [3,4,5,8]) {
  it(`N=${n}: 8 simultaneous tasks, competing robot bundles and identical bids`,()=>{
   const r=rig(n);r.advance(100);
   expect(r.peers.some(p=>p.groupMetrics.bundleSizes.some(size=>size>1))).toBe(true);
   expect(new Set(r.tasks.flatMap(t=>r.peers.filter(p=>p.mayExecute(t.id)).map(()=>t.id))).size).toBe(8);
  });
  it(`N=${n}: duplicate/reordered proposals, grants and delayed bids`,()=>{
   const r=rig(n);r.channels.forEach((c,i)=>c.setLatency(i%3));r.advance(160,true);
   const stale:OwnershipMessage={kind:'grant',from:r.ids[0],tick:0,lease:{taskId:'T0',generation:0,owner:r.ids[1],expires:32}};
   r.ids.forEach(id=>r.bus.post(id,stale));r.advance(3,true);
   expect(r.peers.reduce((s,p)=>s+p.metrics.stale,0)).toBeGreaterThan(0);
  });
  it(`N=${n}: partition before certificate then heal`,()=>{const r=rig(n);r.partition([0]);r.advance(20,true);r.heal();r.advance(100,true);});
  it(`N=${n}: partition after certificate, bidder crash and quorum recovery`,()=>{const r=rig(n);r.advance(15);r.partition([0]);r.dead.add(1);r.advance(60,true);r.heal();r.advance(100,true);});
 }
 it('full queue / changed energy before grant prevents executable ownership',()=>{
  const r=rig(8);r.advance(1);r.extra[0]=['a','b','c','d','e'];r.eligible[0]=false;r.advance(30,true);
  expect(r.tasks.some(t=>r.peers[0].mayExecute(t.id))).toBe(false);
 });
 it('winner crash before custody reassigns through full bundle admission',()=>{
  const r=rig(5);r.advance(12);
  const victim=r.peers.findIndex(p=>r.tasks.some(t=>p.mayExecute(t.id)));
  const lost=r.tasks.filter(t=>r.peers[victim].mayExecute(t.id)).map(t=>t.id);
  expect(lost.length).toBeGreaterThan(0);r.dead.add(victim);r.advance(120,true);
  for(const id of lost)expect(r.peers.some((p,i)=>i!==victim&&p.mayExecute(id))).toBe(true);
 });
 it('loaded crash preserves custody and cannot create a second pickup owner',()=>{
  const r=rig(5);r.advance(12);const task=r.tasks.find(t=>r.peers.some(p=>p.mayExecute(t.id)))!;
  const index=r.peers.findIndex(p=>p.mayExecute(task.id));r.peers[index].mark(task.id,'custody');r.advance(5);
  expect(r.peers[index].acknowledged(task.id,'custody')).toBe(true);r.dead.add(index);r.advance(100,true);
  expect(r.peers.filter((p,i)=>i!==index&&p.mayExecute(task.id))).toHaveLength(0);
 });
 it('set packing selects a joint bundle and is independent of bid arrival order',()=>{
  const tasks=rig(3).tasks.slice(0,2),ids=orderGroup(tasks).map(t=>t.id);
  const b=(id:string,cost:number):GroupBid=>({robotId:id,generation:0,groupId:groupIdentity(0,tasks),taskIds:ids,tick:0,commitmentIds:[],offers:[{taskIds:ids,cost,requiredEnergy:30,battery:100,completionEtas:[5,10]}]});
  expect(selectGroup([b('B',20),b('A',20)])).toEqual([{owner:'A',taskIds:ids}]);
  expect(selectGroup([b('A',20),b('B',20)])).toEqual(selectGroup([b('B',20),b('A',20)]));
 });
});
