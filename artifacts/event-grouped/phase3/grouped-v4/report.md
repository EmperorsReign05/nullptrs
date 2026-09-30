# Phase 3: event-only versus event plus grouped allocation

All 1,980 frozen acceptance scenarios are included; this scoreboard covers the 900 recoverable scenarios. Speed uses mutually complete pairs; reliability uses every scenario. Each column’s speed reduction is relative to stop-and-wait on its own mutually complete population. The direct EVENT→GROUPED comparison below isolates grouping.

| Recoverable suite | STOPWAIT | OLD DISTRIB | EVENT ONLY | EVENT+GROUPED |
| --- | ---: | ---: | ---: | ---: |
| Completion % | 66.89% | 97.56% | 96.22% | 88.44% |
| Paired TCT reduction vs STOPWAIT | 0.00% | 2.32% | 54.82% | 68.87% |
| Makespan reduction vs STOPWAIT | 0.00% | 1.83% | 41.95% | 56.07% |
| Mean release→ownership (ticks) | 81.75 | 81.71 | 18.55 | 4.55 |
| Median certification latency (ticks) | 21.00 | 22.00 | 1.00 | 1.00 |
| Messages/peer/tick (broadcast sends) | 2.91 | 4.55 | 5.53 | 4.20 |
| Audited safety violations | 0 | 0 | 0 | 0 |
| Duplicate executable-owner violations | 0 | 0 | 0 | 0 |

## Paired results

| Comparison | Complete pairs | TCT reduction | 95% bootstrap CI | Makespan reduction |
| --- | ---: | ---: | --- | ---: |
| EVENT→GROUPED | 766/900 | 27.80% | 25.83%–29.66% | 22.87% |
| STOPWAIT→GROUPED | 544/900 | 68.87% | 67.86%–69.83% | 56.07% |
| OLD DISTRIB→GROUPED | 776/900 | 66.12% | 65.15%–67.03% | 52.72% |

Positive reduction means GROUPED is faster; negative means slower.

## Fleet sizes

| N | GROUPED completion | EVENT completion | STOPWAIT→GROUPED TCT | EVENT→GROUPED TCT | STOPWAIT→GROUPED pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 | 92.00% | 97.33% | 73.65% | 40.39% | 243 |
| 5 | 96.33% | 95.67% | 66.47% | 24.60% | 197 |
| 8 | 77.00% | 95.67% | 47.18% | 2.59% | 104 |

## Allocation diagnostics (recoverable)

| Metric | EVENT | GROUPED |
| --- | ---: | ---: |
| averageBundleSize | 1.00 | 1.01 |
| medianBundleSize | 1.00 | 1.00 |
| meanTasksPerProposedGroup | 1.00 | 1.86 |
| proposalRetriesPerTask | unmeasured | 2.06 |
| meanQueuedTasksPerRobotTick | unmeasured | 0.08 |
| energyHoldRobotTicks | 52408.00 | 95625.00 |
| energyHoldsPerRobotTick | 0.05 | 0.06 |
| messages | 5660133.00 | 6470040.00 |

## Answers

1. Grouping improved EVENT-only paired TCT by 27.80% on mutually complete pairs.
2. Completion fell by 7.78 percentage points.
3. Admission became faster: mean release→ownership changed from 18.55 to 4.55 ticks. Energy-hold robot ticks changed from 52408 to 95625. Full-queue feasibility is conservative; these are observed associations rather than a causal isolation of each subcomponent. Certified bundles average 1.01 tasks, so this does not establish a large multi-task-bundle advantage.
4. Final GROUPED SIH paired TCT reduction versus STOPWAIT: 68.87%.
5. Faster completion of successful runs does not make GROUPED an unconditional overall improvement. Prefer EVENT-only for this experiment while grouped reliability and the unresolved Nav2 regression gate remain open. Production remains epoch by default.

GROUPED−EVENT mean release→ownership: -13.99 ticks. Energy-hold total delta: +43217 robot ticks. Total message delta: +809907; normalized message-rate delta: -1.334 broadcasts/peer/tick.

## Same-pair task-flow decomposition

Only the same 766 mutually complete EVENT/GROUPED scenarios appear in both columns below. This avoids comparing different completed-task populations.

| Mean ticks/task | EVENT | GROUPED |
| --- | ---: | ---: |
| releaseToOwnership | 19.05 | 4.49 |
| ownershipToPickup | 21.63 | 19.55 |
| pickupToCompletion | 15.10 | 16.24 |
| releaseToCompletion | 55.78 | 40.28 |

EVENT completed but GROUPED did not in 100 scenarios. GROUPED left 443 unfinished tasks in those runs: 340 never assigned, 51 assigned but not picked up, 52 picked up but incomplete. The corresponding energy-hold counts are 26 EVENT versus 89367 GROUPED robot ticks. Mean ownership latency excludes never-assigned tasks; they are not counted as zero or as completed work.

