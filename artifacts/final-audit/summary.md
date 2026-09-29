# Final audit and software-demo gap closure

The missing task-ownership, learned-bid and dashboard integration paths now exist in a **Node-hosted, synchronous distributed-peer simulation**. This is not an asynchronous multi-device deployment. The old independent-process UDP motion demo remains separate and preassigned-task only. No ROS2, Fast DDS, Nav2, Raspberry Pi execution, physical AMRs or hardware-in-loop implementation was found or added.

Read `implementation-matrix.md` for entry-state findings and `final-matrix.md` for the final requirement-by-requirement assessment, exact source/tests, and claim limits. No PPT file was present; the claim audit maps to the supplied requirement list.

## What changed

- Preserved and committed the previously uncommitted local obstruction/safety work as `a150038`, including regression tests and measurement instruments. Six targeted legacy safety/liveness tests passed before further integration.
- Added `OwnershipPeer`, using the existing transport abstraction with typed channels. Each peer computes its own bid; voters independently validate the winner from the bid bundle. A task carries owner, generation and expiry. One vote per generation and majority intersection prevent two valid owners. Minority partitions cannot acquire ownership; isolated owners stop at expiry. At most one new task is admitted per generation, so simultaneous auctions cannot spend the same queue headroom repeatedly.
- Added heartbeat-based suspicion, pre-pickup ownership expiry/reassignment, and a quorum custody marker before pickup. A failure after custody preparation or pickup requires manual physical load recovery; it does not manufacture a second pickup. Completed custody is terminal. Quorum-certified custody/completion checkpoints are retransmitted by witnesses, so a healed peer converges even if the original owner dies. Partial completion acknowledgments crossing a lease boundary can retry without losing the completion record. Fixed membership, a common monotonic simulation tick, honest crash-stop participants, and retained per-process state are explicit assumptions. Durable restart, dynamic membership and unbounded clock skew are not implemented.
- Wired the **unchanged frozen v4 MLP** into actual peer bidding. It uses own state/tasks, static geometry and received beacons; bounded discounts and winner-change energy/workload/contention guards remain. Disabled or malformed AI falls back to deterministic packets. No retraining or retuning occurred.
- Audit found that the historical `DistributedFleet` had a global commit arbiter. Preserved that mode for the accepted old benchmarks. Added an opt-in synchronized local commit mode: each agent confirms using its received current-round intents and radius-two sensor; unknown possible contenders cause a hold. The new runtime selects this mode and skips the global arbitration pass. This is a discrete-round software protocol, not a claim about asynchronous physical braking.
- Added a standalone fleet HTTP process, separate from Next.js. The dashboard is now a stateless monitor/control client at `/`; the existing central simulator is preserved at `/simulator`. Task announcement, AI toggle, pause/run, route-cell blocking, robot failure and link sever/heal alter real runtime state. Killing the dashboard process does not kill the fleet.
- Repaired application/test TypeScript integration: missing fixture fields, incorrect imports, a numeric feature type, and diagnostic field comparisons. No assertions were weakened. Exporting the existing 15% reserve constant did not alter its value or the deterministic weights. Historical `artifacts/*.ts` reconstructions are excluded from the application build; production source and tests remain checked. Obsolete tuning commands are archived verbatim with a warning that their removed switches are inert.

## Verified results

**Integrated scenario (`end-to-end.json`):** three robots; actual bids with three nonzero model corrections; deterministic AI-disabled fallback; route planning; blocked-route invalidation/replan; robot failure before pickup; a new owner; partition of the surviving peer link until leases expire; heal/recovery; two completed tasks; real telemetry/events. At test end, tick 152, all six safety counters were zero: overlaps, swaps, blocked cells, zero-battery work, payload and queue violations. This is one functional scenario, not a throughput estimate or performance acceptance sweep. Nonzero corrections demonstrate model invocation, not that every discount changed a winner.

**Local commit safety (`tests/local-commit.test.ts`):** 80 runs, 100 ticks each, n=3 and n=6, seeds 1–20, connected and severed conditions: **8,000 fleet-ticks with zero overlaps or swaps**. A direct simultaneous-empty-cell test checks deterministic arbitration inside the agents; a severed-contender test checks safe holding. This is a new, smaller audit of the new mode; the previous 570k+ reported sweep belongs to the historical harness and was not silently transferred to it.

**Dashboard independence (`http-smoke.json`):** actual separate fleet and Next OS processes, actual HTTP commands, pause validation, then termination of the Next process. The fleet advanced from tick 3 to tick 8 with its announced task retained. Reproduce with `scripts/smoke-fleet-http.py` after both builds. The robots remain private simulated contexts in the fleet process; this test does not establish one integrated robot process per AMR.

**Frozen MLP replay (`frozen-bid-reproduction.json`):** isolated checkpoint `9c7335b` matches every frozen source hash. Replay of the existing 200-seed acceptance reproduced **192/200 completed runs and 2783/2800 tasks in both policies**, no safety regression, and **1.559669% aggregate completion-time improvement over the 192 mutually completed pairs**. It is a reproduction of an already inspected acceptance set, not a new holdout and not a result for the integrated runtime. The separate v5 negative result against stronger deterministic comparators remains unchanged in `artifacts/bid-local-v5/`.

