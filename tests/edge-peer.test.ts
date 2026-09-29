import { expect, it } from "vitest";
import { EdgePeer } from "../src/core/distributed/edge-peer";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import type { OwnershipMessage } from "../src/core/distributed/ownership";
import type { Message } from "../src/core/distributed/protocol";
import { edgeChokeScenario } from "../src/core/bench/edge-choke";
import { planPath } from "../src/core/pathfinding/astar";
import { createInitialWorld } from "../src/core/simulation/state";
import { executionEnergyAllowed } from "../src/core/distributed/execution-energy";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

function setup(seed:number, policy:"negotiated"|"stop-and-wait") {
  const scenario=edgeChokeScenario(seed,policy), allocation=new InMemoryBus<OwnershipMessage>(),motion=new InMemoryBus<Message>();
  const transports=scenario.configs.map(c=>{
    const a=new InMemoryTransport(c.self.id,allocation),m=new InMemoryTransport(c.self.id,motion);
    c.members.filter(id=>id!==c.self.id).forEach(id=>{a.addPeer(id);m.addPeer(id);});
    return {a,m};
  });
  return {scenario,transports,peers:scenario.configs.map((c,i)=>new EdgePeer(c,transports[i].a,transports[i].m))};
}
it("all opposing routes require the single bridge and retain reachable chargers",()=>{
  const s=edgeChokeScenario(23000,"negotiated"),w={...createInitialWorld(),map:s.map,robots:s.robots,tasks:s.tasks};
  for(const t of s.tasks) expect(planPath(t.pickup,t.dropoff,w).found).toBe(true);
  w.map=structuredClone(w.map); w.map.cells.find(c=>c.position.x===9&&c.position.y===6)!.blocked=true;
  for(const t of s.tasks) expect(planPath(t.pickup,t.dropoff,w).found).toBe(false);
});

it("three private controllers bid, exchange intents and retain collision safety",()=>{
  const {peers}=setup(23000,"negotiated");
  for(let tick=0;tick<200;tick++){
    const before=peers.map(p=>({...p.world.robots[0].position}));
    peers.forEach((p,i)=>p.prepare(tick,before.filter((q,j)=>i!==j&&Math.abs(q.x-before[i].x)+Math.abs(q.y-before[i].y)<=2)));
    peers.forEach(p=>p.propose(tick));
    peers.forEach(p=>p.commit(tick));
    const next=peers.map(p=>p.world.robots[0].position);
    expect(new Set(next.map(p=>p.x+","+p.y)).size).toBe(3);
    for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)expect(JSON.stringify(before[i])===JSON.stringify(next[j])&&JSON.stringify(before[j])===JSON.stringify(next[i])).toBe(false);
    if(tick===111) expect(peers.every(p=>!!p.world.robots[0].currentTaskId)).toBe(true);
  }
  expect(new Set(peers.flatMap(p=>p.snapshot().completed)).size).toBe(3);
  expect(peers.every(p=>p.world.robots.length===1)).toBe(true);
  expect(peers.every(p=>p.metrics.bidAttempts>0)).toBe(true);
  expect(peers.reduce((a,p)=>a+p.metrics.corrections,0)).toBeGreaterThan(0);
  expect(peers.every(p=>p.snapshot().peersHeard.length===2)).toBe(true);
});

it("execution gate protects remaining task, charger and reserve after pickup",()=>{
  const s=edgeChokeScenario(23000,"negotiated"),w={...createInitialWorld(),map:s.map,robots:s.robots,tasks:s.tasks};
  const r={...s.robots[0],battery:16,currentTaskId:s.tasks[0].id};
  expect(executionEnergyAllowed(r,{...s.tasks[0],status:"in_progress"},{x:5,y:r.position.y},w)).toBe(false);
  expect(executionEnergyAllowed({...r,battery:100},{...s.tasks[0],status:"in_progress"},{x:5,y:r.position.y},w)).toBe(true);
});

it("rejects duplicate simulation phases instead of double execution",()=>{
  const p=setup(23001,"negotiated").peers[0];
  p.prepare(0,[]);expect(()=>p.prepare(0,[])).toThrow();p.propose(0);p.commit(0);expect(()=>p.commit(0)).toThrow();
});

it.skipIf(process.env.REPLAY_ENERGY_GUARD!=="1")("replay prior measured exhaustion seeds as development data",()=>{
  // Reconstruct exactly the existing frozen generator without importing its tests.
  const report=JSON.parse(readFileSync("artifacts/integrated-stopwait-v1/report.json","utf8"));
  const rows=[];
  for(const row of report.rows.filter((r:{integrated:{safety:{zeroBatteryWork:number}}})=>r.integrated.safety.zeroBatteryWork)){
    let state=row.seed>>>0; const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
    const w=createInitialWorld(),cells=w.map.cells.filter(c=>!c.blocked).map(c=>c.position),shuffled=cells.map(p=>({...p}));
    for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
    w.tick=0; w.robots=w.robots.slice(0,row.n).map((r,i)=>({...r,position:shuffled[i],home:shuffled[i],battery:100,status:"idle",currentTaskId:undefined,queuedTaskIds:[],path:[]}));
    w.tasks=Array.from({length:6},(_,i)=>{const a=Math.floor(random()*cells.length),b=(a+1+Math.floor(random()*(cells.length-1)))%cells.length;
      return {id:`M-${i}`,pickup:{...cells[a]},dropoff:{...cells[b]},weight:1,priority:1,createdAt:0,status:"pending"};});
    const runtime=new FleetRuntime(w);
    let minimumBattery=100;
    while(runtime.world.tick<800&&!runtime.world.tasks.every(t=>t.status==="completed")){
      runtime.step();minimumBattery=Math.min(minimumBattery,...runtime.world.robots.map(r=>r.battery));
    }
    rows.push({seed:row.seed,completedTasks:runtime.world.tasks.filter(t=>t.status==="completed").length,
      previousCompletedTasks:row.integrated.completedTasks,minimumBattery,safety:runtime.safety,metrics:runtime.metrics});
    expect(runtime.safety.zeroBatteryWork).toBe(0);expect(minimumBattery).toBeGreaterThanOrEqual(15);
  }
  mkdirSync("artifacts/edge-choke-v1",{recursive:true});
  writeFileSync("artifacts/edge-choke-v1/energy-guard-development.json",JSON.stringify({scope:"13 previously inspected seeds; development replay, not fresh acceptance",rows},null,2)+"\n");
},120000);

