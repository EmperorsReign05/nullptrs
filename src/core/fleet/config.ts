/** Canonical fleet membership contract.
 *
 * One file describes which robots exist, what ROS namespace each owns, where it
 * starts in the grid and which local executor serves its physical moves. Every
 * other layer (ROS2 launch, Fast DDS rosters, Nav2 instances, sensor world,
 * executor routing, telemetry) derives from this file. Nothing else may declare
 * fleet membership.
 *
 * This module is intentionally dependency-free so the same rules can be applied
 * from the TypeScript build, the scripts and the tests.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type FleetRobot = {
  /** Stable robot identity used by every protocol, task and log. */
  id: string;
  /** ROS namespace for this robot's private topic/action/TF tree. */
  namespace: string;
  /** Grid cell this robot occupies in the continuous physical world. */
  origin: { x: number; y: number };
  /** Loopback port of this robot's private physical executor. */
  executorPort: number;
};

export type FleetConfig = {
  /** Grid pitch in metres. Shared by the host grid and every ROS world offset. */
  cellMetres: number;
  /** DDS domain shared by the fleet container and every peer bridge. */
  rosDomainId: number;
  robots: FleetRobot[];
};

export type FleetEndpoint = {
  id: string;
  host: string;
  controlPort: number;
  ownershipPort: number;
  motionPort: number;
  /** Present only when the run brings up a Nav2 executor for this robot. */
  executorPort?: number;
};

export const FLEET_CONFIG_PATH = "config/fleet.json";

/** Deterministic robot identity. The only place fleet ids are formatted. */
export function robotId(index: number): string {
  return `AMR-${String(index + 1).padStart(2, "0")}`;
}

/** ROS namespace for an id: `AMR-01` -> `AMR_01`. ROS forbids `-` in names. */
export function namespaceFor(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Strict majority, correct for any membership size including even N. */
export function quorumOf(size: number): number {
  if (!Number.isInteger(size) || size < 1) throw new Error(`Fleet size must be a positive integer, got ${size}`);
  return Math.floor(size / 2) + 1;
}

/** Grid height that fits `size` origins on the 3-cell vertical pitch. */
export function mapHeightFor(size: number): number {
  return Math.max(13, 2 + 3 * size);
}

/** Build a valid roster for `size` robots. Deterministic: same N, same file. */
export function generateFleetConfig(size: number, options: {
  cellMetres?: number;
  rosDomainId?: number;
  executorBasePort?: number;
} = {}): FleetConfig {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`--robots must be a positive integer, got ${size}`);
  }
  const executorBasePort = options.executorBasePort ?? 19700;
  return {
    cellMetres: options.cellMetres ?? 0.6,
    rosDomainId: options.rosDomainId ?? 96,
    robots: Array.from({ length: size }, (_, i) => ({
      id: robotId(i),
      namespace: namespaceFor(robotId(i)),
      origin: { x: 1, y: 1 + 3 * i },
      executorPort: executorBasePort + i,
    })),
  };
}

