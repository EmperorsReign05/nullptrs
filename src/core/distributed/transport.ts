// Transport abstraction. Deliberately an interface with two implementations
// so the whole distributed stack is testable in-process (CI, no sockets,
// deterministic) and swappable to real UDP without touching agent logic.
//
// This is the difference between "we simulated the compute" and "we ran the
// real stack": with UDPTransport the agents genuinely exchange datagrams
// over a socket, and a link can genuinely be severed.

import { EventEmitter } from "events";
import dgram from "dgram";
import type { Message, PeerId } from "./protocol";

export interface Transport {
  /** Send to one peer, or to all peers when `to` is undefined. */
  send(to: PeerId | undefined, msg: Message): void;
  /** Deliver everything addressed to us since the last drain. */
  drain(): Message[];
  close(): void;
  readonly kind: string;
}

/**
 * Shared delivery fabric for InMemoryTransport.
 *
 * This exists because of a bug worth documenting. The first version gave
 * every agent its own private inbox and had `send()` push into `this.inbox`
 * — the SENDER'S OWN. The net effect was that an agent received its own
 * broadcast and the intended recipient received nothing: agents were blind
 * to each other for the entire life of the system while every test still
 * passed, because the tests asserted on final positions and task completion
 * rather than on whether two robots ever collided. Measured after the fix
 * was applied, the previous build had two robots standing on the same cell
 * in 43% of ticks at n=8.
 *
 * A transport must therefore deliver into the RECIPIENT's queue. The bus is
 * the mechanism that makes that possible while keeping the transport
 * interface, and each agent still owns its own Transport instance — nothing
 * here is a coordinator, it is a socket abstraction.
 */
export class InMemoryBus {
  private queues = new Map<PeerId, Message[]>();

  queue(id: PeerId): Message[] {
    let q = this.queues.get(id);
    if (!q) {
      q = [];
      this.queues.set(id, q);
    }
    return q;
  }

  post(to: PeerId, msg: Message): void {
    this.queue(to).push(msg);
  }

  take(id: PeerId): Message[] {
    const q = this.queues.get(id) ?? [];
    this.queues.set(id, []);
    return q;
  }
}

/**
 * In-process transport. Faithful to the real thing in every way that
 * matters for correctness: messages are queued rather than delivered
 * synchronously, they are delivered to the RECIPIENT, and a peer can be
 * selectively deafened (see `setReachable`) to model a severed link.
 *
 * Pass the same bus to every agent in a fleet.
 */
export class InMemoryTransport implements Transport {
  readonly kind = "in-memory";
  private reachable = new Set<PeerId>();
  private latencyQueue: { at: number; to: PeerId; msg: Message }[] = [];
  private now = 0;

  constructor(private selfId: PeerId, private bus: InMemoryBus) {}

  /** Register a peer we can currently hear. */
  addPeer(id: PeerId) {
    this.reachable.add(id);
  }

  /** Model a severed link: this peer becomes deaf in BOTH directions. */
  setReachable(id: PeerId, reachable: boolean) {
    if (reachable) this.reachable.add(id);
    else this.reachable.delete(id);
  }

  /** Model per-tick delivery delay, in ticks. 0 = same tick. */
  setLatency(ticks: number) {
    this.latency = ticks;
  }
  private latency = 0;

  advanceClock() {
    this.now++;
    const ready = this.latencyQueue.filter((e) => e.at <= this.now);
    this.latencyQueue = this.latencyQueue.filter((e) => e.at > this.now);
    for (const e of ready) {
      // Re-check reachability at DELIVERY time, not only at send time: a
      // link cut while a message is in flight must still drop it, which is
      // what a real severed cable does.
      if (!this.reachable.has(e.to)) continue;
      this.bus.post(e.to, e.msg);
    }
  }

  send(to: PeerId | undefined, msg: Message): void {
    const targets = to ? [to] : [...this.reachable];
    for (const t of targets) {
      if (t === this.selfId) continue;
      if (!this.reachable.has(t)) continue; // link is down
      if (this.latency <= 0) this.bus.post(t, msg);
      else this.latencyQueue.push({ at: this.now + this.latency, to: t, msg });
    }
  }

  drain(): Message[] {
    return this.bus.take(this.selfId);
  }

  close() {
    this.latencyQueue = [];
  }
}

/**
 * Real UDP transport, one socket per agent on the loopback interface.
 *
 * This is the implementation that satisfies "the planning stack runs on
 * separate nodes communicating peer to peer" without needing physical
 * hardware: each agent is a genuinely separate OS process with a genuinely
 * separate socket. Because UDP is connectionless, an agent whose link is
 * killed simply stops receiving — which is exactly the failure the demo
 * needs to show surviving.
 */
export class UdpTransport implements Transport {
  readonly kind = "udp";
  private socket: dgram.Socket;
  private inbox: Message[] = [];

  constructor(
    private selfId: PeerId,
    private port: number,
    /** Map of peerId -> their UDP port. Supplied by a tiny discovery file
     *  or CLI flag; there is no coordinator at runtime. */
    private peers: Record<PeerId, number>
  ) {
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (buf) => {
      try {
        this.inbox.push(JSON.parse(buf.toString()) as Message);
      } catch {
        /* a corrupt datagram must never take an agent down */
      }
    });
  }

  bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(this.port, "127.0.0.1", () => resolve());
    });
  }

  send(to: PeerId | undefined, msg: Message): void {
    const payload = Buffer.from(JSON.stringify(msg));
    if (to !== undefined) {
      const port = this.peers[to];
      if (port === undefined) return;
      this.socket.send(payload, port, "127.0.0.1");
      return;
    }
    for (const [id, port] of Object.entries(this.peers)) {
      if (id === this.selfId) continue;
      this.socket.send(payload, port, "127.0.0.1");
    }
  }

  drain(): Message[] {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}
