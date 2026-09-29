# Local bid inference and stronger comparators — not accepted

The learned scorer is retained as an opt-in experiment. **This evaluation does not support deploying it over the stronger deterministic alternatives.** No model retraining or acceptance-driven tuning occurred. The deterministic default and planner, simulator, distributed stack, and stop-and-wait implementation are unchanged by this work.

## What was implemented

`makeLocalBid` accepts a robot's own state, its own task records, the candidate task, static geometry, and explicitly received peer beacons. It does not accept a fleet world, simulator clock, or global lookup callback. Congestion is reconstructed from received poses; foreign tasks and injected global congestion cannot affect the result. Missing, stale, future, conflicting, or invalid-position beacons prevent learned promotion. Completeness means completeness of the caller's declared peer roster, not proof that the roster contains every relevant robot.

`selectLocalBid` compares explicitly supplied bid packets. Duplicate robots and mixed auction rounds are rejected. A winner change requires a bounded score gap, valid feature values, feasible bids, certified incumbent intent, nonnegative challenger task/queue/charging energy margin with the existing 15% reserve, and the reciprocal-intent/workload guards. The packet contract and selection function are **not a distributed consensus or task-ownership protocol**. No network integration is claimed.

The neural architecture remains 16 inputs → 16 tanh units → one scalar, 289 parameters, with at most a 10% deterministic-cost discount. Training remains **15,268 simulator-generated counterfactual actions across 256 seeds**, terminal-first loss. Feature order: travel, congestion, battery cost, workload, urgency, payload, queue depth, peer route contention, peer next-intent contention, charger distance, post-task charger distance, return-energy reserve, charger-unreachable flag, active route remaining, active-task flag, battery. Urgency is inactive in this workload.

## Experimental design

Development used 64 previously inspected seeds, 6000–6063. Sixteen deterministic weight combinations varied congestion, battery, payload and queue cost. Selection prioritized completed runs, then tasks, then elapsed time, and excluded candidates with a safety regression against original weights on development. The selected weights were travel 1, congestion 0, battery 4, workload 1, urgency 3, payload 0, queue 0. This limited search is not a claim of globally optimal tuning.

The deterministic heuristic uses a bounded discount proportional to spare energy and inversely proportional to queue depth and received route contention, with the same promotion guard. It was fixed before acceptance.

`frozen.json` records source/test hashes, the unchanged MLP, policies and **200 new seeds, 8000–8199**, before evaluation. All arms receive identical information through JSON-copied input values. The test transport delivers fresh beacons from the entire small fleet (radius 100, TTL 2), collects bids synchronously, and supplies the chosen winner to the unchanged dispatcher. Thus this is a local inference boundary under ideal communication, **not evidence of limited-range, lossy-network, independent-process auction operation**. Five regression seeds verify exact deterministic outcome parity for this transport. A feasibility mismatch between the adapter and dispatcher raises an error rather than silently falling back.

## Fresh acceptance

All arms use the same 200 seeds, 2800 tasks and 400-tick horizon. Capped failures are excluded from completion-speed statistics.

| Policy | Completed runs | Completed tasks | Zero-battery work, robot-ticks |
|---|---:|---:|---:|
| Original weights | 192/200 | 2781/2800 | 634 |
| Tuned deterministic | 193/200 | 2787/2800 | 230 |
| Guarded heuristic | 192/200 | 2785/2800 | 634 |
| Guarded MLP | 192/200 | 2781/2800 | 631 |

Every arm had zero collisions, swaps, blocked-cell violations, payload violations and queue violations. The MLP had no per-seed task-count or audited safety regression against original weights. It nevertheless **fails reliability and safety comparisons against the tuned deterministic arm**, and fails total-task reliability against the heuristic. A conditional speed advantage cannot override these failures.

| Comparator for MLP | Mutually completed pairs | Mean ticks saved | Median saved | Aggregate paired reduction | 95% paired-seed bootstrap CI, ticks | Win / tie / loss |
|---|---:|---:|---:|---:|---:|---:|
| Original weights | 192 | 1.0156 | 0 | 0.7702% | [0.0260, 2.0625] | 23 / 159 / 10 |
| Tuned deterministic | 190 | 3.5737 | 0 | 2.6680% | [1.1579, 5.9526] | 89 / 54 / 47 |
| Guarded heuristic | 191 | 0.3455 | 0 | 0.2634% | [-0.5393, 1.3141] | 17 / 160 / 14 |

The original/MLP paired means were **131.8646 / 130.8490 ticks**. These intervals use 10,000 whole-seed resamples, and are conditional on both policies completing; they are not end-to-end throughput guarantees or multiplicity-adjusted comparisons. There is no measurable MLP advantage over the guarded heuristic, and stronger reliability blocks acceptance regardless.

The MLP guard recorded 140 proposed-change evaluations: 88 allowed, 52 suppressed. These are **non-deduplicated scorer evaluations**, not unique auction decisions or causal counts. Actual paired-seed wins/ties/losses are reported above. The experiment did not run single-decision interventions for these new seeds; it does not assign individual savings to individual corrections.

Zero-battery events occurred on seeds 8018, 8031, 8108 under both original and learned policies: respectively 230/227, 203/203, 201/201 robot-ticks. No new learned-only battery failure appeared. The tuned comparator avoided the latter two events. Co-occurrence is not a causal diagnosis; no claim that these events are unavoidable planner defects is made. These seeds are now inspected and must not be reused as fresh acceptance for subsequent tuning.

## Host cost and limitations

Intel Core Ultra 9 185H, Linux x64, Node v24.18.0; warm-cache microbenchmark on one snapshot:

| Operation | Median | p95 | p99 |
|---|---:|---:|---:|
| MLP prediction | 1.400 µs | 1.874 µs | 2.752 µs |
| Local packet including features and energy checks | 147.799 µs | 171.100 µs | 226.911 µs |
| Bid-packet winner guard | 0.735 µs | 1.270 µs | 2.042 µs |

Model JSON: 6863 bytes; sampled bid packets: 602–606 bytes. Static map/input serialization and network latency are outside these timings. These are host measurements, not robot CPU, real-time deadline, bandwidth, power, or memory-footprint certification. The energy certificate remains a static admission check and cannot bound future unbounded motion detours.

This result narrows the defensible claim: the local learned boundary is testable and cheap on this host; a small learned improvement over untuned weights exists in this sample; **ML necessity and superiority over competent deterministic alternatives are not established**. Retain the learned implementation for research, do not switch the default, and do not present this as an accepted deployment upgrade.

## Validation and reproduction

- 52 regular tests pass across the MLP, auction and charging suites, plus the explicit development, acceptance and timing experiments.
- Protected simulator, PIBT, map and stop-and-wait hashes remain unchanged.
- Repository-wide TypeScript checking still reports existing errors outside the edited files; no diagnostics remain in the three edited files.

```sh
npx vitest run tests/bid-mlp.test.ts tests/auction.test.ts tests/charging.test.ts --maxWorkers=1 --minWorkers=1
BID_LOCAL_DEVELOPMENT=1 BID_LOCAL_TIMING=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
BID_LOCAL_ACCEPTANCE=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
```

Do not rerun development to silently replace a frozen configuration after inspection. Repeating acceptance reproduces this sample; it is not a new holdout. Full results are in `development.json`, `acceptance.json`, `frozen.json`, and `host-timing.json`.
