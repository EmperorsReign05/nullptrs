# Team Rocket — AMR Fleet Control Dashboard

Three software modes are available:

- **`/` — integrated fleet demo:** a standalone Node fleet process runs peer task ownership, frozen guarded learned bids and local motion decisions. The Next dashboard monitors state and submits commands. Agents are private simulated contexts with shared tick rounds and simulated sensors.
- **`npm run edge:demo` — three-process fleet demo:** each robot process runs its own complete ownership, frozen MLP bidding and planning stack, communicating directly over UDP. The same dashboard connects through the simulation host on port 4011. Shared simulation timing and sensors are explicit.
- **`/simulator` — original central simulator:** A*, PIBT, deterministic auctioning, task queues and charging run in the browser.

The legacy `worker.ts` UDP demo remains preassigned-task-only. The new `edge-agent.ts` deployment includes live auctions and ownership. ROS2/Fast DDS can carry real peer messages via one sidecar per controller. `N` independent controllers can also execute through actual Nav2, with measured arrival gating grid/task progress, simulated sensors, EKF and Collision Monitor. Fleet size, ROS namespaces, grid origins, transport peers and executor endpoints all come from one `config/fleet.json`; the Nav2 path is verified at N=3 and N=5. This continuous simulation shares a logical clock; physical hardware remains unvalidated.

