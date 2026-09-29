// Stateless dashboard proxy. Killing Next/browser cannot kill the separate
// fleet process. The runtime URL is server configuration, never client input.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function proxy(method: "GET" | "POST", body?: string) {
  try {
    const base = process.env.FLEET_URL ?? "http://127.0.0.1:4010";
    const upstream = await fetch(`${base}/${method === "GET" ? "state" : "command"}`, {
      method, body, cache: "no-store", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(3000),
    });
    return new Response(await upstream.text(), { status: upstream.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Fleet runtime unavailable; start npm run fleet" }, { status: 503 }); }
}
export function GET() { return proxy("GET"); }
export async function POST(request: Request) { return proxy("POST", await request.text()); }
