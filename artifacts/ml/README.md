Latest strict evaluation: **DO NOT SHIP**. The history model fails the targets
on unseen layouts and larger fleets. See [strict results](temporal-results.md),
[pre-test protocol](temporal-protocol.md), and
[full rejected-candidate report](deadlock-risk-temporal.json).
The distributed stack is unchanged; intervention testing was withheld because
the prediction gate failed. Earlier results below cover narrower datasets.

Latest experiment: see [expanded results](expanded-results.md),
[fixed protocol](expanded-protocol.md), and
[model with full evaluation](deadlock-risk-expanded.json).
The expanded study includes safe convoys and mixed traffic. The original
head-on-only experiment below is retained as a reference; its F1 is not directly
comparable with the broader dataset's F1.

Deadlock-risk training experiment

The logistic model passes the strict aggregate held-out F1 gate on this dataset.
It is saved in `deadlock-risk-experiment.json` with its standardizer, threshold,
feature order, seed lists, dataset hash, confusion matrices, and per-seed results.
It is not connected to the distributed stack.

| Predictor | Held-out F1 | Precision | Recall |
| --- | ---: | ---: | ---: |
| Logistic regression | 0.869 | 0.858 | 0.880 |
| Existing intent-occupied rule | 0.620 | 0.821 | 0.498 |
| Always positive | 0.803 | 0.671 | 1.000 |

Training: 40 seeds, 786 samples, 543 positives (69.1%). Evaluation: 20 held-out
seeds, 398 samples, 267 positives (67.1%). Model threshold 0.35 was selected on
training data only. The model beats both baselines on 16/20 held-out seeds;
it loses to both on seed 112 and to always-positive on 101, 114, and 120.
These are pooled sample metrics; the JSON also provides every seed's metrics.
No leaky-split score is used for the verdict.

The sampler uses the existing fair stop-and-wait resolver, congestion update,
move application, and stall-triggered replanning unchanged. Scenarios use the
one-cell spine at x=6 with its alcoves, 3–6 robots starting on opposite sides,
and distinct reflected destinations. Seeds change starting positions. Exact
scenario duplicates are rejected before observing outcomes (seed 12 duplicates
an earlier training scenario and is replaced by 41). M0 verifies 60 distinct
runs and checks unfinished tasks persist through 100 baseline ticks in each.
Some robots can complete before the remaining fleet jams.

The target is fleet deadlock onset within the next three ticks. Onset is the
first tick of ten consecutive ticks with no movement or task progress and
unfinished tasks. Confirmation spans two five-tick stall-replan windows.
Features are captured before moves using the unchanged extractor, own route,
and fresh peer position/intent messages within Manhattan radius three.
Future observations are used only for labels. Samples at/after onset are
excluded; timeout tails without a full observation window are censored.

The positive-rate check ran before fitting. Training intentOccupied is now
nonzero in 38.3% of samples. A separate diagnostic checks fleets of 3, 4, 6,
and 8 robots over 20 seeds each without training. A completing-convoy test
checks that the sampler also produces valid all-negative runs. M2 remains as
a seed-overlap leakage demonstration; leakage need not inflate F1 in every run.

Scope: every measured training/evaluation episode eventually deadlocks.
Negative examples are earlier time windows, not safe episodes. This measures
imminence within one geometry, not discrimination between safe and unsafe
workloads. The feature context assumes fresh messages. Ten-tick confirmation
and 100-tick persistence are operational evidence, not proof of infinite
blocking. Generalization to the distributed policy and any effect on fleet
completion time remain untested. No 20% improvement claim follows from this.

Reproduce from `/tmp/opencode/tr-core`:

```sh
ML_DIAGNOSTICS_ONLY=1 npx vitest run tests/ml.test.ts -t 'M0|future labels|M1'
ML_REPORT_PATH=artifacts/ml/deadlock-risk-experiment.json npx vitest run tests/ml.test.ts tests/ml-diag.test.ts
```

All six ML tests pass, including serialized-model evaluation equivalence.
Repository-wide `tsc --noEmit --incremental false` remains blocked by existing
errors in layout.tsx, features.ts (boolean in a number vector), attack.test.ts,
attack3.test.ts, bidcost.test.ts, and repro-root.test.ts. These files were not
changed in this training task. The feature implementation, logistic optimizer,
predictor, and distributed stack were left untouched.