Machine-readable benchmark results are preserved under `artifacts/`. The existing [hosted demo link](https://amr-edge-ai.vercel.app/) has not been updated by this audit; the new fleet runtime requires a long-lived Node process.

## Central Simulator Capabilities (`/simulator`)

* **Congestion-aware A\*** for per-robot route planning, plus **PIBT**
  (Priority Inheritance with Backtracking) resolving next-move conflicts in the discrete simulation.
* A **task auction**: every eligible robot bids on each pending task based
  on route cost, congestion, battery, current workload, task priority,
  deadline urgency, and whether the task's weight actually fits the
  robot's payload capacity. Lowest cost wins.
* A **battery and charging system**: robots drain battery on movement, get
  routed to the nearest of four charging stations once they're running low,
  and use opportunity charging (top up to a working level, not a full
  charge) so a handful of shared stations don't become a bottleneck.
* A **task queue**: a busy robot can still bid on and hold onto further
  work (up to a cap) instead of the fleet ignoring pending tasks just
  because every robot already has one.

The suite includes seeded safety and stress checks. Tests establish behavior in their modeled regimes, not universal physical safety. The historical prototype cycle failures and legacy UDP stale-route defect have regression fixes; current full-suite results are recorded with the integration artifacts.

## Technologies Used

* Framework: Next.js 16 (App Router) + React 19
* Language: TypeScript
* Styling: Tailwind CSS v4
* Icons: Lucide-React
* Testing: Vitest

## Setup and Installation

### Prerequisites

* Node.js 24 (used for the audit)
* npm (or yarn/pnpm)

### Running the Development Server

Clone the repository and install the dependencies:

```bash
npm install
```

Start the fleet in one terminal:

```bash
npm run fleet
```

Start the monitoring dashboard in another terminal:

```bash
npm run dev
```

For production builds, use `npm run build && npm start` for the dashboard. The fleet defaults to `127.0.0.1:4010`; `FLEET_PORT` changes that port and `FLEET_URL` configures the dashboard proxy.

Open `http://localhost:3000` in your web browser. The page will auto-reload
when you make edits.

### Running the Tests

```bash
npm test
```

This runs the full Vitest suite, including deliberately heavy stress tests
(a 20,000-trial PIBT property test, a 6000-tick continuous run across a
30-robot fleet, task avalanches, fleet decimation). Expect it to take
longer than a typical unit test suite — that's by design.

### Type-checking and Linting

```bash
npx tsc --noEmit
npm run lint
```

## Architecture

### `src/core/` — the simulation engine

Plain TypeScript, no React/Next dependency — the domain logic and
simulation engine.

* `src/core/types.ts` — the shared domain contract: `Position`,
  `RobotState`, `Task`, `WorldState`, `RobotModel`, and friends.
* `src/core/map/` — `warehouse.ts` (the grid layout: shelves, pickup/
  dropoff stations, charging stations, waiting zones, and the real-time
  congestion field) and `graph.ts` (grid utilities).
* `src/core/pathfinding/` — `astar.ts` (congestion-aware A\*) and
  `pibt.ts` (Priority Inheritance with Backtracking for real-time,
  collision-free move resolution).
* `src/core/auction/` — `cost.ts` (bid cost: travel, congestion, battery,
  workload, urgency, payload fit) and `assign.ts` (eligibility rules and
  lowest-cost-wins assignment).
* `src/core/simulation/` — `state.ts` (the seeded initial fleet and
  tasks), `robotModels.ts` (robot specs plus the battery/charging
  constants), `engine.ts` (`stepSimulation`: one simulation tick — route
  planning, PIBT resolution, arrivals, charging), and `dispatch.ts`
  (`runDispatchTick`: runs a full auction round *and* a simulation tick —
  the function the separate central simulator calls each tick).

### `src/app/` and `src/components/dashboard/` — the UI

* `src/app/page.tsx` — read-only telemetry snapshots and command buttons. It polls `/api/fleet`; it does not advance robot ticks.
* `src/server/fleet-http.ts` — standalone fleet process; `/state` and `/command` serve telemetry and control input independently of Next.
* `src/core/distributed/ownership.ts` — fixed-membership quorum task leases, expiry fencing and pickup custody markers.
* `src/core/distributed/runtime.ts` — real peer bids, frozen MLP fallback, local motion mode, controls and simulation telemetry.
* `src/app/simulator/page.tsx` — the preserved browser-owned central simulator.
* `src/app/globals.css` — custom CSS (warehouse grid background pattern,
  scrollbar styling).
* `src/app/layout.tsx` — the root Next.js layout (fonts, HTML/body tags).
* `src/components/dashboard/` — presentational components: `WarehouseMap`,
  `ControlPanel`, `FleetStatus`, `ActiveTasks`, `MetricsBar`, `EventLog`,
  `Header`.
* `tailwind.config.ts` — Tailwind theme/utility configuration.

### `tests/`

The Vitest suite, organized by layer: `astar*.test.ts`, `pibt*.test.ts`,
`auction.test.ts`, `charging.test.ts`, `dispatch.test.ts`, and
`engine-stress.test.ts` / `integration-stress.test.ts` for the whole
backend running together under sustained load.

## How the Central Simulation Works (`/simulator`)

1. `createInitialWorld()` seeds a `WorldState`: a 20x13 warehouse grid, a
   10-robot fleet (5x Scout Agile 2.0, 50kg payload capacity; 5x Addverb
   Dynamo 100, 100kg payload capacity), and a few starter tasks.
2. Every tick, the dashboard calls `runDispatchTick(world)`, which:
   * Runs an auction over pending tasks. A robot is eligible to bid if
     it's not failed or charging, has at least 20% battery, and has room
     in its task queue. Bids weigh travel distance, congestion, battery
     level, current workload, task priority/urgency, and payload fit;
     lowest total cost wins.
   * Advances the simulation by one tick: robots replan via A\* when
     needed, PIBT resolves everyone's next move so nobody collides,
     arrivals at pickup/dropoff update task status, battery drains on
     real movement, and any robot that's run low gets routed to the
     nearest charging station.
3. The whole pipeline is deterministic given the same inputs, which is
   what makes the stress test suite meaningful — the exact same seed
   reproduces the exact same run.

## Central Simulator Control Panel

Every button acts directly on the live `WorldState`:

* **Create Task** — adds a pending task; the next tick's auction picks it
  up and assigns it to whichever eligible robot bids lowest.
* **Start / Pause Sim** — starts or stops the tick loop.
* **Sim Conflict** — stages two robots head-on in a single-file corridor
  so you can watch PIBT's priority inheritance resolve it live (the robot
  that yields gets a floating tooltip explaining what just happened).