/** Reject an invalid fleet with an actionable message instead of a TypeError later. */
export function validateFleetConfig(raw: unknown, source = FLEET_CONFIG_PATH): FleetConfig {
  const fail = (message: string): never => {
    throw new Error(`Invalid fleet config (${source}): ${message}`);
  };
  if (!raw || typeof raw !== "object") return fail("expected a JSON object");
  const cfg = raw as Record<string, unknown>;
  const cellMetres = cfg.cellMetres;
  if (typeof cellMetres !== "number" || !Number.isFinite(cellMetres) || cellMetres <= 0) {
    return fail(`cellMetres must be a positive number, got ${JSON.stringify(cellMetres)}`);
  }
  const rosDomainId = cfg.rosDomainId;
  if (!Number.isInteger(rosDomainId) || (rosDomainId as number) < 0 || (rosDomainId as number) > 232) {
    return fail(`rosDomainId must be an integer 0-232, got ${JSON.stringify(rosDomainId)}`);
  }
  const robots = cfg.robots;
  if (!Array.isArray(robots) || robots.length < 1) {
    return fail("robots must be a non-empty array (N >= 1)");
  }
  const seenId = new Map<string, number>();
  const seenNs = new Map<string, string>();
  const seenOrigin = new Map<string, string>();
  const seenPort = new Map<number, string>();
  const parsed = robots.map((entry, index) => {
    if (!entry || typeof entry !== "object") return fail(`robots[${index}] is not an object`);
    const r = entry as Record<string, unknown>;
    const { id, namespace, origin, executorPort } = r;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return fail(`robots[${index}].id must match [A-Za-z0-9_-]+, got ${JSON.stringify(id)}`);
    }
    if (seenId.has(id)) return fail(`duplicate robot id ${id} at robots[${index}]`);
    seenId.set(id, index);
    const ns = namespace ?? namespaceFor(id);
    if (typeof ns !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ns)) {
      return fail(`robots[${index}].namespace ${JSON.stringify(ns)} is not a legal ROS namespace`);
    }
    if (seenNs.has(ns)) return fail(`duplicate namespace ${ns} (robots[${index}] and ${seenNs.get(ns)})`);
    seenNs.set(ns, id);
    if (!origin || typeof origin !== "object") return fail(`robots[${index}].origin is missing`);
    const { x, y } = origin as Record<string, unknown>;
    if (!Number.isInteger(x) || !Number.isInteger(y) || (x as number) < 0 || (y as number) < 0) {
      return fail(`robots[${index}].origin must be non-negative integers, got ${JSON.stringify(origin)}`);
    }
    const originKey = `${x},${y}`;
    if (seenOrigin.has(originKey)) {
      return fail(`duplicate origin ${originKey} for ${id} and ${seenOrigin.get(originKey)}`);
    }
    seenOrigin.set(originKey, id);
    if (!Number.isInteger(executorPort) || (executorPort as number) < 1 || (executorPort as number) > 65535) {
      return fail(`robots[${index}].executorPort must be 1-65535, got ${JSON.stringify(executorPort)}`);
    }
    if (seenPort.has(executorPort as number)) {
      return fail(`executor port collision on ${executorPort} (${id} and ${seenPort.get(executorPort as number)})`);
    }
    seenPort.set(executorPort as number, id);
    return { id, namespace: ns, origin: { x: x as number, y: y as number }, executorPort: executorPort as number };
  });
  const height = mapHeightFor(parsed.length);
  for (const robot of parsed) {
    if (robot.origin.y >= height) {
      return fail(
        `${robot.id} origin y=${robot.origin.y} is outside the ${parsed.length}-robot map height ${height}; ` +
        `increase the map or lower the origins`,
      );
    }
  }
  return { cellMetres, rosDomainId: rosDomainId as number, robots: parsed };
}

/** Load the roster. `FLEET_CONFIG` lets each harness run against its own fleet. */
export function loadFleetConfig(file = process.env.FLEET_CONFIG ?? FLEET_CONFIG_PATH): FleetConfig {
  const resolved = path.resolve(process.cwd(), file);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(
      `Cannot read fleet config at ${resolved}. Set FLEET_CONFIG or run: npm run fleet:n -- --robots <n>`,
    );
  }
  return validateFleetConfig(JSON.parse(raw), file);
}

export function writeFleetConfig(config: FleetConfig, file = process.env.FLEET_CONFIG ?? FLEET_CONFIG_PATH): string {
  const resolved = path.resolve(process.cwd(), file);
  validateFleetConfig(config, file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(config, null, 2)}\n`);
  return resolved;
}

/** Robot ids in roster order. */
export function fleetIds(config: FleetConfig): string[] {
  return config.robots.map((r) => r.id);
}

export function fleetRobot(config: FleetConfig, id: string): FleetRobot {
  const robot = config.robots.find((r) => r.id === id);
  if (!robot) throw new Error(`${id} is not in the fleet roster (${fleetIds(config).join(", ")})`);
  return robot;
}

/** Deployment endpoints for the edge agents, one OS process each.
 *
 * Control/ownership/motion ports are deployment-local and therefore offset from
 * a per-run base; the executor port comes from the fleet config so a robot id
 * maps to exactly one physical executor without positional arithmetic. */
export function buildEndpoints(
  config: FleetConfig,
  portBase: number,
  host = "127.0.0.1",
  options: { executors?: boolean } = {},
): FleetEndpoint[] {
  const withExecutors = options.executors !== false;
  const ports = new Map<number, string>();
  return config.robots.map((robot, i) => {
    const endpoint: FleetEndpoint = {
      id: robot.id,
      host,
      controlPort: portBase + i,
      ownershipPort: portBase + 100 + i,
      motionPort: portBase + 200 + i,
    };
    // An executor port is advertised only when this run actually brings up a
    // Nav2 stack; its presence is what tells the agent and the host to use it.
    if (withExecutors) endpoint.executorPort = robot.executorPort;
    for (const [label, port] of Object.entries({
      controlPort: endpoint.controlPort,
      ownershipPort: endpoint.ownershipPort,
      motionPort: endpoint.motionPort,
      executorPort: endpoint.executorPort,
    })) {
      if (port === undefined) continue;
      const owner = ports.get(port);
      if (owner) throw new Error(`Port collision on ${port} (${label} for ${robot.id} vs ${owner})`);
      ports.set(port, `${robot.id}.${label}`);
    }
    return endpoint;
  });
}
