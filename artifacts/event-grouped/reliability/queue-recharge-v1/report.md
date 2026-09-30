# Preserve grouped speed; improve completion through queue-aware recharge

All 1,980 frozen acceptance scenarios were run. The main scoreboard is the 900 recoverable scenarios. Grouped-v4 and EVENT remain unchanged recorded controls. Recharge is an optional boolean on the same grouped allocator, not a replacement allocator.

| Recoverable suite | EVENT ONLY | GROUPED BEFORE | GROUPED + QUEUE RECHARGE |
| --- | ---: | ---: | ---: |
| Completion % | 96.22% | 88.44% | 91.44% |
| Paired TCT reduction vs STOPWAIT | 54.82% | 68.87% | 67.54% |
| Makespan reduction vs STOPWAIT | 41.95% | 56.07% | 54.56% |
| Mean release→ownership (ticks) | 18.55 | 4.55 | 4.73 |
| Median certification latency (ticks) | 1.00 | 1.00 | 1.00 |
| Messages/peer/tick (logical sends) | 5.53 | 4.20 | 4.57 |
| Audited safety violations | 0 | 0 | 0 |
| Duplicate executable-owner violations | 0 | 0 | 0 |

Speed columns use their own mutually complete populations; completion includes every scenario. The direct BEFORE→RECHARGE comparison isolates the optional charging change.

## Direct paired comparisons

| Baseline→RECHARGE | Complete pairs | TCT reduction | 95% bootstrap CI | Makespan reduction |
| --- | ---: | ---: | --- | ---: |
| GROUPED BEFORE | 773/900 | -2.18% | -4.03%–-0.42% | -2.21% |
| EVENT | 795/900 | 25.75% | 23.58%–27.78% | 21.02% |
| STOPWAIT | 556/900 | 67.54% | 66.38%–68.65% | 54.56% |
| OLD DISTRIB | 804/900 | 64.82% | 63.74%–65.80% | 51.11% |

Positive reduction means RECHARGE is faster. Negative reduction means a speed penalty.

Completion changed by +3.00 percentage points versus grouped-v4. Recharge recovered 50 scenarios that grouped-v4 failed, while losing 23 scenarios grouped-v4 completed. This reports both sides rather than only recovered cases.

## Fleet sizes

| N | EVENT completion | BEFORE completion | RECHARGE completion | BEFORE→RECHARGE TCT reduction | STOPWAIT→RECHARGE TCT reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 | 97.33% | 92.00% | 95.33% | -3.35% | 72.01% |
| 5 | 95.67% | 96.33% | 97.00% | -2.35% | 65.16% |
| 8 | 95.67% | 77.00% | 82.00% | -0.32% | 47.40% |

## Throughput and energy

| Metric | BEFORE | RECHARGE |
| --- | ---: | ---: |
| Rejected energy checks | 95625.00 | 57292.00 |
| Rejected checks/robot/tick | 0.06 | 0.04 |
| Total logical ownership sends | 6470040.00 | 6113448.00 |
| Average certified bundle size | 1.01 | 1.02 |
| Median certified bundle size | 1.00 | 1.00 |
| Tasks/proposed group | 1.86 | 1.90 |
| Proposal revisions/task | 2.06 | 2.16 |
| Queued tasks/robot/tick | 0.08 | 0.10 |

The inherited summary field `energyHoldRobotTicks` is the runtime energyHolds counter: rejected moveAllowed evaluations, potentially multiple checks for one robot in a tick. It is not a unique count of held robot ticks. Message counts are logical sends, not DDS bytes; both total and normalized counts are shown.

## Exact change

The grouped allocation, bundle scorer, task grouping, set packing, certificates, queue reservations and custody mechanism are unchanged. An unloaded robot previously could pass the charging layer’s active-task-only affordability test while failing the execution layer’s full-queue energy guard. Repeated rejected moves could therefore leave it waiting without starting recharge.

The optional groupedQueueRecharge flag makes recharge readiness depend on the same full-queue guard. A pre-pickup rejected energy move also triggers a recharge check on the next tick, including when a feasible static path understates the energy of the actual attempted move. The robot retains its tasks, order, votes and custody intent. Existing decentralized charging and motion exclusion handle the charger trip. Pickup remains fenced until its entire remaining bundle is feasible and its ownership certificate is valid.

No energy check is deleted. The 15% execution reserve, queue limits and payload checks remain. Loaded cargo still follows the existing conservative delivery/recovery branch; this experiment does not route unaffordable loaded cargo to a charger or reassign it. Majority certificates remain required before task execution. Default epoch and EVENT paths receive the unchanged default charging condition.

## Development first

Complete disjoint development block: 1,980 scenarios. Aggregate completion BEFORE 87.02%; RECHARGE 89.90%. Recoverable completion BEFORE 85.67%; RECHARGE 89.67%. Direct recoverable TCT reduction -2.97%.

The gate was recorded before the development run: zero safety violations, improved completion versus grouped control, and explicit reporting of any TCT penalty. Acceptance uses the same source hashes and algorithm. No acceptance scenarios were used for tuning; no seeds, maps, release times, priorities, batteries, payloads, fleet sizes, horizon, baseline, motion policy, A* or metric formula changed.

## Regression evidence and limits

Full npm test: 610 passed, 20 skipped. Targeted grouped/charging/runtime tests: 37 passed, including successful recharge with sticky custody and loaded-cargo fencing. TypeScript, fleet build and production webpack build passed. New final-code checks reproduced both old epoch and recorded EVENT on all 1,980 scenarios each. The grouped control is also replayed in three cases for each fleet/regime cell before treatment. Every acceptance A row is replayed and compared exactly.

The previous ROS2/software fleet gates passed; prior Nav2 N=8 failed twice with a progress error and remains unresolved. This charging experiment does not claim to fix or revalidate that hardware-path gate. Grouped recharge is measured in the simulator and tests, not deployed on a hardware fleet. Loaded-cargo energy/recovery limitations remain. Frozen speed statistics condition on mutually complete pairs; failed runs are never assigned artificial completion times.

## Reproduction

Run `vite-node scripts/grouped-recharge-benchmark.ts --final` for development, then `vite-node scripts/grouped-recharge-benchmark.ts --acceptance --final` for acceptance. Verify with `python3 scripts/verify-grouped-recharge.py` and format this report with `python3 scripts/report-grouped-recharge.py`. All rows, source hashes, summaries, verification files and source snapshots are retained here. Historical controls are untouched. Publication remains on hold.
