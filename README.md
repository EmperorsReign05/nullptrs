# Team Rocket — AMR Fleet Control Dashboard

Three software modes are available:

- **`/` — integrated fleet demo:** a standalone Node fleet process runs peer task ownership, frozen guarded learned bids and local motion decisions. The Next dashboard monitors state and submits commands. Agents are private simulated contexts with shared tick rounds and simulated sensors.
- **`npm run edge:demo` — three-process fleet demo:** each robot process runs its own complete ownership, frozen MLP bidding and planning stack, communicating directly over UDP. The same dashboard connects through the simulation host on port 4011. Shared simulation timing and sensors are explicit.
- **`/simulator` — original central simulator:** A*, PIBT, deterministic auctioning, task queues and charging run in the browser.

The legacy `worker.ts` UDP demo remains preassigned-task-only. The new `edge-agent.ts` deployment includes live auctions and ownership. ROS2/Fast DDS can carry real peer messages via one sidecar per controller. Three independent controllers can also execute through actual Nav2, with measured arrival gating grid/task progress, simulated sensors, EKF and Collision Monitor. This continuous simulation has a fixed three-robot fixture and shared clock; physical hardware remains unvalidated.

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

## ROS2 / Fast DDS and continuous navigation

The following commands require rootless Podman (or the container engine configured by the scripts). No system ROS installation is required.

```sh
# Build the bridge image and test real Fast DDS peer exchange.
npm run ros2:test
# Run the actual three-controller grid fleet over ROS2/Fast DDS.
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
# Three-robot crossing, transient obstacle, real Nav2 arrival checks.
bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-crossing
# Separate runs validate cancellation and actual controller SIGKILL.
NAV2_FLEET_MODE=fault bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-cancel
NAV2_FLEET_MODE=crash bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-crash
# Interactive continuous simulation; connect the dashboard as above.
NAV2_FLEET_DEMO=1 bash scripts/nav2-fleet-acceptance.sh /tmp/nav2-fleet-demo
```

This is a fixed three-robot simulation fixture, not general hardware deployment. Ownership uses logical time, which pauses during physical cell execution. Dynamic grid-block and simulated-failure dashboard commands are explicitly rejected in Nav2 mode; they remain supported in the grid demo. The Nav2 fault tests use real cancellation/process termination. Do not claim automatic mid-cell recovery or an asynchronous physical-robot lease protocol.

Distributed charging retains task ownership, reaches a charger, recharges and resumes pre-pickup work. Each active job is recertified; queued jobs can span multiple charging visits. Cargo already picked up is never silently reassigned or diverted: an uncertifiable delivery holds for manual recovery. Local safety controls shared charger occupancy; charger fairness is not guaranteed.

New acceptance results are recorded separately from historical v1–v3 outputs. Development results on inspected seeds are not fresh acceptance evidence. No physical Pi/Jetson or real-sensor validation has occurred.

## Historical integrated validation (v4)

Code frozen at `e7dd0cd`. These results remain unchanged as historical evidence. Seeds 31000–31199 have since informed the clearance fix and are now development data, not a fresh acceptance set for newer code:

- Production and fleet builds pass. Full suite: **356 passed, 17 skipped, zero failures**. The former cycle and UDP tests now pass with their completion/safety assertions retained.
- **200 untouched warehouse seeds (31000–31199): 198/200 completed runs, 1197/1200 tasks**, versus fair stop-and-wait **170/200 runs, 1147/1200 tasks**. No baseline-successful run becomes incomplete; all six audited safety counters are zero in both arms.
- On **170 jointly successful pairs**, mean completion-time saving is 1.329 ticks, median 0; aggregate improvement **0.693%**, 95% interval **−0.254% to 1.790%**, wins/ties/losses **46/100/24**. This is not a statistically established speedup and does not meet the 20% target. Failed capped runs are excluded from speed estimates.
- Three real Node controllers using actual ROS2/Fast DDS complete the development choke smoke at tick143. The combined pre-pickup process failure, reassignment, blocked-route reroute, partition/heal and AI-fallback smoke completes at tick241, with zero audited violations. These are development smoke checks, not another fresh seed sweep.
- Real Nav2/Collision Monitor/EKF validation passes separately: route execution, obstacle stop/resume, and route cancellation with zero measured collision ticks. It remains a single continuous simulated robot integration.

See `artifacts/fleet-integration/validation.json` and `artifacts/integrated-stopwait-v4/report.json`. Historical measurements are preserved; model weights and the stop-and-wait baseline are unchanged.
