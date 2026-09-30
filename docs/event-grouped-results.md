# Tasks waited. Robots waited. We removed much of the wait.

## Plain explanation

**Old system:** task arrives. Task waits in a small admission queue. Auction waits for its clock phase. Robots bid. A majority agrees. Robot finally starts.

**EVENT:** task becomes eligible. Robots bid now. A majority can certify now. The safety clock stays; the unnecessary auction-phase wait goes.

**GROUPED:** look at several pending tasks together. Each robot prices feasible ordered bundles, including work already promised. Peers reconstruct one deterministic allocation. Every task still needs its own majority certificate.

**RECHARGE:** an unloaded robot could have enough battery for its current job but not its whole promised queue. Execution correctly stopped it; charging sometimes incorrectly said “ready.” The optional fix makes charging consider that full queue too. It retains ownership and cargo rules.

**Result:** the final grouped + recharge experiment is **67.54% faster on paired task completion time than frozen stop-and-wait**, with **91.44% run completion**. EVENT-only is less fast but more reliable: **54.82% faster, 96.22% completion**. This is an experimental option, not a production-default change.

## What the numbers mean

All **1,980 frozen acceptance scenarios** were evaluated. The primary SIH scoreboard is their **900 recoverable-overlap scenarios**, including N=3/5/8 with 300 scenarios each.

`sumTaskCompletionTime = SUM(completionTick - createdAt)` over tasks in a completed run. Paired speed statistics include **every mutually complete scenario pair**. Completion is the percentage of scenarios where **all tasks finish within the unchanged horizon**, not a percentage of tasks, prediction accuracy, or a collision probability. Failed runs have no fabricated completion times.

For each comparison, aggregate reduction is `1 - SUM(treatment TCT)/SUM(baseline TCT)` over those pairs. Confidence intervals use the existing 10,000-resample paired bootstrap. The speed columns below have different mutually complete populations; use the direct comparisons to isolate changes.

| Recoverable suite | STOPWAIT A | OLD DISTRIB D | EVENT-only | GROUPED before recharge | GROUPED + recharge |
| --- | ---: | ---: | ---: | ---: | ---: |
| Completion % | 66.89% | 97.56% | 96.22% | 88.44% | **91.44%** |
| Paired TCT reduction vs A | 0% | 2.32% | 54.82% | 68.87% | **67.54%** |
| Makespan reduction vs A | 0% | 1.83% | 41.95% | 56.07% | **54.56%** |
| Mean release → ownership, ticks | 81.75 | 81.71 | 18.55 | 4.55 | **4.73** |
| Median eligible → certificate, ticks | 21 | 22 | 1 | 1 | **1** |
| Logical ownership sends / peer / tick | 2.91 | 4.55 | 5.53 | 4.20 | **4.57** |
| Audited safety counter total | 0 | 0 | 0 | 0 | **0** |
| Duplicate executable-owner violations | 0 | 0 | 0 | 0 | **0** |

Old D duplicate-owner counts come from the instrumented full replay retained in phase1, not an invented retrospective field in the original artifact. A was also replayed exactly. Mean ownership latency includes first-assigned tasks in incomplete runs; never-assigned tasks are excluded, not counted as zero.

### Direct comparisons

| Baseline → treatment | Complete pairs / 900 | TCT reduction | 95% bootstrap CI | Makespan reduction |
| --- | ---: | ---: | --- | ---: |
| A → EVENT | 584 | 54.82% | 53.65–55.99% | 41.95% |
| EVENT → GROUPED before recharge | 766 | 27.80% | 25.83–29.66% | 22.87% |
| GROUPED before → GROUPED + recharge | 773 | **−2.18%** | −4.03–−0.42% | −2.21% |
| EVENT → GROUPED + recharge | 795 | **25.75%** | 23.58–27.78% | 21.02% |
| A → GROUPED + recharge | 556 | **67.54%** | **66.38–68.65%** | **54.56%** |
| Old D → GROUPED + recharge | 804 | **64.82%** | 63.74–65.80% | 51.11% |

