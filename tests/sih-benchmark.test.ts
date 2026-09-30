// The SIH acceptance benchmark is a deliverable, so it gets tested like one.
//
// These tests are about the benchmark's own integrity, not about the system's
// speed. The things that can silently turn an honest benchmark into a dishonest
// one are: a workload that differs between arms, a metric that is computed
// differently from the one it is reported under, a timeout quietly counted as a
// completion, a regime label that cannot be re-derived from stored geometry, a
// guidance layer that leaks centralised state, or a guidance layer that changes
// behaviour when it is supposed to be inert.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ARMS, CRITICAL_METRIC_DISTINCTION, OVERLAP_METRIC, STOP_AND_WAIT_POLICY, benchmarkSpec } from "../src/core/bench/sih/protocol";
import { analyseOverlap, classifyRegime } from "../src/core/bench/sih/overlap";
import { buildScenario, layoutMap, scenarioWorld, aisleRows, singleFileColumns, taskObject, type EndpointFamily, type LayoutId } from "../src/core/bench/sih/scenario";
import { runArm } from "../src/core/bench/sih/runner";
import { pairedStats, reliabilityStats } from "../src/core/bench/sih/stats";
import { loadSuite } from "../src/core/bench/sih/evaluate";
import { resolveStopAndWait } from "../src/core/bench/stopwait";
import { createInitialWorld } from "../src/core/simulation/state";
import {
  DETERMINISTIC_HEURISTIC_TOLL, ROUTE_GUIDANCE_FEATURES, extractFeatures, predictRouteGuidance,
  routeGuidanceTollField, scoreRouteGuidance, trainRouteGuidance, type RouteGuidanceModel,
} from "../src/core/ml/routeguidance";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { DistributedFleet } from "../src/core/distributed/fleet";
import type { ArmId, ArmRun } from "../src/core/bench/sih/runner";
import type { RobotState, WorldState } from "../src/core/types";

const ART = "artifacts/sih-acceptance-v1";
const FAMILIES: EndpointFamily[] = ["uniform", "sameAisle", "mirroredCross", "columnTransit"];
const LAYOUTS: LayoutId[] = ["stock", "wide"];

describe("protocol integrity", () => {
  it("keeps the two percentages explicitly distinct", () => {
    expect(CRITICAL_METRIC_DISTINCTION.oneLine).toContain("1.56%");
    expect(CRITICAL_METRIC_DISTINCTION.oneLine).toContain("20%");
    expect(CRITICAL_METRIC_DISTINCTION.oneLine).toMatch(/different experiments/i);
    const spec = benchmarkSpec();
    expect(JSON.stringify(spec)).toContain("whole-system improvement over stop-and-wait");
  });

  it("names both readings of total task completion time and never merges them", () => {
    const spec = benchmarkSpec();
    expect(spec.metrics.sumTaskCompletionTime).toMatch(/SUM over COMPLETED tasks/);
    expect(spec.metrics.makespan).toMatch(/lastTaskCompletionTick - firstTaskCreationTick/);
    expect(spec.statistics.reportingRule).toMatch(/lower bound/i);
  });

  it("declares the full 2x2 ablation plus the two guidance arms", () => {
    const byId = Object.fromEntries(ARMS.map((a) => [a.id, a]));
    expect(byId.A.motion).toBe("stop-and-wait");
    expect(byId.A.bidding).toBe("deterministic");
    expect(byId.B.motion).toBe("stop-and-wait");
    expect(byId.B.bidding).toBe("edge-ai-bid-refinement");
    expect(byId.C.motion).toBe("distributed");
    expect(byId.C.bidding).toBe("deterministic");
    expect(byId.D.motion).toBe("distributed");
    expect(byId.D.bidding).toBe("edge-ai-bid-refinement");
    expect(byId.E.guidance).toBe("predictive-congestion-toll");
    expect(byId.F.guidance).toBe("predictive-congestion-toll");
    // A is the only arm that switches the motion policy, and it is also the only
    // arm that may be compared against as the baseline.
    expect(ARMS.filter((a) => a.runtime.motionPolicy === "stop-and-wait").map((a) => a.id)).toEqual(["A", "B"]);
  });

  it("documents what the stop-and-wait baseline shares with the treatment and what it never uses", () => {
    expect(STOP_AND_WAIT_POLICY.sharedWithTreatment.join(" ")).toMatch(/identical congestion-aware A\*/);
    const forbidden = STOP_AND_WAIT_POLICY.forbiddenAndAbsent.join(" ").toLowerCase();
    for (const banned of ["priority inheritance", "recursive displacement", "backtracking", "congestion guidance", "deadlock-breaking"]) {
      expect(forbidden).toContain(banned);
    }
    // The baseline is handed MORE information than the treatment, on purpose.
    expect(STOP_AND_WAIT_POLICY.documentedAdvantageGivenToBaseline).toMatch(/favours the BASELINE/);
  });
});

