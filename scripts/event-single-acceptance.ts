/** Evaluate the fixed phase-2 experiment. No tuning or scenario generation. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadSuite, provenance } from '../src/core/bench/sih/evaluate';
import { runArm, type ArmRun } from '../src/core/bench/sih/runner';
import { median, pairedStats } from '../src/core/bench/sih/stats';
const out = 'artifacts/event-grouped/acceptance-event-single';
mkdirSync(out, { recursive: true });
const suite = loadSuite('acceptance');
const frozen = JSON.parse(readFileSync('artifacts/sih-acceptance-v1/current/per-scenario.json','utf8'));
const permittedChanges = new Set(['src/core/distributed/ownership.ts', 'src/core/distributed/runtime.ts', 'src/core/bench/sih/runner.ts']);
for (const [path, expected] of Object.entries(frozen.provenance.sourceHashes)) {
  if (!permittedChanges.has(path) && createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
    throw new Error(`Frozen source changed: ${path}`);
  }
}
const indexed = (arm: string) => new Map<string, ArmRun>((frozen.runs as ArmRun[]).filter(r=>r.arm===arm).map(r=>[r.scenarioId,r]));
const baseline = indexed('A'), current = indexed('D');
if (baseline.size !== suite.length || current.size !== suite.length) throw new Error('Frozen evidence/suite size mismatch');
for (const s of suite) for (const index of [baseline,current]) {
  const row = index.get(s.id);
  if (!row || row.horizonTicks !== s.horizonTicks || row.tasksTotal !== s.tasks.length ||
      s.tasks.some(t=>!row.tasks.some(old=>old.id===t.id && old.createdAt===t.createdAt))) throw new Error(`Frozen row mismatch: ${s.id}`);
}
writeFileSync(`${out}/provenance.json`, JSON.stringify({
  ...provenance(), treatment: 'event-single with D bidding and distributed motion; not grouped H',
  baseline: 'unchanged recorded PR #28 A', current: 'unchanged recorded PR #28 D',
  acceptanceSuiteSha256:createHash('sha256').update(readFileSync('artifacts/sih-acceptance-v1/scenarios.json')).digest('hex'),
  frozenRowsSha256:createHash('sha256').update(readFileSync('artifacts/sih-acceptance-v1/current/per-scenario.json')).digest('hex'),
  userAuthorization:'User explicitly requested acceptance threshold evaluation after the phase-2 reliability stop.'
},null,2)+'\n');
const rows: { baseline: ArmRun; current: ArmRun; event: ArmRun }[] = [];
for (const scenario of suite) {
  rows.push({baseline:baseline.get(scenario.id)!,current:current.get(scenario.id)!,event:runArm(scenario,'D',undefined,'event-single')});
  if (rows.length % 100 === 0) console.log(`${rows.length}/${suite.length}`);
}
writeFileSync(`${out}/per-scenario.json.gz`,gzipSync(JSON.stringify(rows)));
function metrics(runs: ArmRun[]) {
  const delays = runs.flatMap(r=>r.tasks).filter(t=>t.firstAssignedTick!==null).map(t=>t.firstAssignedTick!-t.createdAt).sort((a,b)=>a-b);
  return {runs:runs.length,completed:runs.filter(r=>r.completed).length,completionRate:runs.filter(r=>r.completed).length/runs.length,
    tasksCompleted:runs.reduce((s,r)=>s+r.tasksCompleted,0),tasksTotal:runs.reduce((s,r)=>s+r.tasksTotal,0),
    releaseToOwnership:{population:'all first-assigned tasks, including incomplete runs',mean:delays.reduce((a,b)=>a+b,0)/delays.length,median:median(delays),p95:delays[Math.floor(delays.length*.95)]},
    safety:Object.fromEntries(Object.keys(runs[0].safety).map(k=>[k,runs.reduce((s,r)=>s+r.safety[k],0)])),
    duplicateExecutableOwnerRobotTicks:runs.every(r=>r.ownershipTelemetry!==undefined) ? runs.reduce((s,r)=>s+r.ownershipTelemetry!.duplicateExecutableOwners,0) : null};
}
const summary: Record<string,unknown> = {};
for (const n of [0,3,5,8]) for (const regime of ['all','low','recoverable','severe']) {
  const selected=rows.filter(r=>(!n||r.event.fleetSize===n)&&(regime==='all'||r.event.regime===regime));
  const arms={baseline:selected.map(r=>r.baseline),current:selected.map(r=>r.current),event:selected.map(r=>r.event)};
  summary[`n${n}-${regime}`]={
    metrics:Object.fromEntries(Object.entries(arms).map(([k,v])=>[k,metrics(v)])),
    A_to_event:{sumTaskCompletionTime:pairedStats(arms.baseline,arms.event,'sumTaskCompletionTime'),makespan:pairedStats(arms.baseline,arms.event,'makespan')},
    D_to_event:{sumTaskCompletionTime:pairedStats(arms.current,arms.event,'sumTaskCompletionTime'),makespan:pairedStats(arms.current,arms.event,'makespan')},
    A_to_D:{sumTaskCompletionTime:pairedStats(arms.baseline,arms.current,'sumTaskCompletionTime'),makespan:pairedStats(arms.baseline,arms.current,'makespan')},
  };
}
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary['n0-recoverable'],null,2));
