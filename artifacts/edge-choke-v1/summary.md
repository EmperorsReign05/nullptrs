# Independent-process acceptance — 29 September 2026

Three independent Node robot controllers run their own task ownership, guarded frozen MLP bids, A*, obstruction memory and local movement decisions. They exchange ownership and motion packets directly over UDP. The host supplies simulated time and local sensor contacts and audits movement; it does not select routes or movement winners. The dashboard monitors this real state and supplies controls.

## Measured results

Frozen implementation f946872; development seeds 23000–23003; untouched acceptance seeds 24000–24039. Forty paired seeds cover **20 unique geometries**, three robots and three opposing tasks, one bridge, 512-tick horizon. Both policies use identical allocation, planning, sensors and energy protection. The preferred-cell-only comparator is checked against the original stop-and-wait resolver on representative connected snapshots; the historical baseline source is unchanged.

- Negotiated: **40/40 runs, 120/120 tasks completed**, all three robots crossed in every run.
- Stop-and-wait: **0/40 runs, 0/120 tasks completed**. All three tasks were assigned at release in both arms.
- Both arms: zero measured overlaps, swaps, blocked-cell entries, zero-battery work, queue overflow, payload violations and non-adjacent moves.
- **No jointly completed pairs: no valid percentage-speedup estimate.** Failed capped runs are excluded from speed statistics.
- The frozen MLP was invoked and applied bid corrections, but changed no winners in this workload. This is evidence of motion negotiation, not an AI speedup.

Raw data: [acceptance report](acceptance-report.json), [per-seed rows](acceptance-rows.json), [frozen sources](freeze.json).

## End-to-end checks

The separate-process fault smoke kills one controller before pickup, reassigns its job, blocks an aisle, exercises communication partition/healing and AI fallback. All three tasks complete at tick 241 with zero audited safety violations. See [fault smoke](fault-smoke.json). Earlier failed fault fixtures are preserved; adjacent-to-failed-body pickup recovery is not claimed.

The real Next dashboard proxy was checked against these processes: pause/run, AI toggles and task announcement affect actual backend state. After closing Next, backend ticks advanced from 21 to 24 with all three controllers alive. See [dashboard smoke](dashboard-smoke.json). This is an HTTP integration check, not a visual screenshot audit.

Energy-gate development replays eliminated zero-battery work in all 13 previously exhausting seeds while preserving 64 completed tasks. The execution guard reserves energy for active work, queued work, a charging route and a 15% reserve. Charging service itself is not implemented in this distributed lifecycle; a safe hold can leave work unfinished.

## Later queue fix and broader acceptance

Commit 938af2c repairs execution with four already queued tasks. It does not alter the new-bid feasibility rule or frozen model. This branch is unreachable in the three-task choke workload (at most two queued tasks). The original acceptance files and freeze remain untouched; the 40 seeds were not reused to tune this fix.

A new untouched 200-seed warehouse sweep after that fix is **not an overall acceptance pass**: negotiated/integrated completed 173 runs versus baseline 176, with 1165 versus 1159 tasks. Among 166 jointly successful pairs, aggregate improvement was 0.575%, with 95% interval −0.064% to 1.457%. Safety counters were zero in both arms. This sweep runs the one-process integrated runtime, not the three-process deployment. See [latest warehouse results](../integrated-stopwait-v3/summary.md).

## Verification and claim boundaries

Production Next build and targeted tests passed. Full suite: 326 passed, 14 skipped, two existing compare.test.ts cycle assertions failed (10 and 20 robots); UDP passed in this run. See build.txt, targeted-tests.txt and full-suite.txt. This is not a fully green suite.

Safe claim: independently executing robot software, direct UDP coordination, demonstrated narrow-choke completion, guarded AI bidding, failure-before-pickup recovery, live monitoring and audited simulation safety within these protocols.

Do not claim: proven ≥20% integrated speedup, universally improved reliability, asynchronous physical safety, automatic cargo recovery after pickup, ROS2/DDS/Nav2 integration, Raspberry Pi/Jetson measurements or physical AMR deployment. No edge hardware was available. Fixed membership, shared simulation clock, trusted LAN and crash-stop assumptions remain. Losing a majority safely prevents ownership progress.

Reproduction and remote deployment instructions: [edge guide](../../docs/edge/README.md).