* **Sim Deadlock** — stages a genuine 4-robot rotational deadlock at a
  shared junction; watch the conflict/backtrack counters spike as the
  algorithm untangles it.
* **Block Aisle** — blocks a stretch of corridor on the live map (with a
  visible hazard marker), forcing any robot routed through it to replan
  around the obstruction. Click again to clear it.
* **Fail AMR-02** — marks a robot failed mid-route so you can watch the
  rest of the fleet route around it.
* **Reset** — returns to the seeded initial state.
* **Robots / Shelves sliders** — grow or shrink the fleet (up to 20
  robots) and the shelf layout live.

## Design Notes Worth Knowing

* There's no reservation system for charging stations — multiple robots
  can be routed toward the same one, and PIBT alone decides who actually
  occupies it moment to moment.
* Charging is opportunistic, not a full recharge: a robot leaves once
  it's back to a comfortable working level (see
  `RECHARGE_TARGET_PERCENT` in `src/core/simulation/robotModels.ts`) so a
  handful of shared stations turn over faster under load.
* PIBT here has a deliberate, documented scope limit: pure rotations
  longer than a direct 2-robot swap are treated conservatively — see the
  comment at the top of `src/core/pathfinding/pibt.ts`.
* `src/core/` is intentionally decoupled from Next.js/React, so the
  simulation engine can be reasoned about, tested, and reused
  independently of the dashboard UI.

### Three-process choke-point demo

```sh
npm run edge:demo
# In another terminal:
FLEET_URL=http://127.0.0.1:4011 npm run dev
```

Each robot runs in its own Node process. The dashboard is a monitor/control input; the separate simulator supplies physics and phase timing. No Raspberry Pi/Jetson execution has been measured. Run `npm run edge:measure` for the paired choke-point benchmark; `scripts/smoke-edge.mjs` exercises process failure and recovery.

## Benchmark evidence