Negative reduction means slower. Recharge gained **50** previously failed recoverable runs and lost **23** previously complete runs: net **27/900**, or **+3.00 percentage points**. Final grouped completion remains **4.78 points below EVENT** and **6.11 below old D**.

A/final-grouped pair accounting: 556 both complete, 46 A-only complete, 267 grouped-only complete, 31 neither complete. No inconvenient mutually complete pair was removed.

### Fleet sizes: recoverable overlap

| N | EVENT completion | GROUPED before | GROUPED + recharge | A → final TCT reduction | EVENT → final TCT reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 | 97.33% | 92.00% | **95.33%** | 72.01% | 37.71% |
| 5 | 95.67% | 96.33% | **97.00%** | 65.16% | 23.19% |
| 8 | **95.67%** | 77.00% | **82.00%** | 47.40% | 1.37% |

N=8 is the main remaining reliability weakness. Grouping is not an unconditional improvement over EVENT. Final completion over **all 1,980 acceptance scenarios** is **91.57%**, versus EVENT **96.16%** and old D **97.93%**. Low/recoverable/severe and every fleet-size breakdown remain in the saved summaries.

## Exact old protocol

Base: PR #28, `6ad2458d6e32ee57e0267482fa6740124f7f04b2`.

1. Runtime validates immutable task data and announces it through one live peer. Peers learn other tasks through the transport.
2. Peers sort pending tasks by descending priority, ascending creation tick, then ID. Fresh admission is limited to `max(1, floor(N/2))`; existing owners renew separately.
3. Ownership generation is `floor(tick/32)`. Bids are sent at phase 3, accepted in the four-tick bid window, and proposals begin at phase 4.
4. The lexicographically first live bidder proposes after collecting a majority-sized bid set. Receivers independently recompute the winner. A live previous owner takes precedence on renewal.
5. Each grantor votes once per task/generation. `floor(N/2)+1` distinct matching grants certify a lease, expiring at the next generation boundary.
6. Runtime exposes certified ownership. Execution also checks lease validity/quorum reachability; pickup and completion require custody/completion checkpoints. Loaded crash recovery cannot silently assign the cargo to another robot.

## Exact changes, in experimental order

### Phase 1: profile only

Passive timestamps record announcement, first eligibility, first bid, quorum bid, proposal, first grant, first certificate, runtime assignment, physical pickup and completion, alongside `createdAt`. All 1,980 instrumented old-D rows reproduced the frozen original fields exactly.

### Phase 2: event-only

`allocationMode: "event-single"` keeps the original frontier and 32-tick lease/vote generations. A fresh task bids on eligibility instead of waiting for phase 3; bids are accepted throughout that generation and a quorum-sized bid set can propose without the phase-4 gate. One local bid per task/generation and proposal retries bounded by bid-set growth limit traffic.

**No new per-task ballot protocol was implemented.** Existing task + generation identity remains monotonic and safety-critical. Conflicting same-generation votes can still strand an auction until the next generation. Immediate certification means removing artificial auction phase gates, not deleting lease fencing.

The original development stop decision is preserved. The user subsequently explicitly authorized acceptance despite its small reliability regression, then authorized grouped allocation and the recharge experiment. Historical reports saying “stopped” describe those earlier decisions; this document is the current result.

### Phase 3: grouped allocation

`allocationMode: "event-grouped"` builds on immediate eligibility/bidding/certification:

