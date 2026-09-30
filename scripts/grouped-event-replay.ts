/** Exact unchanged event-only replay; no policy or historical artifact mutations. */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runArm, type ArmRun } from '../src/core/bench/sih/runner';
import { loadSuite } from '../src/core/bench/sih/evaluate';
const reference: ArmRun[] = JSON.parse(gunzipSync(readFileSync('artifacts/event-grouped/acceptance-event-single/per-scenario.json.gz')).toString()).map((r: {event: ArmRun}) => r.event);
const lookup = new Map(reference.map(r => [r.scenarioId, r]));
const strip = (r: ArmRun) => {
  const { ownershipTelemetry, ...row } = r;
  return { ...row, tasks: row.tasks.map(({ ownershipStages, ...task }) => task) };
};
const suite = loadSuite('acceptance');
let exact = 0;
for (const scenario of suite) {
  const row = runArm(scenario, 'D', undefined, 'event-single');
  if (JSON.stringify(strip(row)) !== JSON.stringify(strip(lookup.get(scenario.id)!))) {
    throw new Error(`Event-only regression: ${scenario.id}`);
  }
  exact++;
  if (exact % 100 === 0) console.log(`${exact}/${suite.length}`);
}
const result = { scenarios: suite.length, exactEventOnlyRows: exact, reference: 'Recorded 54.82% event-only acceptance experiment' };
writeFileSync('artifacts/event-grouped/phase3/grouped-v4/regression/event-only-replay.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
