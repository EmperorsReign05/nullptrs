import { createServer } from "node:http";
import { reconfigureFleet, fleetOrderBook, fleetService } from "./fleet-service";
import type { RuntimeCommand } from "../core/distributed/runtime";

// The runtime is resolved PER REQUEST, never captured at module load.
//
// `reconfigureFleet` swaps the runtime held in globalThis and stops the old one's
// stepping interval. A module-scope `const fleet = fleetService()` keeps a
// reference to the DISPOSED runtime, so after anyone touches the fleet-size
// slider every subsequent create-task / block-aisle / fail-robot command is
// accepted by a zombie that nothing is stepping: it answers HTTP 200, the task
// appears in the response, and then nothing ever happens to it again. That is the
// worst possible failure for a demo, because every call reports success.
//
// Resolving per request costs one map lookup and makes the swap invisible to
// every caller. The runtime still begins independently of any dashboard request,
// because `fleetService()` constructs and starts it on first reference.
const port = Number(process.env.PORT || process.env.FLEET_PORT || 4010);

// The one thing this process accepts that is NOT a runtime command. Fleet size
// and the shelf layout are baked into a runtime at construction — membership is
// fixed (quorum is derived from it) and the map is a constructor argument — so
// changing either means building a new runtime. Rather than leave the two
// dashboard sliders wired to log messages that do nothing, they now ask for a
// real reconfiguration and the harness performs one. The dashboard labels it as a
// restart, because that is exactly what it is.
type Reconfigure = { kind: "reconfigure"; robots?: number; shelfColumns?: number; orderStream?: boolean };

const RUNTIME_KINDS = ["run", "pause", "ai-on", "ai-off", "heal", "fail", "recover", "link", "block", "task"];
const HARNESS_KINDS = ["order-stream", "reconfigure"];

const state = () => ({ ...fleetService().snapshot(), orderStream: fleetOrderBook().stats() });

createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "GET" && request.url === "/state") {
      response.end(JSON.stringify(state())); return;
    }
    if (request.method === "POST" && request.url === "/command") {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error("Command too long"); }
      const command = JSON.parse(body) as ({ kind: string } & Record<string, unknown> & Partial<Omit<RuntimeCommand, "kind">>);
      if (!command || typeof command.kind !== "string") throw new Error("Unknown command");
      if (![...RUNTIME_KINDS, ...HARNESS_KINDS].includes(command.kind)) throw new Error("Unknown command");

      if (command.kind === "order-stream") {
        if (typeof command.on !== "boolean") throw new Error("order-stream requires a boolean `on`");
        fleetOrderBook().setEnabled(command.on);
        response.end(JSON.stringify(state())); return;
      }

      if (command.kind === "reconfigure") {
        const { robots, shelfColumns, orderStream } = command as Reconfigure;
        if (robots !== undefined && (!Number.isInteger(robots) || (robots as number) < 1 || (robots as number) > 20)) {
          throw new Error("robots must be an integer 1..20");
        }
        if (shelfColumns !== undefined && (!Number.isInteger(shelfColumns) || (shelfColumns as number) < 0 || (shelfColumns as number) > 6)) {
          throw new Error("shelfColumns must be an integer 0..6");
        }
        if (orderStream !== undefined && typeof orderStream !== "boolean") {
          throw new Error("orderStream must be a boolean");
        }
        reconfigureFleet({
          ...(robots !== undefined ? { robots: robots as number } : {}),
          ...(shelfColumns !== undefined ? { shelfColumns: shelfColumns as number } : {}),
          ...(orderStream !== undefined ? { orderStream: orderStream as boolean } : {}),
        });
        response.end(JSON.stringify(state())); return;
      }

      // Safe because the allow-list above is exactly RuntimeCommand's kind union
      // minus the harness-only kinds, which have already returned.
      fleetService().command(command as unknown as RuntimeCommand);
      response.end(JSON.stringify(state())); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "Unknown endpoint" }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid command" }));
  }
}).listen(port, "0.0.0.0", () => console.log(`Fleet runtime listening on 0.0.0.0:${port}`));