- Canonical ordering starts with priority/release/ID, then chains tasks by summed pickup and dropoff Manhattan proximity with deterministic ties. Groups contain at most **four** announced pending tasks. Peers with the same valid information derive the same ordering; asynchronous peers can initially have different groups.
- Each robot computes offers for up to **15 nonempty ordered subsets** of a group. Inputs are its own state/commitments, announced tasks, public geometry and received peer position/path messages. No private peer battery/queue, hidden global robot state, central scheduler or future task truth enters allocation.
- Bundle costs include remaining active-route duration, queued pickup/delivery duration, travel to the first pickup, every delivery and inter-task leg, and priority/deadline penalties. The existing bid scorer/MLP is reused unchanged. Deep queues no longer look cheap because their remaining durations are included in bundle ETA. This fix is scoped to grouped offers; the frozen independent scorer is unchanged.
- Joint feasibility includes payload, battery, charger reachability/reserve, and **five total commitments: one active + four queued**. Fresh admission retains the 20% battery floor; certified execution retains a 15% reserve.
- Bounded exact set-packing dynamic programming maximizes covered tasks, then minimizes bundle cost, then breaks ties deterministically. Each robot wins at most one ordered subset per episode; no task appears in two winning bundles.
- A proposal carries the communicated bids and assignments. Peers reconstruct the selection; reservations fence competing episodes. A winning robot recomputes its own feasibility before granting. All reservations and votes are installed before sending any grant.
- Every task needs its majority certificate. Fresh bundled execution additionally requires the winning owner's grant and certificates for its whole ordered bundle. Queue order is installed only after certification. Remaining commitments are checked again before movement and physical pickup.
- Offers are cached across motion and recomputed on useful changes including commitments, availability/charging, membership, geometry, task phase, generation and 5% battery bins. Transport updates are gated by commitment IDs and feasible offer subsets; proposals by bid-set revision. This is not per-tick bid/proposal rebroadcast. Cost-only refreshes need not emit a new packet; cached cost staleness remains a limitation.

### Reliability iteration: queue-aware recharge

`groupedQueueRecharge: true` is a separate opt-in layered on exactly the same grouped allocator. Before physical pickup, full-queue infeasibility or a rejected energy move causes the existing charging lifecycle to run instead of indefinitely reporting “ready.” A rejected candidate move can trigger this even if another feasible move later succeeds; the policy is conservative and may recharge unnecessarily.

The robot retains its commitments, certified order and custody intent. Loaded cargo still follows the original delivery-or-explicit-recovery branch. No energy guard, reserve, queue limit, ownership vote or cargo rule was removed.

Defaults remain `allocationMode: "epoch"`, recharge off. Experimental paths are wired through `FleetRuntime` and the benchmark runner; this PR does not enable them in the production fleet/dashboard.

## Where the waiting went

Mean first-stage timestamps **after release**, for recoverable tasks having all first-stage observations and a first assignment:

| Stage, ticks after creation | Old D | EVENT | GROUPED before | GROUPED + recharge |
| --- | ---: | ---: | ---: | ---: |
| Announcement | 1.00 | 1.00 | 1.00 | 1.00 |
| Auction eligibility | 62.48 | 16.80 | 1.00 | 1.00 |
| First bid | 80.30 | 16.80 | 1.00 | 1.00 |
| Quorum bid | 80.30 | 16.90 | 1.93 | 1.96 |
| Proposal | 81.30 | 18.01 | 2.99 | 3.10 |
| First grant | 81.30 | 18.01 | 3.35 | 3.50 |
| Certificate | 81.30 | 18.01 | 3.85 | 4.00 |
| Runtime ownership | 81.71 | 18.55 | 4.55 | 4.73 |
| Observed tasks | 10,798 | 10,800 | 10,445 | 10,492 |

Old D spent about **62.48 ticks to admission**, another **17.82 to quorum bid**, **1.00 to certificate**, then **0.41 to runtime visibility**. Final grouped spent **1.00**, **0.96**, **2.04**, and **0.72** respectively. Differences reflect first observations; they do not isolate failed-round time or compare identical assigned populations. Never-assigned tasks are a separate reliability failure.

