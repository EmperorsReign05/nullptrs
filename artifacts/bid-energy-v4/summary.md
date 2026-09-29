# Hard energy admission — fresh acceptance passed

The existing 16-unit MLP, its 16 features, and its 10% discount bound are unchanged. **No retraining occurred.** Training remains 15,268 counterfactual actions across 256 seeds. The change is a hard winner-promotion gate in `guardedBidScorer`, with an auditable energy certificate from `assessBidEnergy`.

## Full prior-acceptance diagnosis

The prior 6000–6199 acceptance set is now development data. `diagnosis.json` contains every zero-battery robot-tick in both arms, decision-state snapshots, bid corrections/features, robot timelines, and single-decision reversions.

| Seed | Battery events, deterministic / old learned | First causal MLP winner change | Single-decision reversion |
|---|---:|---|---|
| 6017 | 0 / 0 | Tick 12, T5: AMR-02 → AMR-06 | Restores all 14 tasks in 149 ticks |
| 6072 | 205 / 205 | None: no MLP winner change | Shared core failure |
| 6178 | 222 / 222 | None for battery failure | Reverting tick 24 / T11 leaves the same 222 events and 14/15 tasks |
| 6199 | 0 / 206 | Tick 0, T3: AMR-04 → AMR-06 | Restores all 16 tasks in 117 ticks, zero battery events |

**Correction to the previous written summary:** actual v3 totals were **427 deterministic / 633 learned robot-ticks** of zero-battery work. The prior prose incorrectly reported 0 / 206, which described only the increment. Its acceptance JSON already held the correct totals. The v3 written summary is corrected with an explicit note.

In 6017 the promoted robot had an active task but an empty path after a route invalidation; the changed allocation later stranded a different robot at charging. In 6199 the incumbent had a newly assigned task but no committed path yet. The promoted robot had ample static energy; another robot eventually depleted while looping on a later task. Therefore these were primarily **uncertified-route/admission failures**, not evidence that retraining or simply increasing the numerical reserve would fix them. Both causal tests revert only the first differing decision and retain the same later learned policy.

## Hard gate

Existing deterministic feasibility, costs, movement, routing, charging behavior and tie-breaks remain unchanged. The MLP still proposes a bounded discount; the guard atomically restores **all deterministic bids** when a winner change is rejected.

For a learned winner change:

1. Both candidates must pass existing hard eligibility. The incumbent's active route must be certified; it need not pass the stronger total-queue energy budget, so a safer challenger can still replace an overcommitted incumbent.
2. The challenger must have a valid committed active path, when active: correct start and task goal, traversable cells, adjacent steps. Empty/stale paths are rejected, not treated as zero work or optimistically replaced by a fresh A* estimate.
3. Account for the actual committed path, the remaining active task, queued tasks, and the proposed task in the dispatcher's actual order. With no active task, the proposed task precedes existing queued work; otherwise it is appended.
4. At every task-completion checkpoint, include a traversable route to the charger the existing engine selects—Manhattan-nearest with its station-order tie-break—and the existing **15% safety reserve**. Current battery must cover the most demanding prefix. Unknown tasks, unreachable legs/charger, or negative energy margin reject the promotion.
5. Retain the score-gap bound, reciprocal-intent guard, and development-selected workload-pressure guard.

Every accepted winner-change event records its certificate and nonnegative energy margin. Tests cover the exact energy boundary, committed detours underestimated by the old check, missing active intent, dispatch queue order, both causal regressions, and historical useful recovery.

This is a **static admission certificate**, not a guarantee against arbitrary future detours, charger blockage, or infinite motion loops. Such a universal execution guarantee cannot be established by an auction scorer alone. No planner/simulator change is made here.

## Retired acceptance set, used only for development

On seeds 6000–6199, deterministic completed **192 runs / 2767 tasks**; the new learned guard completed **192 runs / 2768 tasks**, out of 200 runs / 2800 tasks. Both had the same **427** shared zero-battery robot-ticks, with zero other audited safety events. Both newly diagnosed learned failures recovered.

The gate allowed **35** winner changes and suppressed **32** proposals. Of 36 previously causally helpful changes, **22 remained**, 10 were suppressed, and 4 were no longer encountered after earlier decisions changed. Seed 5076 still fully recovers, now in 156 ticks versus the prior learned 124; deterministic still fails that development seed. This tradeoff is retained rather than hidden.

Among the 192 mutually completed development pairs, mean ticks saved were **1.8333**, 95% paired-seed bootstrap interval **[0.7135, 3.0469]**. Full results: `development.json`.

## New untouched acceptance: 7000–7199

The model, gate, source hashes and 200-seed list were frozen in `model.json` before inspection. The weights exactly equal the prior model. No changes followed acceptance inspection. Full paired outcomes, safety counters, energy certificates and post-evaluation causal reversions are in `acceptance.json`.

| Reliability | Deterministic | Learned |
|---|---:|---:|
| Completed runs | 192/200 | 192/200 |
| Completed tasks | 2783/2800 | 2783/2800 |

No individual seed completed fewer tasks under the learned policy. Both arms recorded **zero collisions, swaps, blocked-cell violations, zero-battery work, payload violations and queue violations**.

**Performance uses only the 192 pairs completed by both policies.** Failed/capped runs do not enter these figures:

- Mean completion ticks: **132.2396 → 130.1771**.
- Paired ticks saved: mean **2.0625**, median **0**.
- Mean saving 95% paired-seed bootstrap interval: **[0.8490, 3.4740]** (10,000 resamples).
- Aggregate paired completion-time reduction: **1.5597%**. Mean per-seed percentage improvement: **1.2705%**.
- Win / tie / loss: **21 / 165 / 6**.

The MLP proposed **62** changes across 2800 feasible auction decisions. The gate allowed **43**, suppressing **19**. Single-decision reversions classified accepted changes as **25 helpful, 7 harmful, 11 neutral**. These local effects interact and cannot be summed as independent savings; reliability and safety did not regress in this acceptance set.

**The stated learned-layer acceptance gates pass in this measured regime.** This is conditional simulation evidence for 4–8 robots and 12–16 tasks with a 400-tick reliability horizon. It does not establish universal completion, hardware safety, 20-robot performance, or a stop-and-wait improvement. Eight runs remain incomplete under both policies; those shared failures are not solved by this scorer. The deterministic default is unchanged; the accepted learned integration is explicit through `withBidScorer(world, guardedBidScorer(model, bound, guard))`.

## Reproduction

From the worktree root:

```sh
npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
BID_ENERGY_DIAG=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
BID_ENERGY_DEVELOPMENT=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
BID_ENERGY_ACCEPTANCE=1 npx vitest run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
```

Acceptance checks frozen production source hashes before and after evaluation. Rerunning the final set reproduces the measurement; it does not create a new independent acceptance sample. The optional `hardEnergy=false` argument exists only for historical v3 diagnosis; it is not the accepted configuration.
