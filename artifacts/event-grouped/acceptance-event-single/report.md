# Frozen acceptance: event-only allocator versus stop-and-wait

This measures the fixed phase-2 `event-single` experiment with D bidding. It does not measure a grouped H allocator. The user explicitly authorized acceptance evaluation after the development reliability regression. No allocator tuning followed that regression.

Primary recoverable result: **54.82% aggregate paired sumTaskCompletionTime reduction** versus frozen A; 95% bootstrap CI **[53.65%, 55.99%]**. There are **584 mutually complete pairs out of 900 scenarios**.

Makespan reduction on the same mutually complete population: **41.95%**, 95% CI [40.65%, 43.16%].

Numeric TCT threshold >=20%: **True**. Bootstrap lower bound >=20%: **True**. This speed result does not erase reliability regressions relative to current D.

| Recoverable population | A→event TCT | TCT 95% CI | A→event makespan | Complete pairs | A completion | D completion | Event completion |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| All N | 54.82% | [53.65%, 55.99%] | 41.95% | 584/900 | 66.89% | 97.56% | 96.22% |
| N=3 | 55.74% | [54.14%, 57.32%] | 47.83% | 259/300 | 88.00% | 98.67% | 97.33% |
| N=5 | 54.97% | [52.88%, 57.03%] | 36.82% | 195/300 | 67.33% | 97.67% | 95.67% |
| N=8 | 49.89% | [47.14%, 52.43%] | 27.53% | 130/300 | 45.33% | 96.33% | 95.67% |

D→event recoverable paired TCT reduction: 52.66%, 846 pairs. Frozen A→D reading: 2.32%.

Pair exclusions are reported, not discarded silently: A-only complete=18; event-only complete=282; neither complete=16.

## Reliability and safety across every acceptance scenario

| Regime | Runs | A completion | D completion | Event completion | Event audited safety counter total | Duplicate executable-owner robot ticks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 1980 | 68.18% | 97.93% | 96.16% | 0 | 0 |
| low | 600 | 74.00% | 98.50% | 96.67% | 0 | 0 |
| recoverable | 900 | 66.89% | 97.56% | 96.22% | 0 | 0 |
| severe | 480 | 63.33% | 97.92% | 95.42% | 0 | 0 |

## Interpretation and provenance

Speed statistics use every mutually complete pair under the frozen PR #28 formula. Reliability uses all scenarios. Timeouts are never imputed as completion times. No acceptance seed, endpoint, battery, payload, priority, horizon, motion policy, baseline, A*, or metric was changed.

The unchanged recorded A/D rows are reused. Protected source hashes and suite/row IDs, task creation ticks, and horizons are checked before treatment runs. Per-scenario evidence includes all A, D and event rows, including incomplete runs. Frozen D was already reproduced exactly on all 1,980 scenarios.

The treatment remains default-off. The observed development reliability regression still blocks promotion and continuation to grouped allocation. No grouped auction or new logical-round safety claim is made. Historical A/D executable-owner counts are marked unmeasured because those rows predate the new audit.

Evidence: `summary.json`, `per-scenario.json.gz`, and `provenance.json` in this directory. Reproduce with `node_modules/.bin/vite-node scripts/event-single-acceptance.ts` and `python3 scripts/report-event-single-acceptance.py`.
