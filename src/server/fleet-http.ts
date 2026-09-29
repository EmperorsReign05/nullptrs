import { createServer } from "node:http";
import { fleetService } from "./fleet-service";
import type { RuntimeCommand } from "../core/distributed/runtime";
const fleet = fleetService(); // Runtime begins independently of any dashboard request.
const port = Number(process.env.FLEET_PORT ?? 4010);
createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "GET" && request.url === "/state") {
      response.end(JSON.stringify(fleet.snapshot())); return;
    }
    if (request.method === "POST" && request.url === "/command") {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error("Command too large"); }
      const command = JSON.parse(body) as RuntimeCommand;
      if (!command || !["run", "pause", "ai-on", "ai-off", "heal", "fail", "link", "block", "task"].includes(command.kind)) throw new Error("Unknown command");
      fleet.command(command); response.end(JSON.stringify(fleet.snapshot())); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "Unknown endpoint" }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid command" }));
  }
}).listen(port, "127.0.0.1", () => console.log(`Fleet runtime listening on 127.0.0.1:${port}`));
