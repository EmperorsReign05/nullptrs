import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const require=createRequire(import.meta.url);
const {edgeChokeScenario}=require("../.fleet-dist/src/core/bench/edge-choke.js");
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startAgents(endpoints) {
  const dir=await mkdtemp(path.join(tmpdir(),"sih-edge-"));
  const file=path.join(dir,"peers.json");await writeFile(file,JSON.stringify(endpoints));
  const children=[];
  try {
    await Promise.all(endpoints.map(e=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[".fleet-dist/src/server/edge-agent.js",file,e.id],{stdio:["ignore","pipe","pipe"]});
      children.push(child);let text="",errors="";
      const timer=setTimeout(()=>reject(new Error("Agent startup timeout: "+e.id+" "+errors)),10000);
      child.stderr.on("data",d=>{errors+=d;});
      child.stdout.on("data",d=>{text+=d;if(text.includes('"ready":true')){clearTimeout(timer);resolve();}});
      child.once("exit",code=>{clearTimeout(timer);if(!text.includes('"ready":true'))reject(new Error("Agent startup failed "+code+" "+errors));});
      child.once("error",reject);
    })));
  }catch(e){children.forEach(c=>c.kill());await rm(dir,{recursive:true,force:true});throw e;}
  return {children,close:async()=>{children.forEach(c=>c.kill());await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?Promise.resolve():new Promise(r=>c.once("exit",r))));await rm(dir,{recursive:true,force:true});}};
}
export class EdgeSimulation {
  constructor(endpoints,{settleMs=8}={}){this.endpoints=endpoints;this.settleMs=settleMs;}
  async request(i,route,body) {
    const e=this.endpoints[i],response=await fetch(`http://${e.host}:${e.controlPort}${route}`,{
      method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",...(process.env.EDGE_TOKEN?{Authorization:`Bearer ${process.env.EDGE_TOKEN}`}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));return result;
  }
  async initialize(seed,policy,session,configure=()=>{}) {
    this.scenario=edgeChokeScenario(seed,policy);configure(this.scenario);this.session=session;this.seed=seed;this.policy=policy;this.tick=0;
    this.failed=new Set();this.running=true;this.aiEnabled=true;this.events=[];this.lastMoves=0;this.noMotionTicks=0;this.longestNoMotionTicks=0;
    this.safety={overlaps:0,swaps:0,blockedCells:0,zeroBatteryWork:0,queueOverflow:0,payloadViolations:0,nonAdjacentMoves:0};
    this.crossed=new Set();this.trace=[];this.pendingBlocks=[];this.releaseState=null;
    this.states=await Promise.all(this.scenario.configs.map((config,i)=>this.request(i,"/initialize",{config,session})));
  }
  snapshot(){
    const robots=this.states.map((s,i)=>({...s.state.robot,...(this.failed.has(i)?{status:"failed"}:{})}));
    const completed=new Set(this.states.flatMap(s=>s.state.completed));
    const tasks=this.scenario.tasks.map(t=>{
      const lease=this.states.flatMap(s=>s.state.claims).map(c=>c.taskId===t.id?c.lease:null)
        .find(l=>l&&l.expires>this.tick&&!this.failed.has(this.endpoints.findIndex(e=>e.id===l.owner)));
      const holder=lease&&this.states.find(s=>s.id===lease.owner);
      const local=holder?.state.tasks.find(x=>x.id===t.id);
      const custody=this.states.filter((_,i)=>!this.failed.has(i)).flatMap(s=>s.state.tasks).find(x=>x.id===t.id&&x.status==="in_progress");
      return {...t,...(local??custody),assignedRobotId:lease?.owner,
        status:completed.has(t.id)?"completed":custody?"in_progress":lease?"assigned":"pending"};
    });
    return {world:{tick:this.tick,map:this.scenario.map,robots,tasks,metrics:{replans:0,conflictCount:0,waitMoves:0,inheritedPriorities:0,backtracks:0}},
      running:this.running,aiEnabled:this.aiEnabled,events:this.events,safety:this.safety,
      metrics:{aiBidAttempts:this.states.reduce((n,s)=>n+s.state.metrics.bidAttempts,0),
        nonzeroCorrections:this.states.reduce((n,s)=>n+s.state.metrics.corrections,0),
        disabledFallbacks:this.states.reduce((n,s)=>n+s.state.metrics.fallbacks,0),failedModelFallbacks:0},
      ownership:this.states.map(s=>({id:s.id,metrics:s.state.ownershipMetrics,tasks:s.state.claims})),
      deployment:"Three OS-process robot controllers; direct UDP ownership and intents; simulated clock and sensors; no physical edge hardware"};
  }
  async command(command){
    const live=this.endpoints.map((_,i)=>i).filter(i=>!this.failed.has(i));
    const index=id=>{const i=this.endpoints.findIndex(e=>e.id===id);if(i<0)throw new Error("Unknown robot");return i;};
    switch(command.kind){
      case "pause":this.running=false;break;
      case "run":this.running=true;break;
      case "ai-on":case "ai-off":
        this.aiEnabled=command.kind==="ai-on";await Promise.all(live.map(i=>this.request(i,"/ai",{enabled:this.aiEnabled})));break;
      case "link": {
        const a=index(command.a),b=index(command.b);
        await Promise.all([[a,b],[b,a]].filter(([i])=>!this.failed.has(i)).map(([i,j])=>this.request(i,"/link",{peer:this.endpoints[j].id,reachable:command.reachable})));break;
      }
      case "heal":
        await Promise.all(live.flatMap(i=>this.endpoints.filter(e=>e.id!==this.endpoints[i].id).map(e=>this.request(i,"/link",{peer:e.id,reachable:true}))));break;
      case "task":
        if(this.scenario.tasks.some(t=>t.id===command.task.id)||!live.length)throw new Error("Duplicate task or no live peer");
        await this.request(live[0],"/announce",{task:command.task});this.scenario.tasks.push(structuredClone(command.task));break;
      case "fail":this.failed.add(index(command.robotId));break; // Crash-stop simulation: no more phases; body remains.
      case "block": {
        const cell=this.scenario.map.cells.find(c=>c.position.x===command.position.x&&c.position.y===command.position.y);
        if(!cell||command.blocked&&this.states.some(s=>s.state.robot.position.x===cell.position.x&&s.state.robot.position.y===cell.position.y))throw new Error("Cannot block absent/occupied cell");
        cell.blocked=command.blocked;this.pendingBlocks.push({position:cell.position,blocked:command.blocked});break;
      }
      default:throw new Error("Unsupported edge demo command");
    }
    this.events.push({tick:this.tick,text:JSON.stringify(command)});
  }
  async step(){
    if(!this.running)return;
    const before=this.states.map(s=>({...s.state.robot.position}));
    const live=this.endpoints.map((_,i)=>i).filter(i=>!this.failed.has(i));
    const blocks=this.pendingBlocks;this.pendingBlocks=[];
    // Host supplies only range-two positions. No intents, routes, winners or
    // other robots' batteries/queues are supplied by the physics host.
    await Promise.all(live.map(i=>this.request(i,"/prepare",{session:this.session,tick:this.tick,blocks,
      contacts:before.filter((p,j)=>j!==i&&Math.abs(p.x-before[i].x)+Math.abs(p.y-before[i].y)<=2)})));
    await sleep(this.settleMs);
    await Promise.all(live.map(i=>this.request(i,"/propose",{session:this.session,tick:this.tick})));
    // UDP is deliberately not converted into centrally relayed messages.
    // Late/missing intents lead to conservative holds in each peer.
    await sleep(this.settleMs);
    await Promise.all(live.map(async i=>{this.states[i]=await this.request(i,"/commit",{session:this.session,tick:this.tick});}));
    const after=this.states.map(s=>s.state.robot.position);let moves=0;
    this.safety.overlaps+=after.length-new Set(after.map(p=>p.x+","+p.y)).size;
    for(let i=0;i<after.length;i++){
      const distance=Math.abs(after[i].x-before[i].x)+Math.abs(after[i].y-before[i].y);
      if(distance>0)moves++;if(distance>1)this.safety.nonAdjacentMoves++;
      const r=this.states[i].state.robot;
      if(r.battery<=0&&r.currentTaskId)this.safety.zeroBatteryWork++;
      if((r.queuedTaskIds?.length??0)>4)this.safety.queueOverflow++;
      if(this.scenario.tasks.some(t=>t.id===r.currentTaskId&&t.weight>r.model.payloadCapacity))this.safety.payloadViolations++;
      if(this.scenario.map.cells.some(c=>c.blocked&&c.position.x===after[i].x&&c.position.y===after[i].y))this.safety.blockedCells++;
      for(let j=i+1;j<after.length;j++)if(distance&&after[i].x===before[j].x&&after[i].y===before[j].y&&after[j].x===before[i].x&&after[j].y===before[i].y)this.safety.swaps++;
      if(this.scenario.robots[i].position.x<9&&after[i].x>9||this.scenario.robots[i].position.x>9&&after[i].x<9)this.crossed.add(r.id);
    }
    this.lastMoves=moves;this.noMotionTicks=moves?0:this.noMotionTicks+1;
    if(this.tick>=112)this.longestNoMotionTicks=Math.max(this.longestNoMotionTicks,this.noMotionTicks);
    this.trace.push({tick:this.tick,robots:this.states.map(s=>({id:s.id,position:s.state.robot.position,battery:s.state.robot.battery,task:s.state.robot.currentTaskId,decision:s.state.decision}))});
    if(this.trace.length>64)this.trace.shift();
    if(this.tick===111)this.releaseState=this.states.map(s=>({id:s.id,task:s.state.robot.currentTaskId,claims:s.state.claims}));
    this.tick++;
    // Detect errors; NEVER repair moves or choose a winner in the simulator.
    if(this.safety.overlaps||this.safety.swaps||this.safety.blockedCells||this.safety.nonAdjacentMoves)throw new Error("Physical safety audit failed: "+JSON.stringify(this.safety));
  }
  result(){
    const snapshot=this.snapshot(),completedTasks=snapshot.world.tasks.filter(t=>t.status==="completed").length;
    return {seed:this.seed,policy:this.policy,completed:completedTasks===this.scenario.tasks.length,completedTasks,ticks:this.tick,
      motionTicks:Math.max(0,this.tick-112),safety:this.safety,allThreeCrossed:this.crossed.size===3,
      allThreeAssignedAtRelease:this.releaseState?.every(s=>!!s.task)??false,releaseState:this.releaseState,
      longestNoMotionTicks:this.longestNoMotionTicks,unfinishedAtCap:completedTasks<3,
      deadlockConclusion:completedTasks<3?"unfinished within horizon; permanent deadlock not established":"completed",
      states:this.states,trace:this.trace,snapshot};
  }
}