For the same 766 mutually complete EVENT/grouped-before scenarios, task-flow means were EVENT **19.05 / 21.63 / 15.10** and grouped **4.49 / 19.55 / 16.24** ticks for release→ownership / ownership→pickup / pickup→completion. Most of that measured gain came from admission. This does not establish a large multi-task bundle advantage: final certified bundles average **1.02 tasks**, median **1**, while proposed groups average **1.90 tasks**.

Retries are counted as distinct proposal revisions after the first per task (final **2.16/task**), not independent logical ballot rounds. Complete per-round failure durations and quorum-failure attribution are not instrumented; no exact failed-round decomposition is claimed.

## Traffic and energy

Recoverable totals include failed runs to the full horizon:

| Metric | Old D | EVENT | GROUPED before | GROUPED + recharge |
| --- | ---: | ---: | ---: | ---: |
| Logical ownership sends | 6,015,789 | 5,660,133 | 6,470,040 | 6,113,448 |
| Sends / peer / tick | 4.55 | 5.53 | 4.20 | 4.57 |
| Rejected energy checks | 27,484 | 52,408 | 95,625 | 57,292 |

Final total sends are **8.01% above EVENT**, despite a lower normalized rate, and **5.51% below grouped-before**. Both matter. These count logical ownership send calls, including heartbeat/gossip, not DDS bytes or motion traffic; broadcasts fan out to up to N−1 peers. This is not proof of real DDS transport capacity at N=8.

The historical field `energyHoldRobotTicks` actually counts rejected `moveAllowed` evaluations, potentially multiple per robot/tick. It is not unique held robot ticks. Final queued tasks average **0.10/robot/tick**. All fleet/regime summaries and per-scenario records are retained.

## Why ownership safety still holds

Within a task/generation, a peer cannot vote for conflicting lease identities. Two strict-majority certificates would intersect at a grantor, which would need to vote twice; the protocol rejects that. Bundle identity is included in lease equality, so conflicting group plans cannot evade the fence. Reservation installation precedes grants, owner participation verifies private feasibility, and whole-bundle certification prevents executing a partially certified fresh bundle.

Across generations, leases expire at a shared boundary and stale-generation messages are rejected. Custody is quorum-recorded before physical pickup; a future majority intersects that write and cannot give physical cargo to a different owner. Completion checkpoints remain. Duplicate/reordered grants are keyed by sender and matching identity. Minority partitions stop when leases expire; liveness can be lost without creating a second owner.

**Scope of this argument:** honest peers, fixed membership, shared integer tick clock, crash-stop failures, retained in-process votes. It is not a Byzantine proof, reboot persistence guarantee, or independent wall-clock UDP lease implementation. The simulator's task/motion mirror and audits observe global state; allocator bidding does not consume hidden global peer state.

## Method and failed experiments

Frozen A–F stay intact. Treatments use D's distributed motion and existing Edge-AI bid mode, with guidance off. No change to map, starts, tasks/endpoints, seeds, release times, priorities, payloads, batteries, fleet sizes, horizon, speed, stop-and-wait, A*, conflict policy or TCT formula. Deterministic-bid G / MLP increment G→H was not measured in this iteration.

Each final grouped/recharge policy ran all **1,980 disjoint frozen development scenarios before acceptance**, with fixed source hashes through acceptance. Grouped-v4 development completion was 87.02%; recharge raised it to 89.90%. Recoverable recharge development completion rose 85.67→89.67%, with a 2.97% paired TCT penalty. The declared gate required zero safety violations, improved completion and honest reporting of speed cost; the catastrophic completion floor was 80% overall.

Preserved failed/superseded development runs: v1 mistakenly applied the 20% fresh-bid floor to certified execution (stopped at 263 scenarios); v2 fixed reserve but had speculative order/incomplete crash recovery (625); v3 fixed those but recalculated too often and lacked the final pickup guard (732). These partial development runs are not acceptance results. No acceptance seed was used for tuning.

## Regression evidence

