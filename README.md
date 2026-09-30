# Team Rocket · Decentralized AMR Fleet Coordination

**Robots coordinate work with each other. The dashboard lets people see what is happening.**

Built for **SIH26123: Edge-AI-Based Distributed Fleet Coordination for Autonomous Mobile Robots**. The system combines peer task auctions, majority-certified ownership, local motion coordination, energy-aware queues, and guarded Edge-AI bidding. It includes a warehouse simulator, separate robot processes, ROS2/Fast DDS transport, and Nav2 integration.

The biggest measured improvement came from **getting tasks assigned sooner**. Faster pathfinding was not the answer to the dominant delay.

> **Latest experimental result:** **67.54% lower total task completion time** than frozen stop-and-wait, **95% confidence interval 66.38–68.65%**, and **54.56% lower makespan**, with **zero audited inter-robot collision and duplicate-owner violations**. Run completion was **91.44%**. These are simulation results from the optional allocator in [PR #30](https://github.com/EmperorsReign05/nullptrs/pull/30), not physical-hardware results or the production default.

[Measured experiment and technical explanation](https://github.com/EmperorsReign05/nullptrs/blob/main/docs/event-grouped-results.md) · [PR #30](https://github.com/EmperorsReign05/nullptrs/pull/30) · [Quick start](#run-it-locally) · [Evidence](#evidence-you-can-check) · [Limits](#what-is-still-unfinished) · [Glossary](#short-glossary)

## What problem does this solve?

In a busy warehouse, several robots need the same aisle and several tasks need the same robot. Simply stopping whenever another robot blocks the next cell can leave the fleet waiting indefinitely. Independently choosing the cheapest robot for every task can also overload its queue or promise work its battery cannot support.

Our controllers coordinate both **who owns the work** and **who moves next**. A robot needs a valid majority ownership certificate before execution. Battery, payload and queue constraints remain execution gates. Once cargo has been picked up, a failed robot requires explicit recovery; another robot cannot silently claim that physical cargo.

## The scoreboard

All experimental policies ran the same **1,980 frozen acceptance scenarios**. The table below uses the primary **900 recoverable-overlap scenarios**, with **300 each at N=3, 5 and 8**.

| Metric | Stop-and-wait | Original distributed | EVENT-only | EVENT + grouped + recharge |
| --- | ---: | ---: | ---: | ---: |
| Runs completing all tasks | 66.89% | **97.56%** | 96.22% | 91.44% |
| Paired total task-time reduction vs stop-and-wait | Baseline | 2.32% | 54.82% | **67.54%** |
| Paired makespan reduction vs stop-and-wait | Baseline | 1.83% | 41.95% | **54.56%** |
| Mean release → ownership, ticks | 81.75 | 81.71 | 18.55 | **4.73** |
| Median eligibility → certificate, ticks | 21 | 22 | **1** | **1** |
| Logical ownership sends / peer / tick | 2.91 | 4.55 | 5.53 | 4.57 |
| Audited safety counter total | 0 | 0 | 0 | 0 |
| Duplicate executable-owner violations | 0 | 0 | 0 | 0 |

**EVENT-only already clears the numerical 20% target**, with a 95% interval of **53.65–55.99%**. Grouped allocation plus queue-aware recharge is faster on directly paired completed runs, but less reliable overall. It is an experimental candidate, not an unconditional upgrade.

### The comparisons that actually isolate the changes

| Comparison | Mutually complete pairs / 900 | Total task-time reduction | 95% bootstrap interval |
| --- | ---: | ---: | --- |
| Stop-and-wait → EVENT | 584 | 54.82% | 53.65–55.99% |
| EVENT → grouped + recharge | 795 | **25.75%** | 23.58–27.78% |
| Stop-and-wait → grouped + recharge | 556 | **67.54%** | 66.38–68.65% |
| Original distributed → grouped + recharge | 804 | 64.82% | 63.74–65.80% |

Each comparison has its own mutually complete population. Subtracting two headline percentages does not isolate an allocator's effect.

| Fleet size | EVENT completion | Grouped + recharge completion | Grouped TCT reduction vs stop-and-wait | Grouped TCT reduction vs EVENT |
| --- | ---: | ---: | ---: | ---: |
| N=3 | 97.33% | 95.33% | 72.01% | 37.71% |
| N=5 | 95.67% | **97.00%** | 65.16% | 23.19% |
| N=8 | **95.67%** | 82.00% | 47.40% | 1.37% |

**N=8 is the main grouped reliability weakness.** EVENT remains the stronger reliability choice overall. Across all 1,980 acceptance scenarios, grouped + recharge completes 91.57%, versus EVENT's 96.16%.

### How we count

- **Primary:** `sumTaskCompletionTime = SUM(completionTick - createdAt)` across tasks in complete runs. This includes waiting for assignment, travel to pickup, and delivery.
- **Secondary:** makespan, from the first task's creation to the last task's completion.
- **Paired reduction:** `1 - SUM(treatment time) / SUM(baseline time)`, using every scenario where both policies finish all tasks. Confidence intervals use 10,000 paired bootstrap resamples.
- **Reliability:** the fraction of all scenarios where every task finishes within the unchanged horizon. Timeouts are reported as failures, never invented completion times.
- Ownership latency includes observed first-assigned tasks, including those in incomplete runs; never-assigned tasks are excluded. It therefore has a different denominator from paired speed.
- Traffic counts logical ownership sends, not DDS bytes or all fleet traffic. Grouped total sends are **8.01% above EVENT**, despite the lower normalized rate.

Maps, starts, task endpoints, releases, batteries, payloads, priorities, fleet sizes, horizon, A*, movement policy and the stop-and-wait implementation were held fixed. Development used a disjoint frozen block before acceptance. The detailed record includes failed experiments and source hashes.

## What changed—and why it worked

1. **Profile the wait.** The original full system spent roughly 70% of task flow time waiting for ownership. Routing improvements barely moved the final metric.
2. **EVENT: bid when eligible.** Remove the artificial bid/proposal clock-phase wait. Keep the original admission frontier, 32-tick lease generations, majority voting and expiry fencing.
3. **GROUPED: consider several tasks together.** Deterministically form groups of up to four announced tasks. Robots price ordered subsets using their own current work, full queued duration, travel legs, urgency, payload, battery and charger reserve. Peers reconstruct a non-conflicting selection from communicated offers.
4. **Certify before executing.** Every task still needs a strict-majority certificate. Fresh bundled execution also needs the owner's grant and certificates for its whole ordered bundle. Reservations prevent competing groups from spending the same capacity.
5. **Recharge for the promised queue.** An unloaded robot with enough battery for one job could still be unable to execute its whole queue. The optional fix starts the existing charging lifecycle when those commitments are unaffordable, retaining ownership and custody rules.

Most measured gain came from admission latency. **Final certified bundles average only 1.02 tasks, median 1**; we do not claim large bundles explain the result. Recharge recovered reliability by 3 percentage points versus grouped alone, at a 2.18% paired task-time penalty.

**No new per-task ballot protocol was introduced.** The event experiment retains task + generation identities. Conflicting votes can still require waiting for the next generation. Experimental modes are `event-single` and `event-grouped`, with a separate `groupedQueueRecharge` option; default mode remains `epoch`, recharge off.

## Architecture: where decisions happen

```text
Task announcement → peer bids / bundle offers → deterministic proposal
                                              ↓
                                  majority ownership certificate
                                              ↓
                              local planning + guarded execution
                                              ↓
                                  pickup / completion checkpoints

Robot peers ← UDP or ROS2/Fast DDS → robot peers
Dashboard ← telemetry and operator commands → fleet host
Simulation host → modeled physics, sensors and shared logical timing
```

- **Controllers:** own task ownership, bids, local planning and execution checks. Grouped bidding uses own commitments, announced tasks, public geometry and received peer messages; it does not read another robot's private queue or battery.
- **Dashboard:** displays telemetry and submits operator commands. It does not choose auction winners in the peer fleet.
- **Simulation host:** supplies modeled physics, sensors and shared timing. Separate processes are genuine transport integration, while the environment remains simulated.
- **Edge AI:** a frozen, guarded bid-refinement MLP with deterministic fallback. Its incremental effect is measured separately; the 67.54% result is a whole-system result, not an AI-only gain.
- **Motion:** congestion-aware A* and local conflict coordination. The preserved browser simulator uses central PIBT; it is a separate mode.

## Ownership and safety, in plain terms

A robot cannot execute a task just because it won a cheap bid. It needs `floor(N/2) + 1` matching peer grants, a valid lease, and runtime feasibility checks.

Within a task/generation, a peer cannot grant conflicting identities. Two strict majorities must share a peer, so two conflicting certificates would require that peer to vote twice. Expiry fencing and stale-generation rejection protect later generations. Bundle identity is part of the lease identity; duplicate and reordered grants do not create extra votes.

Custody is quorum-recorded before physical pickup. Later allocation cannot invent another owner for loaded cargo. Completion checkpoints, crash recovery and conservative energy/payload/queue checks remain.

**Assumptions:** honest peers, fixed membership, a shared integer tick clock, crash-stop failures and retained in-process votes. This is not a Byzantine protocol, a durable reboot guarantee, or proof of safety for independently timed physical robots.

## Run it locally

Node.js 24 was used for recorded validation. Install dependencies:

```sh
npm install
```

### Dashboard + integrated fleet

In separate terminals:

```sh
npm run fleet
```

```sh
npm run dev
```

Open **http://localhost:3000**. The standalone fleet serves telemetry on port 4010; the dashboard monitors it. Set `FLEET_PORT` and `FLEET_URL` to change the connection. This starts the default allocator, not the PR #30 experiment. Visit **`/simulator`** for the preserved browser-owned central simulator.

### Three separate robot processes

```sh
npm run edge:demo
```

```sh
FLEET_URL=http://127.0.0.1:4011 npm run dev
```

Each robot runs its own ownership, learned bidding and planning stack over UDP. The legacy `worker.ts` demo is preassigned-task-only; `edge-agent.ts` includes live ownership auctions.

### Configurable fleet and ROS2/Nav2

`config/fleet.json` defines membership, namespaces, grid origins and executor ports. `FLEET_CONFIG` selects another validated roster. These paths require the container setup used by the supplied scripts for ROS2/Nav2.

```sh
npm run fleet:n -- --robots 5 --transport udp
npm run ros2:test
npm run fleet:n -- --robots 5
npm run fleet:n:nav2 -- --robots 3
```

ROS2 uses real Fast DDS peer exchange with shared memory disabled. The bridge is local to each controller. Nav2 uses separate namespaces, EKF and Collision Monitor; task progress waits for successful path execution and measured arrival. The environment and sensors are simulated. These deployment paths validate the default epoch mode, not deployed grouped allocation.

The [historical hosted dashboard](https://amr-edge-ai.vercel.app/) is not evidence of the latest experimental runtime. The integrated fleet requires a long-lived Node process.

## Evidence you can check

| Evidence | Where to look |
| --- | --- |
| Exact algorithms, fleet breakdowns, failed experiments, safety argument | [Experiment technical report](https://github.com/EmperorsReign05/nullptrs/blob/main/docs/event-grouped-results.md) |
| Final grouped + recharge measurements and provenance | [Final report](https://github.com/EmperorsReign05/nullptrs/blob/main/artifacts/event-grouped/reliability/queue-recharge-v1/report.md) |
| EVENT control | [EVENT acceptance report](https://github.com/EmperorsReign05/nullptrs/blob/main/artifacts/event-grouped/acceptance-event-single/report.md) |
| Grouped experiment and superseded development runs | [Grouped phase report](https://github.com/EmperorsReign05/nullptrs/blob/main/artifacts/event-grouped/phase3/grouped-v4/report.md) |
| Reviewable optional implementation | [PR #30](https://github.com/EmperorsReign05/nullptrs/pull/30) |
| Historical large measurement files | [Checksummed evidence archive](https://github.com/EmperorsReign05/nullptrs/releases/tag/audit-evidence-2026-09-29) |

PR #30 records **610 tests passed, 20 skipped**, passing TypeScript, production and fleet builds. Hostile grouped tests cover simultaneous tasks, competing groups, ties, duplicates, reordering, delayed bids, stale generations, partitions, crashes before/after custody, queue saturation and changing energy. Executable ownership uniqueness is checked tick by tick. Old D and EVENT replays reproduce their original fields on all 1,980 scenarios each.

These are recorded results, not tests rerun by editing this README. To run the local code checks:

```sh
npm test
npx tsc --noEmit
npm run build
npm run fleet:build
```

To restore historical evidence without overwriting existing files:

```sh
python3 scripts/fetch-benchmark-evidence.py
```

To reproduce the **optional allocator experiment**, follow its technical report: `scripts/restore-event-grouped-inputs.py` restores exact checksummed inputs without regenerating seeds. Benchmark reproduction writes artifacts; preserve recorded evidence before rerunning it.

## What is still unfinished?

- **Grouped N=8 reliability:** 82% completion versus EVENT's 95.67%. Grouped is not the default recommendation for every fleet size.
- **Nav2 N=8 progress:** the experiment's regression runs failed twice with a controller progress error (`status=6`, `code=105`), with no recorded collisions. N=3/5 passed. Earlier larger-fleet successes do not close this latest gate.
- **Physical deployment:** no measured Raspberry Pi/Jetson execution, real sensor validation, or physical multi-robot acceptance. Grouped ownership has not been validated in deployed DDS/Nav2 controllers.
- **Safety scope:** zero audited violations describes these tests and scenarios; it is not industrial safety certification or a universal collision guarantee.
- **Coordination limits:** generation conflicts, cached offer costs, shared logical timing and unguaranteed charger fairness remain. Full failed-round duration and quorum-failure attribution are not instrumented.

**Current decision:** keep experimental switches off by default. EVENT offers the stronger reliability balance; grouped + recharge offers greater paired speed with a clearly measured reliability cost. Both experimentally exceed the numerical 20% criterion; neither result alone establishes complete hardware readiness or competition rank.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/core/distributed/ownership.ts` | Peer auctions, grants, leases, custody and completion |
| `src/core/distributed/runtime.ts` | Controller runtime, bidding and execution |
| `src/core/auction/` | Cost models and assignment; grouped bundle logic in PR #30 |
| `src/core/pathfinding/` | A* and central simulator PIBT |
| `src/core/simulation/` | Seeded worlds, robot models, energy and simulation |
| `src/server/fleet-http.ts` | Independent fleet telemetry/command service |
| `src/app/`, `src/components/dashboard/` | Next.js/React monitoring UI |
| `config/fleet.json` | Fleet roster and deployment configuration |
| `tests/`, `scripts/`, `artifacts/` | Verification, reproduction and preserved evidence |

Stack: TypeScript, Node.js, Next.js/React, Tailwind, Vitest; ROS2/Fast DDS and Nav2 for transport/navigation integration.

## Historical evidence

The sections below preserve the earlier benchmark methodology and results. Their unmet-target statements describe those frozen versions, **not** the subsequent PR #30 experimental result above.

## Frozen PR #28 benchmark: the starting point

This is the benchmark built to measure the actual SIH26123 criterion rather than the historical Edge-AI ablation. Every number below is read from `artifacts/sih-acceptance-v1/` and regenerable with the commands listed at the end.

### The two percentages are not the same experiment

**1.56% = bid-MLP incremental ablation. 20% = whole-system improvement over stop-and-wait. They are different experiments.**

- The accepted **1.56%** replaces *deterministic task bidding* with the *learned bid-refinement MLP* on the **same** coordination stack and the **same** motion system: 2,800 tasks, 200 unseen scenarios, 43 allocation winners changed. It measures the bid MLP and nothing else. It is not a SIH comparison and must never be compared to the 20% threshold.
- SIH's **20%** compares our *complete* proposed decentralized system against a *traditional stop-and-wait coordination baseline*, on workloads with **overlapping paths**, with **zero inter-robot collisions**.

### Metric definitions, fixed before any arm ran

"Total task completion time" is not defined mathematically by the problem statement, so both readings are measured and never merged:

- `sumTaskCompletionTime` = Σ over **completed** tasks of (`completionTick` − `createdAt`). **Primary.**
- `makespan` = `lastTaskCompletionTick` − `firstTaskCreationTick`. **Secondary.**

`reduction_i = (T_baseline_i − T_system_i) / T_baseline_i`; `aggregateReduction = 1 − Σ T_system / Σ T_baseline`, on **mutually complete pairs** only, with a 10,000-resample 95% paired bootstrap. A timed-out run has no completion time and its horizon is never imputed for it — speed and reliability are reported with separate denominators and are never combined.

### The baseline is not a straw man

Arm A is the **unchanged, hash-frozen** `resolveStopAndWait` (`src/core/bench/stopwait.ts`, SHA-256 `da6c1635…`, the same bytes the v5 acceptance recorded): follow the A* route; if the next cell is occupied now or already claimed this tick, do not move; resume when clear. It shares the treatment's congestion-aware A*, map, replanning triggers, stall-triggered rerouting, locally-sensed obstruction memory, ownership, quorum, custody, charging, energy admission and horizon. It uses no priority arbitration, no recursive displacement, no backtracking, no escape-chain breaking, no congestion guidance. It is additionally given an **advantage**: it resolves conflicts *synchronously with global visibility* while the treatment confirms locally.

### Workload and regime classification

1,980 frozen scenarios: 2 layouts (the production corridor warehouse, and a 3-to-4-cell-aisle AMR warehouse), 4 endpoint families, 3 fleet sizes (N=3, 5, 8), 12 tasks per run on a saturated release schedule, 1,500-tick horizon, every arm handed byte-identical geometry, starts, capabilities, batteries, endpoints, priorities and release times. The same (layout, family, seed) order book appears at all three fleet sizes, so fleet size is the only variable.

Regimes are assigned from **geometry only**, before any policy runs, and the label is re-derivable from the stored workload (asserted in `tests/sih-benchmark.test.ts`):

| Regime | Meaning | Scenarios |
|---|---|---:|
| `low` | overlap index below the control threshold | 600 |
| `recoverable` | **SIH acceptance regime**: genuine interference, geometry has passing opportunities | 900 |
| `severe` | overlap at/above threshold, or the routes have no passing place | 480 |

### Results (frozen, recoverable-overlap suite)

| Arm | Motion | Bidding | Guidance | Completion | Paired N | `sumTaskCompletionTime` | 95% CI | `makespan` | Safety |
|---|---|---|---:|---:|---:|---:|---|---:|
| A | stop-and-wait | deterministic | off | 66.9% | 602 | baseline | — | baseline | 0 |
| B | stop-and-wait | edge-AI bid | off | 67.7% | 588 | 0.11% | −0.17 … 0.39 | 0.03% | 0 |
| C | distributed | deterministic | off | 97.7% | 593 | **2.22%** | 1.46 … 3.05 | 1.53% | 0 |
| D | distributed | edge-AI bid | off | 97.6% | 590 | **2.32%** | 1.53 … 3.14 | 1.83% | 0 |
| E | distributed | deterministic | congestion toll | 97.8% | 594 | 2.26% | 1.48 … 3.08 | 1.58% | 0 |
| F | distributed | edge-AI bid | congestion toll | 97.6% | 591 | 2.33% | 1.54 … 3.17 | 1.86% | 0 |

**Historical result: the PR #28 epoch allocator did not meet the 20% criterion.** The 95% paired bootstrap lower bound for the A→D reduction in `sumTaskCompletionTime` is **1.53%**, against a 20% gate. The 95% lower bound for `makespan` is **1.00%**.

The honest positives are large and are reported on their own terms:

- **Reliability.** On the same 900 scenarios, the full system completes **97.6%** of runs (10,768/10,800 tasks) against stop-and-wait's **66.9%** (10,028/10,800 tasks). On the severe-contention regime, 97.9% versus 63.3%. Stop-and-wait livelocks: it typically retires 10 or 11 of 12 tasks and then makes no progress for 1,200+ consecutive ticks.
- **Zero audited robot-to-robot collision violations** in all 11,880 arm-runs, in every arm, every regime, every fleet size.
- **Motion efficiency.** 26.8% of the full system's productive robot-ticks are congestion waits, against 72.1% for stop-and-wait; 98.6% of its movement ticks advance toward its goal, against 91.8%.
- **Ablations stay separate.** A→C (distributed motion alone) 2.22%; C→D (the bid MLP alone) **0.15%**, CI −0.07 … 0.35 — the same experiment as the historical 1.56%, on a different workload. A→B (learned bidding with primitive motion) 0.11%.

### Where the time actually goes

Per completed task on the recoverable suite (sum of the three components equals flow time exactly, verified per slice):

| Component | Stop-and-wait | Full system |
|---|---:|---:|
| release → first ownership (certification, allocation, queueing) | 94.5 ticks | 82.2 ticks |
| ownership → pickup (approach travel + its congestion) | 19.2 | 19.3 |
| pickup → done (loaded travel + its congestion) | 15.9 | 15.6 |
| **total flow time** | **129.5** | **117.1** |

**70% of total task completion time is the wait for a task to be certified and assigned, not the wait for a route.** The A→D gain is essentially all queue drain: the two travel components are unchanged to within a tick, while the queue component is 12.3 ticks per task shorter because the fleet retires work faster. Congestion is 26.8% of *productive* robot-ticks, and productive ticks are only 25% of all robot-ticks — the rest is fleet slack, which is reported separately and never counted as delay.

### Route-guidance experiment (implemented, measured, and honestly null)

An experimental **local predictive congestion guidance** layer: a bounded non-negative per-cell additive A* cost, `baseEdgeCost + deterministicCurrentCongestion + boundedPredictedCongestionToll`. A* still chooses the route, the agent still resolves immediate conflict and guarantees safety, and ownership, custody, charging and energy admission are untouched. A 16-feature linear model predicts the realised expected additional wait, trained on whole-run rollouts on a **disjoint development seed block** and split by seed and layout family. Runtime inference reads only `Agent.guidanceObservation()`: own position, route, goal, route length, wait and stall history, own sensor contacts, received peer intents, own recent edge and cell history — no simulator state, no other robot's queue or battery, no global task or dashboard state, no centrally computed congestion field, no future ground truth. Centralised Training + Decentralised Execution.

It **ranks congested cells well** (the worst-predicted decile of cells carries 3.5× the base-rate realised wait, against 1.8× for a hand-set deterministic heuristic — see `guidance/test.json`) and it **changes nothing end to end**: C→E **+0.08%** (CI 0.00 … 0.16) and D→F **+0.06%** (CI −0.01 … 0.14) on the recoverable suite, and it is *negative* on the severe suite. The delay breakdown above explains why: the dominant cost is a queue that a per-cell routing toll cannot move, and the second is raw travel toward destinations that lie behind the penalised cells. Reported as a measured null result, not as a success. The 8-unit MLP ranked slightly better than the linear model (4.3× vs 3.5× decile lift) on 112 positive rows, which is inside the noise of that sample, so the smaller linear model is the frozen one.

### Reproduce the historical benchmark

```sh
npx vite-node scripts/sih-benchmark.ts generate      # freeze the suite (refuses to re-freeze)
npx vite-node scripts/sih-benchmark.ts train-guidance
npx vite-node scripts/sih-benchmark.ts evaluate --arms A,B,C,D,E,F \
  --model artifacts/sih-acceptance-v1/guidance/model.json
npx vite-node scripts/sih-benchmark.ts delay
npx vite-node scripts/sih-benchmark.ts final         # writes final-summary.json
npx vitest run tests/sih-benchmark.test.ts
```

Every headline number above is `acceptance.primaryGate.*`, `acceptance.ablation.*` or `acceptance.guidanceExperiment.*` in `artifacts/sih-acceptance-v1/final-summary.json`, which is assembled by reading the other artifacts and recomputing nothing.

### Measured limitations

- One Node process, a shared logical tick, simulated sensors. No hardware, no real sensor noise, no asynchronous physical leases.
- Workload is queue-saturated by design, so `sumTaskCompletionTime` is dominated by certification-and-queueing latency that both arms pay equally; the reported 2.32% is the coordination difference measured on the part of the metric that coordination can move.
- The paired-complete set is 590 of 900 recoverable scenarios, because stop-and-wait times out on 298 of them. Those 298 are reported in the reliability section and are **not** scored as a speedup.
- The 20% gate is evaluated on the mutually complete subset, which is biased toward scenarios the baseline can finish. On the full suite the system-level difference is larger and is a reliability difference, not a speed one.
- `commRange` is still 6, so per-tick ownership cost grows toward O(N²) and N=8 is close to the transport ceiling.
- `ownership-scale-probe.mjs` aborted in this pass at its own instrumentation step; `fault-scenarios.mjs` (30/30 safe) and `admission-benchmark.mjs` (0 duplicate executable owners) both ran clean.

## Historical integrated validation (v4)

Code frozen at `e7dd0cd`. These results remain unchanged as historical evidence. Seeds 31000–31199 have since informed the clearance fix and are now development data, not a fresh acceptance set for newer code:

- Production and fleet builds pass. Full suite: **356 passed, 17 skipped, zero failures**. The former cycle and UDP tests now pass with their completion/safety assertions retained.
- **200 untouched warehouse seeds (31000–31199): 198/200 completed runs, 1197/1200 tasks**, versus fair stop-and-wait **170/200 runs, 1147/1200 tasks**. No baseline-successful run becomes incomplete; all six audited safety counters are zero in both arms.
- On **170 jointly successful pairs**, mean completion-time saving is 1.329 ticks, median 0; aggregate improvement **0.693%**, 95% interval **−0.254% to 1.790%**, wins/ties/losses **46/100/24**. This is not a statistically established speedup and does not meet the 20% target. Failed capped runs are excluded from speed estimates.
- Three real Node controllers using actual ROS2/Fast DDS complete the development choke smoke at tick143. The combined pre-pickup process failure, reassignment, blocked-route reroute, partition/heal and AI-fallback smoke completes at tick241, with zero audited violations. These are development smoke checks, not another fresh seed sweep.
- Real Nav2/Collision Monitor/EKF validation passes separately: route execution, obstacle stop/resume, and route cancellation with zero measured collision ticks. It remains a single continuous simulated robot integration.

See `artifacts/fleet-integration/validation.json` and `artifacts/integrated-stopwait-v4/report.json`. Historical measurements are preserved; model weights and the stop-and-wait baseline are unchanged.


## Historical integrated validation (v5)

Runtime frozen at `c4c5b3a`. The local terminal-aisle clearance fix recovers both inspected v4 failures; all 200 old seeds complete in development. This does not imply universal completion.

- **Fresh seeds 42000–42199:** integrated **198/200 runs, 1197/1200 tasks**; unchanged stop-and-wait **174/200 runs, 1155/1200 tasks**. No baseline-successful run is lost. All six audited safety counters are zero for both. Two new incomplete cases remain, with no acceptance-driven tuning.
- **174 jointly completed pairs:** baseline mean **192.730 ticks**, integrated **191.609**; mean saving **1.121 ticks**, median paired saving **0**, wins/ties/losses **49/105/20**. Aggregate improvement **0.581%**, 95% interval **−0.249% to 1.462%**. No statistically established speedup; **20% target unmet**. Failed capped runs are excluded.
- Builds pass; full suite **361 passed, 20 skipped, zero failures**. Frozen MLP and stop-and-wait source hashes are unchanged.
- Main-worktree real Nav2 crossing: **3 tasks, 12 real path actions, 119 logical ticks, 33.264 wall seconds**, zero measured continuous/grid collisions. A transient obstacle stops motion with zero settled drift. Separate actual cancellation and controller-SIGKILL tests preserve partial pose and prevent false arrival/task completion.
- Development profiling across 400 seeds identifies serialized admission as the main delay. A 16-tick lease experiment is **rejected**: it introduces a failed run and fails three existing ownership tests. Production retains the 32-tick protocol. Faster admission requires quorum-certified capacity reservations, not simply reducing a timer.

The fresh warehouse comparison remains a one-process grid simulation with identical learned scoring in both arms. It is neither an AI ablation nor a 200-seed Nav2 evaluation. The historical **1.56% AI-only improvement** compares learned bidding with deterministic bidding, not stop-and-wait.

Evidence: `artifacts/parallel-v5/validation.json`, `artifacts/integrated-stopwait-v5/report.json`, `artifacts/nav2-fleet-v1/report.json`, and `artifacts/completion-profile/`. Raw traces and logs are preserved separately with checksums in `artifacts/parallel-v5/evidence.json`.

## Short glossary

| Term | Meaning |
| --- | --- |
| AMR | Autonomous mobile robot: a robot that carries work around the warehouse. |
| TCT | Total task completion time here: the sum of each task's release-to-completion time. |
| Makespan | Time from the first task release until the final task finishes. |
| Mutually complete pair | The same scenario finished by both compared policies. |
| Confidence interval | Bootstrap uncertainty range around the measured paired reduction; not a guarantee for new warehouses. |
| Quorum / certificate | A strict majority's matching votes / the proof that those votes authorize ownership. |
| Lease / generation | Time-limited ownership / the logical time window that fences votes and expiry. |
| Custody | Recorded responsibility for cargo after pickup; it blocks silent reassignment. |
| EVENT / grouped | Bid when eligible / evaluate several tasks and feasible ordered bundles together. |
| DDS / Nav2 | ROS2 peer messaging / the navigation stack that executes controller-authorized movement. |
| Tick | One logical simulation step, not a measured physical second. |