Large historical measurement files are distributed as a [downloadable evidence archive](https://github.com/EmperorsReign05/nullptrs/releases/tag/audit-evidence-2026-09-29), rather than embedded in code-review diffs. Models, protocols and compact results remain in Git. The archive and all original files are SHA-256 checked against `artifacts/evidence-manifest.json`. Restore missing historical inputs before opt-in diagnosis/reproduction commands:

```sh
python3 scripts/fetch-benchmark-evidence.py
```

The command requires Python 3.9+ and leaves existing files untouched. Use `--destination /tmp/fleet-evidence` for a separate complete copy. Summary files are explicitly derived views; archived original measurements are unchanged.

Historical v3 integrated warehouse acceptance: 173/200 completed runs versus stop-and-wait's 176/200; 166 jointly completed pairs give 0.575% aggregate improvement with a 95% interval of −0.064% to 1.457%. This does not establish better overall reliability or a speedup. Three-process choke acceptance completed 40/40 versus 0/40, so it establishes recovery in that workload, not a valid percentage-speedup estimate. Hardware validation and the ≥20% integrated target remain outstanding.

## N-robot fleet configuration

`config/fleet.json` is the single source of truth for fleet membership. Nothing
else declares it — not the ROS launch, not the DDS roster, not the host harness.

```json
{
  "cellMetres": 0.6,
  "rosDomainId": 96,
  "robots": [
    { "id": "AMR-01", "namespace": "AMR_01", "origin": { "x": 1, "y": 1 }, "executorPort": 19700 }
  ]
}
```

Ids must be unique, namespaces unique and legal ROS names, origins distinct and
in-bounds, and executor ports collision-free; an invalid fleet is rejected with a
message naming the offending field rather than failing later. `FLEET_CONFIG`
points any command at a different roster, which is how each acceptance run gets
its own fleet.

Launch an arbitrary-N fleet — this is the exact command for any size:

```sh
# Software fleet over real Fast DDS peers; N controllers, N tasks, one killed mid-run.
npm run fleet:n -- --robots 5
npm run fleet:n -- --robots 8
npm run fleet:n -- --robots 1
npm run fleet:n -- --robots 3          # the historical three-robot fleet
npm run fleet:n -- --robots 5 --transport udp
npm run fleet:n -- --robots 5 --kill none    # measure fleet size without fault injection

# Same fleet driven through real Nav2, EKF and Collision Monitor.
npm run fleet:n:nav2 -- --robots 3
FLEET_N=5 npm run nav2:test -- artifacts/n-robot/nav2-n5
```

Results are written as machine-readable `result.json` under
`artifacts/n-robot/`, and every run records the `fleet.json` it used.

Changing fleet size is a config edit, never a code edit. Ownership quorum is
`floor(N/2) + 1` and is derived from membership, so it is correct for even and
odd N; the ownership suite covers N=1, 2, 3, 4, 5 and 8.

### Liveness and task admission

Peer liveness is measured against the newest tick a peer has actually **observed
on the network**, not against its own tick counter. The local counter is driven by
the host and runs ahead of real fleet progress whenever delivery is backed up, so
comparing against it declared healthy peers dead purely because their heartbeats
were in flight. When the transport produces no peer news at all in a tick, the
clock falls back to the local tick, which is what still detects a lone dead peer
and a total stall. Failure detection therefore stays bounded by the 6-tick
`PEER_TIMEOUT_TICKS` window, and healthy peers no longer time out because other
robots were slow.

Ownership traffic is bounded rather than re-broadcast every tick. A task is
announced when it is first learned and re-healed once per generation; custody and
completion proofs and our own grant are gossiped the same way; and a proposal is
retried only when the bid set has actually grown. Per-tick traffic falls from
about 11 messages per peer to about 4.5 at N=8, which is what keeps the transport
under its throughput ceiling.

Admission is no longer one task per 32-tick generation. Up to `floor(N/2)` new
tasks may be auctioned at once, which still bounds how much of a robot's queue and
energy headroom one generation can consume. At N=1/2/3 this evaluates to 1, so the
small-fleet protocol is unchanged. Measured on 8 independent tasks with movement
disabled: median certification latency is unchanged at N=3, improves 1.9x at N=5
and 3.7x at N=8, with no duplicate executable owner in any arm.

Nav2 continuous execution is verified at N=1, 3, 5, 6, 7 and 8, and software
fleets over real Fast DDS at N=1, 3, 5 and 8. Evidence lives in
`artifacts/ownership-scale/`.

## ROS2 / Fast DDS and continuous navigation

The following commands require rootless Podman (or the container engine configured by the scripts). No system ROS installation is required.

```sh
# Build the bridge image and test real Fast DDS peer exchange.
npm run ros2:test
# Run the actual N-controller grid fleet over ROS2/Fast DDS (FLEET_N=3 by default).
npm run ros2:smoke
# Interactive fleet over DDS (dashboard still connects to port 4011).
EDGE_TRANSPORT=ros2 npm run edge:demo
# In a separate terminal:
FLEET_URL=http://127.0.0.1:4011 npm run dev
# Validate actual Nav2 + EKF + simulated LiDAR/IMU/odometry + Collision Monitor.
npm run nav2:test -- /tmp/nav2-validation
```

ROS peer traffic uses rmw_fastrtps_cpp with UDP transport; Fast DDS shared memory is disabled in the supplied profile. The Node/ROS bridge is local to each robot, not a message broker. Discovery must find the configured roster before simulation ticks begin. `ROS_BRIDGE_COMMAND` accepts a JSON argv array to use another installed ROS launch command or container engine.

The Nav2 fleet adapter follows each robot controller’s locally authorized cell move through real FollowPath. Separate namespaces and TF graphs isolate robot frames; a shared simulated physical world supplies peer bodies and initial blocked-cell geometry. Logical movement and task progress wait for successful action completion and fresh measured arrival. Cancellation or lost controller heartbeat stops execution and retains partial pose; recovery requires restart/relocalization.

After building the ROS and Nav2 images with the commands above:

```sh
# N-robot crossing, transient obstacle, real Nav2 arrival checks.
FLEET_N=3 bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-crossing
FLEET_N=5 bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-crossing-n5
# Separate runs validate cancellation and actual controller SIGKILL.
NAV2_FLEET_MODE=fault bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-cancel
NAV2_FLEET_MODE=crash bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-crash
# Interactive continuous simulation; connect the dashboard as above.
NAV2_FLEET_DEMO=1 bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-demo
```

This is a simulated N-robot fixture, not general hardware deployment. Ownership uses logical time, which pauses during physical cell execution. Dynamic grid-block and simulated-failure dashboard commands are explicitly rejected in Nav2 mode; they remain supported in the grid demo. The Nav2 fault tests use real cancellation/process termination. Do not claim automatic mid-cell recovery or an asynchronous physical-robot lease protocol.

Distributed charging retains task ownership, reaches a charger, recharges and resumes pre-pickup work. Each active job is recertified; queued jobs can span multiple charging visits. Cargo already picked up is never silently reassigned or diverted: an uncertifiable delivery holds for manual recovery. Local safety controls shared charger occupancy; charger fairness is not guaranteed.

New acceptance results are recorded separately from historical v1–v3 outputs. Development results on inspected seeds are not fresh acceptance evidence. No physical Pi/Jetson or real-sensor validation has occurred.

## SIH 2026 acceptance benchmark (v1)

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

**Answer: NO. The current system does not meet the 20% criterion.** The 95% paired bootstrap lower bound for the A→D reduction in `sumTaskCompletionTime` is **1.53%**, against a 20% gate. The 95% lower bound for `makespan` is **1.00%**.

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

### Reproduce

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


## Latest integrated validation (v5)

Runtime frozen at `c4c5b3a`. The local terminal-aisle clearance fix recovers both inspected v4 failures; all 200 old seeds complete in development. This does not imply universal completion.

- **Fresh seeds 42000–42199:** integrated **198/200 runs, 1197/1200 tasks**; unchanged stop-and-wait **174/200 runs, 1155/1200 tasks**. No baseline-successful run is lost. All six audited safety counters are zero for both. Two new incomplete cases remain, with no acceptance-driven tuning.
- **174 jointly completed pairs:** baseline mean **192.730 ticks**, integrated **191.609**; mean saving **1.121 ticks**, median paired saving **0**, wins/ties/losses **49/105/20**. Aggregate improvement **0.581%**, 95% interval **−0.249% to 1.462%**. No statistically established speedup; **20% target unmet**. Failed capped runs are excluded.
- Builds pass; full suite **361 passed, 20 skipped, zero failures**. Frozen MLP and stop-and-wait source hashes are unchanged.
- Main-worktree real Nav2 crossing: **3 tasks, 12 real path actions, 119 logical ticks, 33.264 wall seconds**, zero measured continuous/grid collisions. A transient obstacle stops motion with zero settled drift. Separate actual cancellation and controller-SIGKILL tests preserve partial pose and prevent false arrival/task completion.
- Development profiling across 400 seeds identifies serialized admission as the main delay. A 16-tick lease experiment is **rejected**: it introduces a failed run and fails three existing ownership tests. Production retains the 32-tick protocol. Faster admission requires quorum-certified capacity reservations, not simply reducing a timer.

The fresh warehouse comparison remains a one-process grid simulation with identical learned scoring in both arms. It is neither an AI ablation nor a 200-seed Nav2 evaluation. The historical **1.56% AI-only improvement** compares learned bidding with deterministic bidding, not stop-and-wait.

Evidence: `artifacts/parallel-v5/validation.json`, `artifacts/integrated-stopwait-v5/report.json`, `artifacts/nav2-fleet-v1/report.json`, and `artifacts/completion-profile/`. Raw traces and logs are preserved separately with checksums in `artifacts/parallel-v5/evidence.json`.