it("UDP baseline's local decisions match the frozen stop-and-wait resolver on connected snapshots",async()=>{
  const {Agent}=await import("../src/core/distributed/agent");
  const {resolveStopAndWait}=await import("../src/core/bench/stopwait");
  const {mapFromOpen}=await import("../src/core/bench/scenarios");
  const map=mapFromOpen([{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]);
  for(const [starts,targets] of [
    [[0,2,3],[1,1,3]], // contested free cell
    [[0,1,3],[1,0,3]], // swap
    [[0,1,2],[1,2,3]], // convoy: occupancy checked before moves
    [[0,1,3],[1,1,2]], // stationary body
    [[0,2,3],[-1,1,3]], // invalid target
  ]){
    const world={...createInitialWorld(),map,tasks:[]};
    world.robots=world.robots.slice(0,3).map((r,i)=>({...r,id:String(i),position:{x:starts[i],y:0},path:[{x:starts[i],y:0},{x:targets[i],y:0}]}));
    const bus=new InMemoryBus<Message>();
    const agents=world.robots.map(r=>{
      const t=new InMemoryTransport(r.id,bus);world.robots.filter(x=>x.id!==r.id).forEach(x=>t.addPeer(x.id));
      const a=new Agent(r.id,{id:r.id,position:r.position,path:r.path,priority:0,docked:false,seq:1},map,t,6,undefined,2);
      a.setSensorFeed(world.robots.map(x=>x.position));return a;
    });
    agents.forEach(a=>a.decideStopWait(0));agents.forEach(a=>a.tick(0));
    const actual=agents.map(a=>a.confirmDecision(0).to);
    expect(actual).toEqual(resolveStopAndWait(world.robots,world).moves.map(m=>m.to));
  }
});

it("a lost current intent cannot authorize a contested empty-cell move",async()=>{
  const {Agent}=await import("../src/core/distributed/agent");
  const {mapFromOpen}=await import("../src/core/bench/scenarios");
  const map=mapFromOpen([{x:0,y:0},{x:1,y:0},{x:2,y:0}]),bus=new InMemoryBus<Message>();
  const a=new Agent("a",{id:"a",position:{x:0,y:0},path:[{x:0,y:0},{x:1,y:0}],priority:0,docked:false,seq:3},
    map,new InMemoryTransport("a",bus),6,undefined,2,true);
  a.setSensorFeed([{x:2,y:0}]);a.decide(1);
  expect(a.confirmDecision(1).to).toEqual({x:0,y:0});
});

it("routes around a failed body's unknown-contender envelope without entering it",async()=>{
  const {DistributedFleet}=await import("../src/core/distributed/fleet");
  const {mapFromOpen}=await import("../src/core/bench/scenarios");
  const cells=[];for(let y=0;y<7;y++)for(let x=0;x<10;x++)cells.push({x,y});
  const map=mapFromOpen(cells),r={...createInitialWorld().robots[0],position:{x:5,y:3},currentTaskId:"failed-neighbor",path:[]};
  const task={id:"failed-neighbor",pickup:r.position,dropoff:{x:7,y:2},weight:1,createdAt:0,priority:1,status:"in_progress" as const,assignedRobotId:r.id};
  const f=new DistributedFleet(map,[r],[task],{localCommit:true,priorityYield:true,motionTransport:new InMemoryTransport(r.id,new InMemoryBus<Message>())});
  const agent=f.getAgent(r.id)!;agent.updateLocal({...agent.getLocal(),path:[r.position,{x:5,y:2},{x:6,y:2},{x:7,y:2}]});
  for(let tick=0;tick<12;tick++){
    f.observeExternalMotion(tick,[{x:4,y:2}]);f.proposeExternalMotion(tick);f.commitExternalMotion(tick);
    expect(Math.abs(r.position.x-4)+Math.abs(r.position.y-2)).toBeGreaterThan(1);
  }
  expect(task.status).toBe("completed");
});

it("a full existing queue does not prevent executing already-owned work",()=>{
  const world=createInitialWorld();
  const active={id:"active",pickup:{x:3,y:0},dropoff:{x:3,y:2},weight:1,createdAt:0,priority:1,status:"in_progress" as const};
  const queued=Array.from({length:4},(_,i)=>({id:`q${i}`,pickup:{x:3,y:2},dropoff:{x:3,y:3},weight:1,createdAt:0,priority:1,status:"assigned" as const}));
  const robot={...world.robots[0],position:{x:3,y:0},battery:100,currentTaskId:active.id,queuedTaskIds:queued.map(t=>t.id)};
  world.tasks=[active,...queued];world.robots=[robot];
  expect(executionEnergyAllowed(robot,active,{x:3,y:1},world)).toBe(true);
  expect(executionEnergyAllowed({...robot,battery:20},active,{x:3,y:1},world)).toBe(false);
});
