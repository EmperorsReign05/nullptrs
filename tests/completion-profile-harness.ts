import { FleetRuntime } from "../src/core/distributed/runtime";
import { createInitialWorld } from "../src/core/simulation/state";
import type { OwnershipMessage } from "../src/core/distributed/ownership";
import type { Position } from "../src/core/types";
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export function profileScenario(seed: number, n: number) {
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
  w.tasks = Array.from({ length: 6 }, (_, i) => {
    const a = Math.floor(random() * cells.length);
    const b = (a + 1 + Math.floor(random() * (cells.length - 1))) % cells.length;
    return { id: `M-${i}`, pickup: { ...cells[a] }, dropoff: { ...cells[b] },
      weight: 1, priority: 1, createdAt: 0, status: "pending" as const };
  });
  return w;
}

const same = (a: Position,b: Position) => a.x===b.x&&a.y===b.y;
export function profileRun(seed:number,n:number,stopwait:boolean) {
 const runtime=new FleetRuntime(profileScenario(seed,n),undefined,stopwait?{motionPolicy:"stop-and-wait"}:{});
 const categories={taskMoves:0,idleMoves:0,chargingTransitMoves:0,chargingWait:0,chargingHold:0,leaseWait:0,endpointHandshake:0,motionWait:0,idleWhileUnadmitted:0,idleOther:0};
 const taskTrace=Object.fromEntries(runtime.world.tasks.map(t=>[t.id,{firstAnnounce:null,firstBid:null,firstProposal:null,firstGrant:null,firstExecutable:null,pickup:null,complete:null} as Record<string,number|null>]));
 const messageCounts:Record<string,number>={};
 let retreats=0,routeDistanceChecks=0,endpointWaitNoAck=0;
 const distances=new Map<string,Map<string,number>>();
 function distance(a:Position,b:Position) {
  const key=`${b.x},${b.y}`;
  if(!distances.has(key)) {
   const open=new Set(runtime.world.map.cells.filter(c=>!c.blocked).map(c=>`${c.position.x},${c.position.y}`));
   const d=new Map([[key,0]]),q=[b];
   for(let i=0;i<q.length;i++){const p=q[i];for(const [x,y] of [[p.x+1,p.y],[p.x-1,p.y],[p.x,p.y+1],[p.x,p.y-1]]){const k=`${x},${y}`;if(open.has(k)&&!d.has(k)){d.set(k,d.get(`${p.x},${p.y}`)!+1);q.push({x,y});}}}
   distances.set(key,d);
  }
  return distances.get(key)!.get(`${a.x},${a.y}`)??Infinity;
 }
 // Instrument only the transport boundary. No packet, ordering or core mutation.
 for(const peer of runtime.peers.values()) {
  const transport=(peer as unknown as {transport:{send(to:string|undefined,m:OwnershipMessage):void}}).transport;
  const send=transport.send.bind(transport);
  transport.send=(to,m)=>{
   messageCounts[m.kind]=(messageCounts[m.kind]??0)+1;
   const id=m.kind==="announce"?m.task.id:m.kind==="bid"?m.packet.taskId:m.kind==="propose"?m.proposal.taskId:m.kind==="grant"?m.lease.taskId:undefined;
   const field={announce:"firstAnnounce",bid:"firstBid",propose:"firstProposal",grant:"firstGrant"}[m.kind as "announce"];
   if(id&&field&&taskTrace[id][field]===null)taskTrace[id][field]=m.tick;
   send(to,m);
  };
 }
 const advance=runtime.fleet.advance.bind(runtime.fleet);
 runtime.fleet.advance=tick=>{
  const before=runtime.world.robots.map(r=>{
   const task=runtime.world.tasks.find(t=>t.id===r.currentTaskId),peer=runtime.peers.get(r.id)!;
   if(task&&peer.mayExecute(task.id)&&taskTrace[task.id].firstExecutable===null)taskTrace[task.id].firstExecutable=tick;
   const goal=task?(task.status==="in_progress"?task.dropoff:task.pickup):undefined;
   return {position:{...r.position},taskId:task?.id,goal,mode:runtime.charging.get(r.id)!.state.mode,executable:task?peer.mayExecute(task.id):false,ack:task?peer.acknowledged(task.id,task.status==="in_progress"?"completed":"custody"):false};
  });
  const unadmitted=runtime.world.tasks.some(t=>taskTrace[t.id].firstExecutable===null&&t.status!=="completed");
  advance(tick);
  runtime.world.robots.forEach((r,i)=>{
   const b=before[i],moved=!same(b.position,r.position);
   if(moved){
    if(b.mode==="transit")categories.chargingTransitMoves++;
    else if(b.taskId){categories.taskMoves++;if(b.goal){routeDistanceChecks++;if(distance(r.position,b.goal)>distance(b.position,b.goal))retreats++;}}
    else categories.idleMoves++;
   } else if(b.mode==="charging")categories.chargingWait++;
   else if(b.mode==="hold")categories.chargingHold++;
   else if(b.mode==="transit")categories.motionWait++;
   else if(b.taskId&&!b.executable)categories.leaseWait++;
   else if(b.taskId&&b.goal&&same(b.position,b.goal)){categories.endpointHandshake++;if(!b.ack)endpointWaitNoAck++;}
   else if(b.taskId)categories.motionWait++;
   else if(unadmitted)categories.idleWhileUnadmitted++;
   else categories.idleOther++;
  });
 };
 while(runtime.world.tick<800&&!runtime.world.tasks.every(t=>t.status==="completed")){
  runtime.step();
  for(const t of runtime.world.tasks){if(t.status==="in_progress"&&taskTrace[t.id].pickup===null)taskTrace[t.id].pickup=runtime.world.tick-1;if(t.status==="completed"&&taskTrace[t.id].complete===null)taskTrace[t.id].complete=runtime.world.tick-1;}
 }
 return {seed,n,ticks:runtime.world.tick,completed:runtime.world.tasks.every(t=>t.status==="completed"),completedTasks:runtime.world.tasks.filter(t=>t.status==="completed").length,categories,taskTrace,messageCounts,retreats,routeDistanceChecks,endpointWaitNoAck,safety:runtime.safety,metrics:runtime.metrics};
}
