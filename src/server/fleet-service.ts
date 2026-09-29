import { FleetRuntime } from "../core/distributed/runtime";
// One long-lived Node runtime. HTTP/browser lifetime never drives robot ticks.
// Deployment target is the separate fleet-http Node process, not serverless.
const key = Symbol.for("sih.fleet-runtime.v1");
type Holder = { runtime: FleetRuntime; timer: ReturnType<typeof setInterval> };
export function fleetService(): FleetRuntime {
  const root = globalThis as typeof globalThis & { [key]?: Holder };
  if (!root[key]) {
    const runtime = new FleetRuntime();
    const timer = setInterval(() => runtime.step(), 250);
    timer.unref(); root[key] = { runtime, timer };
  }
  return root[key]!.runtime;
}
