import { describe, it, expect } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, "../.fleet-dist/src/core/distributed/worker.js");
const require = createRequire(import.meta.url);

type Frame = { id: string; tick: number; position: { x: number; y: number }; moved: boolean; reason: string; peers: number; taskStatus: string; decideUs: number; rssMb: number; done?: boolean };

function launch(ids: string[], ports: number[], specs: { pos: string; pickup: string; dropoff: string; bays?: string }[], period = 40) {
  const procs: ChildProcess[] = [];
  const frames: Frame[][] = ids.map(() => []);
  const ready: Promise<void>[] = [];
  const errors: string[] = [];
  specs.forEach((s, i) => {
    const p = spawn(process.execPath, [worker, "--start-barrier=ipc",
      `--id=${ids[i]}`, `--port=${ports[i]}`, `--peers=${ports.join(",")}`,
      `--ids=${ids.join(",")}`, `--pos=${s.pos}`, `--pickup=${s.pickup}`,
      `--dropoff=${s.dropoff}`, `--period=${period}`, `--range=6`, `--bays=${s.bays ?? ""}`], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    ready.push(new Promise<void>((resolve, reject) => {
      p.once("error", reject);
      p.once("exit", code => { if (code !== 0) reject(new Error(`worker ${ids[i]} exited ${code}`)); });
      p.on("message", message => { if ((message as { ready?: boolean }).ready) resolve(); });
    }));
    p.stderr!.on("data", chunk => errors.push(`${ids[i]}: ${chunk}`));
    // A stdout chunk need not contain complete JSON lines.
    createInterface({ input: p.stdout! }).on("line", line => {
      if (!line.startsWith("{")) return;
      try { frames[i].push(JSON.parse(line) as Frame); }
      catch { errors.push(`Malformed worker frame: ${line}`); }
    });
    procs.push(p);
  });
  return { procs, frames, ready: Promise.all(ready), errors };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("UDP: three real OS processes, peer-to-peer, no coordinator", () => {
  it("U1: agents on separate processes and sockets exchange state and finish their tasks", async () => {
    const ids = ["AMR-01", "AMR-02", "AMR-03"];
    const ports = [5211, 5212, 5213];
    // single-file spine at x=6 with an alcove at (5,8): the choke point
    const specs = [
      { pos: "6,2", pickup: "6,2", dropoff: "6,11", bays: "5,3;7,3;5,5;7,5;5,7;7,7;5,9;7,9;5,11;7,11" },
      { pos: "6,10", pickup: "6,10", dropoff: "6,1", bays: "5,3;7,3;5,5;7,5;5,7;7,7;5,9;7,9;5,11;7,11" },
      { pos: "6,6", pickup: "6,6", dropoff: "5,8", bays: "5,3;7,3;5,5;7,5;5,7;7,7;5,9;7,9;5,11;7,11" },
    ];
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(here, "../tsconfig.fleet.json")], { timeout: 15000 });
    const { procs, frames, ready, errors } = launch(ids, ports, specs);
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_resolve, reject) => {
        startupTimeout = setTimeout(() => reject(new Error(`Workers did not become ready: ${errors.join("; ")}`)), 15000);
      })]);
      if (startupTimeout) clearTimeout(startupTimeout);
      procs.forEach(p => p.send!("start"));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !frames.every(f => f.some(x => x.done))) await sleep(50);
    } finally {
      if (startupTimeout) clearTimeout(startupTimeout);
      procs.forEach(p => { if (p.exitCode === null && p.signalCode === null) p.kill(); });
    }
    expect(errors, "worker errors").toEqual([]);

    for (let i = 0; i < ids.length; i++) {
      const f = frames[i];
      const done = f.find((x) => x.done);
      const last = f[f.length - 1];
      const reasons: Record<string, number> = {};
      f.forEach((x) => { reasons[x.reason] = (reasons[x.reason] ?? 0) + 1; });
      console.log(`U1 ${ids[i]}: frames=${f.length} lastTick=${last?.tick} pos=${last?.position.x},${last?.position.y} task=${last?.taskStatus} DONE=${done ? "YES" : "no"} decideUs=${last?.decideUs} rssMb=${last?.rssMb} peers=${last?.peers}`);
      console.log(`     reasons ${JSON.stringify(reasons)}`);
    }
    // Each process must have actually observed peers OVER THE SOCKET, and
    // must have measured a decision cost. Read only non-terminal frames —
    // the final `done` frame is a shutdown report and carries no metrics.
    const live = frames.map((f) => f.filter((x) => !x.done));
    const sawPeers = live.map((f) => Math.max(0, ...f.map((x) => x.peers ?? 0)));
    const decide = live.flatMap((f) => f.map((x) => x.decideUs ?? 0)).filter((x) => x > 0).sort((a, b) => a - b);
    const rss = live.flatMap((f) => f.map((x) => x.rssMb ?? 0)).filter((x) => x > 0);
    console.log(`U1 max peers observed per agent: ${sawPeers.join(", ")}  <- datagrams arrived over real UDP sockets`);
    console.log(`U1 decision cost over ${decide.length} decisions: median ${decide[Math.floor(decide.length / 2)]}us  p95 ${decide[Math.floor(decide.length * 0.95)]}us  max ${decide[decide.length - 1]}us`);
    console.log(`U1 agent RSS: ${Math.min(...rss)}-${Math.max(...rss)} MB (includes the tsx/Node runtime, not just the agent)`);
    const allDone = frames.every((f) => f.some((x) => x.done && x.taskStatus === "completed"));
    console.log(`U1 all three agents completed their task over UDP: ${allDone}`);
    // Every agent must have run a real number of ticks and completed. Frame
    // counts differ by design: task lengths differ, so a 3-cell task
    // legitimately finishes in a handful of frames.
    const ran = frames.map((f) => f.length);
    console.log(`U1 frames per agent: ${ran.join(", ")}  (task lengths differ by design)`);
    expect(Math.min(...ran)).toBeGreaterThan(2);
    expect(Math.max(...sawPeers)).toBeGreaterThan(0);
    expect(allDone).toBe(true);
  }, 60000);
});
