# Integrated runtime versus stop-and-wait

**Negative speed result:** the integrated runtime does not establish the required 20% completion-time improvement on this workload. The observed 0.335% improvement is statistically inconclusive, and battery exhaustion remains an integration defect.

## Protocol

200 paired seeds (20000–20199), 100 each at 3 and 6 AMRs, stock warehouse, six pending tasks released at tick zero, 100% starting battery, task weight 1, 800-tick limit. Starts are sampled without replacement; distinct pickup/dropoff endpoints come from open cells. No outcome filtering, model retraining, policy tuning, or selection of a winning regime followed the results.

Both arms run the actual FleetRuntime: peer ownership, lease renewals, task admission, guarded frozen MLP bids, energy eligibility, sensor-derived obstruction memory, A*, arrival checkpoints and battery accounting. Only motion changes. The baseline invokes the existing resolveStopAndWait function unchanged. Inactive bodies remain obstacles. It gets the same obstruction learning and replanning, without treatment-only sidestep side effects.

The baseline retains synchronous global conflict arbitration; the integrated policy uses local confirmation. This gives the baseline reliable simultaneous conflict resolution. Both use a shared simulation clock and connected in-memory communication. This is not an asynchronous or packet-loss comparison.

## Reliability and safety: all 200 seeds

| Metric | Stop-and-wait | Integrated |
|---|---:|---:|
| Fully completed runs | 176/200 | 180/200 |
| Completed tasks | 1161/1200 | 1178/1200 |
| Overlaps | 0 | 0 |
| Swaps | 0 | 0 |
| Blocked-cell violations | 0 | 0 |
| Payload violations | 0 | 0 |
| Queue violations | 0 | 0 |
| Runs with zero-battery unfinished work | 0 | 13 |
| Zero-battery work counter, robot-ticks | 0 | 6086 |

The integrated policy completes eight seeds the baseline fails, but fails four the baseline completes: **20017, 20037, 20057, 20135**. Aggregate reliability improves numerically; individual-seed regressions remain. This is not a clean safety/energy acceptance pass.

The runtime's zeroBatteryWork counter counts a robot holding a current task at zero battery, including stationary ticks. It does **not** mean 6086 illegal moves. Diagnostic replay of all 13 exhaustion seeds plus all four baseline-only completions (16 unique seeds) reproduced their original outcomes exactly and found **zero moves begun with less than one move's energy**. Every exhaustion happened with a task in progress. In 11/13 depletion traces the robot occupied only two distinct cells in its last 64 ticks, repeatedly moving back and forth with lease-related holds. The other traces occupied four and nine cells. Initial task-energy certification does not bound energy subsequently spent on unresolved detours/oscillation. This runtime has no charging lifecycle.

These traces establish exhaustion and repeated motion, not a causal MLP winner-change diagnosis. The frozen MLP is enabled in both arms; this is not an AI ablation.

## Completion time: only the 172 pairs where both finish

| Metric | Result |
|---|---:|
| Mean ticks, baseline → integrated | 191.012 → 190.372 |
| Median ticks, baseline → integrated | 187 → 187 |
| Mean paired ticks saved | 0.640 |
| Median paired ticks saved | 0 |
| Aggregate improvement | **0.335%** |
| 95% paired-bootstrap interval for improvement | **−0.171% to +1.027%** |
| 95% interval for mean ticks saved | −0.326 to +1.971 |
| Integrated wins / ties / losses | 32 / 123 / 17 |

Failed runs and their 800-tick caps are excluded from all speed statistics. Bootstrap resamples paired seeds 10,000 times with a fixed random seed. The interval contains zero: no statistically established speedup, and no valid ≥20% claim.

| Fleet | Runs completed, baseline → integrated | Jointly completed pairs | Improvement | 95% interval |
|---|---:|---:|---:|---:|
| 3 AMRs, 100 seeds | 95 → 99 | 95 | −0.116% | −0.524% to +0.262% |
| 6 AMRs, 100 seeds | 81 → 81 | 77 | +0.887% | −0.062% to +2.286% |

Six-task admission is serialized by existing ownership epochs, adding common latency to both policies. This benchmark includes that overhead. It does not measure sustained charging workloads, hardware, ROS2, independent OS-process ownership, network loss, or the isolated contribution of AI. Historical 20.6% and 1.56% results belong to different central benchmarks; neither substitutes for this result.

## Reproduce

```sh
MEASURE_INTEGRATED=1 npx vitest run tests/integrated-measurement.test.ts
DIAGNOSE_INTEGRATED=1 npx vitest run tests/integrated-measurement.test.ts
```

protocol.json records the protocol; report.json contains every seed and aggregates; energy-diagnosis.json contains depletion histories and final states. Normal tests verify resolver parity and shared obstruction learning. A passing measurement test means the experiment ran, **not** that the performance target was met.

## Validation

TypeScript and standalone fleet build passed. Ownership/auction/end-to-end: 40 passed; local-commit/liveness: 8 passed; measurement/adapter and diagnostic/adapter: 2 passed each. Full suite: 317 passed, 3 failed, 13 skipped. The failures match the prior audit: two existing compare.test.ts cycle assertions and the load-sensitive UDP assertion. UDP passed standalone. No assertions were weakened. See full-suite.txt, udp-standalone.txt, and verdict.json.
