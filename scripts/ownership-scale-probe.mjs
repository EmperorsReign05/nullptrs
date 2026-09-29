#!/usr/bin/env node
/** Ownership/liveness scale probe.
 *
 * Drives the real Nav2 (or grid) fleet and records, per tick, exactly what the
 * ownership layer saw: peer heartbeat ticks and ages, liveness, quorum
 * reachability, per-task bid/grant/certificate state, and the wall-clock cost of
 * each phase plus the order controllers were advanced in. Instrumentation only —
 * it adds no decisions to the protocol.
 *
 *   node scripts/ownership-scale-probe.mjs --robots 7 --out artifacts/ownership-scale/nav2-n7
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EdgeSimulation, startAgents, sleep } from "./edge-sim.mjs";
import { loadFleetConfig, buildEndpoints, writeRunConfig, quorumOf, parseArgs } from "./fleet-config.mjs";
import { configureNav2Fleet } from "./nav2-fleet-scenario.mjs";

// Accepts --key value and --key=value; `npm run -- --robots 5` splits the value.
const args = parseArgs();
const arg = (k, d) => (args[k] === undefined ? d : args[k]);
const n = Number(arg("robots", "3"));
const mode = arg("mode", "nav2");           // nav2 | ros2 (DDS transport, grid executor) | grid (UDP)
const out = path.resolve(arg("out", `artifacts/ownership-scale/${mode}-n${n}`));
const ticks = Number(arg("ticks", String(Math.max(220, n * 120))));
const budgetMs = Number(arg("budget-ms", "900000"));
const portBase = Number(arg("port-base", "26000"));

await mkdir(out, { recursive: true });
const configPath = path.join(out, "fleet.json");
writeRunConfig(n, configPath);
process.env.FLEET_CONFIG = configPath;
const config = loadFleetConfig(configPath);
const nav2 = mode === "nav2";
// ros2 = real Fast DDS peers with the grid executor: isolates transport from
// physical execution, so we can tell which one causes the liveness failure.
const useDds = nav2 || mode === "ros2";

if (useDds) {
  process.env.EDGE_TRANSPORT = "ros2";
  process.env.ROS_BRIDGE_COMMAND = JSON.stringify([
    "podman", "run", "--rm", "-i", "--network=host",
    "-e", `ROS_DOMAIN_ID=${config.rosDomainId}`,
    process.env.ROS_BRIDGE_IMAGE ?? "localhost/teamrocket-ros2:jazzy",
  ]);
} else {
  process.env.EDGE_TRANSPORT = "udp";
}
const endpoints = buildEndpoints(config, portBase, "127.0.0.1", { executors: nav2 });

const sim_state = async (i) => {
  const e = endpoints[i];
  const r = await fetch(`http://${e.host}:${e.controlPort}/state`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Per-phase wall-clock cost, including the Nav2 physical action in /commit.
const perPhase = { "/prepare": [], "/propose": [], "/commit": [] };
const started = Date.now();
// `--with-nav2` brings up the real Nav2 container for the duration of the run so
// one command reproduces a whole measurement, including the ROS container.
let container = null;
async function startNav2Container() {
  const { spawn } = await import("node:child_process");
  const name = `oscale-nav2-n${n}-${Date.now()}`;
  const domain = config.rosDomainId;
  const root = process.cwd();
  container = spawn("podman", [
    "run", "--name", name, "--rm", "--network", "host", "--security-opt", "label=disable",
    "-e", `ROS_DOMAIN_ID=${domain}`, "-e", "RMW_IMPLEMENTATION=rmw_fastrtps_cpp",
    "-v", `${root}/ros2/teamrocket_nav_sim:/ws/src/teamrocket_nav_sim:ro`,
    "-v", `${out}:/results`,
    "localhost/teamrocket-nav2:jazzy",
    // The image ENTRYPOINT is already ["/bin/bash","-c"], so the script is one arg.
    "set -eo pipefail\nsource /opt/ros/jazzy/setup.bash\ncd /ws\n" +
    "colcon build --packages-select teamrocket_nav_sim > /results/build.log 2>&1\n" +
    "source install/setup.bash\nexec ros2 launch teamrocket_nav_sim fleet.launch.py fleet_config:=/results/fleet.json",
  ], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  container.unref();
  const { once } = await import("node:events");
  const deadline = Date.now() + 240000;
  for (;;) {
    const up = await Promise.all(config.robots.map((r) => probePort(r.executorPort)));
    if (up.every(Boolean)) return name;
    if (Date.now() > deadline) throw new Error(`Nav2 executors never came up: ${JSON.stringify(up)}`);
    await sleep(1000);
  }
}
const probePort = async (port) => {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(300);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
};
async function stopNav2Container() {
  if (!container) return;
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("podman", ["stop", "--time", "2", container.spawnargs[3]], { stdio: "ignore" }); } catch { /* already gone */ }
}
if (nav2 && args["with-nav2"] !== undefined) await startNav2Container();

