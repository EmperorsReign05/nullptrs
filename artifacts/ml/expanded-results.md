The expanded model improves aggregate held-out F1 substantially, with a recall
tradeoff and unresolved false alarms. It passes the original two-baseline gate
on the complete test set. It is an experimental artifact, not deployed.

| Predictor, evaluated on the same 120 fresh test seeds | F1 | Precision | Recall | False-positive samples |
| --- | ---: | ---: | ---: | ---: |
| New forest, selected on validation only | **0.759** | **0.834** | 0.696 | **132** |
| Original saved logistic model | 0.574 | 0.427 | 0.876 | 1,121 |
| Logistic retrained on expanded training data | 0.661 | 0.633 | 0.691 | 383 |
| Existing intentOccupied rule | 0.504 | 0.586 | 0.442 | 299 |
| Always-positive | 0.531 | 0.361 | 1.000 | 1,689 |

F1 improves by 0.184 over the original model and 0.098 over retraining logistic.
False-positive samples fall 88.2% versus the original model, with lower recall.
The old 0.869 head-on-only result is from a different dataset and must not be
compared directly to the new 0.759. The table re-evaluates both models on exactly
the same broader test samples.

Paired bootstrap of whole scenario seeds (2,000 resamples), 95% percentile
intervals for the new model's F1 advantage:

| Comparison | F1 difference interval |
| --- | ---: |
| Original saved model | +0.113 to +0.258 |
| Retrained logistic | +0.068 to +0.131 |
| Rule baseline | +0.213 to +0.297 |
| Always-positive | +0.157 to +0.299 |

These intervals capture variation among this generator's seeds, not uncertainty
about new geometries or real fleets. They do not treat correlated agent-ticks
as independent observations.

There are important failures:

- On head-on traffic, forest F1 is 0.843 versus 0.895 for the original model.
- On mixed traffic, forest F1 is 0.668 versus 0.801 for the original model and
  0.843 for always-positive. The aggregate gate passes; this subgroup gate does
  not. The model is not a universal replacement for the original specialist.
- On safe convoys, sample false-positive rate drops from 76.3% to 4.4%, but
  28/40 convoy runs still contain at least one alarm. Across all completing test
  runs, 30/42 contain an alarm. That is too frequent to call deployment ready.
- At least one agent predicts within the target window for all 78 deadlocking
  test runs: earliest valid warning is three ticks ahead for 57, two for 13,
  and one for eight. This fleet-level event measure does not erase the 291
  missed positive agent-tick samples or the false alarms.

Training used 180 unique runs (3,914 samples, 36.9% positive), validation 60
runs (1,234 samples, 36.7% positive), and final evaluation 120 runs (2,645 samples,
956 positives / 36.1%). Final evaluation has 78 deadlocking and 42 completing
runs. Each split has equal episode counts for head-on, safe convoy, and random
mixed routes. This mix is synthetic, not an estimate of deployment prevalence.
All runs use the same spine/alcove map and 3–6 robots. The fixed protocol is in
[expanded-protocol.md](expanded-protocol.md).

The new forest learns interactions among the unchanged nine features. It uses
48 trees of maximum depth seven, minimum leaf count eight, and four randomly
chosen feature candidates per node. Bootstrap units are whole seeds. Episodes
have equal total weight before class balancing. Depth was selected from 3/5/7
on validation F1; threshold 0.55 was fitted on training only. The candidate was
frozen before the final holdout was generated. No final-test tuning or refitting
was performed. Scores are class-weighted ranking scores, not calibrated event
probabilities.

The sampler and three-tick future target are unchanged. Training and evaluation
reuse the fair baseline's congestion and stall-replanning behavior. Every run
is checked against the independent baseline runner through 100 ticks, including
completion counts and persistent failure. Exact scenarios are deduplicated
across splits; previously inspected head-on fixtures are excluded. M2 is kept.
The original extractor, logistic implementation, predictor, and distributed
stack were not changed.

Saved model plus reports: [deadlock-risk-expanded.json](deadlock-risk-expanded.json).
It includes feature ordering, selected model, seed lists, dataset/model hashes,
confusion matrices, per-family/per-seed results, confidence intervals, and
warning lead times. The original artifact is preserved. The new model's compact
JSON payload is about 231 KB; the pretty-printed full experiment report is larger.
On this host, scoring averaged 3.21 microseconds per sample at the median of 25
batch means. This is neither a hardware guarantee nor an end-to-end agent cost.
No completion-time or distributed-policy benefit has been measured.

Reproduce from `/tmp/opencode/tr-core`:

```sh
# Check label rates without fitting.
ML_DIAGNOSTICS_ONLY=1 npx vitest run tests/ml-improved.test.ts
# Select on development data only; final holdout remains unopened.
npx vitest run tests/ml-improved.test.ts
# Reproduce the frozen final experiment; this is not a new independent trial.
ML_FINAL=1 ML_IMPROVED_REPORT=artifacts/ml/deadlock-risk-expanded.json npx vitest run tests/ml-improved.test.ts
# Existing ML regressions, M2, and nonlinear model tests.
npx vitest run tests/ml.test.ts tests/ml-diag.test.ts tests/ml-forest.test.ts
```

Validation: ten tests passed across the final experiment and regression suite;
targeted ESLint passed. Repository-wide TypeScript checking still reports the
same seven existing diagnostics in layout.tsx, features.ts, attack.test.ts,
attack3.test.ts, bidcost.test.ts, and repro-root.test.ts. There are no new
TypeScript diagnostics from the added files. No distributed-stack files changed.
