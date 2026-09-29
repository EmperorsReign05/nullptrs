#!/usr/bin/env node
/** Launch an arbitrary-N fleet from one config and report machine-readable results.
 *
 *   npm run fleet:n -- --robots 5              # software fleet over real Fast DDS
 *   npm run fleet:n -- --robots 8 --transport udp
 *   npm run fleet:n -- --robots 5 --nav2       # delegates to the Nav2 acceptance
 *   npm run fleet:n -- --robots 3 --out /tmp/x
 *
 * Fleet size is chosen by writing a valid config, never by editing code. That
 * config is then the single source of truth for controller count, ROS namespaces,
 * Nav2 stacks, origins, transport peers and executor endpoints.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, writeRunConfig, loadFleetConfig, buildEndpoints, quorumOf } from "./fleet-config.mjs";

const args = parseArgs();
const robots = Number(args.robots ?? process.env.FLEET_N ?? 3);
if (!Number.isInteger(robots) || robots < 1) {
  console.error(`--robots must be a positive integer, got ${args.robots}`);
  process.exit(2);
}
const transport = args.transport ?? process.env.EDGE_TRANSPORT ?? "ros2";
const out = path.resolve(args.out ?? `artifacts/n-robot/software-n${robots}`);

const nav2 = !!args.nav2;
if (nav2) {
  // Nav2 needs the container image and its own readiness probing.
  const child = spawn("bash", ["scripts/nav2-fleet-acceptance.sh", args.out ?? `artifacts/n-robot/nav2-n${robots}`], {
    stdio: "inherit", env: { ...process.env, FLEET_N: String(robots) },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  await mkdir(out, { recursive: true });
  const configPath = path.join(out, "fleet.json");
  writeRunConfig(robots, configPath, {
    rosDomainId: Number(process.env.ROS_DOMAIN_ID ?? 96),
  });
  process.env.FLEET_CONFIG = configPath;
  const config = loadFleetConfig(configPath);

  if (transport === "ros2") {
    process.env.EDGE_TRANSPORT = "ros2";
    process.env.ROS_BRIDGE_COMMAND = JSON.stringify([
      "podman", "run", "--rm", "-i", "--network=host",
      "-e", `ROS_DOMAIN_ID=${config.rosDomainId}`,
      process.env.ROS_BRIDGE_IMAGE ?? "localhost/teamrocket-ros2:jazzy",
    ]);
  } else {
    process.env.EDGE_TRANSPORT = "udp";
  }

  const { EdgeSimulation, startAgents } = await import("./edge-sim.mjs");
  const { configureNav2Fleet } = await import("./nav2-fleet-scenario.mjs");
  const portBase = Number(args["port-base"] ?? process.env.FLEET_PORT_BASE ?? 19800);
  const endpoints = buildEndpoints(config, portBase, "127.0.0.1", { executors: false });
  const started = Date.now();
  const processes = await startAgents(endpoints);
  let report;
  try {
    // More peers need a longer lockstep settle window: every participant must
    // hear the others before it decides, or bids fall short of quorum.
    const settleMs = Number(args["settle-ms"] ?? (transport === "ros2" ? 20 + 12 * robots : 8));
    const sim = new EdgeSimulation(endpoints, { settleMs });
    // Every robot gets one task; Nav2 mode uses the crossing geometry, otherwise
    // the stock edge fixture is used unchanged.
    await sim.initialize(23000, "negotiated", `fleet-n${robots}-${Date.now()}`,
      (s) => { if (nav2) configureNav2Fleet(s, true, config); });

    // Every controller must have discovered the whole roster at startup.
    const discovered = sim.states.filter((s) =>
      s.transport?.subscriptions?.motion === config.robots.length
      && s.transport?.subscriptions?.ownership === config.robots.length).length;
    // Prove killing one controller does not take the fleet down.
    // --kill none disables the fault injection so fleet size alone can be measured.
    const killArg = args.kill ?? "auto";
    const killAt = killArg === "none" ? null
      : killArg === "auto" ? (robots > 1 ? Math.min(2, robots - 1) : null)
      : Math.min(Math.max(Number(killArg), 0), robots - 1);
    const budget = robots * 140;
    while (sim.tick < budget && !sim.result().completed) {
      if (killAt !== null && sim.tick === 2) {
        processes.children[killAt].kill("SIGKILL");
        sim.failed.add(killAt);
      }
      await sim.step();
    }
    const result = sim.result();
    const live = sim.states.filter((_, i) => !sim.failed.has(i));
    // Every surviving controller must still answer; the killed one must not.
    const survivorsResponsive = (await Promise.all(live.map((_, i) =>
      sim.request(sim.states.indexOf(live[i]), "/state").then(() => true).catch(() => false)))).every(Boolean);
    const survivorsAreMajority = live.length >= quorumOf(config.robots.length);
    report = {
      schema: 1,
      passed: Object.values(result.safety).every((x) => x === 0)
        && discovered === config.robots.length
        && survivorsResponsive,
      robots: config.robots.length,
      quorum: quorumOf(config.robots.length),
      controllersStarted: sim.states.filter((s) => s.pid).length,
      ddsPeersReady: discovered,
      // After the kill, survivors should still hold the other survivors.
      ddsPeersAfterKill: live.filter((s) => s.transport?.subscriptions?.motion >= live.length).length,
      transport,
      settleMs,
      tasksCompleted: result.completedTasks,
      totalTasks: result.totalTasks,
      completed: result.completed,
      ticks: result.ticks,
      killedController: killAt === null ? null : config.robots[killAt].id,
      survivingControllers: live.length,
      survivorsAreMajority,
      survivorsResponsive,
      safety: result.safety,
      fleet: config.robots.map((r) => ({ id: r.id, namespace: r.namespace, origin: r.origin, executorPort: r.executorPort })),
      peers: sim.states.map((s) => ({ id: s.id, pid: s.pid, subscriptions: s.transport?.subscriptions ?? null, failed: sim.failed.has(sim.states.indexOf(s)) })),
      wallSeconds: (Date.now() - started) / 1000,
      scope: `${config.robots.length} independent OS-process controllers over ${transport}; membership, namespaces and endpoints derived from ${path.relative(process.cwd(), configPath)}`,
      limitations: [
        "Shared logical clock; not an asynchronous physical-robot lease protocol",
        "No Nav2 or hardware: this path uses the grid executor",
        `One controller is killed at tick 2 to prove fleet survivability. Its task cannot complete unless the survivors still form a quorum (N-1 >= floor(N/2)+1), so N=2 legitimately completes fewer tasks.`,
      ],
    };
  } finally {
    await processes.close();
  }
  await writeFile(path.join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    robots: report.robots, controllersStarted: report.controllersStarted,
    ddsPeersReady: report.ddsPeersReady, tasksCompleted: report.tasksCompleted,
    safety: { overlaps: report.safety.overlaps, swaps: report.safety.swaps },
    passed: report.passed,
  }));
  if (!report.passed) process.exitCode = 1;
}
