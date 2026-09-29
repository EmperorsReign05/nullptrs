# Implementation audit — entry state at 4fa41e6 plus preserved local changes

Evidence is executable source and tests, not README/plan comments. Status below is BEFORE gap closure; final report records changes. “Simulation” does not mean physical deployment. Test references identify evidence to run, not a blanket assertion that all tests pass.

| Requirement | Status | Exact source | Exact tests / evidence | End-to-end and PPT limit |
|---|---|---|---|---|
| A: independent agent per AMR | IMPLEMENTED | distributed/agent.ts, worker.ts | tests/udp.test.ts U1 | Separate OS processes for preassigned motion demo only |
| A: peer communication, state, intent | IMPLEMENTED | distributed/protocol.ts, transport.ts | tests/dist.test.ts, udp.test.ts | In-memory and loopback UDP; no task messages |
| A: no central movement coordinator | PARTIAL | distributed/fleet.ts step; worker.ts | tests/dist-safety.test.ts vs udp.test.ts | Fleet harness globally arbitrates destinations; do not claim its results prove coordinator-free UDP safety |
| A: message loss | PARTIAL | transport.ts setReachable/setLatency | tests/dist-safety.test.ts | Severed/delayed in-memory links; no general end-to-end loss protocol |
| A: severed link | IMPLEMENTED | fleet.ts, sensor.ts | tests/dist-safety.test.ts, dist-liveness.test.ts | Simulation safety with physical-position sensor feed and global commit arbiter |
| A: stale state | IMPLEMENTED | agent.ts receive/peer expiry | tests/dist.test.ts | Motion peer state only; not task ownership |
| B: distributed task announcement | MISSING | protocol.ts only tick/depart | No test | Preassigned tasks in worker.ts and fleet.ts |
| B: independent real task bidding | MISSING | auction/cost.ts; ml/bidmodel.ts makeLocalBid | tests/bid-mlp.test.ts local boundary | Local API exists, not used by workers |
| B: deterministic winner and ties | PARTIAL | auction/assign.ts; ml/bidmodel.ts selectLocalBid | tests/auction.test.ts; bid-mlp.test.ts | Central auction/local packet selector only |
| B: duplicate prevention / versioned claim | MISSING | types.ts Task.assignedRobotId | No distributed ownership test | A field is not an agreement protocol |
| B: failed-owner reassignment / unfinished recovery | MISSING | worker.ts preassigned task; fleet.ts settleArrivals | No distributed recovery test | No fencing/lease/generation |
| C: heartbeat / peer timeout | PARTIAL | protocol.ts TickMessage; agent.ts | tests/dist.test.ts | Tick freshness exists; not durable robot failure or owner release |
| C: failed robot detection | PARTIAL | browser page.tsx handleFailAMR | tests/charging.test.ts | Manually injected central status; no distributed task failover |
| C: failed robot obstacle | PARTIAL | sensor.ts; simulation/engine.ts | tests/dist-safety.test.ts; engine-stress.test.ts | Sensor-fed simulation; worker.ts never sets sensor feed |
| C: release after failure | MISSING | distributed/fleet.ts, worker.ts | No test | No distributed release path |
| C: dashboard failure independence | BROKEN | app/page.tsx timer owns runDispatchTick | Source call path | Closing browser stops dashboard simulation; independent UDP demo continues separately |
| D: A*, congestion | IMPLEMENTED | pathfinding/astar.ts; map/warehouse.ts | tests/astar.test.ts; astar-stress.test.ts | Real discrete-grid simulation code |
| D: local obstruction sensing/memory | IMPLEMENTED | distributed/agent.ts, sensor.ts | tests/dist-liveness.test.ts | Simulated sensing; no hardware driver |
| D: blocked aisle / route invalidation / reroute | IMPLEMENTED | simulation/engine.ts; fleet.ts replanAll; page.tsx handleBlockAisle | tests/engine-stress.test.ts; dist-liveness.test.ts | Central dashboard control changes real simulation map |
| D: PIBT/conflict resolution | IMPLEMENTED | pathfinding/pibt.ts | tests/pibt.test.ts; pibt-stress.test.ts | Central PIBT distinct from local distributed agent protocol |
| D: collision prevention / network-loss fallback | PARTIAL | sensor.ts, agent.ts, fleet.ts step | tests/dist-safety.test.ts; dist-liveness.test.ts | Tested simulation regime; no universal/UDP/hardware safety proof |
| E: guarded MLP in real bid path | MISSING | ml/bidmodel.ts; auction/cost.ts withBidScorer | tests/bid-mlp.test.ts | Used by benchmark adapters; not dashboard or UDP auction |
| E: deterministic availability / bounded AI / hard guard | IMPLEMENTED | auction/cost.ts; ml/bidfeatures.ts assessBidEnergy; bidmodel.ts | tests/bid-mlp.test.ts | Frozen v4 supported; integration still missing |
| E: disabled/failed AI fallback | PARTIAL | auction/cost.ts finite fallback; bidmodel.ts | tests/bid-mlp.test.ts | Bad numeric scorer falls back; no runtime model-load path |
| E: final distributed system uses AI | MISSING | worker.ts, fleet.ts | Source call path | Cannot claim end-to-end Edge-AI allocation yet |
| F: dashboard real state / positions / tasks / battery | IMPLEMENTED | app/page.tsx; components/dashboard/* | page calls runDispatchTick | Real central simulation, not distributed telemetry |
| F: health and events | PARTIAL | page.tsx; FleetStatus.tsx; EventLog.tsx | Source transitions | Central simulated status/events; no peer health feed |
| F: real controls | IMPLEMENTED | page.tsx handleCreateTask/BlockAisle/FailAMR | Source handlers | Mutate central simulation; shelf count display and layout need separate scrutiny |
| F: monitoring-only dashboard | BROKEN | page.tsx owns world and timer | Source call path | Browser is the simulation brain |
| G: deterministic vs learned reproducibility | IMPLEMENTED | tests/bid-mlp.test.ts; artifacts/bid-energy-v4/* | BID_ENERGY_ACCEPTANCE | Frozen historical source hashes; 1.56% conditional on jointly completed runs, not distributed performance |
| G: ORIG vs NEW reproducibility | PARTIAL | artifacts/ab.ts, fleetOrig.ts, agentOrig.ts | tests/dist-liveness.test.ts | Rig exists; reported long sweep outputs not yet independently regenerated here |
| G: safety metrics | IMPLEMENTED | tests/dist-safety.test.ts; artifacts/overlap-audit.ts | same | Regime-specific counts; original artifacts preserved |
| G: stop-and-wait baseline | IMPLEMENTED | bench/stopwait.ts | tests/bench.test.ts; regime.test.ts; regime2.test.ts | Fair baseline code exists |
| G: stop-and-wait comparison run | PARTIAL | bench/scenarios.ts; tests/regime*.test.ts | Existing test assertions/output; rerun required for current integrated system | Historical regime result is not new integrated result |
| G: scalability | IMPLEMENTED | tests/multiseed.test.ts; artifacts/ab.ts | same | Synthetic fleet sweeps; not hardware scalability |
| H: browser simulation | IMPLEMENTED | app/page.tsx | Next app | Primary dashboard mode |
| H: Node / UDP | IMPLEMENTED | distributed/worker.ts, transport.ts | tests/udp.test.ts | Loopback independent processes, preassigned jobs |
| H: ROS2 / Fast DDS / Nav2 | MISSING | No implementation found in src or dependencies | No tests | Must not claim deployed middleware or navigation stack |
| H: Raspberry Pi / physical AMRs / HIL | MISSING | No drivers, deployment or measurements found | No tests | Host simulation and UDP only |

All core paths above are relative to `src/core/` unless prefixed otherwise.

## Must implement for a truthful integrated software demo

1. Versioned task ownership with quorum/expiry fencing, retries, deterministic bids, and explicit post-pickup recovery. No task execution without valid ownership.
2. Wire the frozen guarded MLP into each actual bidder, with deterministic disable/error fallback; do not retrain.
3. Run the fleet outside the browser and expose snapshots/control inputs. Connect a dashboard view to that runtime; close the browser without halting execution.
4. Integrate failure injection, blocked map updates, communication cuts, ownership recovery and telemetry; test one full scenario and preserve machine-readable results.
5. Resolve type/build integration errors, preserve and commit local safety work, distinguish existing full-suite failures from new regressions.

## Claims to soften rather than invent implementations

- No ROS2, DDS, Nav2, physical robot, Pi or HIL claim.
- No claim that global simulator arbitration is decentralized movement execution or proves UDP collision safety.
- No universal completion or zero-collision guarantee; report measured regime and horizon.
- Frozen MLP's 1.56% result is a historical central-simulator paired-success result. No new end-to-end or >20% learned speedup claim. v5 stronger-comparator negative result remains in the record.
- Dynamic membership, unbounded clock skew, durable crash/restart and adversarial packets are not silently implied by a minimal simulation ownership protocol.
