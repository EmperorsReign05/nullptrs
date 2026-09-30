/** Exact off-mode checks; writes only new reliability experiment evidence. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runArm, type ArmRun } from '../src/core/bench/sih/runner';
import { loadSuite } from '../src/core/bench/sih/evaluate';
const out='artifacts/event-grouped/reliability/queue-recharge-v1/regression';mkdirSync(out,{recursive:true});
const epoch:ArmRun[]=JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/phase1/D.json.gz')).toString());
const event:ArmRun[]=JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/acceptance-event-single/per-scenario.json.gz')).toString()).map((r:{event:ArmRun})=>r.event);
const stripped=(r:ArmRun)=>{const {ownershipTelemetry,...row}=r;return {...row,tasks:row.tasks.map(({ownershipStages,...task})=>task)};};
const suite=loadSuite('acceptance');
for(const mode of ['epoch','event-single'] as const){
 const lookup=new Map((mode==='epoch'?epoch:event).map(r=>[r.scenarioId,r]));let exact=0;
 for(const scenario of suite){
  const row=runArm(scenario,'D',undefined,mode);
  if(JSON.stringify(stripped(row))!==JSON.stringify(stripped(lookup.get(scenario.id)!)))throw new Error(`Off-mode regression ${mode}: ${scenario.id}`);
  exact++;if(exact%200===0)console.log(`${mode} ${exact}/${suite.length}`);
 }
 const result={mode,scenarios:suite.length,exactRows:exact};
 writeFileSync(`${out}/${mode}-replay.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
