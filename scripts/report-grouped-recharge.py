"""Format fixed recharge measurements and the preserved historical controls."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root/'artifacts/event-grouped/reliability/queue-recharge-v1'
s = json.loads((out/'acceptance/summary.json').read_text())
dev = json.loads((out/'development/summary.json').read_text())
previous = json.loads((root/'artifacts/event-grouped/phase3/grouped-v4/acceptance/summary.json').read_text())
event = json.loads((root/'artifacts/event-grouped/acceptance-event-single/summary.json').read_text())
rec = s['n0-recoverable']; m = rec['metrics']
def pct(v): return 'unmeasured' if v is None else f'{100*v:.2f}%'
def num(v): return 'unmeasured' if v is None else f'{v:.2f}'
def reading(section,key,metric='sumTaskCompletionTime'): return section[key][metric]['aggregateReduction']
names = ['event','control','grouped']
lines = ['# Preserve grouped speed; improve completion through queue-aware recharge', '',
         'All 1,980 frozen acceptance scenarios were run. The main scoreboard is the 900 recoverable scenarios. Grouped-v4 and EVENT remain unchanged recorded controls. Recharge is an optional boolean on the same grouped allocator, not a replacement allocator.', '',
         '| Recoverable suite | EVENT ONLY | GROUPED BEFORE | GROUPED + QUEUE RECHARGE |',
         '| --- | ---: | ---: | ---: |']
tct = [reading(event['n0-recoverable'],'A_to_event'),reading(previous['n0-recoverable'],'A_to_GROUPED'),reading(rec,'A_to_GROUPED')]
ms = [reading(event['n0-recoverable'],'A_to_event','makespan'),reading(previous['n0-recoverable'],'A_to_GROUPED','makespan'),reading(rec,'A_to_GROUPED','makespan')]
for label,values in [
    ('Completion %',[pct(m[n]['completionRate']) for n in names]),
    ('Paired TCT reduction vs STOPWAIT',[pct(x) for x in tct]),
    ('Makespan reduction vs STOPWAIT',[pct(x) for x in ms]),
    ('Mean release→ownership (ticks)',[num(m[n]['meanReleaseToOwnership']) for n in names]),
    ('Median certification latency (ticks)',[num(m[n]['medianCertificationLatency']) for n in names]),
    ('Messages/peer/tick (logical sends)',[num(m[n]['broadcastsPerPeerTick']) for n in names]),
    ('Audited safety violations',[str(sum(m[n]['safety'].values())) for n in names]),
    ('Duplicate executable-owner violations',[str(m[n]['duplicateExecutableOwnerRobotTicks']) for n in names]),
]:
    lines.append('| '+' | '.join([label,*values])+' |')
lines += ['', 'Speed columns use their own mutually complete populations; completion includes every scenario. The direct BEFORE→RECHARGE comparison isolates the optional charging change.', '',
          '## Direct paired comparisons', '',
          '| Baseline→RECHARGE | Complete pairs | TCT reduction | 95% bootstrap CI | Makespan reduction |',
          '| --- | ---: | ---: | --- | ---: |']
for label,key in [('GROUPED BEFORE','GROUPED_to_RECHARGED'),('EVENT','EVENT_to_GROUPED'),('STOPWAIT','A_to_GROUPED'),('OLD DISTRIB','D_to_GROUPED')]:
    v=rec[key]['sumTaskCompletionTime']; ci=v['aggregateReduction95CI']
    lines.append(f"| {label} | {v['pairedCompleteCount']}/900 | {pct(v['aggregateReduction'])} | {pct(ci[0])}–{pct(ci[1])} | {pct(reading(rec,key,'makespan'))} |")
direct=rec['GROUPED_to_RECHARGED']['sumTaskCompletionTime']
delta=m['grouped']['completionRate']-m['control']['completionRate']
lines += ['', 'Positive reduction means RECHARGE is faster. Negative reduction means a speed penalty.', '',
          f"Completion changed by {100*delta:+.2f} percentage points versus grouped-v4. Recharge recovered {direct['treatmentOnlyComplete']} scenarios that grouped-v4 failed, while losing {direct['baselineOnlyComplete']} scenarios grouped-v4 completed. This reports both sides rather than only recovered cases.", '',
          '## Fleet sizes', '',
          '| N | EVENT completion | BEFORE completion | RECHARGE completion | BEFORE→RECHARGE TCT reduction | STOPWAIT→RECHARGE TCT reduction |',
          '| --- | ---: | ---: | ---: | ---: | ---: |']
for n in [3,5,8]:
    cell=s[f'n{n}-recoverable']; metrics=cell['metrics']
    lines.append(f"| {n} | {pct(metrics['event']['completionRate'])} | {pct(metrics['control']['completionRate'])} | {pct(metrics['grouped']['completionRate'])} | {pct(reading(cell,'GROUPED_to_RECHARGED'))} | {pct(reading(cell,'A_to_GROUPED'))} |")
lines += ['', '## Throughput and energy', '', '| Metric | BEFORE | RECHARGE |', '| --- | ---: | ---: |']
for key,label in [('energyHoldRobotTicks','Rejected energy checks'),('energyHoldsPerRobotTick','Rejected checks/robot/tick'),('messages','Total logical ownership sends'),('averageBundleSize','Average certified bundle size'),('medianBundleSize','Median certified bundle size'),('meanTasksPerProposedGroup','Tasks/proposed group'),('proposalRetriesPerTask','Proposal revisions/task'),('meanQueuedTasksPerRobotTick','Queued tasks/robot/tick')]:
    lines.append(f"| {label} | {num(m['control'][key])} | {num(m['grouped'][key])} |")
lines += ['', 'The inherited summary field `energyHoldRobotTicks` is the runtime energyHolds counter: rejected moveAllowed evaluations, potentially multiple checks for one robot in a tick. It is not a unique count of held robot ticks. Message counts are logical sends, not DDS bytes; both total and normalized counts are shown.', '',
          '## Exact change', '',
          'The grouped allocation, bundle scorer, task grouping, set packing, certificates, queue reservations and custody mechanism are unchanged. An unloaded robot previously could pass the charging layer’s active-task-only affordability test while failing the execution layer’s full-queue energy guard. Repeated rejected moves could therefore leave it waiting without starting recharge.', '',
          'The optional groupedQueueRecharge flag makes recharge readiness depend on the same full-queue guard. A pre-pickup rejected energy move also triggers a recharge check on the next tick, including when a feasible static path understates the energy of the actual attempted move. The robot retains its tasks, order, votes and custody intent. Existing decentralized charging and motion exclusion handle the charger trip. Pickup remains fenced until its entire remaining bundle is feasible and its ownership certificate is valid.', '',
          'No energy check is deleted. The 15% execution reserve, queue limits and payload checks remain. Loaded cargo still follows the existing conservative delivery/recovery branch; this experiment does not route unaffordable loaded cargo to a charger or reassign it. Majority certificates remain required before task execution. Default epoch and EVENT paths receive the unchanged default charging condition.', '',
          '## Development first', '',
          f"Complete disjoint development block: 1,980 scenarios. Aggregate completion BEFORE {pct(dev['n0-all']['metrics']['control']['completionRate'])}; RECHARGE {pct(dev['n0-all']['metrics']['grouped']['completionRate'])}. Recoverable completion BEFORE {pct(dev['n0-recoverable']['metrics']['control']['completionRate'])}; RECHARGE {pct(dev['n0-recoverable']['metrics']['grouped']['completionRate'])}. Direct recoverable TCT reduction {pct(reading(dev['n0-recoverable'],'GROUPED_to_RECHARGED'))}.", '',
          'The gate was recorded before the development run: zero safety violations, improved completion versus grouped control, and explicit reporting of any TCT penalty. Acceptance uses the same source hashes and algorithm. No acceptance scenarios were used for tuning; no seeds, maps, release times, priorities, batteries, payloads, fleet sizes, horizon, baseline, motion policy, A* or metric formula changed.', '',
          '## Regression evidence and limits', '',
          'Full npm test: 610 passed, 20 skipped. Targeted grouped/charging/runtime tests: 37 passed, including successful recharge with sticky custody and loaded-cargo fencing. TypeScript, fleet build and production webpack build passed. New final-code checks reproduced both old epoch and recorded EVENT on all 1,980 scenarios each. The grouped control is also replayed in three cases for each fleet/regime cell before treatment. Every acceptance A row is replayed and compared exactly.', '',
          'The previous ROS2/software fleet gates passed; prior Nav2 N=8 failed twice with a progress error and remains unresolved. This charging experiment does not claim to fix or revalidate that hardware-path gate. Grouped recharge is measured in the simulator and tests, not deployed on a hardware fleet. Loaded-cargo energy/recovery limitations remain. Frozen speed statistics condition on mutually complete pairs; failed runs are never assigned artificial completion times.', '',
          '## Reproduction', '',
          'Run `vite-node scripts/grouped-recharge-benchmark.ts --final` for development, then `vite-node scripts/grouped-recharge-benchmark.ts --acceptance --final` for acceptance. Verify with `python3 scripts/verify-grouped-recharge.py` and format this report with `python3 scripts/report-grouped-recharge.py`. All rows, source hashes, summaries, verification files and source snapshots are retained here. Historical controls are untouched. Publication remains on hold.']
(out/'report.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines[:18]))