- Final full `npm test`: **610 passed, 20 skipped**. Targeted grouped/charging/runtime suites: **37 passed**. TypeScript, production webpack build and fleet build passed.
- Hostile grouped coverage includes N=3/4/5/8, eight simultaneous tasks, multiple/competing groups, deterministic ties, delayed bids, duplicate/reordered proposals and grants, stale generations, partitions before/after certification, quorum recovery, bidder/winner crashes, sticky loaded custody, queue saturation and changed energy. Tick-by-tick checks enforce executable owners ≤1; runtime movement/pickup enforce energy, payload and queue constraints.
- Existing hostile ownership coverage: 63 cases/mode for epoch and EVENT. EVENT fault scenarios: 30, all safe.
- Final-code replays reproduced **every original field** of old D and recorded EVENT on all **1,980 scenarios each**. Every frozen A acceptance row was also replayed exactly. The unchanged grouped control was replayed on three scenarios per fleet/regime cell in each block; its saved rows were independently checked unchanged everywhere.
- Independent saved-row verification checked all 1,980 IDs/task release ticks/source hashes, all safety counters, and **128 acceptance + 64 development paired comparisons**.
- Earlier ROS2 tests including real DDS and software fleets N=1/3/5/8 passed. Earlier Nav2 N=3/5 passed. **Nav2 N=8 failed twice**, including isolated rerun: controller progress error `status=6`, `code=105`, no recorded collisions. It remains unresolved. Recharge did not rerun or fix this gate. These transport/hardware paths exercise default epoch, not a deployed grouped fleet.

Zero audited collisions/duplicate owners is measured simulator/test evidence, not a universal hardware safety guarantee. No claim that all regression gates pass is made.

## Evidence and reproduction

- [Final recharge report](../artifacts/event-grouped/reliability/queue-recharge-v1/report.md), with development/acceptance rows, provenance, source snapshot, verification and regression logs beside it.
- [Grouped phase report](../artifacts/event-grouped/phase3/grouped-v4/report.md), including earlier experiments and failed Nav2 logs.
- [EVENT acceptance report](../artifacts/event-grouped/acceptance-event-single/report.md).
- [Initial profiling/development record](event-allocator-experiment.md), retained as history.

Historical reports/snapshots were not rewritten; their earlier “publication on hold” status is superseded by this PR. Compressed complete rows and checkpoints are included (compressed evidence plus exact frozen-input copies); uncompressed scratch checkpoints stay local.

Two required PR #28 inputs were ignored by the original repository: the frozen development suite and original per-scenario A–F rows. Exact compressed copies plus SHA-256 hashes are included in `artifacts/event-grouped/frozen-inputs/`. Restore them with the command below; it verifies existing files and refuses to overwrite a mismatch. No seed regeneration is needed. Then run, in order:

```sh
python3 scripts/restore-event-grouped-inputs.py
node_modules/.bin/vite-node scripts/event-single-acceptance.ts
node_modules/.bin/vite-node scripts/grouped-benchmark.ts --final
node_modules/.bin/vite-node scripts/grouped-benchmark.ts --acceptance --final
node_modules/.bin/vite-node scripts/grouped-recharge-benchmark.ts --final
node_modules/.bin/vite-node scripts/grouped-recharge-benchmark.ts --acceptance --final
python3 scripts/verify-grouped-recharge.py
python3 scripts/report-grouped-recharge.py
```

These commands write experiment artifacts; preserve the checked-in measured evidence before rerunning them. `event-single-acceptance.ts` consumes the phase-2 control already included in this branch. Full-source hashes and frozen dependencies are recorded in provenance files.

## Decision

The final numeric SIH TCT requirement and its 95% lower bound exceed 20%; makespan also exceeds 20%, with zero audited inter-robot collision violations. Completion is still materially worse than EVENT at N=8. Keep all experimental switches off by default. EVENT remains the stronger reliability choice; grouped + recharge is a faster optional candidate with explicit unfinished reliability and Nav2 gates.