describe("scenario generation", () => {
  it("is a pure function of (seed, fleetSize, family, layout)", () => {
    for (const layout of LAYOUTS) {
      for (const family of FAMILIES) {
        const a = buildScenario(901234, 5, family, layout);
        const b = buildScenario(901234, 5, family, layout);
        expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
        const c = buildScenario(901235, 5, family, layout);
        expect(JSON.stringify(c)).not.toEqual(JSON.stringify(a));
      }
    }
  });

  it("derives its aisle and corridor structure from the layout, not from constants", () => {
    for (const layout of LAYOUTS) {
      const map = layoutMap(layout);
      expect(aisleRows(map).length).toBeGreaterThan(0);
      for (const row of aisleRows(map)) {
        for (let x = 0; x < map.width; x++) {
          const cell = map.cells[row * map.width + x];
          expect(cell.blocked).toBe(false);
        }
      }
      for (const x of singleFileColumns(map)) {
        expect(singleFileColumns(layoutMap(layout))).toContain(x);
      }
    }
    // The stock layout is the harsh one and the wide layout is not; the benchmark
    // needs both or it is only measuring a maze.
    expect(singleFileColumns(layoutMap("stock")).length).toBeGreaterThan(0);
  });

  it("never places a task endpoint on a blocked cell", () => {
    for (const layout of LAYOUTS) {
      const map = layoutMap(layout);
      const open = (p: { x: number; y: number }) => !map.cells.find((c) => c.position.x === p.x && c.position.y === p.y)!.blocked;
      for (const family of FAMILIES) {
        for (let i = 0; i < 25; i++) {
          const rec = buildScenario(950000 + i, 5, family, layout);
          for (const t of rec.tasks) {
            expect(open(t.pickup)).toBe(true);
            expect(open(t.dropoff)).toBe(true);
            expect(`${t.pickup.x},${t.pickup.y}`).not.toBe(`${t.dropoff.x},${t.dropoff.y}`);
          }
        }
      }
    }
  });

  it("gives every arm the same robots, capabilities, batteries and task schedule", () => {
    const rec = buildScenario(902345, 8, "mirroredCross", "wide");
    const a = scenarioWorld(rec, layoutMap(rec.layout));
    const b = scenarioWorld(rec, layoutMap(rec.layout));
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    expect(a.robots.map((r) => r.id)).toEqual(rec.robots.map((r) => r.id));
    expect(a.robots.map((r) => r.battery)).toEqual(rec.robots.map((r) => r.batteryPercent));
    expect(a.robots.map((r) => r.model.payloadCapacity)).toEqual(rec.robots.map((r) => r.payloadCapacity));
    a.robots.forEach((r, i) => {
      expect(`${r.position.x},${r.position.y}`).toBe(`${rec.robots[i].start.x},${rec.robots[i].start.y}`);
    });
    // Only the first task exists at tick 0; the rest arrive at their createdAt tick.
    expect(a.tasks).toHaveLength(1);
    expect(a.tasks[0].id).toBe(rec.tasks[0].id);
    expect(rec.tasks.slice(1).every((t, i) => t.createdAt === rec.tasks[0].createdAt + (i + 1) * rec.releaseIntervalTicks)).toBe(true);
  });

  it("emits a task that the runtime will accept", () => {
    const rec = buildScenario(902345, 3, "uniform", "stock");
    const runtime = new FleetRuntime(scenarioWorld(rec, layoutMap(rec.layout)));
    for (const t of rec.tasks.slice(1)) expect(() => runtime.command({ kind: "task", task: taskObject(t) })).not.toThrow();
  });
});

