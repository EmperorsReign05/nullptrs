# Final implementation matrix

This matrix describes the audited code, not aspirational PPT architecture. Paths are relative to the repository. **Integrated demo** means the standalone Node fleet process, per-peer contexts with message queues, simulated range sensing, and shared discrete tick rounds. **Legacy UDP** means separate OS processes running preassigned jobs. They are not the same deployment.

| Requirement | Final status | Source | Test/evidence | End-to-end / safe PPT claim |
|---|---|---|---|---|
| A: one independent agent per AMR | PARTIAL | src/core/distributed/agent.ts, ownership.ts, worker.ts | tests/udp.test.ts; fleet-e2e.test.ts | Private contexts in integrated demo; separate processes only legacy UDP |
| A: peer-to-peer communication | IMPLEMENTED | src/core/distributed/transport.ts | tests/isolation.test.ts; ownership.test.ts; udp.test.ts | In-memory peers in demo; real loopback UDP separately |
| A: robot-state exchange | IMPLEMENTED | src/core/distributed/ownership.ts, protocol.ts | tests/ownership.test.ts; udp.test.ts | Pose/path heartbeat and bid packets; no physical telemetry |
| A: intent exchange | IMPLEMENTED | src/core/distributed/agent.ts tick/confirmDecision | tests/local-commit.test.ts | Current-round intents, simulated synchronized rounds |
| A: no central movement coordinator | IMPLEMENTED | src/core/distributed/fleet.ts localCommit branch; agent.ts confirmDecision | tests/local-commit.test.ts | Integrated mode skips global arbitration; physics/time/sensors still simulated centrally. Historical default retains arbiter |
| A: message loss | PARTIAL | ownership.ts; transport.ts | ownership.test.ts total partition/delay; local-commit.test.ts | Safety under missing packets/partitions; no arbitrary-loss liveness bound or asynchronous deployment proof |
| A: severed communication | IMPLEMENTED | runtime.ts command(link); fleet.ts setLink | fleet-e2e.test.ts; local-commit.test.ts | Ownership expires, unknown motion contenders cause safe holds; heal resumes |
| A: stale state | IMPLEMENTED | agent.ts peerSequence; ownership.ts validLease | local-commit.test.ts stale packet; ownership.test.ts stale grant | Old sequences cannot refresh motion state; old generations cannot regain ownership |
| B: task announcement | IMPLEMENTED | ownership.ts announce/tick | ownership.test.ts; fleet-e2e.test.ts | Originating peer repeatedly announces immutable task records |
| B: independent bids | IMPLEMENTED | runtime.ts bid; ml/bidmodel.ts makeLocalBid | fleet-e2e.test.ts; bid-mlp.test.ts | Own robot/tasks, static geometry, explicitly received beacons only |
| B: deterministic winner | IMPLEMENTED | ml/bidmodel.ts selectLocalBid; ownership.ts receive(propose) | ownership.test.ts agreement | Each voter recomputes transmitted bid bundle; disagreement can stall, cannot bypass quorum |
| B: ties | IMPLEMENTED | ml/bidmodel.ts selectLocalBid | ownership.test.ts tied costs | Lexical robot-ID tie-break |
| B: duplicate ownership prevention | IMPLEMENTED | ownership.ts votes/grants/ownership/mayExecute | ownership.test.ts duplicate/partition tests | One vote per generation, intersecting majorities, expiry fencing; honest crash-stop peers/shared clock |
| B: ownership representation/version | IMPLEMENTED | ownership.ts Ownership | ownership.test.ts stale grants | Task ID, owner, generation, expiry, distinct grantors |
| B: failed-owner reassignment | IMPLEMENTED | ownership.ts heartbeat/lease expiry; runtime.ts step | ownership.test.ts pre-pickup death; fleet-e2e.test.ts | Before custody preparation, unfinished task can obtain a newer-generation owner |
| B: unfinished-task recovery | PARTIAL | ownership.ts markers/acks/recoveryRequired | ownership.test.ts post-pickup death | Post-pickup load quarantined for manual physical recovery; no automatic duplicate pickup or automatic load rescue |
| C: heartbeat/timeout | IMPLEMENTED | ownership.ts PEER_TIMEOUT_TICKS | ownership.test.ts death/partition | Failure suspicion is not proof of death; expiry, not suspicion alone, fences execution |
| C: failed robot detection | IMPLEMENTED | ownership.ts isLive; runtime.ts fail command | ownership.test.ts; fleet-e2e.test.ts | Missing heartbeats plus operator-injected simulated crash; no hardware health driver |
| C: failed robot obstacle | IMPLEMENTED | runtime.ts setInactive; fleet.ts physical feed; sensor.ts | fleet-e2e.test.ts; dist-liveness.test.ts | Failed body remains at its cell, sensed by other simulated robots |
| C: task release after failure | IMPLEMENTED | ownership.ts; runtime.ts ownership projection | fleet-e2e.test.ts | Failure before custody preparation recovers; uncertain/prepared or picked-up custody requires manual recovery |
| C: dashboard failure independent | IMPLEMENTED | src/server/fleet-http.ts, fleet-service.ts; src/app/api/fleet/route.ts | scripts/smoke-fleet-http.py; http-smoke.json | Entire Next process terminated and independent fleet continued |
| D: A* | IMPLEMENTED | src/core/pathfinding/astar.ts | astar.test.ts; astar-stress.test.ts | Unchanged, reused for each local route |
| D: congestion-aware cost | IMPLEMENTED | src/core/map/warehouse.ts; fleet.ts localWorld | astar.test.ts; dist-liveness.test.ts | Local sensed congestion for motion; received beacons for bids |
| D: obstruction sensing | IMPLEMENTED | src/core/distributed/sensor.ts; agent.ts | dist-liveness.test.ts; local-commit.test.ts | Synthetic range sensor, not LiDAR/camera hardware |
| D: blocked-aisle detection | PARTIAL | runtime.ts block command; agent.ts blocker memory | fleet-e2e.test.ts; dist-liveness.test.ts | Real map-injection control and observed robot blockers; no perception of unknown physical aisles |
| D: route invalidation | IMPLEMENTED | fleet.ts replanAll/routeHasWall | fleet-e2e.test.ts | Whole remaining route checked after map change |
| D: rerouting | IMPLEMENTED | fleet.ts replanAll/localWorld | fleet-e2e.test.ts; dist-liveness.test.ts | Blocked path replanned; learned obstruction hint has retry without overlay |
| D: PIBT/conflict resolution | IMPLEMENTED | pathfinding/pibt.ts; distributed/agent.ts | pibt.test.ts; local-commit.test.ts | Central simulator uses PIBT; integrated peer mode uses local priority claims, not distributed PIBT |
| D: collision prevention | IMPLEMENTED | agent.ts confirmDecision; sensor.ts | local-commit.test.ts 8000 ticks; fleet-e2e.test.ts | Zero observed overlaps/swaps in tested synchronized regime, not universal hardware safety |
| D: local network-loss fallback | IMPLEMENTED | agent.ts confirmDecision | local-commit.test.ts unknown contender | May stop when evidence is missing; not guaranteed uninterrupted progress |
| E: MLP invoked in actual task bids | IMPLEMENTED | runtime.ts bid; ownership.ts computeBid | fleet-e2e.test.ts | Integrated peer bidders invoke frozen model; three nonzero corrections in E2E |
| E: deterministic bid available | IMPLEMENTED | auction/cost.ts; runtime.ts ai-off | fleet-e2e.test.ts | AI disable uses zero-bound deterministic packets |
| E: bounded AI correction | IMPLEMENTED | ml/bidmodel.ts | bid-mlp.test.ts | Frozen 10% maximum discount |
| E: hard feasibility guard | IMPLEMENTED | ml/bidfeatures.ts assessBidEnergy; bidmodel.ts selectLocalBid | bid-mlp.test.ts guard/energy tests | Task/committed queue/charger reserve, route certification, workload and contention checks; static admission only |
| E: AI failure fallback | IMPLEMENTED | runtime.ts bid catch | fleet-e2e.test.ts bad model | Invalid model falls back to deterministic cost |
| E: distributed system uses learned scorer | PARTIAL | runtime.ts vs worker.ts | fleet-e2e.test.ts vs udp.test.ts | Yes in integrated simulated peer runtime; no in legacy independent UDP workers |
| F: real runtime state | IMPLEMENTED | app/page.tsx; app/api/fleet/route.ts; server/fleet-http.ts | http-smoke.json | Dashboard polls actual running simulation, not mock snapshots |
| F: positions | IMPLEMENTED | WarehouseMap.tsx; runtime.ts snapshot | fleet-e2e.test.ts; HTTP smoke | Real simulation coordinates |
| F: task state | IMPLEMENTED | ActiveTasks.tsx; runtime.ts snapshot | fleet-e2e.test.ts | Ownership-driven status and completed tasks |
| F: battery | IMPLEMENTED | FleetStatus.tsx; runtime.ts movement drain | fleet-e2e.test.ts | Simulated consumption; charging remains in separate central engine, not this runtime |
| F: health/failure | IMPLEMENTED | FleetStatus.tsx; runtime.ts; ownership.ts | fleet-e2e.test.ts | Simulated failure plus recovery-required display |
| F: events | IMPLEMENTED | EventLog.tsx; runtime.ts log | fleet-e2e.test.ts | Real commands, ownership changes, completion events |
| F: real controls | IMPLEMENTED | app/page.tsx; runtime.ts command | HTTP smoke; fleet-e2e.test.ts | Announce, block, fail, sever/heal, run/pause, enable/disable AI |
| F: monitoring/control only | IMPLEMENTED | app/api/fleet/route.ts proxy; server/fleet-http.ts | Dashboard-process-kill HTTP smoke | Browser/Next neither schedule ticks nor choose bids/moves |
| G: deterministic vs learned replay | IMPLEMENTED | scripts/reproduce-frozen-bid.sh | frozen-bid-reproduction.json | Isolated 9c7335b replay passes original frozen hashes and reproduces 1.559669% on 192 jointly completed pairs |
| G: distributed ORIG vs NEW replay | IMPLEMENTED | artifacts/ab.ts, fleetOrig.ts, agentOrig.ts | orig-new-20-seeds.txt | Verified 20 seeds at n=4,8; historical default mode, not new local-commit mode |
| G: safety reproducibility | IMPLEMENTED | tests/dist-safety.test.ts; local-commit.test.ts | baseline/final logs; end-to-end.json | Exact test regimes recorded; prior 570k figure not newly regenerated here |
| G: stop-and-wait baseline | IMPLEMENTED | src/core/bench/stopwait.ts | tests/bench.test.ts | Byte-identical to audit entry |
| G: actual stop-and-wait comparison | PARTIAL | tests/regime.test.ts; regime2.test.ts | full-suite.txt | Central comparisons ran; new integrated runtime has NOT been benchmarked against stop-and-wait |
| G: scalability sweeps | IMPLEMENTED | tests/multiseed.test.ts; artifacts/ab.ts | full-suite.txt; orig-new-20-seeds.txt | Synthetic scaling, not hardware/UDP full-stack scaling |
| H: browser-only | IMPLEMENTED | app/simulator/page.tsx | existing central test suite | Old central simulator preserved at /simulator |
| H: Node execution | IMPLEMENTED | server/fleet-http.ts; package.json fleet scripts | build.txt; HTTP smoke | Separate fleet and dashboard Node processes |
| H: UDP | PARTIAL | distributed/worker.ts, transport.ts | tests/udp.test.ts | Preassigned motion demo only; flaky under CPU load; no integrated ownership/scorer deployment |
| H: ROS2 | MISSING | No implementation | No test | Must not claim |
| H: Fast DDS | MISSING | No implementation | No test | Must not claim |
| H: Raspberry Pi execution | MISSING | No deployment/measurement | No test | Must not claim |
| H: Nav2 | MISSING | No implementation | No test | Must not claim |
| H: physical AMR / HIL | MISSING | No drivers/hardware harness | No test | Must not claim |

Dashboard component paths in F are under `src/components/dashboard/`; unprefixed test names are under `tests/`.
