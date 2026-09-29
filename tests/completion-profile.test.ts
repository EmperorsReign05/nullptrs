import { expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { profileRun, profileScenario } from "./completion-profile-harness";
import { OWNERSHIP_EPOCH_TICKS, BID_WINDOW } from "../src/core/distributed/ownership";
import { FleetRuntime } from "../src/core/distributed/runtime";

it("profiling preserves runtime outcomes and partitions all robot ticks",()=>{
 for(const baseline of [false,true]) {
  const measured=profileRun(31000,3,baseline),plain=new FleetRuntime(profileScenario(31000,3),undefined,baseline?{motionPolicy:"stop-and-wait"}:{});
  while(plain.world.tick<800&&!plain.world.tasks.every(t=>t.status==="completed"))plain.step();
  expect(measured.ticks).toBe(plain.world.tick);
  expect(measured.safety).toEqual(plain.safety);
  expect(measured.metrics).toEqual(plain.metrics);
  // Fleet size comes from the run, not a literal in the invariant.
  expect(Object.values(measured.categories).reduce((a,b)=>a+b,0)).toBe(measured.ticks*measured.n);
  expect(measured.taskTrace["M-0"].firstBid).toBe(3);
  expect(measured.taskTrace["M-5"].firstBid).toBe(163);
 }
});
it.skipIf(process.env.RUN_COMPLETION_PROFILE!=="1")("profile 400 existing development seeds",()=>{
 const outputDir=process.env.PROFILE_OUTPUT;
 if(!outputDir)throw new Error("Set PROFILE_OUTPUT to a new output directory; historical reports are never overwritten");
 if(existsSync(`${outputDir}/report.json`))throw new Error("Refusing to overwrite a previous profiling report");
 const rows=[];
 for(const start of [26000,31000])for(let i=0;i<200;i++){
  const seed=start+i,n=i%2?6:3;
  rows.push({seed,n,baseline:profileRun(seed,n,true),integrated:profileRun(seed,n,false)});
  if((i+1)%50===0)console.log(`profile ${start}: ${i+1}/200`);
 }
 const joint=rows.filter(r=>r.baseline.completed&&r.integrated.completed);
 function summarize(key:"baseline"|"integrated",selected=joint){
  const runs=selected.map(r=>r[key]),sum=(fn:(r:ReturnType<typeof profileRun>)=>number)=>runs.reduce((a,r)=>a+fn(r),0);
  return {runs:runs.length,totalTicks:sum(r=>r.ticks),meanTicks:sum(r=>r.ticks)/runs.length,
   categories:Object.fromEntries(Object.keys(runs[0].categories).map(k=>[k,sum(r=>r.categories[k as keyof typeof r.categories])])),
   safety:Object.fromEntries(Object.keys(runs[0].safety).map(k=>[k,sum(r=>r.safety[k as keyof typeof r.safety])])),
   retreats:sum(r=>r.retreats),endpointWaitNoAck:sum(r=>r.endpointWaitNoAck),
   meanFirstExecutableByTask:Object.fromEntries(Object.keys(runs[0].taskTrace).map(k=>[k,runs.filter(r=>r.taskTrace[k].firstExecutable!==null).reduce((a,r)=>a+r.taskTrace[k].firstExecutable!,0)/runs.filter(r=>r.taskTrace[k].firstExecutable!==null).length])),
   meanFirstBidByTask:Object.fromEntries(Object.keys(runs[0].taskTrace).map(k=>[k,sum(r=>r.taskTrace[k].firstBid!)/runs.length])),
   messages:Object.fromEntries(Object.keys(runs[0].messageCounts).map(k=>[k,sum(r=>r.messageCounts[k]??0)]))};
 }
 const baseline=summarize("baseline"),integrated=summarize("integrated");
 const report={commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  protocol:{seeds:"26000..26199 and31000..31199",runs:400,status:"development only; both cohorts already inspected",fleetSizes:[3,6],tasks:6,horizon:800,epochTicks:OWNERSHIP_EPOCH_TICKS,bidWindow:BID_WINDOW,command:"PROFILE_OUTPUT=/tmp/completion-profile-new RUN_COMPLETION_PROFILE=1 ./node_modules/.bin/vitest run tests/completion-profile.test.ts",instrumentation:"Passive send and advance wrappers; exact robot-tick partition. Static BFS increase counts retreat moves, not an assertion that each is avoidable. MotionWait includes confirmation/replan/conflict; not all waits are collisions. Endpoint category captures at-goal protocol/arrival waits."},
  reliability:{baseline:rows.filter(r=>r.baseline.completed).length,integrated:rows.filter(r=>r.integrated.completed).length,baselineTasks:rows.reduce((a,r)=>a+r.baseline.completedTasks,0),integratedTasks:rows.reduce((a,r)=>a+r.integrated.completedTasks,0)},
  admissionCeiling:{finalTaskEarliestExecutableTick:5*OWNERSHIP_EPOCH_TICKS+BID_WINDOW,optimisticZeroTravelImprovementPercent:100*(baseline.meanTicks-(5*OWNERSHIP_EPOCH_TICKS+BID_WINDOW))/baseline.meanTicks,interpretation:"Optimistic upper bound if cadence retained; even instant last-task delivery cannot beat its earliest auction. This is not a predicted speedup."},
  recommendations:[{priority:1,change:"Separate serialized admission rounds from fixed lease generations",evidence:"One new task bids every32ticks; sixth first bids163. Idle exposure dominates successful runs.",requirements:["Keep existing32tick lease expiry and quorum fencing","Admit next fresh auction only after intersecting-quorum commitment of previous assignment","Persist predecessor/reservation certificate and include committed queue/energy obligations in new bids","Delayed or partitioned peer cannot vote for a different admission frontier","Prove no double spend, stale claims, custody transfer or duplicate execution under loss/crash/partition"],status:"Not implemented; requires new protocol and fault tests, not shorter timeout"},{priority:2,change:"Renew leases before expiration with nonoverlapping validity intervals",evidence:"Successful integrated runs spend2960robot ticks lease-fenced in current400seed profile",requirements:["Future grant cannot authorize execution early","Current expiry still fences isolated owner","Respect custody checkpoints across generations"],status:"Not implemented"},{priority:3,change:"Reduce repeated terminal task announcements/checkpoints only after reliable receipt or bounded anti-entropy",evidence:"More than1.7million announcements for346 successful paired baseline runs",status:"Transport/CPU opportunity, not established completion-tick speedup"}],
  paired:{count:joint.length,baseline,integrated,aggregateImprovementPercent:100*(baseline.totalTicks-integrated.totalTicks)/baseline.totalTicks,wins:joint.filter(r=>r.baseline.ticks>r.integrated.ticks).length,ties:joint.filter(r=>r.baseline.ticks===r.integrated.ticks).length,losses:joint.filter(r=>r.baseline.ticks<r.integrated.ticks).length},
  allRunDiagnostics:{baseline:summarize("baseline",rows),integrated:summarize("integrated",rows)},
  limitations:["No performance inference from failed capped runs; allRunDiagnostics are censored exposure counts only","Idle robot ticks overlap elapsed time and cannot be added to predicted makespan savings","Passive counts identify candidate causes, not intervention-proven speedups","No new acceptance; MLP and baseline unchanged"]};
 mkdirSync(outputDir,{recursive:true});
 writeFileSync(`${outputDir}/report.json`,JSON.stringify(report,null,2)+"\n");
 writeFileSync(process.env.PROFILE_ROWS??`${outputDir}/rows.json`,JSON.stringify(rows,null,2)+"\n");
 console.log(JSON.stringify(report,null,2));
 expect(rows).toHaveLength(400);
},1800000);