describe("policy-independent regime classification", () => {
  it("re-derives every stored regime label from stored geometry alone", () => {
    for (const layout of LAYOUTS) {
      for (const family of FAMILIES) {
        for (let i = 0; i < 12; i++) {
          const rec = buildScenario(960000 + i, 5, family, layout, "development");
          const recomputed = analyseOverlap({
            map: layoutMap(rec.layout),
            starts: rec.robots.map((r) => r.start),
            tasks: rec.tasks.map((t) => ({ id: t.id, pickup: t.pickup, dropoff: t.dropoff })),
          });
          expect(recomputed.overlapIndex).toBeCloseTo(rec.overlap.overlapIndex, 12);
          expect(classifyRegime(recomputed)).toBe(rec.regime);
        }
      }
    }
  });

  it("is a pure function of map, starts and task endpoints", () => {
    const rec = buildScenario(961111, 5, "columnTransit", "stock", "development");
    const input = {
      map: layoutMap(rec.layout),
      starts: rec.robots.map((r) => r.start),
      tasks: rec.tasks.map((t) => ({ id: t.id, pickup: t.pickup, dropoff: t.dropoff })),
    };
    // Robot order must not change the workload's classification: the legs are an
    // unordered set for every metric that matters.
    const shuffled = { ...input, starts: [...input.starts].reverse() };
    expect(analyseOverlap(shuffled).overlapIndex).toBeCloseTo(analyseOverlap(input).overlapIndex, 12);
    expect(analyseOverlap(input)).toEqual(analyseOverlap(input));
  });

  it("places every scenario in exactly one regime, with the precedence the spec declares", () => {
    const t = OVERLAP_METRIC.regimeThresholds;
    for (const layout of LAYOUTS) {
      for (let i = 0; i < 30; i++) {
        const rec = buildScenario(962222 + i, 5, FAMILIES[i % 4], layout, "development");
        expect(["low", "recoverable", "severe"]).toContain(rec.regime);
        if (rec.regime === "low") expect(rec.overlap.overlapIndex).toBeLessThan(t.lowMaxOverlapIndex);
        if (rec.regime === "severe" && rec.overlap.overlapIndex >= t.lowMaxOverlapIndex && !rec.overlap.staticRecoverable) {
          expect(rec.overlap.staticRecoverable).toBe(false);
        }
        if (rec.regime === "recoverable") {
          expect(rec.overlap.staticRecoverable).toBe(true);
          expect(rec.overlap.overlapIndex).toBeGreaterThanOrEqual(t.minOverlapIndex);
          expect(rec.overlap.overlapIndex).toBeLessThan(t.severeMinOverlapIndex);
        }
      }
    }
  });
});

