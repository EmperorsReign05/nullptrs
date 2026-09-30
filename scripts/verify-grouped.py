"""Independent aggregate and frozen identity checks on saved benchmark rows."""
import gzip
import json
import math
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped/phase3/grouped-v4'
for block in (['development'] if '--development-only' in sys.argv else ['development', 'acceptance']):
    directory = out / block
    rows = json.loads(gzip.decompress((directory / 'per-scenario.json.gz').read_bytes()))
    summary = json.loads((directory / 'summary.json').read_text())
    assert len(rows) == 1980
    assert len({r['grouped']['scenarioId'] for r in rows}) == 1980
    checks = 0
    for row in rows:
        g = row['grouped']
        assert all(v == 0 for v in g['safety'].values())
        assert g['ownershipTelemetry']['duplicateExecutableOwners'] == 0
        for base in ['event'] + (['stopwait', 'old'] if block == 'acceptance' else []):
            b = row[base]
            assert b['scenarioId'] == g['scenarioId']
            assert [(t['id'], t['createdAt']) for t in b['tasks']] == [(t['id'], t['createdAt']) for t in g['tasks']]
    for n in [0,3,5,8]:
        for regime in ['all', 'low', 'recoverable', 'severe']:
            selected = [r for r in rows if (not n or r['grouped']['fleetSize'] == n) and (regime == 'all' or r['grouped']['regime'] == regime)]
            s = summary[f'n{n}-{regime}']
            assert s['metrics']['grouped']['runs'] == len(selected)
            rate = sum(r['grouped']['completed'] for r in selected) / len(selected)
            assert math.isclose(s['metrics']['grouped']['completionRate'], rate)
            for base, key in [('event', 'EVENT_to_GROUPED')] + ([('stopwait', 'A_to_GROUPED'), ('old', 'D_to_GROUPED')] if block == 'acceptance' else []):
                complete = [r for r in selected if r[base]['completed'] and r['grouped']['completed']]
                for metric in ['sumTaskCompletionTime', 'makespan']:
                    v = s[key][metric]
                    baseline = sum(r[base][metric] for r in complete)
                    treatment = sum(r['grouped'][metric] for r in complete)
                    assert v['pairedCompleteCount'] == len(complete)
                    assert v['baselineTotal'] == baseline and v['treatmentTotal'] == treatment
                    assert math.isclose(v['aggregateReduction'], 1-treatment/baseline)
                    checks += 1
    result = {'scenarios': len(rows), 'independentlyCheckedPairedComparisons': checks, 'allSafetyCountersZero': True, 'duplicateExecutableOwners': 0, 'taskIdsAndReleaseTicksMatch': True}
    (directory / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(block, result)
