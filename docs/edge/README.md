# Three-process edge-controller demo

This deployment runs one complete robot controller per Node process: frozen guarded MLP bids, quorum task ownership, A*, obstruction memory, local head-on priority negotiation, and local move confirmation. Each process holds only its own robot state. Ownership and motion packets travel directly between peers over UDP.

The separate simulator supplies the common integer clock, static map/control changes, and each robot's radius-two sensor contacts. It collects telemetry and audits physical outcomes. It does not compute routes, auction winners, or movement winners. It never repairs a collision by moving a robot or choosing a different winner.

**Actual edge hardware has not been tested.** The project currently has no Raspberry Pis or Jetsons. Three local OS processes are evidence of process isolation and network integration, not evidence of edge-hardware execution. The three-process acceptance report must not be described as a hardware result.

## Local demo and dashboard

From the repository root, with the existing dependencies installed:

```sh
npm run edge:demo
```

In another terminal:

```sh
FLEET_URL=http://127.0.0.1:4011 npm run dev
```

Open the dashboard. It shows actual telemetry from the three independent controller processes through the simulation host. Pause/run, AI enable/disable, task announcement, blocked cells, failure, severed links, and healing operate on this deployment. A local failure command actually terminates the chosen robot process; its body remains in the simulated world. Stop the demo with Ctrl-C. There is no in-session failed-process restart.

The first 112 simulation ticks allow peer auctions and custody checkpoints to settle while motion is held. Then all three robots are released together. The map has two rooms connected only through (9,6); removing that cell disconnects every pickup-to-dropoff journey. Two robots travel east and one west. This intentionally exercises opposing traffic, not an uncontested convoy.

The older `npm run fleet` runtime remains available as the one-process integrated simulator and historical benchmark target. It is a different deployment from `edge:demo`.

## Reproducible checks

```sh
npm run fleet:build
npx vitest run tests/edge-peer.test.ts tests/local-commit.test.ts tests/ownership.test.ts
node scripts/smoke-edge.mjs
node scripts/measure-edge-choke.mjs             # four development seeds
node scripts/measure-edge-choke.mjs --accept    # 40 paired acceptance seeds
```

The 40-seed protocol is frozen at seeds 24000–24039, horizon 512. Both policies use the same allocation, AI, sensing, A*, energy gate, obstruction-memory rules and UDP phase boundaries. The baseline moves only toward its preferred route cell; its connected-snapshot decisions are tested against the unchanged original stop-and-wait resolver. Negotiated motion can yield and lets the head-on priority winner hold while the loser clears space.

Current pose and desired route step are exchanged before proposals; proposals are then exchanged before each peer confirms its own move. The host grants an 8 ms delivery opportunity between phases, not a delivery guarantee. Missing current intent from a potential contender causes a hold. This is a shared-clock simulation protocol, not an asynchronous physical robot safety protocol.

Failed/capped runs contribute only to reliability, never to percentage speedup. Both end-to-end ticks (including admission) and the motion window (after the common release) are reported. Only pairs where both policies complete contribute to either speed measure. A passing experiment script is not a passing 20% target.

## Future physical edge deployment

The compiled entry point has been exercised with Node 24 on the development host. Build it once:

```sh
npm run fleet:build
```

Copy the entire `.fleet-dist/` tree to each device. It includes the frozen model JSON and compiled core; there is no Python, ONNX, torch, or npm runtime dependency for the controller. Each device needs a compatible Node runtime; execution and timings on ARM hardware still require verification.

Replace the example IP addresses in `docs/edge/peers.example.json` with the real devices' addresses and copy the same file to all three. On each device, run its own ID:

```sh
export EDGE_BIND=0.0.0.0
export EDGE_TOKEN='replace-with-a-shared-demo-secret'
node .fleet-dist/src/server/edge-agent.js peers.json AMR-01
```

Use AMR-02 and AMR-03 on the other devices. The HTTP control ports and the two UDP ports per device must be reachable on the trusted demonstration LAN. HTTP control uses the shared token when exposed beyond loopback. UDP assumes honest fixed-membership peers; it is not authenticated or Byzantine fault tolerant.

On the simulation/dashboard host, use the same peer file and token:

```sh
export EDGE_TOKEN='replace-with-a-shared-demo-secret'
node scripts/edge-demo.mjs --endpoints=peers.json
# Or run the paired experiment:
node scripts/measure-edge-choke.mjs --accept --endpoints=peers.json
```

Keep local-host acceptance artifacts before running another environment. A remote endpoint is not proof of physical hardware: record device identity, CPU/architecture, Node version, process IDs, power/temperature conditions, timing and memory results before changing the hardware-verification claim. The scripts deliberately leave `hardwareValidated: false` until that evidence exists.

## Remaining limits

- Common simulation time and phase boundaries; no claim about arbitrary clock skew or physical continuous motion.
- Fixed roster and crash-stop sessions. No durable vote storage, single-peer restart within a session, or dynamic membership.
- A custody checkpoint fences pickup. If a robot fails after custody, physical/manual recovery is required; the software does not fabricate another load.
- Unknown nearby contenders are treated conservatively. Their safety envelopes can make a nearby pickup unreachable, even when the failed body does not occupy the pickup itself. A failed-body-adjacent pickup trace is retained in the artifacts.
- The energy gate checks each proposed move against remaining work, charging-route distance and reserve. It prevents spending that reserve on repeated detours; it does not add charging, physical load recovery, or guarantee completion of every blocked task.
- No ROS 2, DDS, Nav2, physical AMR, or hardware-in-loop execution is supplied by this deployment.
