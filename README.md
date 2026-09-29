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
