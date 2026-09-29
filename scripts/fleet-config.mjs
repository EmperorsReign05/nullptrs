/** Single entry point for fleet membership in the scripts.
 *
 * Wraps the compiled canonical contract so no script re-declares a roster,
 * a robot id, an origin or a port. Everything resolves through FLEET_CONFIG.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const config = require("../.fleet-dist/src/core/fleet/config.js");

export const {
  FLEET_CONFIG_PATH,
  buildEndpoints,
  fleetIds,
  fleetRobot,
  generateFleetConfig,
  loadFleetConfig,
  mapHeightFor,
  namespaceFor,
  quorumOf,
  robotId,
  validateFleetConfig,
} = config;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write a valid config for `robots` and return its path. The file is the
 * single source of truth for that run; nothing downstream re-derives it. */
export function writeRunConfig(robots, out, extra = {}) {
  const cfg = validateFleetConfig(generateFleetConfig(robots, extra), path.basename(out));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`);
  return out;
}

/** Command line: --robots N, --config path, --ros-domain N, --out dir.
 * Accepts `--key=value` and `--key value`, because `npm run x -- --k v`
 * delivers the value as a separate argv token. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const hit = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!hit) throw new Error(`Unexpected argument ${argv[i]}`);
    if (hit[2] !== undefined) { args[hit[1]] = hit[2]; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[hit[1]] = next; i++; }
    else args[hit[1]] = "true";
  }
  return args;
}
