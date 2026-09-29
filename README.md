# Team Rocket — AMR fleet simulation

A TypeScript warehouse simulator and Next.js dashboard for SIH26123. This first review layer contains congestion-aware A*, PIBT movement conflict resolution, deterministic task auctions, payload checks, task queues and simulated charging.

## Run

```sh
npm ci
npm run dev
```

Open http://localhost:3000. The browser advances the central simulation. Distributed controllers and learned bidding arrive in subsequent review layers; this layer is not a decentralized deployment.

## Validate

```sh
npx tsc --noEmit
npm test
npm run build
```

The regression suite includes stress and experimental comparisons. The known 10/20-robot cycle assertions in compare.test.ts are retained and fail; no universal deadlock freedom, physical safety or ≥20% speedup is claimed.

## Distributed motion layer

Per-robot state and intent exchange, UDP transport, local sensing and obstruction memory are available under `src/core/distributed/`. `localCommit` confirms movement using each agent's received intents and simulated local contacts. The historical fleet-wide arbitration mode remains for comparison. This layer has preassigned tasks; peer task ownership and learned bidding arrive in subsequent layers.

```sh
npx vitest run tests/dist.test.ts tests/dist-safety.test.ts tests/dist-liveness.test.ts tests/local-commit.test.ts tests/udp.test.ts
```

## Guarded learned bidding

The dependency-free MLP is a bounded correction over deterministic bids. Queue pressure, peer-route contention and charging-route energy feasibility inform scoring. Hard exclusions and a winner-change guard remain authoritative; disabled or failed inference falls back to deterministic bidding. Frozen model files remain in Git. No retraining was done for this PR split.

Compact results remain under `artifacts/`. Original traces and historical reports are available in the [checksummed evidence archive](https://github.com/EmperorsReign05/nullptrs/releases/tag/audit-evidence-2026-09-29). Restore missing files before running opt-in historical diagnostics:

```sh
python3 scripts/fetch-benchmark-evidence.py
npx vitest run tests/bid-mlp.test.ts
```

The manifest identifies source commit 65431a3 and records each original file checksum. Model-only results must not be presented as integrated motion or hardware performance.
