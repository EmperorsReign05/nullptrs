Research follow-up: deadlock prediction and local decision making

Reviewed 2026-09-29. This is a research proposal, not a successful new model.
No datasets were downloaded and no runtime or distributed-stack files changed.

Finding from our code

The current sampler declares onset only after the entire fleet stops moving
and making task progress. A blocked subset can therefore exist while its samples
remain negative because a distant robot is still working. Our counterexample
captures that distinction. The failed result establishes a limit of this target
and representation, not a general impossibility of useful deadlock prediction.

Relevant primary sources

1. Chandy, Misra, Haas, Distributed Deadlock Detection (1983).
   https://www.cs.utexas.edu/~misra/scannedPdf.dir/DistrDeadlockDetection.pdf
   Detects dependency-based deadlocks without a process holding global state.
   It explicitly distinguishes a blocked subset from all processes waiting.
   Its communication assumptions include correct, FIFO, eventually delivered
   messages. These are not automatic guarantees for our UDP transport or for
   changing robot routes. It is a detection foundation, not a future predictor.

2. PRIMAL2, Pathfinding via Reinforcement and Imitation Multi-Agent Learning—Lifelong.
   https://arxiv.org/html/2010.08184v3
   Uses corridor endpoint/orientation/blocking information and coordination
   conventions. Its observations also contain nearby goals and predicted paths.
   Initialization restricts occupancy within narrow corridors. These conditions
   differ from our current one-intent peer messages and opposing-start fixtures.
   Useful lesson: represent corridor structure; do not import its scores or
   treat simulator-wide corridor occupancy as locally known.

3. Li, Gama, Ribeiro, Prorok, Graph Neural Networks for Decentralized Multi-Robot Path Planning.
   https://arxiv.org/html/1912.06095
   Combines local observation encoding with graph-based information exchange.
   Multi-hop information requires actual neighbor communication rounds. It is
   a planning/action model, not evidence of a particular deadlock forecasting F1.
   The architectural lesson is explicit relations and bounded information flow.

4. EVENFLOW D3.3 Final Use Case Evaluation (December 2025), sections 4.1 and 5.1.
   https://evenflow-project.eu/wp-content/uploads/2023/02/EVENFLOW_D3.3-Final-Use-Case-Evaluation_v1.0_2025-12-30.pdf
   Compares neural prefix classification, generated continuations plus a
   symbolic automaton, and probabilistic event forecasting. Its results show a
   substantial earliness/accuracy tradeoff. This is a project report, and its
   two-robot trajectory task differs from our three-tick fleet-freeze label.
   Some referenced implementation repositories are described as private.

5. A Decentralized Multi-Robot Dataset for Early Deadlock Forecasting in Smart Factory Navigation (January 2026).
   https://zenodo.org/records/18391070
   Public record describes 100 simulated executions of two Carter robots, with
   trajectory/event/camera data. It is relevant to methodology, but is not a
   nine-feature grid-planning dataset. No files were downloaded.

6. Wang, He, Pajic, Neuro-Symbolic Deadlock Resolution in Multi-Robot Systems (L4DC 2025).
   https://proceedings.mlr.press/v283/wang25f.html
   Learns relational rules for resolving deadlocks after they occur. This is a
   possible later recovery-policy direction, not a forecaster meeting our bar.
   The abstract's guarantees must not be transferred to our discrete grid system.

7. Skrynnik et al., Learn to Follow (AAAI 2024), author implementation.
   https://github.com/Cognitive-AI-Systems/learn-to-follow
   Combines planning and a learned local conflict-resolution policy; includes
   a smaller FollowerLite implementation. This is an action-policy alternative
   with different training cost and evaluation, not a drop-in classifier.

Recommended next experiment — inference from the sources and our failures

A. Name it explicitly: agent-involvement-in-blocking-component forecast.
   Keep a three-tick future horizon. Label the first persistent blocking event
   involving the observed agent, not the moment an unrelated remote task ends.
   Specify persistence, alternative routes, and parked-goal blockage before
   generating data. Exclude already-affected samples and validate negatives on
   waits that actually clear. Preserve all previous reports as different targets.

B. Represent a dependency graph: which peer holds my requested cell; who waits
   for whom; corridor direction and escape availability. Preserve robot identity
   through a short history. Distinguish physical occupation from competing
   claims: the latter is not automatically a circular wait. Graph cycles alone
   do not prove persistent robot deadlock when replanning/escape is possible.

C. Start with a symbolic graph/short-rollout predictor as a strong baseline.
   Then compare a small relational temporal model (e.g. GRU over pair histories,
   or a bounded GNN) that predicts dependency transitions. Apply a separately
   tested symbolic predicate to the predicted graph/sequence. This is a proposed
   adaptation, not an implementation or proven result from any one paper.

D. Use existing one-hop observations first. If missing information remains the
   limiting factor, compare an explicitly separate message-budget experiment
   with corridor claims, short intents, or bounded dependency forwarding.
   Count actual bytes/hops/delay and test stale/lost messages. No omniscient
   graph assembled from the simulator may be an inference input. Multi-hop
   exchange cannot reveal information across a disconnected component.

E. Compare representation-only and information-added variants separately so
   any gain is attributable. Keep the original rule and always-positive
   baselines, plus the new symbolic baseline. Freeze thresholds and evaluate
   fresh maps/seeds, per-regime precision/recall/F1, and safe-episode alarms.
   A future-label predictor must beat current-state detection and simple
   forward reasoning; merely recognizing an already-present cycle is not early
   prediction. No numerical success guarantee is justified by these sources.

This proposal requires an explicitly different prediction target; it must not
be reported as a repaired score on the old fleet-wide task. If the old target
is retained, additional information would have to make the relevant remote
progress observable. No architecture can recover genuinely absent information.
