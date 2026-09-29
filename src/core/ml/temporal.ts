// Causal, per-agent history. The original nine-feature schema is a prefix,
// unchanged. No labels, global clock feature, task outcomes, or peer routes.
import { extractFeatures, FEATURE_NAMES, type FeatureContext } from "./features";
import { manhattanDistance, positionsEqual } from "../map/graph";
import type { Position } from "../types";

export const TEMPORAL_FEATURE_NAMES = [
  ...FEATURE_NAMES,
  ...FEATURE_NAMES.map((name) => `lag1_${name}`),
  ...FEATURE_NAMES.map((name) => `lag2_${name}`),
  "hasLag1", "hasLag2", "movedLastTick", "waitStreakNorm",
  "opposingIntentFraction", "followingIntentFraction", "nearestOpposingPeer",
  "stationaryPeerFraction", "approachingPeerFraction", "reciprocalIntent",
] as const;

type Snapshot = { tick: number; position: Position; base: number[];
  peers: Map<string, Position>; wait: number; previousBase?: number[] };
export class LocalHistory {
  private states = new Map<string, Snapshot>();
  reset() { this.states.clear(); }
  observe(ctx: FeatureContext): number[] {
    const { local, peers, currentTick } = ctx;
    const previous = this.states.get(local.id);
    if (previous && currentTick <= previous.tick) throw new Error("observations must advance per-agent time");
    const last = previous?.tick === currentTick - 1 ? previous : undefined;
    const base = extractFeatures(ctx).map(Number);
    const moved = last ? !positionsEqual(last.position, local.position) : false;
    const wait = last && !moved ? Math.min(5, last.wait + 1) : 0;
    const preferred = local.path[1];
    const direction = preferred ? { x: preferred.x - local.position.x, y: preferred.y - local.position.y } : { x: 0, y: 0 };
    let opposing = 0, following = 0, nearest = 0, stationary = 0, approaching = 0, reciprocal = 0;
    for (const peer of peers) {
      if (peer.intent && preferred) {
        const px = peer.intent.x - peer.position.x, py = peer.intent.y - peer.position.y;
        const dot = direction.x * px + direction.y * py;
        // Only peers ahead along my route axis are approaching head-on.
        const ahead = (peer.position.x - local.position.x) * direction.x + (peer.position.y - local.position.y) * direction.y > 0;
        const aligned = direction.x !== 0 ? peer.position.y === local.position.y : peer.position.x === local.position.x;
        if (dot < 0 && ahead && aligned) {
          opposing++;
          nearest = Math.max(nearest, 1 / Math.max(1, manhattanDistance(local.position, peer.position)));
        }
        if (dot > 0) following++;
        if (positionsEqual(peer.intent, local.position) && positionsEqual(preferred, peer.position)) reciprocal = 1;
      }
      const old = last?.peers.get(peer.id);
      if (old) {
        if (positionsEqual(old, peer.position)) stationary++;
        if (manhattanDistance(local.position, peer.position) < manhattanDistance(last!.position, old)) approaching++;
      }
    }
    const count = Math.max(1, peers.length);
    const empty = Array(FEATURE_NAMES.length).fill(0);
    const vector = [...base, ...(last?.base ?? empty), ...(last?.previousBase ?? empty),
      Number(Boolean(last)), Number(Boolean(last?.previousBase)), Number(moved), wait / 5,
      opposing / count, following / count, nearest, stationary / count, approaching / count, reciprocal];
    this.states.set(local.id, { tick: currentTick, position: { ...local.position }, base,
      peers: new Map(peers.map((p) => [p.id, { ...p.position }])), wait, previousBase: last?.base });
    return vector;
  }
}
