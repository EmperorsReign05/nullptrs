# Team Rocket — AMR Fleet Control Dashboard

Two software modes are available:

- **`/` — integrated fleet demo:** a standalone Node fleet process runs peer task ownership, frozen guarded learned bids and local motion decisions. The Next dashboard monitors state and submits commands. Agents are private simulated contexts with shared tick rounds and simulated sensors.
- **`/simulator` — original central simulator:** A*, PIBT, deterministic auctioning, task queues and charging run in the browser.

The separate UDP worker demo runs independent processes with preassigned tasks; it is not the integrated auction deployment. ROS2, Fast DDS, Nav2 and physical robot hardware are not implemented.

See the [final audit](artifacts/final-audit/summary.md) and [implementation matrix](artifacts/final-audit/final-matrix.md) for measured results, exact tests and claim limits. The existing [hosted demo link](https://amr-edge-ai.vercel.app/) has not been updated by this audit; the new fleet runtime requires a long-lived Node process.

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

The suite includes seeded safety and stress checks. Tests establish behavior in their modeled regimes, not universal physical safety. The audit records two pre-existing prototype wait-cycle failures and a load-sensitive UDP test; the full suite is not claimed green.

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
