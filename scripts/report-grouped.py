"""Report frozen measurements only; never alter runs or simulation policy."""
import gzip
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped/phase3/grouped-v4'
summary = json.loads((out / 'acceptance/summary.json').read_text())
previous = json.loads((root / 'artifacts/event-grouped/acceptance-event-single/summary.json').read_text())
dev = json.loads((out / 'development/summary.json').read_text())
rec = summary['n0-recoverable']
old = previous['n0-recoverable']
diagnostics = json.loads((out / 'acceptance/task-flow-diagnostics.json').read_text())['n0-recoverable']
def pct(v):
    return 'unmeasured' if v is None else f'{100*v:.2f}%'
def num(v):
    return 'unmeasured' if v is None else f'{v:.2f}'
def comparison(s, key, metric='sumTaskCompletionTime'):
    return s[key][metric]['aggregateReduction']

names = ['stopwait', 'old', 'event', 'grouped']
m = rec['metrics']
lines = ['# Phase 3: event-only versus event plus grouped allocation', '',
         'All 1,980 frozen acceptance scenarios are included; this scoreboard covers the 900 recoverable scenarios. Speed uses mutually complete pairs; reliability uses every scenario. Each column’s speed reduction is relative to stop-and-wait on its own mutually complete population. The direct EVENT→GROUPED comparison below isolates grouping.', '',
         '| Recoverable suite | STOPWAIT | OLD DISTRIB | EVENT ONLY | EVENT+GROUPED |',
         '| --- | ---: | ---: | ---: | ---: |']
tct = [0, comparison(old, 'A_to_D'), comparison(old, 'A_to_event'), comparison(rec, 'A_to_GROUPED')]
ms = [0, comparison(old, 'A_to_D', 'makespan'), comparison(old, 'A_to_event', 'makespan'), comparison(rec, 'A_to_GROUPED', 'makespan')]
table = [
    ('Completion %', [pct(m[n]['completionRate']) for n in names]),
    ('Paired TCT reduction vs STOPWAIT', [pct(x) for x in tct]),
    ('Makespan reduction vs STOPWAIT', [pct(x) for x in ms]),
    ('Mean release→ownership (ticks)', [num(m[n]['meanReleaseToOwnership']) for n in names]),
    ('Median certification latency (ticks)', [num(m[n]['medianCertificationLatency']) for n in names]),
    ('Messages/peer/tick (broadcast sends)', [num(m[n]['broadcastsPerPeerTick']) for n in names]),
    ('Audited safety violations', [str(sum(m[n]['safety'].values())) for n in names]),
    ('Duplicate executable-owner violations', [str(m[n]['duplicateExecutableOwnerRobotTicks']) if m[n]['duplicateExecutableOwnerRobotTicks'] is not None else 'unmeasured' for n in names]),
]
for label, values in table:
    lines.append('| ' + ' | '.join([label, *values]) + ' |')
lines += ['', '## Paired results', '', '| Comparison | Complete pairs | TCT reduction | 95% bootstrap CI | Makespan reduction |', '| --- | ---: | ---: | --- | ---: |']
for label, key in [('EVENT→GROUPED', 'EVENT_to_GROUPED'), ('STOPWAIT→GROUPED', 'A_to_GROUPED'), ('OLD DISTRIB→GROUPED', 'D_to_GROUPED')]:
    t = rec[key]['sumTaskCompletionTime']; ci = t['aggregateReduction95CI']
    lines.append(f"| {label} | {t['pairedCompleteCount']}/900 | {pct(t['aggregateReduction'])} | {pct(ci[0])}–{pct(ci[1])} | {pct(comparison(rec,key,'makespan'))} |")
lines += ['', 'Positive reduction means GROUPED is faster; negative means slower.', '', '## Fleet sizes', '', '| N | GROUPED completion | EVENT completion | STOPWAIT→GROUPED TCT | EVENT→GROUPED TCT | STOPWAIT→GROUPED pairs |', '| --- | ---: | ---: | ---: | ---: | ---: |']
for n in [3,5,8]:
    s = summary[f'n{n}-recoverable']
    lines.append(f"| {n} | {pct(s['metrics']['grouped']['completionRate'])} | {pct(s['metrics']['event']['completionRate'])} | {pct(comparison(s,'A_to_GROUPED'))} | {pct(comparison(s,'EVENT_to_GROUPED'))} | {s['A_to_GROUPED']['sumTaskCompletionTime']['pairedCompleteCount']} |")