**ORIG/current historical motion replay (`orig-new-20-seeds.txt`):** 20 seeds each at n=4 and n=8, 400 ticks, no bays. Completed tasks **159 → 212**, full runs **17 → 27**, observed overlaps **1/9433 → 0/5733 fleet-ticks**. This smaller sweep checks reproducibility, not replacement of the previously reported 80-seed figures. Paired successful-run latency did not improve uniformly; see the raw output.

**Stop-and-wait:** original baseline code is byte-identical. Central `bench`, `regime`, and `regime2` comparisons ran in the full suite. For example the logged width-1/n=8 central regime has 23 jointly completed pairs and median 20.6% improvement; the full sweep and its selection limits remain visible. **No stop-and-wait performance comparison has been run for the new integrated runtime.** Do not present the central regime or the MLP replay as its end-to-end speedup.

## Validation and remaining failures

- Standalone fleet TypeScript build and Next production build pass.
- Application/test TypeScript checking passes. Historical research snapshots are not claimed to type-check against current private class layouts.
- Ownership tests cover the eight requested safety/recovery cases, plus serialized fresh admission, healed-peer checkpoint convergence, and completion retries at lease boundaries. The integrated and local-commit regression suites pass.
- Full suite at entry: **299 passed, 3 failed, 11 skipped**. Failures: two prototype wait-cycle assertions in `tests/compare.test.ts` and the load-sensitive UDP completion assertion.
- Final full suite: see `full-suite.txt` and `verification.json` for the exact final count. The same two prototype failures remain. UDP passed one full run and failed another; standalone behavior is not substituted for full-suite evidence. No assertion was relaxed to hide these failures.
- Original A*, central PIBT, central engine/dispatch, and stop-and-wait are byte-identical to entry. The frozen MLP artifact is unchanged. Source hashes and final test status are in `verification.json`.

## Must do before submission

1. Use the scoped software-demo description below. An end-to-end asynchronous multi-process/physical-fleet claim still lacks the implementation and evidence needed to support it.
2. If the submission claims the new integrated demo meets the brief's ≥20% stop-and-wait improvement, run a fair paired benchmark of that exact runtime first. This audit supplies no such result; existing central-regime measurements cannot fill that gap.
3. Run the two-process demo on the presentation machine. It needs the standalone fleet process as well as Next; it is not a single static/serverless deployment. Preserve the known full-suite failures in the handoff; the experimental `engine2` branch is not the demo engine.

There is no remaining missing ownership, model-invocation, control or telemetry path for the scoped synchronous software demo. Long-duration autonomous charging remains a central-simulator feature; it was not newly integrated into the finite-task peer runtime. Post-pickup physical rescue is intentionally manual. An interrupted custody handshake is also treated conservatively as uncertain physical custody, even if pickup cannot be confirmed; it is not automatically reassigned.

## PPT claims to soften

Safe: **“A working software prototype with independent peer allocation logic, versioned quorum ownership, guarded frozen learned bids, local obstruction-based routing, tested simulation safety under partitions, automatic failure reassignment before custody preparation, and an independent monitoring dashboard.”** Attach the tested timing, membership and sensor assumptions.

Do not claim:

- ROS2, Fast DDS, Nav2, Raspberry Pi deployment, physical robot sensing/control, HIL or hardware timing.
- Integrated per-AMR OS processes over UDP: the legacy UDP test only exchanges motion state for preassigned tasks.
- Universal collision freedom, arbitrary-delay/asynchronous lease safety, durable restart recovery, unrestricted dynamic membership, or uninterrupted progress through partitions.
- Automatic physical cargo recovery after pickup or autonomous charging in the new peer runtime.
- n=12 liveness solved; 50% more completed tasks means 50% faster makespan; or centralized PIBT is a theoretical ceiling.
- New distributed-runtime speedup from the old 1.56% MLP replay or the central 20.6% regime.

## Running and reproducing

```sh
npm run fleet                 # terminal 1: build and run fleet on 127.0.0.1:4010
npm run build && npm start    # terminal 2: monitoring UI, normally localhost:3000
# Open / for the integrated demo; /simulator for the original central simulator.

npx vitest run tests/ownership.test.ts tests/local-commit.test.ts tests/fleet-e2e.test.ts tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
python3 scripts/smoke-fleet-http.py  # after npm run build && npm run fleet:build
scripts/reproduce-frozen-bid.sh     # isolated historical replay, no model training
npx vite-node artifacts/ab.ts -- 20 400 4,8
npx tsc --noEmit --incremental false
npx vitest run                     # known failures are documented above
```

`FLEET_PORT` configures the backend port; `FLEET_URL` configures the Next proxy's backend address. The compiled fleet uses Node built-ins and the existing TypeScript toolchain; no middleware/dependency framework was added.
