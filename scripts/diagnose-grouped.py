"""Task-flow and censored failure diagnostics from recorded rows only."""
import gzip
import json
from pathlib import Path
from statistics import mean, median

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped/phase3/grouped-v4'
for block in ['development', 'acceptance']:
    directory = out / block
    if not (directory / 'per-scenario.json.gz').exists():
        continue
    rows = json.loads(gzip.decompress((directory / 'per-scenario.json.gz').read_bytes()))
    result = {}
    for n in [0,3,5,8]:
        for regime in ['all','low','recoverable','severe']:
            selected = [r for r in rows if (not n or r['grouped']['fleetSize'] == n) and (regime == 'all' or r['grouped']['regime'] == regime)]
            complete = [r for r in selected if r['event']['completed'] and r['grouped']['completed']]
            cell = {'pairedCompleteRuns': len(complete), 'pairedCompleteTaskFlow': {}}
            for arm in ['event','grouped']:
                tasks = [t for r in complete for t in r[arm]['tasks']]
                stats = {}
                for key, start, end in [('releaseToOwnership','createdAt','firstAssignedTick'), ('ownershipToPickup','firstAssignedTick','pickedUpTick'), ('pickupToCompletion','pickedUpTick','completedTick'), ('releaseToCompletion','createdAt','completedTick')]:
                    durations = [t[end]-t[start] for t in tasks if t[end] is not None and t[start] is not None]
                    stats[key] = {'mean': mean(durations), 'median': median(durations), 'tasks': len(durations)} if durations else None
                cell['pairedCompleteTaskFlow'][arm] = stats
            failures = [r for r in selected if r['event']['completed'] and not r['grouped']['completed']]
            unfinished = [t for r in failures for t in r['grouped']['tasks'] if t['completedTick'] is None]
            cell['eventCompleteGroupedIncomplete'] = {
                'runs': len(failures), 'unfinishedTasks': len(unfinished),
                'neverAssigned': sum(t['firstAssignedTick'] is None for t in unfinished),
                'assignedUnpicked': sum(t['firstAssignedTick'] is not None and t['pickedUpTick'] is None for t in unfinished),
                'pickedUncompleted': sum(t['pickedUpTick'] is not None for t in unfinished),
                'groupedEnergyHoldRobotTicks': sum(r['grouped']['energyHoldTicks'] for r in failures),
                'eventEnergyHoldRobotTicks': sum(r['event']['energyHoldTicks'] for r in failures),
                'interpretation': 'Descriptive associations; no causal ablation. Grouped execution conservatively rechecks full remaining commitments.'
            }
            result[f'n{n}-{regime}'] = cell
    (directory / 'task-flow-diagnostics.json').write_text(json.dumps(result, indent=2)+'\n')
    print(block, json.dumps(result['n0-recoverable'], indent=2))
