# Event-triggered allocator: stopped after phase 2

Base: PR #28 at `6ad2458d6e32ee57e0267482fa6740124f7f04b2`.

This is a failed development experiment retained for review. The optional mode is `event-single`; the default is `epoch`. Grouped allocation and per-task logical rounds were not implemented because phase 2 reduced completion reliability, triggering the requested stop condition. No acceptance G/H result or SIH success level is claimed.

## Algorithms and safety

Epoch protocol trace (PR #28, 6ad2458):
1. Runtime task command validates immutable task fields, installs the task in world state and announces it to one live peer. Other peers learn it solely through transport announcements.
2. Each peer sorts known pending tasks by priority descending, creation tick ascending, ID ascending. It admits max(1,floor(N/2)) tasks without a previous owner. Existing leases renew outside that frontier.
3. At phase 3 of each 32-tick generation each peer computes and broadcasts its local bid once. Receivers only accept bids sent inside the generation's 4-tick bid window.
4. At phase >=4, the lexicographically first live bidder proposes once per increase in bid-set size, after collecting majority-sized bid knowledge.
5. Each recipient independently recomputes the winner from the transmitted distinct-member bids. Renewal favors a previous live owner. A custody marker forbids a different owner. Each peer casts at most one ownership vote per task/generation.
6. Matching majority grants form a certificate immediately. Every certificate expires at the next epoch boundary; execution rechecks expiry. Runtime mirrors the holder certificate into task ownership in the same step.
7. Pickup requires a quorum custody checkpoint; completion also uses a checkpoint. Minority lease expiry fences execution. Custody prevents reassignment of physical cargo after a loaded crash.

Phase 2 event-only ablation:
Retain the entire epoch lease/vote/custody structure and frontier. Broadcast the local bid upon first eligibility in a generation, instead of waiting for phase 3. Accept such bids throughout that generation. Allow proposal once enough bids exist, without a phase-4 check. Emit at most one local bid per task/generation. Proposals remain bounded by bid-set growth. This is event-single, not grouped allocation or a logical-round redesign.

Safety argument:
The majority intersection argument is unchanged: within each task/generation, every grantor retains its single vote, certificates require >N/2 distinct matching grantors, and expiry remains the same common tick boundary. Earlier bids/proposals cannot permit two conflicting certificates. The custody/checkpoint code is unchanged. Bundle capacity is not yet solved; advancing to grouping requires new joint feasibility checks.

## Frozen acceptance profile (D only)

All 1,980 epoch D rows exactly reproduce the recorded PR #28 evidence after removing added instrumentation fields. Frozen acceptance scenarios, baseline, metric, motion, A*, bid model, endpoints, release times and horizon remain unchanged.

For recoverable tasks with a first assignment (including tasks in incomplete runs):

| First stage after release | Mean ticks |
| --- | ---: |
| Announcement | 1.00 |
| Auction eligibility | 62.48 |
| First bid / quorum bid | 80.30 |
| Proposal / first grant / certificate | 81.30 |
| Runtime assignment | 81.71 |

These are first observations aggregated across peers in runtime tick coordinates. Their differences describe the first-stage path; they do not separately isolate time spent in failed rounds. The 81.71 population differs from the originally quoted ~82.2; no frozen result was changed. The completed-task mean in these exact rows is 81.70.

## Development phase 2 result

All 1,980 scenarios from the existing disjoint frozen development suite were evaluated with D's bid model and unchanged motion, under epoch and event-single modes. Speed statistics use only mutually complete scenario pairs. No timeout receives an invented completion time.

| Recoverable slice | Epoch ownership | Event ownership | D→event paired TCT reduction | Epoch completion | Event completion |
| --- | ---: | ---: | ---: | ---: | ---: |
| All N | 81.73 | 17.87 | 53.59% | 96.33% | 96.22% |
| N=3 | 148.31 | 43.05 | 55.75% | 98.33% | 97.67% |
| N=5 | 68.39 | 7.77 | 54.42% | 98.33% | 95.67% |
| N=8 | 28.50 | 2.79 | 46.93% | 92.33% | 95.33% |

Recoverable paired makespan reduction: 39.50%. Across all regimes, completion falls from 97.32% to 95.91% (72 previously complete runs lost, 44 gained). All recorded runtime safety counters are zero.

## Stop decision and failed experiments

Phase 2 substantially reduces ownership latency and paired TCT, but reduces overall reliability and N=5 recoverable completion. The required stop condition applies. No grouped allocator, queued-duration cost change, fast logical-round certification, guidance experiment, G/H acceptance evaluation, D→H comparison, A→H comparison, or acceptance bootstrap success claim follows this failure.

Unfinished tasks in lost runs include tasks that were assigned and sometimes already picked up. Earlier admission therefore does not by itself ensure completion. The 72 lost runs average 1,681.75 energy-hold robot ticks under event mode versus 0.17 under epoch mode, and peak in-flight task counts average 6.46 versus 4.89. This identifies a strong energy-hold association, not a proven cause of the regression. No acceptance seed was used to tune treatment parameters.

## Evidence and reproduction

- `artifacts/event-grouped/phase1/D.json.gz`: all frozen acceptance D rows with first-stage instrumentation.
- `artifacts/event-grouped/phase1/epoch-reproduction.json`: exact comparison against historical D rows.
- `artifacts/event-grouped/phase2/development.json.gz`: all development epoch/event pairs, including failures.
- `artifacts/event-grouped/phase2/summary.json`: paired TCT/makespan, reliability and safety by fleet size and regime.
- `artifacts/event-grouped/phase1/throughput.json` and `phase2/throughput.json`: traffic, concurrency, stale messages, observed rounds and first-stage timing.
- `artifacts/event-grouped/provenance.json`: base commit and frozen-suite hashes.

Run `node_modules/.bin/vite-node scripts/profile-ownership-stages.ts`, then `node_modules/.bin/vite-node scripts/event-single-development.ts`, then `python3 scripts/summarise-event-experiment.py`. Scripts write only into the new event-grouped artifact directory. Required frozen development and historical per-scenario files must be restored from PR #28 evidence; they are not regenerated.

## Limitations

This mode retains global epoch retries and renewal fencing. It is not the requested final grouped allocator. No bundle feasibility claim is made. Existing hostile tests exercise per-task ownership safety, not every proposed new group/capacity/energy adversary. The telemetry records first-stage times and counts task generations; renewals are included, uncertified observed generations are not automatically quorum failures, and retry durations and per-round certification quantiles are not fully instrumented. Traffic counts are ownership send calls including heartbeat/checkpoint gossip, not bytes or combined motion traffic.

Earlier bids can use state that changes before later grants. Single-owner quorum safety does not prove joint robot queue/energy feasibility across multiple tasks. The phase-2 reliability failure prevents promoting this mode or proceeding to grouped certification.

## Regression evidence

- Final `npm test`: 583 passed, 20 skipped (69 passed test files, 3 skipped).
- TypeScript `tsc --noEmit`: passed.
- Fleet build: passed.
- Production build with webpack: passed. Turbopack rejects the isolated checkout's symlink to dependencies; no application source workaround was introduced.
- ROS2 tests: passed, including real Fast DDS exchange. Podman and UDP/process tests require execution outside the filesystem sandbox.
- Hostile ownership suite: 63 cases for each mode, 126 total. Each simulated tick checks executable owners per task <=1.
- Fault script under event-single: 30 scenarios, all safe.
- Software N=1/3/5/8 and Nav2 N=3/5/8: all seven existing gates passed.
- Fleet gate details and logs: `artifacts/event-grouped/regression/fleet-gates.json` and adjacent logs. These run the production default epoch allocator; they do not establish event-single behavior over DDS or Nav2.

Historical artifacts remain unchanged. New evidence lives under `artifacts/event-grouped`.

## Message complexity

Development recoverable ownership broadcasts per peer per tick rise from 4.314 to 5.540 (+28.4%). At N=3: 3.563→5.167; N=5: 4.692→5.552; N=8: 4.492→5.688. Each broadcast fans out to up to N−1 recipients. These counts include the unchanged heartbeat, task gossip and checkpoint traffic, and exclude motion traffic. They measure simulator sends, not DDS backlog or bytes. Across the 900 recoverable development runs, total ownership sends fall from 6,271,634 to 5,667,832 (−9.6%) because treatment runs are shorter; the higher instantaneous rate remains a separate transport concern.

Certified task generations per 100 ticks rise from 7.210 to 12.554, including renewals. Mean concurrently uncertified candidate tasks falls from 0.745 to 0.139. This is not a grouped auction: every proposal remains a single task with bundle size 1.

The observed first-stage and traffic reports include every fleet size and all three overlap regimes. First-certification latency quantiles are eligibility→first certificate, not per-round latency. Renewal counts cannot be interpreted as fresh-task throughput or retries per task.
