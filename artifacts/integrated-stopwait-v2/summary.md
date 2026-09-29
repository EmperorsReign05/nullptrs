# Fresh warehouse energy-guard check

Behavior frozen at commit f946872. Seeds 25000–25199 were not used to design the guard. This is the one-process FleetRuntime warehouse workload, **not** the new separate-process choke-point deployment.

200 paired seeds, 100 each at 3 and 6 robots, six tasks, horizon 800; identical frozen guarded MLP and execution-energy gate in both arms. Original stop-and-wait resolver unchanged.

| Metric | Stop-and-wait | Integrated |
|---|---:|---:|
| Completed runs | 166/200 | 168/200 |
| Completed tasks | 1141/1200 | 1163/1200 |
| Overlaps / swaps | 0 / 0 | 0 / 0 |
| Zero-battery unfinished-work observations | 0 | 0 |
| Blocked-cell / payload / queue violations | 0 / 0 / 0 | 0 / 0 / 0 |

Among 158 jointly completed pairs, mean ticks were 190.329 → 190.108. Mean saving: 0.222 ticks; median saving: 0. Aggregate improvement: **0.116%**, 95% paired-bootstrap interval **-0.372% to 0.531%**. Wins/ties/losses: 20/130/8. Failed/capped runs are excluded from speed statistics.

No statistically established speedup and no 20% claim. Ten baseline failures recovered, eight baseline successes regressed. The gate protects energy, not universal task completion. The frozen MLP is enabled in both arms, so this is not an AI ablation.

On the 13 previously inspected exhaustion seeds (development data), the gate eliminated zero-battery work, kept minimum battery at or above 20%, and preserved 64 completed tasks before and after. That paired development comparison is distinct from this fresh acceptance set: raw completion rates from different seed sets must not be used to estimate the guard's causal effect.

Reproduce with `MEASURE_INTEGRATED=1 npx vitest run tests/integrated-measurement.test.ts` at f946872 in a separate checkout to preserve the archived results. Raw per-seed data and protocol are in report.json. Historical v1 numbers are unchanged and require source commit 20fb088 for reproduction.
