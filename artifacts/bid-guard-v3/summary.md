# Bounded MLP with winner-change guard — acceptance rejected

The learned component is retained for investigation, **not approved for deployment**. The exact historical regression was fixed, but new untouched acceptance seeds exposed two new run failures and a battery safety regression. The deterministic default remains unchanged.

## Architecture and training

The existing deterministic cost and hard eligibility checks feed a dependency-free, 16-hidden-unit tanh MLP (289 parameters). The MLP applies a **0–10% discount**, never an unrestricted replacement or surcharge. Terminal-first rollout labels rank every completed outcome ahead of every incomplete outcome; within a decision, terminal-order violations disable speed fitting until their ranking margin is satisfied.

Training used **15,268 counterfactual actions, 3,470 decisions, 256 scenario seeds**, including 367 incomplete counterfactual rollouts. The retained model was trained for 400 epochs. No retraining occurred during this guard experiment. Training normalization and the model are retained in `model.json`.

The 16 ordered features are travel cost, congestion, battery cost, workload proxy, urgency, payload surplus, queue depth, peer-route contention, peer-next-intent contention, nearest-charger distance, post-task charger distance, energy reserve after return, charger-unreachable flag, remaining active route length, active-task flag, and battery. Urgency was zero throughout this workload.

## Guard and causal evidence

All bidders are evaluated on the same auction state. If the MLP changes the winner, the guard requires unchanged hard feasibility for both candidates, a deterministic gap within the candidate's 10% discount budget, and challenger feasibility through its active job, queued jobs, proposed task, and return to a charger with the existing 15% reserve. Invalid or out-of-distribution predictions fall back to deterministic cost.

The guard rejects a challenger with **reciprocal next-cell intent**, the causal condition observed in seed 5069. The selected workload variant also rejects a challenger with both a deeper queue and no shorter remaining active route. If rejected, **all bids revert to deterministic values**, preserving its winner and tie-break; simply suppressing one bid could otherwise elect an unchecked third robot. If the winner is unchanged, bounded discounts remain allowed. The guard does not move robots or change routing.

At tick 24 of seed 5069, task T11 changed from AMR-04 (213 → 207.60159504386706) to AMR-08 (216.5 → 203.50240308045008). AMR-08 was waiting in reciprocal next-cell contention, despite having no queued or active task. Reverting **only that decision** and retaining the later learned policy restored 13/16 tasks versus 12/16. It did not fix the shared core deadlock. The guard reproduces that restoration. It also preserves development seed 5076's recovery from 12/13 tasks to all 13 in 124 ticks.

All 25 divergent prior acceptance seeds, their 35 winner changes, full features, robot states, and exact bid corrections are in `divergent-seeds.json`; `divergent-seeds.md` is the outcome index. The single-decision regression experiment is in `causal-5069.json` and the ordinary test suite.

## Development selection

Only development seeds 2000–2019, 3000–3079, and 5000–5099 influenced guard selection. The latter 100 seeds were explicitly retired from acceptance before diagnosis. No arbitrary seed-specific rule was added.

| Guard | Runs / tasks complete | Allowed / suppressed changes | Previously causal benefits preserved | Mean paired ticks saved |
|---|---|---|---|---:|
| Reciprocal | 196/200; 2786/2800 | 79 / 1 | 43/43 | 2.5333 |
| Contention | 195/200; 2785/2800 | 68 / 10 | 34/43 | 2.3641 |
| **Workload, selected** | **196/200; 2786/2800** | **77 / 4** | **43/43** | **2.5744** |

Deterministic development scoring completed 195/200 runs and 2785/2800 tasks. All audited development safety counts were zero. A stricter preliminary gate lost the recovered run by vetoing changes away from an overcommitted baseline winner; its complete results are retained separately in `development-strict.json`. Full final development results are in `development.json`.

## Fresh acceptance — frozen before inspection

The frozen model, guard, source hashes, and **200 new seeds 6000–6199** are recorded in `model.json`. No behavior was changed after inspecting their results. `acceptance.json` contains paired outcomes, all winner-change events, safety counters, and post-evaluation single-decision causal reversions.

| Reliability | Deterministic | Guarded MLP |
|---|---:|---:|
| Completed runs | 192/200 | 190/200 |
| Completed tasks | 2767/2800 | 2766/2800 |

**Reliability failed.** Seeds 6017 and 6199 completed under deterministic scoring but timed out with guarded ML. The guard was not tuned to these failures.

| Safety, robot-tick/event counts | Deterministic | Guarded MLP |
|---|---:|---:|
| Collisions | 0 | 0 |
| Swaps | 0 | 0 |
| Blocked-cell violations | 0 | 0 |
| Zero-battery work | 427 | 633 |
| Payload violations | 0 | 0 |
| Queue violations | 0 | 0 |

**Safety failed:** seed 6199 introduced 206 additional robot-ticks; 427 robot-ticks were shared on seeds 6072 and 6178. Correction from the subsequent full trace audit: the original prose incorrectly reported the increment (206) as the total and omitted the common 427. The acceptance JSON already recorded the correct totals.

## Paired completion-time performance

Only the **190 seeds completed by both policies** enter these statistics. Failed runs are not assigned artificial completion times. Capped reliability summaries remain separately available in the JSON.

- Mean ticks: deterministic **131.8684**, guarded MLP **129.5895**.
- Paired ticks saved: mean **2.2789**, median **0**.
- Mean saving, 95% paired-seed bootstrap interval: **[0.8632, 3.7684] ticks** (10,000 resamples).
- Reduction in paired aggregate completion ticks: **1.7282%**; mean per-seed percentage improvement: **1.4204%**.
- Win / tie / loss: **28 / 152 / 10**.

This is a statistically measurable **conditional** improvement, not an acceptable fleet-wide speedup: the reliability and safety gates failed. Conditioning on mutual completion also excludes the new learned failures.

## Learned usefulness and limitations

Across 2,800 feasible auction decisions, the MLP proposed 67 winner changes. The guard allowed **63** and suppressed **4**. Single-decision reversion under the frozen downstream policy identified **36 helpful, 20 harmful, and 7 neutral** allowed changes. These are local causal effects; interactions mean they cannot be summed as independent savings or treated as proof of universal safety.

The model remains materially influential and fixes the diagnosed development regression. The guard sees current intent and estimated static commitment feasibility; it does not certify future progress or energy usage under repeated detours. Acceptance exposes that limitation. Shared occupied-dead-end planner defects were not modified. This is synthetic 4–8-robot, 12–16-task simulation evidence with a 400-tick reliability horizon, not hardware validation or a stop-and-wait comparison.

## Reproduction

From the worktree root:

```sh
npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
BID_GUARD_ACCEPTANCE=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
```

The first command runs the guard regression/recovery tests using the included frozen artifact. The second reproduces the recorded acceptance measurement, checking production source hashes before and after. Rerunning it is verification of the same set, **not a new independent acceptance sample**. The default deterministic scorer is unchanged; experimental integration uses `withBidScorer(world, guardedBidScorer(model, bound, guard))` explicitly.
