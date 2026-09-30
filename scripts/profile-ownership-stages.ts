import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { runArm } from '../src/core/bench/sih/runner';
import { loadSuite } from '../src/core/bench/sih/evaluate';
const suite = loadSuite('acceptance');
const out = 'artifacts/event-grouped/phase1';
mkdirSync(out, { recursive: true });
const rows = [];
for (const scenario of suite) {
  rows.push(runArm(scenario, 'D'));
  if (rows.length % 100 === 0) console.log(`${rows.length}/${suite.length}`);
}
writeFileSync(`${out}/D.json`, JSON.stringify(rows));
const stats = (values: number[]) => {
  values.sort((a,b)=>a-b);
  return { count: values.length, mean: values.reduce((a,b)=>a+b,0)/values.length, median: values[Math.floor(values.length/2)], p95: values[Math.floor(values.length*.95)] };
};
const report: Record<string, unknown> = {};
for (const n of [0,3,5,8]) for (const regime of ['all','low','recoverable','severe']) {
  const runs = rows.filter(r=>(!n || r.fleetSize===n) && (regime==='all' || r.regime===regime));
  const tasks = runs.flatMap(r=>r.tasks).filter(t=>t.firstAssignedTick!==null);
  const stages = ['firstAnnouncementTick','firstAuctionEligibleTick','firstBidTick','quorumBidTick','proposalTick','firstGrantTick','certificateTick'];
  report[`n${n}-${regime}`] = { runs: runs.length, completionRate: runs.filter(r=>r.completed).length/runs.length,
    releaseToOwnership: stats(tasks.map(t=>t.firstAssignedTick!-t.createdAt)),
    stages: Object.fromEntries(stages.map(stage=>[stage,stats(tasks.filter(t=>t.ownershipStages?.[stage]!==undefined).map(t=>t.ownershipStages![stage]-t.createdAt))])) };
}
writeFileSync(`${out}/summary.json`, JSON.stringify(report,null,2));
