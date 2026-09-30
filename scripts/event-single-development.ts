import { mkdirSync, writeFileSync } from 'node:fs';
import { loadSuite } from '../src/core/bench/sih/evaluate';
import { runArm } from '../src/core/bench/sih/runner';
import { pairedStats } from '../src/core/bench/sih/stats';
const suite = loadSuite('development');
const rows = [];
for (const scenario of suite) {
  rows.push({ epoch: runArm(scenario,'D'), event: runArm(scenario,'D',undefined,'event-single') });
  if (rows.length % 100 === 0) console.log(`${rows.length}/${suite.length}`);
}
const out='artifacts/event-grouped/phase2'; mkdirSync(out,{recursive:true});
writeFileSync(`${out}/development.json`,JSON.stringify(rows));
const results: Record<string,unknown> = {};
for (const n of [0,3,5,8]) for (const regime of ['all','low','recoverable','severe']) {
 const selected=rows.filter(r=>(!n||r.epoch.fleetSize===n)&&(regime==='all'||r.epoch.regime===regime));
 const stats=(arm:'epoch'|'event')=>{
  const runs=selected.map(r=>r[arm]);const ts=runs.flatMap(r=>r.tasks).filter(t=>t.firstAssignedTick!==null);
  return { completion: runs.filter(r=>r.completed).length/runs.length, ownership:ts.reduce((s,t)=>s+t.firstAssignedTick!-t.createdAt,0)/ts.length, safety:runs.reduce((s,r)=>s+Object.values(r.safety).reduce((a,b)=>a+b,0),0) };
 };
 results[`n${n}-${regime}`]={epoch:stats('epoch'),event:stats('event'),tct:pairedStats(selected.map(r=>r.epoch),selected.map(r=>r.event),'sumTaskCompletionTime'),makespan:pairedStats(selected.map(r=>r.epoch),selected.map(r=>r.event),'makespan')};
}
writeFileSync(`${out}/summary.json`,JSON.stringify(results,null,2));
