/** Local process adapter only. Peer delivery is performed by the ROS2 sidecar
 * over Fast DDS; stdin/stdout never connect different robot controllers.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Transport } from "./transport";

type Channel = "motion" | "ownership";
export type RosBridgeOptions = { id: string; members: string[]; session: string; command: string[]; readyTimeoutMs?: number };
export class RosBridge {
  private child: ChildProcessWithoutNullStreams;
  private inbox: Record<Channel, unknown[]> = { motion: [], ownership: [] };
  private failure: Error | undefined;
  private closing = false;
  private blocked = new Set<string>();
  readonly discovery = { motion: 0, ownership: 0 };
  readonly stats = { motion: { sent: 0, received: 0, dropped: 0 }, ownership: { sent: 0, received: 0, dropped: 0 } };
  private constructor(private options: RosBridgeOptions, onReady: () => void, onFailure: (error: Error) => void) {
    const [command, ...args] = options.command;
    if (!command) throw new Error("ROS bridge command cannot be empty");
    this.child = spawn(command, [...args, "--id", options.id, "--members", options.members.join(","), "--session", options.session],
      { stdio: ["pipe", "pipe", "pipe"] });
    const fail = (error: Error) => {
      if (this.closing) return;
      this.failure = error; this.inbox.motion = []; this.inbox.ownership = []; onFailure(error);
    };
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.on("exit", (code, signal) => fail(new Error(`ROS bridge exited (${code ?? signal})`)));
    this.child.stderr.on("data", chunk => process.stderr.write(`[ROS ${options.id}] ${chunk}`));
    createInterface({ input: this.child.stdout }).on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { fail(new Error("Invalid ROS bridge output")); return; }
      if (event.event === "ready") {
        if (event.id !== options.id || event.rmw !== "rmw_fastrtps_cpp") fail(new Error("Unexpected ROS identity or middleware"));
        else onReady();
      } else if (event.event === "message" && (event.channel === "motion" || event.channel === "ownership")) {
        const channel = event.channel as Channel, message = event.message;
        if (!message || typeof message.from !== "string" || message.from === options.id || !options.members.includes(message.from) || this.blocked.has(message.from)) {
          this.stats[channel].dropped++; return;
        }
        this.stats[channel].received++; this.inbox[channel].push(message);
      } else if (event.event === "stats" && event.subscriptions) {
        this.discovery.motion = Number(event.subscriptions.motion) || 0;
        this.discovery.ownership = Number(event.subscriptions.ownership) || 0;
      } else if (event.event === "error") fail(new Error(`ROS bridge: ${event.error ?? event.message}`));
    });
  }
  static async start(options: RosBridgeOptions): Promise<RosBridge> {
    let bridge: RosBridge | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ROS bridge readiness timed out")), options.readyTimeoutMs ?? 15000);
        bridge = new RosBridge(options, resolve, reject);
      });
      return bridge!;
    } catch (error) { bridge?.close(); throw error; }
    finally { if (timer) clearTimeout(timer); }
  }
  private write(value: unknown) {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("ROS bridge is closed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  refreshDiscovery() { this.write({ op: "stats" }); }
  setReachable(peer: string, reachable: boolean) {
    if (!this.options.members.includes(peer)) throw new Error("Unknown ROS peer");
    if (reachable) this.blocked.delete(peer); else this.blocked.add(peer);
    this.write({ op: "link", peer, reachable });
  }
  channel<T>(channel: Channel): Transport<T> & { stats: RosBridge["stats"][Channel]; setReachable: (peer: string, reachable: boolean) => void } {
    return {
      kind: "ros2-fast-dds", stats: this.stats[channel],
      setReachable: (peer, reachable) => this.setReachable(peer, reachable),
      send: (to, message) => {
        if (to && this.blocked.has(to)) { this.stats[channel].dropped++; return; }
        this.write({ op: "send", channel, ...(to ? { to } : {}), message }); this.stats[channel].sent++;
      },
      drain: () => {
        if (this.failure) throw this.failure; // No motion after losing its peer transport.
        if (this.closing) throw new Error("ROS bridge is closed");
        const messages = this.inbox[channel]; this.inbox[channel] = []; return messages as T[];
      },
      close: () => this.close(),
    };
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    this.inbox.motion = []; this.inbox.ownership = [];
    this.child.stdin.end(); this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 2000);
    timer.unref(); this.child.once("exit", () => clearTimeout(timer));
  }
}