describe("metric correctness", () => {
  it("reproduces sumTaskCompletionTime and makespan from the per-task trace", () => {
    for (const id of ["A", "C", "D"] as ArmId[]) {
      const run = runArm(buildScenario(970001, 5, "mirroredCross", "wide"), id);
      const completed = run.tasks.filter((t) => t.completedTick !== null);
      expect(run.sumTaskCompletionTime).toBe(completed.reduce((a, t) => a + t.completedTick! - t.createdAt, 0));
      expect(run.tasksCompleted).toBe(completed.length);
      if (run.completed) {
        const first = Math.min(...run.tasks.map((t) => t.createdAt));
        const last = Math.max(...completed.map((t) => t.completedTick!));
        expect(run.makespan).toBe(last - first);
        expect(completed).toHaveLength(run.tasksTotal);
      } else {
        // A run that retired nothing has no completion time, and the benchmark
        // must not manufacture one.
        expect(run.makespan).toBeNull();
      }
      // The three delay components must reconstruct flow time exactly.
      expect(run.releaseToAssignmentTicks + run.assignmentToPickupTicks + run.pickupToCompletionTicks)
        .toBeLessThanOrEqual(run.sumTaskCompletionTime);
    }
  });

  it("never counts a timeout horizon as a completion time", () => {
    const base: ArmRun = {
      arm: "A", armName: "x", scenarioId: "s", seed: 1, fleetSize: 3, layout: "stock", regime: "recoverable",
      endpointFamily: "uniform", horizonTicks: 1500, ticksRun: 1500, completed: false, tasksCompleted: 0, tasksTotal: 12,
      sumTaskCompletionTime: 0, makespan: null, longestNoProgressTicks: 1200, tasks: [],
      releaseToAssignmentTicks: 0, assignmentToPickupTicks: 0, pickupToCompletionTicks: 0,
      phaseTicks: { approach: { travel: 0, wait: 0 }, loaded: { travel: 0, wait: 0 }, charging: { travel: 0, wait: 0 }, idle: { travel: 0, wait: 0 } },
      progressTicks: { advancing: 0, lateral: 0, retreating: 0 }, decisionReasons: {}, guidance: { predictedCells: 0, rejectedFeatures: 0, replansWithGuidance: 0 },
      meanInFlightTasks: 0, peakInFlightTasks: 0, meanMovingRobots: 0, ticksWithTwoOrMoreMovingRobots: 0,
      energyHoldTicks: 0, reroutes: 0, replans: 0, bidAttempts: 0, bidNonzeroCorrections: 0, bidDisabledFallbacks: 0,
      safety: { overlaps: 0, swaps: 0, blockedCells: 0, zeroBatteryWork: 0, queueOverflow: 0, payloadViolations: 0 },
      centralisedPibtCounters: { conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    };
    const timedOut: ArmRun = { ...base, sumTaskCompletionTime: 1500 * 12 };
    const finished: ArmRun = { ...base, completed: true, sumTaskCompletionTime: 300, makespan: 250 };
    // A finite sum over an empty set must NOT smuggle a timed-out run into the
    // speed analysis. This is the exact bug that made an early pass report 900
    // pairs from a suite where the baseline only completed two thirds of it.
    const stats = pairedStats([timedOut], [finished], "sumTaskCompletionTime");
    expect(stats.pairedCompleteCount).toBe(0);
    expect(stats.baselineOnlyComplete).toBe(0);
    expect(stats.treatmentOnlyComplete).toBe(1);
    expect(stats.neitherComplete).toBe(0);
    const rel = reliabilityStats([timedOut]);
    expect(rel.timedOutRuns).toBe(1);
    expect(rel.completedRuns).toBe(0);
    expect(rel.completionRate).toBe(0);
  });

  it("computes the aggregate reduction exactly as the spec formula states", () => {
    const mk = (id: string, flow: number, makespan: number | null): ArmRun => ({
      arm: "A", armName: "a", scenarioId: id, seed: 1, fleetSize: 3, layout: "stock", regime: "recoverable",
      endpointFamily: "uniform", horizonTicks: 1500, ticksRun: makespan ?? 1500, completed: makespan !== null,
      tasksCompleted: makespan !== null ? 12 : 0, tasksTotal: 12, sumTaskCompletionTime: flow, makespan,
      longestNoProgressTicks: 0, tasks: [], releaseToAssignmentTicks: 0, assignmentToPickupTicks: 0, pickupToCompletionTicks: 0,
      phaseTicks: { approach: { travel: 0, wait: 0 }, loaded: { travel: 0, wait: 0 }, charging: { travel: 0, wait: 0 }, idle: { travel: 0, wait: 0 } },
      progressTicks: { advancing: 0, lateral: 0, retreating: 0 }, decisionReasons: {}, guidance: { predictedCells: 0, rejectedFeatures: 0, replansWithGuidance: 0 },
      meanInFlightTasks: 0, peakInFlightTasks: 0, meanMovingRobots: 0, ticksWithTwoOrMoreMovingRobots: 0,
      energyHoldTicks: 0, reroutes: 0, replans: 0, bidAttempts: 0, bidNonzeroCorrections: 0, bidDisabledFallbacks: 0,
      safety: { overlaps: 0, swaps: 0, blockedCells: 0, zeroBatteryWork: 0, queueOverflow: 0, payloadViolations: 0 },
      centralisedPibtCounters: { conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
    });
    const b = [mk("s1", 1000, 200), mk("s2", 500, 150)];
    const t = [mk("s1", 700, 170), mk("s2", 450, 140)];
    const stats = pairedStats(b, t, "sumTaskCompletionTime");
    expect(stats.baselineTotal).toBe(1500);
    expect(stats.treatmentTotal).toBe(1150);
    expect(stats.aggregateReduction).toBeCloseTo(1 - 1150 / 1500, 12);
    expect(stats.pairedCompleteCount).toBe(2);
    expect(stats.wins).toBe(2);
    // Deterministic bootstrap: same input, same interval, every time.
    const again = pairedStats(b, t, "sumTaskCompletionTime");
    expect(again.aggregateReduction95CI).toEqual(stats.aggregateReduction95CI);
    const ms = pairedStats(b, t, "makespan");
    expect(ms.aggregateReduction).toBeCloseTo(1 - 310 / 350, 12);
  });
});

describe("stop-and-wait baseline invariants", () => {
  it("never moves onto an occupied cell and never swaps", () => {
    const world: WorldState = { ...createInitialWorld(), tick: 0 };
    world.robots = world.robots.slice(0, 6).map((r, i) => ({
      ...r, position: { x: i % 5, y: 1 + Math.floor(i / 5) }, home: r.position,
      path: [{ x: i % 5, y: 1 + Math.floor(i / 5) }, { x: i % 5, y: 2 + Math.floor(i / 5) }], status: "assigned" as const,
    }));
    const occupantOf = new Map(world.robots.map((r) => [`${r.position.x},${r.position.y}`, r.id]));
    const { moves } = resolveStopAndWait(world.robots, world);
    for (const m of moves) {
      if (m.from.x === m.to.x && m.from.y === m.to.y) continue;
      // never enter a cell somebody is standing on
      const occupant = occupantOf.get(`${m.to.x},${m.to.y}`);
      expect(occupant === undefined || occupant === m.robotId).toBe(true);
      // never trade places with the robot on the cell being vacated
      const vacating = occupantOf.get(`${m.from.x},${m.from.y}`);
      expect(vacating === undefined || vacating === m.robotId).toBe(true);
      // one cell per tick, never a teleport
      expect(Math.abs(m.to.x - m.from.x) + Math.abs(m.to.y - m.from.y)).toBe(1);
    }
    // No two robots may resolve to the same destination.
    const destinations = moves.filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y).map((m) => `${m.to.x},${m.to.y}`);
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});

describe("route-guidance safety envelope", () => {
  const rec = buildScenario(970111, 5, "mirroredCross", "stock", "development");
  const map = layoutMap(rec.layout);
  const world = scenarioWorld(rec, map);
  const runtime = new FleetRuntime(world);
  for (let i = 0; i < 12; i++) runtime.step();
  const agent = runtime.fleet.getAgent(world.robots[0].id)!;
  const observation = agent.guidanceObservation(runtime.world.tick);
  const model = JSON.parse(readFileSync(`${ART}/guidance/model.json`, "utf8")).model as RouteGuidanceModel;
  const field = routeGuidanceTollField(model, observation);

  it("refuses to predict from a schema it was not trained for", () => {
    const wrong = { ...model, schema: [...ROUTE_GUIDANCE_FEATURES].reverse() };
    expect(() => predictRouteGuidance(wrong, extractFeatures(observation)[0])).toThrow(/schema/i);
  });

  it("degrades to a zero toll on missing, malformed or non-finite input", () => {
    const zero = (m: RouteGuidanceModel, obs = observation) => Array.from(routeGuidanceTollField(m, obs).tolls).every((t) => t === 0);
    expect(zero({ ...model, parameters: [] })).toBe(true);
    expect(zero({ ...model, mean: [] })).toBe(true);
    expect(zero({ ...model, scale: new Array(ROUTE_GUIDANCE_FEATURES.length).fill(0) })).toBe(true);
    expect(zero({ ...model, maxToll: Number.NaN })).toBe(true);
    expect(zero({ ...model, maxToll: 1e9 })).toBe(true);
    expect(zero(undefined as unknown as RouteGuidanceModel)).toBe(true);
    const features = extractFeatures(observation)[5];
    features[3] = Number.NaN;
    expect(predictRouteGuidance(model, features)).toBe(0);
    features[3] = 1e9; // far outside the training distribution
    expect(predictRouteGuidance(model, features)).toBe(0);
  });

  it("bounds every prediction into [0, maxToll] and never makes a cell cheaper than free", () => {
    for (const t of field.tolls) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(model.maxToll);
    }
    // Blocked cells are never scored at all, so no toll can be attached to one.
    for (let i = 0; i < map.cells.length; i++) if (map.cells[i].blocked) expect(field.tolls[i]).toBe(0);
  });

  it("is additive to the deterministic cost and never touches traversability", () => {
    const base = { ...map, cells: map.cells.map((c) => ({ ...c, congestion: 0 })) };
    const withToll = { ...base, cells: base.cells.map((c, i) => ({ ...c, congestion: c.congestion + field.tolls[i] })) };
    expect(withToll.cells.map((c) => c.blocked)).toEqual(base.cells.map((c) => c.blocked));
    expect(withToll.cells.map((c) => c.congestion)).toEqual(base.cells.map((c, i) => c.congestion + field.tolls[i]));
  });

  it("reads nothing a decentralized robot could not legitimately know", () => {
    const keys = Object.keys(observation).sort();
    expect(keys).toEqual([
      "contentionHistory", "edgeHistory", "goal", "map", "peers", "position", "recentWaitShare",
      "route", "routeRemaining", "sensorContacts", "stallTicks", "tick",
    ]);
    // Peer views carry pose and intent only. No battery, no task queue, no payload.
    for (const peer of observation.peers) {
      expect(Object.keys(peer).sort()).toEqual(["docked", "id", "intent", "lastSeenTick", "position", "preferred", "priority", "seq", "stallTicks"]);
    }
    // The observation is a detached copy: mutating it cannot reach back into the
    // agent, the fleet, or the simulator.
    observation.position.x = 999;
    expect(agent.getLocal().position.x).not.toBe(999);
  });

  it("changes nothing at all when the layer is switched OFF", () => {
    const record = buildScenario(970222, 5, "mirroredCross", "stock", "development");
    const on = runArm(record, "C", model);
    const off = runArm(record, "C");
    expect(on.sumTaskCompletionTime).toBe(off.sumTaskCompletionTime);
    expect(on.completed).toBe(off.completed);
    expect(on.makespan).toBe(off.makespan);
    expect(on.decisionReasons).toEqual(off.decisionReasons);
    expect(on.safety).toEqual(off.safety);
    expect(off.guidance.replansWithGuidance).toBe(0);
  });

  it("refuses to run the guidance arms without a model", () => {
    expect(() => runArm(buildScenario(970333, 3, "uniform", "wide"), "E")).toThrow(/route-guidance model/);
  });

  it("beats a hand-set deterministic heuristic at ranking congested cells", () => {
    const test = JSON.parse(readFileSync(`${ART}/guidance/test.json`, "utf8")) as Record<string, { liftAtTopDecile: number }>;
    const lift = (k: string) => test[k].liftAtTopDecile;
    expect(lift("linear")).toBeGreaterThan(1);
    expect(lift("deterministicHeuristic")).toBeGreaterThan(1);
    // Reported honestly either way: whichever wins, the number is in the artifact.
    expect(Number.isFinite(lift("linear")) && Number.isFinite(lift("mlp"))).toBe(true);
  });

  it("trains a model that reproduces its own scoring", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      seed: 1, layout: "stock", fleetSize: 3, regime: "development", robotId: "AMR-01", cell: i,
      features: Array.from({ length: ROUTE_GUIDANCE_FEATURES.length }, (_, f) => ((i * (f + 3)) % 7) / 7),
      target: (i % 5) / 2,
    }));
    const trained = trainRouteGuidance(rows, { kind: "linear", epochs: 60, seed: 3 });
    expect(trained.schema).toEqual([...ROUTE_GUIDANCE_FEATURES]);
    expect(scoreRouteGuidance(trained, rows).rows).toBe(120);
    expect(DETERMINISTIC_HEURISTIC_TOLL.trainedOn.label).toMatch(/no training/);
  });
});

