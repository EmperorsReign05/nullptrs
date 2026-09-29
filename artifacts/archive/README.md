# Historical experiment commands

`tune-stall-history.sh` is retained verbatim as provenance. Its environment switches were removed by the accepted distributed-safety cleanup, so it is not a live tuning command. Use `artifacts/ab.ts` for the frozen-ORIG/current comparison. Do not infer new measurements from obsolete switches.

The other scripts and frozen source reconstructions under `artifacts/` remain research provenance, not application modules. They are excluded from the application TypeScript build. Production source and tests are still type-checked; model JSON imported by the runtime remains included.
