# Fresh warehouse acceptance after full-queue execution fix

Frozen commit **938af2c**, 200 previously untouched seeds **26000–26199**, six tasks/run, 3 or 6 robots, 800-tick horizon. One-process integrated runtime; connected communication. Both arms use the same frozen MLP and energy gate. This is a motion comparison, not an AI ablation or separate-process hardware test.

| Metric | Stop-and-wait | Integrated |
|---|---:|---:|
| Completed runs | 176/200 | 173/200 |
| Completed tasks | 1159/1200 | 1165/1200 |
| Measured safety violations | 0 | 0 |

**Run reliability fails the comparison.** More individual tasks completed does not cancel fewer fully completed runs. The ten baseline-only and seven integrated-only seeds remain in report.json.

Performance uses only the **166 jointly completed pairs**: mean ticks 191.813 vs 190.711; medians 188 vs 188. Mean paired saving 1.102 ticks; median saving 0. Wins/ties/losses: **24/130/12**. Aggregate improvement **0.575%**, 95% paired-bootstrap interval **−0.064% to 1.457%** (10,000 resamples). No statistically established speedup and no ≥20% result. Failed capped runs are not used for speed claims.

Safety counters cover overlap, swaps, blocked cells, zero-battery work, queue overflow and payload violations. All were zero in both arms. No model retraining or baseline changes were made. No retuning followed this acceptance result. Historical v1/v2 measurements remain preserved.

Reproduce with the opt-in measurement command documented in tests/integrated-measurement.test.ts; protocol.json and report.json record the exact workload and rows.