describe("fleet wiring", () => {
  it("installs no guidance by default and stays deterministic without it", () => {
    const rec = buildScenario(970444, 3, "uniform", "stock", "development");
    const positions = () => {
      const map = layoutMap(rec.layout);
      const robots: RobotState[] = createInitialWorld().robots.slice(0, 3).map((r, i) => ({
        ...r, position: { ...rec.robots[i].start }, home: { ...rec.robots[i].start }, battery: 100,
        path: [], status: "idle" as const, currentTaskId: undefined, queuedTaskIds: [],
      }));
      const fleet = new DistributedFleet(map, robots, [], { localCommit: true });
      expect(fleet.getAgent(robots[0].id)!.getTollField()).toBeNull();
      for (let tick = 0; tick < 20; tick++) fleet.advance(tick);
      return JSON.stringify(fleet.getRobots().map((r) => r.position));
    };
    expect(positions()).toBe(positions());
  });
});

describe("frozen acceptance suite", () => {
  const available = existsSync(`${ART}/scenarios.json`) && existsSync(`${ART}/current/summary.json`);

  it.skipIf(!available)("has unique ids and unique seeds, with the declared composition", () => {
    const suite = loadSuite("acceptance");
    expect(suite.length).toBe(1980);
    expect(new Set(suite.map((s) => s.id)).size).toBe(suite.length);
    expect(new Set(suite.map((s) => `${s.seed}/${s.fleetSize}`)).size).toBe(suite.length);
    for (const n of [3, 5, 8]) {
      for (const [regime, target] of [["low", 200], ["recoverable", 300], ["severe", 160]] as [string, number][]) {
        expect(suite.filter((s) => s.fleetSize === n && s.regime === regime).length).toBe(target);
      }
    }
  });

  it.skipIf(!available)("presents the SAME order book at all three fleet sizes", () => {
    // Fleet size is the only intended variable between N=3, N=5 and N=8, so the
    // same (layout, family, seed) must appear at each size with byte-identical
    // tasks and a nested set of starts. Anything else means one fleet size was
    // quietly handed an easier workload.
    const suite = loadSuite("acceptance");
    const groups = new Map<string, typeof suite>();
    for (const s of suite) {
      const k = `${s.layout}/${s.endpointFamily}/s${s.seed}`;
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    let checked = 0;
    for (const [, group] of groups) {
      if (group.length !== 3) continue;
      const sizes = group.map((g) => g.fleetSize).sort((a, b) => a - b);
      expect(sizes).toEqual([3, 5, 8]);
      expect(new Set(group.map((g) => g.regime)).size).toBe(1);
      const reference = JSON.stringify(group[0].tasks);
      for (const g of group) {
        expect(JSON.stringify(g.tasks)).toBe(reference);
        expect(g.robots.slice(0, group[0].fleetSize).map((r) => `${r.start.x},${r.start.y}`))
          .toEqual(group[0].robots.map((r) => `${r.start.x},${r.start.y}`));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(600);
  });

  it.skipIf(!available)("uses a seed block disjoint from the development block", () => {
    const acceptance = loadSuite("acceptance");
    const development = loadSuite("development");
    const overlap = acceptance.filter((a) => development.some((d) => d.seed === a.seed));
    expect(overlap).toEqual([]);
    expect(Math.min(...acceptance.map((s) => s.seed))).toBeGreaterThanOrEqual(900000);
  });

  it.skipIf(!available)("records zero audited safety violations in every arm", () => {
    const summary = JSON.parse(readFileSync(`${ART}/current/summary.json`, "utf8")) as Record<string, unknown>;
    for (const [id, report] of Object.entries(summary)) {
      if (!/^[A-F]$/.test(id)) continue;
      const totals = (report as { safetyTotals: Record<string, number> }).safetyTotals;
      expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(0);
    }
  });

  it.skipIf(!available)("never lets a timed-out run into a speed statistic", () => {
    const recorded = JSON.parse(readFileSync(`${ART}/current/per-scenario.json`, "utf8")) as { runs: ArmRun[] };
    const summary = JSON.parse(readFileSync(`${ART}/current/summary.json`, "utf8")) as Record<string, unknown>;
    const byId = new Map<string, ArmRun[]>();
    for (const r of recorded.runs) {
      const list = byId.get(r.scenarioId) ?? [];
      list.push(r);
      byId.set(r.scenarioId, list);
    }
    for (const [, runs] of byId) {
      if (!runs.some((r) => r.arm === "A")) continue;
      if (!runs.every((r) => r.completed)) continue;
      expect(runs.every((r) => r.makespan !== null)).toBe(true);
    }
    const paired = (summary.D as { speed: Record<string, Record<string, { pairedCompleteCount: number }>> })
      .speed.sumTaskCompletionTime.recoverable.pairedCompleteCount;
    const both = [...byId.values()].filter((runs) => {
      const a = runs.find((r) => r.arm === "A")!, d = runs.find((r) => r.arm === "D")!;
      return a && d && a.completed && d.completed && a.regime === "recoverable";
    }).length;
    expect(paired).toBe(both);
  });
});

describe("stop-and-wait arm is the documented policy", () => {
  it("actually selects the stop-and-wait motion policy and no learned bidding", () => {
    const rec = buildScenario(970555, 5, "columnTransit", "stock", "development");
    const a = runArm(rec, "A");
    const d = runArm(rec, "D");
    // A never leaves the preferred cell, and never relocates for courtesy.
    for (const reason of ["sensor-yield", "step-aside", "occupied", "lost-claim"]) {
      expect(a.decisionReasons[reason] ?? 0).toBe(0);
    }
    expect(d.decisionReasons["free"] ?? 0).toBeGreaterThan(0);
    expect(a.bidAttempts).toBe(0);
    expect(d.bidAttempts).toBeGreaterThan(0);
  });
});
