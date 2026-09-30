"""Independent saved-row checks; no simulation or policy changes."""
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped/reliability/queue-recharge-v1'
blocks = ['development'] if '--development-only' in sys.argv else ['development','acceptance']
for block in blocks:
    directory = out / block
    rows = json.loads(gzip.decompress((directory/'per-scenario.json.gz').read_bytes()))
    summary = json.loads((directory/'summary.json').read_text())
    provenance = json.loads((directory/'provenance.json').read_text())
    assert len(rows) == 1980
    assert len({r['grouped']['scenarioId'] for r in rows}) == 1980
    for path, expected in provenance['hashes'].items():
        assert hashlib.sha256((root/path).read_bytes()).hexdigest() == expected, path
    controls = json.loads(gzip.decompress((root/f'artifacts/event-grouped/phase3/grouped-v4/{block}/per-scenario.json.gz').read_bytes()))
    controls = {r['grouped']['scenarioId']: r['grouped'] for r in controls}
    comparisons = [('control','GROUPED_to_RECHARGED'),('event','EVENT_to_GROUPED')]
    if block == 'acceptance':
        comparisons += [('stopwait','A_to_GROUPED'),('old','D_to_GROUPED')]
    for row in rows:
        treatment = row['grouped']
        assert all(v == 0 for v in treatment['safety'].values())
        assert treatment['ownershipTelemetry']['duplicateExecutableOwners'] == 0
        assert row['control'] == controls[treatment['scenarioId']]
        for arm, _ in comparisons:
            baseline = row[arm]
            assert baseline['scenarioId'] == treatment['scenarioId']
            assert [(t['id'],t['createdAt']) for t in baseline['tasks']] == [(t['id'],t['createdAt']) for t in treatment['tasks']]
    checks = 0
    for n in [0,3,5,8]:
        for regime in ['all','low','recoverable','severe']:
            selected = [r for r in rows if (not n or r['grouped']['fleetSize'] == n) and (regime == 'all' or r['grouped']['regime'] == regime)]
            s = summary[f'n{n}-{regime}']
            assert s['metrics']['grouped']['runs'] == len(selected)
            assert math.isclose(s['metrics']['grouped']['completionRate'],sum(r['grouped']['completed'] for r in selected)/len(selected))
            for arm, key in comparisons:
                complete = [r for r in selected if r[arm]['completed'] and r['grouped']['completed']]
                for metric in ['sumTaskCompletionTime','makespan']:
                    v = s[key][metric]
                    baseline = sum(r[arm][metric] for r in complete)
                    treatment = sum(r['grouped'][metric] for r in complete)
                    assert v['pairedCompleteCount'] == len(complete)
                    assert v['baselineTotal'] == baseline and v['treatmentTotal'] == treatment
                    assert math.isclose(v['aggregateReduction'],1-treatment/baseline)
                    checks += 1
    result = {'scenarios':len(rows),'independentlyCheckedPairedComparisons':checks,'sourceHashesMatch':True,'recordedGroupedControlUnchanged':True,'taskIdsAndReleaseTicksMatch':True,'allSafetyCountersZero':True,'duplicateExecutableOwners':0}
    (directory/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
    print(block,result)