lines += ['', '## Allocation diagnostics (recoverable)', '', '| Metric | EVENT | GROUPED |', '| --- | ---: | ---: |']
for key in ['averageBundleSize','medianBundleSize','meanTasksPerProposedGroup','proposalRetriesPerTask','meanQueuedTasksPerRobotTick','energyHoldRobotTicks','energyHoldsPerRobotTick','messages']:
    lines.append(f"| {key} | {num(m['event'][key])} | {num(m['grouped'][key])} |")
gain = comparison(rec, 'EVENT_to_GROUPED')
reliability_delta = m['grouped']['completionRate']-m['event']['completionRate']
lines += ['', '## Answers', '',
          f"1. Grouping {'improved' if gain>0 else 'hurt'} EVENT-only paired TCT by {pct(abs(gain))} on mutually complete pairs.",
          f"2. Completion {'improved' if reliability_delta>0 else 'fell'} by {abs(100*reliability_delta):.2f} percentage points.",
          f"3. Admission became faster: mean release→ownership changed from {num(m['event']['meanReleaseToOwnership'])} to {num(m['grouped']['meanReleaseToOwnership'])} ticks. Energy-hold robot ticks changed from {m['event']['energyHoldRobotTicks']} to {m['grouped']['energyHoldRobotTicks']}. Full-queue feasibility is conservative; these are observed associations rather than a causal isolation of each subcomponent. Certified bundles average {num(m['grouped']['averageBundleSize'])} tasks, so this does not establish a large multi-task-bundle advantage.",
          f"4. Final GROUPED SIH paired TCT reduction versus STOPWAIT: {pct(comparison(rec,'A_to_GROUPED'))}.",
          '5. Faster completion of successful runs does not make GROUPED an unconditional overall improvement. Prefer EVENT-only for this experiment while grouped reliability and the unresolved Nav2 regression gate remain open. Production remains epoch by default.' if gain>0 and reliability_delta<0 else '5. Use the direct speed comparison and unconditional completion rates together; no production promotion is implied.', '',
          f"GROUPED−EVENT mean release→ownership: {m['grouped']['meanReleaseToOwnership']-m['event']['meanReleaseToOwnership']:.2f} ticks. Energy-hold total delta: {m['grouped']['energyHoldRobotTicks']-m['event']['energyHoldRobotTicks']:+d} robot ticks. Total message delta: {m['grouped']['messages']-m['event']['messages']:+d}; normalized message-rate delta: {m['grouped']['broadcastsPerPeerTick']-m['event']['broadcastsPerPeerTick']:+.3f} broadcasts/peer/tick."]
lines += ['', '## Same-pair task-flow decomposition', '',
          f"Only the same {diagnostics['pairedCompleteRuns']} mutually complete EVENT/GROUPED scenarios appear in both columns below. This avoids comparing different completed-task populations.", '',
          '| Mean ticks/task | EVENT | GROUPED |', '| --- | ---: | ---: |']
for key in ['releaseToOwnership','ownershipToPickup','pickupToCompletion','releaseToCompletion']:
    f = diagnostics['pairedCompleteTaskFlow']
    lines.append(f"| {key} | {num(f['event'][key]['mean'])} | {num(f['grouped'][key]['mean'])} |")
