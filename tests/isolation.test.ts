import { describe, it, expect } from "vitest";
import { InMemoryBus, InMemoryTransport } from "../src/core/distributed/transport";
import type { TickMessage } from "../src/core/distributed/protocol";

function msg(from: string, x: number): TickMessage {
  return { kind: "tick", from, seq: 0, position: { x, y: 0 }, intent: null, priority: 0, docked: false };
}

describe("ISOLATION: a transport must deliver to the RECIPIENT", () => {
  it("A's broadcast reaches B, not A", () => {
    const bus = new InMemoryBus();
    const a = new InMemoryTransport("A", bus);
    const b = new InMemoryTransport("B", bus);
    a.addPeer("B");
    b.addPeer("A");

    a.send(undefined, msg("A", 5));

    const gotA = a.drain();
    const gotB = b.drain();
    console.log(`A received ${gotA.length} (expect 0), B received ${gotB.length} (expect 1)`);
    expect(gotA.length).toBe(0);
    expect(gotB.length).toBe(1);
    expect(gotB[0].from).toBe("A");
  });

  it("with latency the message still arrives, one tick late", () => {
    const bus = new InMemoryBus();
    const a = new InMemoryTransport("A", bus);
    const b = new InMemoryTransport("B", bus);
    a.addPeer("B");
    a.setLatency(1);
    a.send(undefined, msg("A", 5));
    expect(b.drain().length).toBe(0);
    a.advanceClock();
    expect(b.drain().length).toBe(1);
    console.log("latency=1: delivered on the next tick, to the recipient");
  });

  it("a severed link drops the message", () => {
    const bus = new InMemoryBus();
    const a = new InMemoryTransport("A", bus);
    const b = new InMemoryTransport("B", bus);
    a.addPeer("B");
    a.setReachable("B", false);
    a.send(undefined, msg("A", 5));
    console.log(`severed: B received ${b.drain().length} (expect 0)`);
    expect(b.drain().length).toBe(0);
  });
});
