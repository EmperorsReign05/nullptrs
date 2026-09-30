/** Queue-aware recharge v1; fixed grouped control, development before acceptance. */
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,appendFileSync } from 'node:fs';
import { gzipSync,gunzipSync } from 'node:zlib';
import { loadSuite } from '../src/core/bench/sih/evaluate';
import { runArm,type ArmRun } from '../src/core/bench/sih/runner';
import { pairedStats,median } from '../src/core/bench/sih/stats';
const acceptance=process.argv.includes('--acceptance'),block=acceptance?'acceptance':'development';
const out=`artifacts/event-grouped/reliability/queue-recharge-v1/${block}`;mkdirSync(out,{recursive:true});
const suite=loadSuite(block);
const controlRows=JSON.parse(gunzipSync(readFileSync(`artifacts/event-grouped/phase3/grouped-v4/${block}/per-scenario.json.gz`)).toString());
const controls=new Map<string,ArmRun>(controlRows.map((r:{grouped:ArmRun})=>[r.grouped.scenarioId,r.grouped]));
const eventRows=acceptance ? JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/acceptance-event-single/per-scenario.json.gz')).toString()) : JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/phase2/development.json.gz')).toString());
const lookup=new Map<string,ArmRun>(eventRows.map((r:{event:ArmRun})=>[r.event.scenarioId,r.event]));
const frozen=JSON.parse(readFileSync('artifacts/sih-acceptance-v1/current/per-scenario.json','utf8'));
const old=new Map<string,ArmRun>((JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/phase1/D.json.gz')).toString()) as ArmRun[]).map(r=>[r.scenarioId,r]));
const a=new Map<string,ArmRun>(frozen.runs.filter((r:ArmRun)=>r.arm==='A').map((r:ArmRun)=>[r.scenarioId,r]));
const allowed=new Set(['src/core/distributed/ownership.ts','src/core/distributed/runtime.ts','src/core/bench/sih/runner.ts']);
for(const [path,hash] of Object.entries(frozen.provenance.sourceHashes)) if(!allowed.has(path)&&createHash('sha256').update(readFileSync(path)).digest('hex')!==hash)throw new Error(`Frozen source changed: ${path}`);
if(lookup.size!==suite.length)throw new Error('EVENT suite mismatch');
if(controls.size!==suite.length)throw new Error('Grouped control suite mismatch');
const hashes=Object.fromEntries(['src/core/auction/grouped.ts','src/core/distributed/charging.ts','src/core/distributed/ownership.ts','src/core/distributed/runtime.ts','src/core/bench/sih/runner.ts',`artifacts/sih-acceptance-v1/scenarios${acceptance?'':'-development'}.json`].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
writeFileSync(`${out}/provenance.json`,JSON.stringify({block,algorithm:'queue-recharge-v1; unchanged grouped allocation, opt-in pre-pickup full-queue charging and recharge event after rejected energy move',hashes,baseline:'Recorded fixed grouped-v4 and EVENT; A and D frozen PR #28',catastrophicDevelopmentFloor:0.80,developmentAcceptanceGate:"zero safety violations and improved completion versus fixed grouped control; report any paired TCT penalty"},null,2)+'\n');
const rows:{event:ArmRun;control:ArmRun;grouped:ArmRun;stopwait?:ArmRun;old?:ArmRun}[]=[];
const stripped=(r:ArmRun)=>{const {ownershipTelemetry,...v}=r;return {...v,tasks:v.tasks.map(({ownershipStages,...t})=>t)};};
const replayed:Record<string,number>={};
writeFileSync(`${out}/progress.ndjson`,'');
for(const scenario of suite){
 const event=lookup.get(scenario.id)!;
 const cell=`${scenario.fleetSize}:${scenario.regime}`;
 if((replayed[cell]??0)<3){
  const replay=runArm(scenario,'D',undefined,'event-single');
  const groupedReplay=runArm(scenario,'D',undefined,'event-grouped');
  if(JSON.stringify(stripped(groupedReplay))!==JSON.stringify(stripped(controls.get(scenario.id)!)))throw new Error('Grouped control behavior changed: '+scenario.id);
  if(JSON.stringify(stripped(replay))!==JSON.stringify(stripped(event)))throw new Error(`EVENT behavior changed: ${scenario.id}`);
  replayed[cell]=(replayed[cell]??0)+1;
 }
 try {
  const grouped=runArm(scenario,'D',undefined,'event-grouped',true);
  if(Object.values(grouped.safety).some(x=>x!==0))throw new Error(`Grouped safety regression: ${scenario.id}`);
  let stopwait:ArmRun|undefined;
  if(acceptance){
   stopwait=runArm(scenario,'A');
   if(JSON.stringify(stripped(stopwait))!==JSON.stringify(stripped(a.get(scenario.id)!)))throw new Error(`Frozen A behavior changed: ${scenario.id}`);
  }
  const row={event,control:controls.get(scenario.id)!,grouped,...(acceptance?{stopwait,old:old.get(scenario.id)!}:{})};rows.push(row);
  appendFileSync(`${out}/progress.ndjson`,JSON.stringify(row)+'\n');
 } catch(error){writeFileSync(`${out}/failure.json`,JSON.stringify({scenarioId:scenario.id,error:String(error),completedRows:rows.length},null,2)+'\n');throw error;}
 if(rows.length%100===0)console.log(`${rows.length}/${suite.length}`);
}
writeFileSync(`${out}/per-scenario.json.gz`,gzipSync(JSON.stringify(rows)));
function metrics(runs:ArmRun[]){
 const ts=runs.flatMap(r=>r.tasks),own=ts.filter(t=>t.firstAssignedTick!==null).map(t=>t.firstAssignedTick!-t.createdAt);
 const certification=ts.filter(t=>t.ownershipStages?.certificateTick!==undefined&&t.ownershipStages?.firstAuctionEligibleTick!==undefined).map(t=>t.ownershipStages!.certificateTick-t.ownershipStages!.firstAuctionEligibleTick);
 const telemetry=runs.map(r=>r.ownershipTelemetry),bundles=telemetry.flatMap(t=>Object.values(t?.group?.certifiedBundles??{}).map(b=>b.size));
 const groupSizes=telemetry.flatMap(t=>t?.group?.groupSizes??[]);
 return {runs:runs.length,completionRate:runs.filter(r=>r.completed).length/runs.length,
  meanReleaseToOwnership:own.reduce((a,b)=>a+b,0)/own.length,medianCertificationLatency:median(certification),
  broadcastsPerPeerTick:telemetry.every(t=>!!t)?telemetry.reduce((s,t)=>s+t!.messages,0)/telemetry.reduce((s,t)=>s+t!.peerTicks,0):null,
  messages:telemetry.every(t=>!!t)?telemetry.reduce((s,t)=>s+t!.messages,0):null,
  averageBundleSize:bundles.length?bundles.reduce((a,b)=>a+b,0)/bundles.length:1,medianBundleSize:bundles.length?median(bundles):1,
  meanTasksPerProposedGroup:groupSizes.length?groupSizes.reduce((a,b)=>a+b,0)/groupSizes.length:1,
  proposalRetriesPerTask:telemetry.some(t=>t?.group)?telemetry.reduce((s,t)=>s+Object.values(t?.group?.attempts??{}).reduce((a,x)=>a+Math.max(0,x.length-1),0),0)/ts.length:null,
  meanQueuedTasksPerRobotTick:telemetry.some(t=>t?.group)?telemetry.reduce((s,t)=>s+(t?.group?.queueTasks??0),0)/telemetry.reduce((s,t)=>s+(t?.group?.queueRobotTicks??0),0):null,
  energyHoldRobotTicks:runs.reduce((s,r)=>s+r.energyHoldTicks,0),energyHoldsPerRobotTick:runs.reduce((s,r)=>s+r.energyHoldTicks,0)/runs.reduce((s,r)=>s+r.ticksRun*r.fleetSize,0),
  safety:Object.fromEntries(Object.keys(runs[0].safety).map(k=>[k,runs.reduce((s,r)=>s+r.safety[k],0)])),
  duplicateExecutableOwnerRobotTicks:telemetry.every(t=>!!t)?telemetry.reduce((s,t)=>s+t!.duplicateExecutableOwners,0):null};
}
const summary:Record<string,unknown>={};
for(const n of [0,3,5,8])for(const regime of ['all','low','recoverable','severe']){
 const selected=rows.filter(r=>(!n||r.grouped.fleetSize===n)&&(regime==='all'||r.grouped.regime===regime)),g=selected.map(r=>r.grouped),e=selected.map(r=>r.event);
 const compare=(base:ArmRun[])=>({sumTaskCompletionTime:pairedStats(base,g,'sumTaskCompletionTime'),makespan:pairedStats(base,g,'makespan')});
 summary[`n${n}-${regime}`]={metrics:{event:metrics(e),control:metrics(selected.map(r=>r.control)),grouped:metrics(g),...(acceptance?{stopwait:metrics(selected.map(r=>r.stopwait!)),old:metrics(selected.map(r=>r.old!))}:{})},GROUPED_to_RECHARGED:compare(selected.map(r=>r.control)),EVENT_to_GROUPED:compare(e),...(acceptance?{A_to_GROUPED:compare(selected.map(r=>r.stopwait!)),D_to_GROUPED:compare(selected.map(r=>r.old!))}:{})};
}
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary['n0-recoverable'],null,2));
