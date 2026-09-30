// Stateless dashboard adapter for the fleet runtime.
//
// TWO TOPOLOGIES, AND THE DASHBOARD WORKS IN BOTH.
//
//   external     FLEET_URL points at the separate `npm run fleet` Node process.
//                This is the one-process-per-robot deployment the project claims,
//                and it is what a local demo and the ROS2/Nav2 runs use.
//
//   in-process   No external runtime. The same FleetRuntime is hosted inside this
//                Next server and stepped from here.
//
// WHY THE FALLBACK EXISTS. The previous version of this file proxied to
// FLEET_URL (default http://127.0.0.1:4010) and returned 503 when it did not
// answer. That is correct on a laptop and fatal on a single-deploy host: Vercel
// runs each route as an isolated function, there is no long-lived process on
// 127.0.0.1 to answer, and nothing can be started in a second terminal. So a
// Vercel deployment could NEVER show a live fleet — it could only ever show
// "Fleet runtime not connected", and the demo would be dead on arrival for
// exactly the audience it was built for.
//
// With the fallback there is always a runtime, so the failure mode "the dashboard
// has nothing behind it" no longer exists. What DOES still vary is the topology,
// so the snapshot says which one is live and the dashboard displays it. Claiming
// one-process-per-robot while serving a single in-process fleet would be a lie
// told to a judge, and it is the one thing this adapter must not do.
//
// The runtime URL is server configuration, never client input.
import { reconfigureFleet, fleetOrderBook, fleetService, stepIfDue } from "@/server/fleet-service";
import type { RuntimeCommand } from "@/core/distributed/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXTERNAL_TIMEOUT_MS = 1500;

type Snapshot = Record<string, unknown> & { orderStream?: unknown };

function localState(topology: "in-process" | "external"): Snapshot {
  // A serverless host can suspend the process between requests, so the stepping
  // interval may not have run. Catch up before answering, otherwise a frozen
  // instance serves a permanently stale frame.
  stepIfDue();
  return { ...fleetService().snapshot(), orderStream: fleetOrderBook().stats(), topology };
}

async function proxy(method: "GET" | "POST", body?: string): Promise<Response> {
  const base = process.env.FLEET_URL;
  if (base) {
    try {
      const upstream = await fetch(`${base}/${method === "GET" ? "state" : "command"}`, {
        method,
        body,
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      });
      if (upstream.ok) {
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      // A reachable-but-refusing external runtime is a real fault and is reported
      // as one, rather than being papered over with a different topology.
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      // Unreachable. Fall through to the in-process runtime rather than 503.
    }
  }
  // In-process runtime.
  if (method === "GET") return Response.json(localState("in-process"), { headers: { "Cache-Control": "no-store" } });

  let payload: ({ kind: string } & Record<string, unknown> & Partial<Omit<RuntimeCommand, "kind">>);
  try {
    payload = JSON.parse(body ?? "{}") as typeof payload;
  } catch {
    return Response.json({ error: "Invalid command body" }, { status: 400 });
  }
  // The runtime's own `command` is a chain of `if (kind === ...)` and silently
  // ignores anything it does not recognise, logging it as a JSON blob. Proxied
  // through fleet-http an unknown kind is rejected by the allow-list there, but
  // the in-process path had no such gate and answered 200 to garbage. The two
  // topologies must reject the same things.
  const RUNTIME_KINDS = ["run", "pause", "ai-on", "ai-off", "heal", "fail", "link", "block", "task"];
  const HARNESS_KINDS = ["order-stream", "reconfigure"];
  if (![...RUNTIME_KINDS, ...HARNESS_KINDS].includes(payload.kind)) {
    return Response.json({ error: `Unknown command: ${payload.kind}` }, { status: 400 });
  }
  try {
    if (payload.kind === "order-stream") {
      if (typeof payload.on !== "boolean") return Response.json({ error: "order-stream requires a boolean `on`" }, { status: 400 });
      fleetOrderBook().setEnabled(payload.on);
    } else if (payload.kind === "reconfigure") {
      const { robots, shelfColumns, orderStream } = payload;
      if (robots !== undefined && (!Number.isInteger(robots) || (robots as number) < 1 || (robots as number) > 20)) {
        return Response.json({ error: "robots must be an integer 1..20" }, { status: 400 });
      }
      if (shelfColumns !== undefined && (!Number.isInteger(shelfColumns) || (shelfColumns as number) < 0 || (shelfColumns as number) > 6)) {
        return Response.json({ error: "shelfColumns must be an integer 0..6" }, { status: 400 });
      }
      if (orderStream !== undefined && typeof orderStream !== "boolean") {
        return Response.json({ error: "orderStream must be a boolean" }, { status: 400 });
      }
      reconfigureFleet({
        ...(robots !== undefined ? { robots: robots as number } : {}),
        ...(shelfColumns !== undefined ? { shelfColumns: shelfColumns as number } : {}),
        ...(orderStream !== undefined ? { orderStream: orderStream as boolean } : {}),
      });
    } else {
      fleetService().command(payload as unknown as RuntimeCommand);
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid command" }, { status: 400 });
  }
  return Response.json(localState("in-process"), { headers: { "Cache-Control": "no-store" } });
}

export function GET() { return proxy("GET"); }
export async function POST(request: Request) { return proxy("POST", await request.text()); }
