// Deadlock-risk prediction: feature extraction.
//
// Every feature here is already available to an agent from its own state
// and the peer messages it has received. Nothing requires a global view,
// a simulator, or privileged information — a feature that needs any of
// those would be cheating in a system whose whole claim is that no agent
// has a global view.
//
// The feature set is deliberately small and hand-picked rather than
// learned or exhaustive. On a 158-cell map with a handful of seeds, a
// high-dimensional feature vector will fit the training seeds and
// generalise to nothing.

import { manhattanDistance, positionsEqual, getNeighbors } from "../map/graph";
import { isTraversable } from "../map/warehouse";
import type { LocalState, PeerId, PeerView } from "../distributed/protocol";
import type { Position, WarehouseMap } from "../types";

/**
 * Feature names, in the exact order `extractFeatures` emits them. Kept as a
 * single exported constant so the training code, the model file, and the
 * reporting code cannot drift out of sync — a silent ordering mismatch
 * between train and inference is the classic way a model looks trained and
 * behaves like noise.
 */
export const FEATURE_NAMES = [
  "intentOccupied", // my next cell is held or claimed by a peer
  "peersInRange", // how many peers I can hear
  "blockedPeers", // peers whose intent is the cell I am standing on
  "contentionRatio", // fraction of my remaining route that peers want
  "bayAvailability", // free bays adjacent to me, normalised
  "pathLengthNorm", // how much route is left
  "stepAsideCooldown", // 1 if I stepped aside recently
  "neighbourPressure", // fraction of my neighbours currently occupied
  "intentConflict", // 1 if a peer wants the cell I want
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;

/** How many recent ticks count as "recently" for the cooldown feature. */
export const RECENT_TICKS = 3;

export type FeatureContext = {
  local: LocalState;
  peers: PeerView[];
  map: WarehouseMap;
  bays: ReadonlySet<string>;
  /** Tick at which this agent last stepped aside, or -1. */
  lastStepAsideTick: number;
  currentTick: number;
};

function posKey(p: Position): string {
  return `${p.x},${p.y}`;
}

/** Returns a vector of exactly FEATURE_COUNT numbers, in FEATURE_NAMES order. */
export function extractFeatures(ctx: FeatureContext): number[] {
  const { local, peers, map, bays, lastStepAsideTick, currentTick } = ctx;
  const from = local.position;
  const preferred = local.path.length > 1 ? local.path[1] : null;

  // 1. intentOccupied — is the cell I want held or claimed right now?
  const intentOccupied = preferred
    ? peers.some(
        (p) =>
          positionsEqual(p.position, preferred) ||
          (p.intent !== null && positionsEqual(p.intent, preferred))
      )
    : 0;

  // 2. peersInRange — raw count, clamped; beyond a handful it stops being
  //    informative and starts being a fleet-size proxy.
  const peersInRange = Math.min(peers.length, 6) / 6;

  // 3. blockedPeers — peers that want the cell I am sitting on. This is the
  //    signature of a head-on and the single strongest deadlock precursor.
  const blockedPeers = Math.min(
    peers.filter((p) => p.intent !== null && positionsEqual(p.intent, from)).length,
    4
  ) / 4;

  // 4. contentionRatio — of the cells I still have to traverse, what share
  //    do peers currently want? High means my route runs through a crowd.
  const remaining = local.path.slice(1);
  let contentionRatio = 0;
  if (remaining.length > 0) {
    let contested = 0;
    for (const cell of remaining) {
      if (peers.some((p) => (p.intent !== null && positionsEqual(p.intent, cell)) || positionsEqual(p.position, cell))) {
        contested++;
      }
    }
    contentionRatio = contested / remaining.length;
  }

  // 5. bayAvailability — can I actually step aside? Free bays over total
  //    adjacent bays. Zero here is a strong deadlock signal, because it
  //    means the escape hatch is occupied or absent.
  let adjacentBays = 0;
  let freeBays = 0;
  if (bays.size > 0) {
    for (const n of getNeighbors(from, map)) {
      if (!bays.has(posKey(n))) continue;
      adjacentBays++;
      const taken =
        peers.some((p) => positionsEqual(p.position, n) || (p.intent !== null && positionsEqual(p.intent, n))) ||
        !isTraversable(n, map);
      if (!taken) freeBays++;
    }
  }
  const bayAvailability = adjacentBays > 0 ? freeBays / adjacentBays : 0;

  // 6. pathLengthNorm — longer remaining route means more chances to meet
  //    someone, but it saturates, so it is log-compressed.
  const pathLengthNorm = remaining.length === 0 ? 0 : Math.min(1, Math.log1p(remaining.length) / Math.log(21));

  // 7. stepAsideCooldown — am I inside the hysteresis window? If so I
  //    cannot step aside, which is exactly when I am most likely to be
  //    stuck. This is the feature that encodes the livelock mechanism.
  const stepAsideCooldown = lastStepAsideTick >= 0 && currentTick - lastStepAsideTick < RECENT_TICKS ? 1 : 0;

  // 8. neighbourPressure — how boxed in am I right now.
  const neighbours = getNeighbors(from, map);
  let occupiedNeighbours = 0;
  for (const n of neighbours) if (peers.some((p) => positionsEqual(p.position, n))) occupiedNeighbours++;
  const neighbourPressure = neighbours.length > 0 ? occupiedNeighbours / neighbours.length : 0;

  // 9. intentConflict — is a peer claiming the exact cell I want this tick.
  //    Distinct from intentOccupied: that also counts physical occupation.
  const intentConflict = preferred && peers.some((p) => p.intent !== null && positionsEqual(p.intent, preferred)) ? 1 : 0;

  return [
    Number(intentOccupied),
    peersInRange,
    blockedPeers,
    contentionRatio,
    bayAvailability,
    pathLengthNorm,
    stepAsideCooldown,
    neighbourPressure,
    intentConflict,
  ];
}

/**
 * The label. A tick is POSITIVE when the fleet is at risk of deadlock, which
 * we define operationally and without peeking at the future: an agent that
 * is blocked by a peer AND has no free bay to escape into. That is precisely
 * the state from which no legal move exists, so it is the state we want the
 * model to learn to recognise.
 */
export function labelIsAtRisk(ctx: FeatureContext): number {
  const f = extractFeatures(ctx);
  const intentOccupied = f[0];
  const bayAvailability = f[4];
  const blockedPeers = f[2];
  return intentOccupied > 0 && bayAvailability === 0 && blockedPeers > 0 ? 1 : 0;
}