## Development gate

Complete disjoint development block: 1980 scenarios; completion 87.02%. Recoverable EVENT→GROUPED paired TCT reduction: 26.67%. The predeclared catastrophic completion floor was 80%; every audited safety counter must be zero.

## Exact algorithms and safety

The production epoch path first announces immutable task data, then selects a priority/release/id frontier of max(1, floor(N/2)) fresh tasks. Its generation is floor(tick/32), with bids at phase 3 and proposals from phase 4. A proposer is the lexicographically first live bidder; peers independently reconstruct the winner, each voting once per task/generation. A strict majority floor(N/2)+1 establishes the lease, which expires at the next generation boundary. Runtime execution also requires live quorum reachability and the applicable custody/completion checkpoints. Announcements, grants and checkpoints retain the existing bounded healing behavior.

EVENT retains the epoch ownership protocol and its fixed membership, per-task generation votes, leases, majority certificates, custody and completion checkpoints. Fresh bidding/proposal starts on eligibility rather than waiting for the periodic phase. This phase does not redesign it.

GROUPED derives canonical spatial orders from announced immutable task data, then partitions up to four tasks per episode. Robots disclose ordered-subset offers using their own active work and queues. The existing bid scorer remains unchanged. Full active and queued travel duration, inter-task travel, payload, queue capacity, battery reserve, priority and deadlines contribute to bundle feasibility/cost. Deterministic set packing maximizes admitted task coverage, then minimizes bundle cost, with stable ties. Each robot wins at most one bundle in an episode and each task appears once.

Peers independently reconstruct winners. Queue reservations fence competing bundles. A selected owner rechecks the full bundle before granting. Every task still needs a majority certificate; execution additionally requires the owner’s grant and certificates for its whole ordered bundle. Same-generation conflicting votes remain rejected. Certified work order is installed only after certification. Custody remains sticky after pickup intent; a loaded crash cannot create a second cargo owner. Pre-custody dead-owner recovery goes through grouped feasibility checks. Execution and physical pickup recheck remaining commitments against the 15% execution reserve; the 20% fresh-bid admission floor remains intact.

Grouping uses own state, announced tasks, and received membership data. No central scheduler, future task data or hidden peer state is used. Simulation assumes honest peers, fixed roster, shared tick clock and crash-stop failures. This is not a Byzantine or restart-persistence proof.

## Regressions

Full npm test: 608 passed, 20 skipped. TypeScript, production webpack build, fleet build and ROS2 tests (including real DDS) passed. New grouped tests: 25 passed, including tick-by-tick ownership uniqueness, concurrency, crashes, partitions, stale/duplicate/reordered messages, capacity and energy changes. Event-only fault scenarios: 30, all safe. Software fleets N=1/3/5/8 passed; Nav2 N=3/5 passed. Nav2 N=8 failed twice, including an isolated rerun, with controller progress error status=6/code=105 and no recorded collisions. This is an unresolved regression gate; no claim that all regressions pass is made. Both failed logs are retained. Grouped mode remains optional.

## Measurement limitations

Message counts are logical ownership broadcast sends, not DDS bytes; fanout grows with fleet size. Certification latency is first eligible tick to first certificate and includes waits/retries. Mean release→ownership includes every first-assigned task, including incomplete runs. Proposal retries are distinct proposal revisions beyond the first per task. Actual average bundle sizes count deduplicated certified robot bundles. Runtime and transport regression gates use the default epoch mode; grouped behavior is tested in the simulator and hostile ownership tests, not deployed on a hardware fleet.

## Failed and superseded development experiments

v1 incorrectly applied the 20% new-bid floor to certified execution, stranding feasible work; stopped after 263 scenarios. v2 corrected the reserve but retained speculative ordering and incomplete grouped crash recovery; stopped after 625. v3 corrected those issues but recalculated offers too frequently and lacked the final full-queue pickup gate; stopped after 732. These partial runs are preserved separately and are not acceptance results. Final v4 refreshes offers on useful state changes and always refreshes owner feasibility before granting. No policy was changed between final development and acceptance.

Evidence: development/ and acceptance/ contain all scenario rows, summaries, source hashes and provenance. Reproduce with `vite-node scripts/grouped-benchmark.ts --final`, then `vite-node scripts/grouped-benchmark.ts --acceptance --final`, then `python3 scripts/report-grouped.py`. Frozen A is replayed and checked exactly for every acceptance scenario. Separate final-code replays reproduced both frozen D and recorded EVENT on all 1,980 scenarios exactly; logs and verification files are in regression/. Historical artifacts remain untouched. Publication is on hold.
