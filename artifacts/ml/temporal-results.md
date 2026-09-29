DO NOT SHIP. The strict model targets were not achieved.

The complete prediction experiment is implemented and evaluated. The selected
history model is saved only as a rejected research candidate. Deployment model
is null. The intervention experiment was not run because its prerequisite—the
prediction acceptance gate—failed. No actuation benefit is claimed.

| Metric on 432 fresh final runs | Required | Measured | Outcome |
| --- | ---: | ---: | --- |
| Overall F1 | >=0.90 | 0.527 | Fail |
| Precision | >=95% | 40.4% | Fail |
| Recall | >=90% | 75.8% | Fail |
| Safe runs with any false alarm | <=5% | 127/148 = 85.8% | Fail |
| F1 in every positive-containing evaluated regime | >=0.85 | 0.491–0.574 across evaluated marginals | Fail |
| Beat both baselines with positive lower confidence bounds | Every applicable evaluated regime | Several failures; aggregate rule interval also crosses zero | Fail |

Comparison on exactly the same final samples:

| Model | F1 | Precision | Recall |
| --- | ---: | ---: | ---: |
| New history forest | 0.527 | 0.404 | 0.758 |
| Existing rule | 0.517 | 0.402 | 0.724 |
| Previous expanded forest | 0.364 | 0.266 | 0.577 |
| Original logistic | 0.268 | 0.183 | 0.497 |
| Always-positive | 0.235 | 0.133 | 1.000 |

The 95% paired seed-bootstrap interval for F1 advantage over the rule is
[-0.0003, +0.0217]. That does not establish superiority. Against the previous
forest it is [+0.147, +0.180], but beating an earlier model does not waive the
rule baseline or false-alarm targets. Prior single-geometry results remain
valid only for their original datasets; they did not establish this broader
kind of generalization.

The final suite contains 39,116 agent-tick samples, including 5,205 positives
(13.3%). There are 284 deadlocking and 148 completing runs. At least one agent
warns in the three-tick window in 283/284 deadlocking runs. This event recall is
not the acceptance metric and does not offset 1,258 missed positive samples
or the 5,816 false-positive samples. Safe convoys alarm in 126/144 runs. Every
safe run in fleet-size groups 6, 8, and 10 alarms.

What was tested

- 216 training runs on three layouts, sizes 3/4/6; 7,051 samples, 22.6% positive.
- 72 validation runs on a different layout, same sizes; 3,010 samples, 17.2% positive.
- 432 final runs on three unseen layouts, sizes 3/6/8/10. Sizes 8 and 10 are
  absent from training and validation. One final layout includes a passing loop.
- Each suite contains opposing traffic, convoys, and random mixed routes.
- No episode timed out without either completion or a confirmed stall. All 720
  runs were checked against the existing fair baseline runner through 160 ticks.
- Eight operating-point candidates: snapshot/history models at depths 5/8,
  each with a train-only F1 threshold and a train-only precision/safe-alarm
  constrained threshold. No tuning or reselection after the final evaluation.
- Histories improved validation F1 from 0.572 for the best snapshot candidate
  to 0.619. The selected depth-eight history model uses threshold 0.51.
  Its precision-constrained alternative had zero alarms on 28 safe validation
  runs, but only 27.6% recall and 82.2% precision; it also failed the targets.

The exact protocol and frozen pre-test model hash are in
[temporal-protocol.md](temporal-protocol.md). Complete metrics, every evaluated
traffic/layout/fleet marginal, per-seed results, confidence intervals, seeds,
hashes, and the rejected candidate are in
[deadlock-risk-temporal.json](deadlock-risk-temporal.json).

The observability finding

There is a tested counterexample with identical local observations and local
history at tick 2 in two worlds. The nearby robots are the same, the observing
agent's route is the same, and the remote robot has taken the same path so far.
In one world its task finishes at tick 2; in the other it continues until tick
12. Fleet-wide stall onset is therefore tick 3 versus tick 13, making the
observer's three-tick labels 1 versus 0. The remote task destination is not
locally observable. Even a perfect learner cannot distinguish these histories.
This proves a worst-case information limit, not that any particular statistical
precision/recall pair is impossible under every workload distribution.

Separately, exact 37-feature-vector collisions provide a finite-corpus bound:

| Corpus | Minimum errors forced by conflicting labels | Maximum errors compatible with P>=.95 and R>=.90 |
| --- | ---: | ---: |
| Training | 322 | 235.05 |
| Final | 1,462 | 767.05 |

For a deterministic classifier, each identical-vector group forces at least
min(positive count, negative count) errors. With N positives, R>=.90 and P>=.95
imply at most N*(.10 + .90*.05/.95) errors. Thus both targets are impossible on
these sampled rows using this fixed representation, even with an in-sample
oracle. This is not a test score and was not used as a prediction feature.
More training epochs cannot remove this information loss. A different richer
local representation might reduce empirical collisions, but cannot remove the
counterexample involving an unobserved remote task.

Implementation and boundaries

The new LocalHistory module appends two causal lags, history masks, observed
movement/waiting, and peer-intent/motion relationships to the unchanged nine
base features. It stores state per agent, resets across gaps, and has no access
to labels, future trajectories, global progress, seed IDs, or peer routes.
The forest accepts an explicit feature count while retaining its nine-feature
defaults. The sampler accepts an optional local-observation callback and custom
bay sets; the original sampling path and three-tick label are unchanged.

No predictor was connected to the distributed stack. Hash checks verify all
five distributed source files and the original features.ts, logistic.ts, and
predictor.ts are unchanged. Original saved models are preserved. The old forest's
development selection reproduces its original frozen hash after extending the
forest's optional schema configuration.

Validation: 15 tests passed across the final experiment, prior-model reproduction,
and ML regression/observability suites. Targeted ESLint passed. Repository-wide
TypeScript checking still has the same seven pre-existing diagnostics; none
come from these additions. Passing harness tests means the experiment ran
correctly, not that its scientific acceptance gates passed.

Reproduce from /tmp/opencode/tr-core:

```sh
ML_DIAGNOSTICS_ONLY=1 npx vitest run tests/ml-targets.test.ts
ML_TARGETS_DEVELOPMENT=artifacts/ml/temporal-development.json npx vitest run tests/ml-targets.test.ts
ML_TARGETS_FINAL=1 ML_TARGETS_REPORT=artifacts/ml/deadlock-risk-temporal.json npx vitest run tests/ml-targets.test.ts
npx vitest run tests/ml.test.ts tests/ml-diag.test.ts tests/ml-forest.test.ts tests/ml-observability.test.ts tests/ml-improved.test.ts
```

The final set is now exposed and must not be reused for future model selection.
A defensible next experiment would separately define agent-local deadlock onset
or a locally actionable conflict outcome, while preserving this fleet-wide
experiment as a failed result. That would be a new target with a fresh holdout,
not a relabelling that makes these scores look better. It was not substituted
for the requested target here.
