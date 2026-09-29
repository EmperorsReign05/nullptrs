// Peer-to-peer wire protocol.
//
// No central coordinator, no shared world state, no arbiter. Each agent
// broadcasts a small fixed-size message about ITSELF once per tick and
// decides its own next move from its own plan plus whatever peer messages
// have arrived. Nothing in this file references a global fleet.
//
// The message deliberately carries only what a neighbour needs to avoid
// colliding with us: where we are, where we are trying to go, and how
// strongly we want to go there. A robot's full route and battery are NOT
// broadcast, because a local exchange radius is the whole point — an agent
// physically cannot reason about a robot it cannot hear.

export type PeerId = string;

/** Broadcast once per tick by every live agent. */
export type TickMessage = {
  kind: "tick";
  from: PeerId;
  /** Monotonic per-agent tick counter. Used to detect staleness. */
  seq: number;
  position: { x: number; y: number };
  /** The single cell we intend to occupy next tick, or null if idle. */
  intent: { x: number; y: number } | null;
  /** Desired route step, distinct from a held/alternate move proposal. */
  preferred?: { x: number; y: number } | null;
  /** Higher wins a contested cell. Derived from how long we have waited. */
  priority: number;
  /** True while we are parked on a charging dock and must not be pushed. */
  docked: boolean;
  /** Diagnostic consecutive holds. Never permission to enter an occupied
   * cell; the previously proposed stalled-peer exception was rejected. */
  stallTicks: number;
};

/** Sent when an agent is shutting down, so peers stop counting it. */
export type DepartMessage = {
  kind: "depart";
  from: PeerId;
  seq: number;
};

export type Message = TickMessage | DepartMessage;

/**
 * Communication radius, in cells. A robot only reasons about peers within
 * this radius. This is the knob that makes the system decentralised rather
 * than merely distributed, and it is also what bounds per-tick work: an
 * agent's decision cost is O(neighbours), not O(fleet).
 *
 * Must be large enough that a robot can see every peer that could possibly
 * contend for its next cell. Manhattan radius 2 is the safe minimum for
 * 4-connected movement: a peer that could take my next cell is at distance
 * <= 1 from it, hence <= 2 from me.
 */
export const DEFAULT_COMM_RANGE = 2;

export function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Everything an agent believes about a peer. Intentionally partial. */
export type PeerView = {
  id: PeerId;
  position: { x: number; y: number };
  intent: { x: number; y: number } | null;
  /** Desired route step, distinct from a held/alternate move proposal. */
  preferred?: { x: number; y: number } | null;
  priority: number;
  docked: boolean;
  seq: number;
  /** Peer-reported consecutive stall count. 0 when unknown. */
  stallTicks: number;
  /** Wall-clock tick at which this view was last refreshed. */
  lastSeenTick: number;
};

/** What the agent itself owns. Never shared. */
export type LocalState = {
  id: PeerId;
  position: { x: number; y: number };
  /** Full remaining route, including the current cell at index 0. */
  path: { x: number; y: number }[];
  priority: number;
  docked: boolean;
  seq: number;
};

/** Conflict resolution for a cell multiple agents want. */
export type Claim = {
  cellKey: string;
  claimantId: PeerId;
  priority: number;
};