failure = diagnostics['eventCompleteGroupedIncomplete']
lines += ['', f"EVENT completed but GROUPED did not in {failure['runs']} scenarios. GROUPED left {failure['unfinishedTasks']} unfinished tasks in those runs: {failure['neverAssigned']} never assigned, {failure['assignedUnpicked']} assigned but not picked up, {failure['pickedUncompleted']} picked up but incomplete. The corresponding energy-hold counts are {failure['eventEnergyHoldRobotTicks']} EVENT versus {failure['groupedEnergyHoldRobotTicks']} GROUPED robot ticks. Mean ownership latency excludes never-assigned tasks; they are not counted as zero or as completed work."]
lines += ['', '## Development gate', '',
          f"Complete disjoint development block: {dev['n0-all']['metrics']['grouped']['runs']} scenarios; completion {pct(dev['n0-all']['metrics']['grouped']['completionRate'])}. Recoverable EVENT→GROUPED paired TCT reduction: {pct(comparison(dev['n0-recoverable'],'EVENT_to_GROUPED'))}. The predeclared catastrophic completion floor was 80%; every audited safety counter must be zero.", '',
          '## Exact algorithms and safety', '',
          'The production epoch path first announces immutable task data, then selects a priority/release/id frontier of max(1, floor(N/2)) fresh tasks. Its generation is floor(tick/32), with bids at phase 3 and proposals from phase 4. A proposer is the lexicographically first live bidder; peers independently reconstruct the winner, each voting once per task/generation. A strict majority floor(N/2)+1 establishes the lease, which expires at the next generation boundary. Runtime execution also requires live quorum reachability and the applicable custody/completion checkpoints. Announcements, grants and checkpoints retain the existing bounded healing behavior.', '',
          'EVENT retains the epoch ownership protocol and its fixed membership, per-task generation votes, leases, majority certificates, custody and completion checkpoints. Fresh bidding/proposal starts on eligibility rather than waiting for the periodic phase. This phase does not redesign it.', '',
          'GROUPED derives canonical spatial orders from announced immutable task data, then partitions up to four tasks per episode. Robots disclose ordered-subset offers using their own active work and queues. The existing bid scorer remains unchanged. Full active and queued travel duration, inter-task travel, payload, queue capacity, battery reserve, priority and deadlines contribute to bundle feasibility/cost. Deterministic set packing maximizes admitted task coverage, then minimizes bundle cost, with stable ties. Each robot wins at most one bundle in an episode and each task appears once.', '',
          'Peers independently reconstruct winners. Queue reservations fence competing bundles. A selected owner rechecks the full bundle before granting. Every task still needs a majority certificate; execution additionally requires the owner’s grant and certificates for its whole ordered bundle. Same-generation conflicting votes remain rejected. Certified work order is installed only after certification. Custody remains sticky after pickup intent; a loaded crash cannot create a second cargo owner. Pre-custody dead-owner recovery goes through grouped feasibility checks. Execution and physical pickup recheck remaining commitments against the 15% execution reserve; the 20% fresh-bid admission floor remains intact.', '',
          'Grouping uses own state, announced tasks, and received membership data. No central scheduler, future task data or hidden peer state is used. Simulation assumes honest peers, fixed roster, shared tick clock and crash-stop failures. This is not a Byzantine or restart-persistence proof.', '',
          '## Regressions', '',
          'Full npm test: 608 passed, 20 skipped. TypeScript, production webpack build, fleet build and ROS2 tests (including real DDS) passed. New grouped tests: 25 passed, including tick-by-tick ownership uniqueness, concurrency, crashes, partitions, stale/duplicate/reordered messages, capacity and energy changes. Event-only fault scenarios: 30, all safe. Software fleets N=1/3/5/8 passed; Nav2 N=3/5 passed. Nav2 N=8 failed twice, including an isolated rerun, with controller progress error status=6/code=105 and no recorded collisions. This is an unresolved regression gate; no claim that all regressions pass is made. Both failed logs are retained. Grouped mode remains optional.', '',
          '## Measurement limitations', '',
          'Message counts are logical ownership broadcast sends, not DDS bytes; fanout grows with fleet size. Certification latency is first eligible tick to first certificate and includes waits/retries. Mean release→ownership includes every first-assigned task, including incomplete runs. Proposal retries are distinct proposal revisions beyond the first per task. Actual average bundle sizes count deduplicated certified robot bundles. Runtime and transport regression gates use the default epoch mode; grouped behavior is tested in the simulator and hostile ownership tests, not deployed on a hardware fleet.', '',
          '## Failed and superseded development experiments', '',
          'v1 incorrectly applied the 20% new-bid floor to certified execution, stranding feasible work; stopped after 263 scenarios. v2 corrected the reserve but retained speculative ordering and incomplete grouped crash recovery; stopped after 625. v3 corrected those issues but recalculated offers too frequently and lacked the final full-queue pickup gate; stopped after 732. These partial runs are preserved separately and are not acceptance results. Final v4 refreshes offers on useful state changes and always refreshes owner feasibility before granting. No policy was changed between final development and acceptance.', '',
          'Evidence: development/ and acceptance/ contain all scenario rows, summaries, source hashes and provenance. Reproduce with `vite-node scripts/grouped-benchmark.ts --final`, then `vite-node scripts/grouped-benchmark.ts --acceptance --final`, then `python3 scripts/report-grouped.py`. Frozen A is replayed and checked exactly for every acceptance scenario. Separate final-code replays reproduced both frozen D and recorded EVENT on all 1,980 scenarios exactly; logs and verification files are in regression/. Historical artifacts remain untouched. Publication is on hold.']
(out / 'report.md').write_text('\n'.join(lines) + '\n')
print('\n'.join(lines[:16]))
