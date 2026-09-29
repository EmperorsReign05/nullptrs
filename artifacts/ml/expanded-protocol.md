Expanded experiment protocol, fixed before opening the final holdout

Task: improve deadlock-risk prediction using the existing nine features and
unchanged fair stop-and-wait simulator. No distributed-stack integration.

Target stays fleet deadlock onset within 1–3 ticks. Confirmation: ten motionless
and task-progress-free ticks. Exclude onset and later rows; censor incomplete
observation windows. Audit completion/persistence against the existing baseline
runner through 100 ticks for every episode.

Three scenario families share the same spine and alcoves: opposing routes,
ordered convoys that can finish without overtaking, and randomly assigned mixed
routes. All use 3–6 robots. Family proportions are equal by episode, not by tick.
Keep all previous head-on fixtures (seeds 1–120, sizes 2–8) out. Remove exact
scenario duplicates across train, validation, and test before observing outcomes.

Training: 60 unique episodes per family, seeds starting at 1000.
Validation: 20 per family, seeds starting at 10000.
Final test: 40 per family, seeds starting at 20000.
Seed construction and duplicate rejection are in tests/ml-corpus.ts.

Candidates: unchanged logistic fitModel and 48-tree forests at depths 3, 5, 7.
Forests bootstrap scenario seeds and weight episodes equally before class
balancing. Four random candidate features per node; minimum leaf count eight.
Random seed 20260929. Thresholds: F1 optimum on TRAIN only, grid 0.05–0.95.
Select candidate with highest validation F1. Ties retain the earlier, simpler
candidate. Do not refit after selection or tune using final test outcomes.

Development results: logistic F1 0.6949, depth 3 forest 0.7002, depth 5 forest
0.7786, depth 7 forest 0.7920. Selected depth 7, threshold 0.55.
Frozen candidate SHA-256:
c8e862776601ecc6b953f8187222c17d3678193d1ae8269b7d670a7d9540075a

Final comparisons on identical samples: selected candidate, original saved
logistic model, logistic retrained on the expanded training data, intentOccupied
rule, and always-positive. Required gate remains strict F1 superiority over
both rule and always-positive. Report replacement improvement separately versus
both logistic models. Report per-family and per-seed results, safe-episode false
alarms, and 95% paired seed-bootstrap intervals (2000 resamples) for F1 deltas.
A failure remains a failure; no post-holdout tuning is authorized by this protocol.

No completion-time claim follows from prediction scores. Re-running the frozen
experiment reproduces the same result and is not another independent trial.
