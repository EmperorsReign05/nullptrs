"""Format recorded acceptance statistics; no simulation or policy changes."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped/acceptance-event-single'
summary = json.loads((out / 'summary.json').read_text())
# Historical A/D rows lack the newly introduced executable-owner audit.
for section in summary.values():
    for arm in ['baseline', 'current']:
        section['metrics'][arm]['duplicateExecutableOwnerRobotTicks'] = None
(out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
def pct(v):
    return f'{100*v:.2f}%' if v is not None else 'not measured'
rec = summary['n0-recoverable']
tct = rec['A_to_event']['sumTaskCompletionTime']
ms = rec['A_to_event']['makespan']
ci = tct['aggregateReduction95CI']
lines = [
    '# Frozen acceptance: event-only allocator versus stop-and-wait', '',
    'This measures the fixed phase-2 `event-single` experiment with D bidding. It does not measure a grouped H allocator. The user explicitly authorized acceptance evaluation after the development reliability regression. No allocator tuning followed that regression.', '',
    f"Primary recoverable result: **{pct(tct['aggregateReduction'])} aggregate paired sumTaskCompletionTime reduction** versus frozen A; 95% bootstrap CI **[{pct(ci[0])}, {pct(ci[1])}]**. There are **{tct['pairedCompleteCount']} mutually complete pairs out of {tct['candidates']} scenarios**.", '',
    f"Makespan reduction on the same mutually complete population: **{pct(ms['aggregateReduction'])}**, 95% CI [{pct(ms['aggregateReduction95CI'][0])}, {pct(ms['aggregateReduction95CI'][1])}].", '',
    f"Numeric TCT threshold >=20%: **{tct['aggregateReduction'] >= .20}**. Bootstrap lower bound >=20%: **{ci[0] >= .20}**. This speed result does not erase reliability regressions relative to current D.", '',
    '| Recoverable population | A→event TCT | TCT 95% CI | A→event makespan | Complete pairs | A completion | D completion | Event completion |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
]
for n in [0,3,5,8]:
    s = summary[f'n{n}-recoverable']; t = s['A_to_event']['sumTaskCompletionTime']; m=s['metrics']
    lines.append(f"| {'All N' if n==0 else f'N={n}'} | {pct(t['aggregateReduction'])} | [{pct(t['aggregateReduction95CI'][0])}, {pct(t['aggregateReduction95CI'][1])}] | {pct(s['A_to_event']['makespan']['aggregateReduction'])} | {t['pairedCompleteCount']}/{t['candidates']} | {pct(m['baseline']['completionRate'])} | {pct(m['current']['completionRate'])} | {pct(m['event']['completionRate'])} |")
lines += ['', f"D→event recoverable paired TCT reduction: {pct(rec['D_to_event']['sumTaskCompletionTime']['aggregateReduction'])}, {rec['D_to_event']['sumTaskCompletionTime']['pairedCompleteCount']} pairs. Frozen A→D reading: {pct(rec['A_to_D']['sumTaskCompletionTime']['aggregateReduction'])}.", '',
    f"Pair exclusions are reported, not discarded silently: A-only complete={tct['baselineOnlyComplete']}; event-only complete={tct['treatmentOnlyComplete']}; neither complete={tct['neitherComplete']}.", '',
    '## Reliability and safety across every acceptance scenario', '',
    '| Regime | Runs | A completion | D completion | Event completion | Event audited safety counter total | Duplicate executable-owner robot ticks |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for regime in ['all','low','recoverable','severe']:
    s=summary[f'n0-{regime}']; m=s['metrics']; e=m['event']
    lines.append(f"| {regime} | {e['runs']} | {pct(m['baseline']['completionRate'])} | {pct(m['current']['completionRate'])} | {pct(e['completionRate'])} | {sum(e['safety'].values())} | {e['duplicateExecutableOwnerRobotTicks']} |")
lines += ['', '## Interpretation and provenance', '',
    'Speed statistics use every mutually complete pair under the frozen PR #28 formula. Reliability uses all scenarios. Timeouts are never imputed as completion times. No acceptance seed, endpoint, battery, payload, priority, horizon, motion policy, baseline, A*, or metric was changed.', '',
    'The unchanged recorded A/D rows are reused. Protected source hashes and suite/row IDs, task creation ticks, and horizons are checked before treatment runs. Per-scenario evidence includes all A, D and event rows, including incomplete runs. Frozen D was already reproduced exactly on all 1,980 scenarios.', '',
    'The treatment remains default-off. The observed development reliability regression still blocks promotion and continuation to grouped allocation. No grouped auction or new logical-round safety claim is made. Historical A/D executable-owner counts are marked unmeasured because those rows predate the new audit.', '',
    'Evidence: `summary.json`, `per-scenario.json.gz`, and `provenance.json` in this directory. Reproduce with `node_modules/.bin/vite-node scripts/event-single-acceptance.ts` and `python3 scripts/report-event-single-acceptance.py`.']
(out/'report.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines[:10]))
