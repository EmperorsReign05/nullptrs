Strict model-target experiment — protocol before final evaluation

The target stays fleet deadlock onset within the next 1–3 ticks, confirmed by ten
consecutive motionless/task-progress-free ticks. Samples at/after onset are
excluded. No change to the nine base features, fair stop-and-wait resolver,
congestion, replanning, or verified distributed implementation.

A new causal representation has 37 features: the original nine; two prior
nine-feature vectors; availability masks for both lags; movement and capped
waiting; opposing/following intent fractions; inverse nearest opposing-peer
distance; stationary/approaching peer fractions; and reciprocal intent.
Only own state and received peer positions/intents are used. No global tick,
scenario ID, seed, fleet size, future state, or peer route is an input. History
is per agent and resets across observation gaps and episodes.

Train: 216 runs, layouts 0/1/2, fleet sizes 3/4/6, eight seeds per layout/size/
traffic-family cell, seeds beginning 100000. Validation: 72 runs on different
layout 3, same sizes/counts, seeds beginning 200000. Final: 432 runs on unseen
layouts 4/5/6 and sizes 3/6/8/10, twelve seeds per cell, seeds beginning 300000.
The traffic families remain opposing routes, convoys, and mixed routes.
Layout 6 includes a passing loop. All are synthetic generators on the static
warehouse grid. Layout IDs map to exact geometries in ml-generalization-corpus.ts.

Before fitting, audit nonzero positive rates, finite features, and agreement
with the existing baseline runner through 160 ticks. Document censored runs.
A regression constructs identical local observation histories with different
fleet-wide future labels. Exact feature/label collisions quantify the minimum
error any deterministic classifier using this representation makes on the
sampled corpus. This is an observability audit, not a trained predictor score.

Candidates: 48-tree seed-bootstrap forests at depths 5/8 using either the base
nine features or all 37. Minimum leaf count eight; four candidate split features
for snapshot models and eight for history models. Equal episode weights before
class balancing. Forest random seed stays 20260929. For each fitted model,
choose thresholds on TRAIN only from 0.01–1.00: (a) maximum F1; (b) maximum recall
subject to precision >=95% and safe-episode alarm rate <=5%, if feasible.
On validation, prefer a candidate satisfying F1>=.90, precision>=.95, recall>=.90,
and safe-episode alarm rate<=.05; otherwise select maximum F1 as a rejected
research candidate. Freeze the selected model before generating final data.

Final acceptance requires all of: overall F1>=.90, precision>=.95, recall>=.90,
safe-episode alarm rate<=.05; F1>=.85 in every positive-containing traffic,
layout, and fleet-size marginal; and strict wins over rule and always-positive
in each such marginal, with positive lower bounds on paired 95% seed-bootstrap
F1-difference intervals (2,000 draws). Pure-negative regimes use false-alarm
rates, not undefined positive-class F1 competition. The default code retains
convention F1=0 for reporting such groups and marks the baseline gate N/A.

Re-evaluate the original logistic and previous forest on identical final rows.
Save every target pass/fail, confusion matrix, per-regime and per-seed result,
seed lists, model/data hashes, ambiguity audit, and selected research candidate.
If any acceptance gate fails, save deploymentModel=null and do not integrate
or run interventions with the verified distributed fleet. A valid negative
experiment passes harness tests without satisfying the scientific acceptance
gates. An intervention benefit remains unmeasured until an accepted predictor
is tested against the existing non-ML distributed policy in a separate study.

Development selection frozen before final holdout generation:
history-d8-f1, threshold 0.51, validation F1 0.6193, precision 0.5133,
recall 0.7803, safe-run alarm rate 23/28. No candidate meets all targets.
The high-precision variant lowers safe alarms to 0/28 but recall to 0.2755
and precision is still only 0.8218 on validation. These are development
results, not the final benchmark. Final evaluation will quantify the failure;
it is not an opportunity to choose another threshold.
Frozen candidate SHA-256:
3a58191c15d2d8359b1cb9c35e932d7f08d714aa66f7a3d4fe1cf216bd0b231a