const processes = await startAgents(endpoints);
const samples = [];
let result = null;
try {
  // Preflight: prove every controller is actually serving before blaming protocol.
  const preflight = await Promise.all(endpoints.map(async (e, i) => {
    try { const s = await sim_state(i); return { id: e.id, port: e.controlPort, ok: s.id === e.id }; }
    catch (error) { return { id: e.id, port: e.controlPort, ok: false, error: String(error) }; }
  }));
  if (preflight.some((p) => !p.ok)) {
    throw new Error(`preflight failed: ${JSON.stringify(preflight)}`);
  }

  const settleMs = Number(arg("settle-ms", useDds ? "25" : "8"));
  const sim = new EdgeSimulation(endpoints, { settleMs });
  await sim.initialize(23000, "negotiated", `oscale-${Date.now()}`,
    (s) => { if (nav2) configureNav2Fleet(s, true, config); });

  // Wall-clock cost of each phase per peer. Wrapping `request` sees every phase
  // for every controller without changing step order.
  const req = sim.request.bind(sim);
  sim.request = async (i, route, body) => {
    const t0 = process.hrtime.bigint();
    try { return await req(i, route, body); }
    finally {
      if (perPhase[route]) perPhase[route].push({ tick: sim.tick, id: sim.endpoints[i]?.id, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    }
  };

  const deadline = Date.now() + budgetMs;
  while (sim.tick < ticks && !sim.result().completed && Date.now() < deadline) {
    const t0 = Date.now();
    await sim.step();
    const wall = Date.now() - t0;
    if (sim.tick % 4 === 0 || sim.tick < 40) {
      const diag = await Promise.all(endpoints.map((_e, i) =>
        sim.request(i, "/diagnostics").catch(() => null)));
      samples.push({
        tick: sim.tick, wallMs: wall,
        datagrams: sim.states.map((st) => st.datagrams ?? null),
      perPeer: diag.map((d, i) => d && ({
          id: endpoints[i].id, now: d.now, generation: d.generation, phase: d.phase,
          quorum: d.quorum, liveCount: d.liveCount, quorumReachable: d.quorumReachable,
          metrics: d.metrics, taskCount: d.taskCount,
          ages: Object.fromEntries(Object.entries(d.heard).map(([k, v]) => [k, v.age])),
          heardTicks: Object.fromEntries(Object.entries(d.heard).map(([k, v]) => [k, v.tick])),
          dead: Object.entries(d.heard).filter(([, v]) => !v.live).map(([k]) => k),
          freshness: d.freshness, progressWatermark: d.progressWatermark, admissionFrontier: d.admissionFrontier,
          sentByKind: d.sentByKind,
          certificates: Object.entries(d.auctions).filter(([, a]) => a.certificateReached).map(([t]) => t),
          candidate: Object.entries(d.auctions).find(([, a]) => a.isCandidate)?.[0] ?? null,
          bestBidsLive: Object.values(d.auctions).map((a) => a.bidsLive),
        })).filter(Boolean),
      });
    }
    // Runaway guard only: a single tick legitimately costs seconds in Nav2
    // (EKF warm-up, first action-server round trip), so this is deliberately loose.
    if (wall > 60000) break;
  }
  result = sim.result();
} finally {
  await processes.close();
  await stopNav2Container();
}

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
// Why did progress stop? Correlate certificates with live-peer counts.
const firstCert = samples.find((s) => s.perPeer.some((p) => p.certificates.length));
const last = samples[samples.length - 1];
const summary = {
  schema: 1, mode, robots: n, quorum: quorumOf(n),
  config: config.robots.map((r) => ({ id: r.id, namespace: r.namespace, origin: r.origin, executorPort: r.executorPort })),
  completed: result?.completed ?? false,
  completedTasks: result?.completedTasks ?? 0, totalTasks: result?.totalTasks ?? 0,
  ticks: result?.ticks ?? samples[samples.length - 1]?.tick ?? 0,
  safety: result?.safety ?? null,
  wallSeconds: (Date.now() - started) / 1000,
  firstCertificateAtTick: firstCert ? firstCert.tick : null,
  // Per-phase wall-clock cost, including the Nav2 physical action in /commit.
  phaseWallMs: Object.fromEntries(Object.entries(perPhase).map(([k, v]) => [k, {
    calls: v.length, totalMs: Number(v.reduce((a, x) => a + x.ms, 0).toFixed(1)),
    p50: Number((pct(v.map((x) => x.ms), 0.5) ?? 0).toFixed(2)),
    p95: Number((pct(v.map((x) => x.ms), 0.95) ?? 0).toFixed(2)),
    max: Number(Math.max(0, ...v.map((x) => x.ms)).toFixed(2)),
  }])),
  finalSample: last ? {
    tick: last.tick, wallMs: last.wallMs,
    perPeer: last.perPeer.map((p) => ({ id: p.id, liveCount: p.liveCount, quorumReachable: p.quorumReachable, dead: p.dead, bestBidsLive: p.bestBidsLive, candidate: p.candidate, grants: p.metrics.grants, bids: p.metrics.bids })),
  } : null,
};
await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(path.join(out, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`);
await writeFile(path.join(out, "phase-timing.json"), `${JSON.stringify(perPhase, null, 2)}\n`);
console.log(JSON.stringify({ mode, robots: n, completed: summary.completed, tasks: `${summary.completedTasks}/${summary.totalTasks}`,
  ticks: summary.ticks, firstCertificateAtTick: summary.firstCertificateAtTick,
  quorumReachable: last?.perPeer.map((p) => p.quorumReachable) ?? null,
  liveCounts: last?.perPeer.map((p) => p.liveCount) ?? null,
  wallSeconds: Number(summary.wallSeconds.toFixed(1)) }));
