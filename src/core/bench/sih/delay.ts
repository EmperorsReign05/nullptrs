// Phase 9: where does the remaining time actually go?
//
// The decomposition is built ONLY from quantities the running system already
// produces, so it cannot perturb the run it measures:
//
//   per-task phase split   - createdAt / first assignment / pickup / completion
//                            ticks, which the ownership + custody layers own
//   fleet robot-ticks      - world.robots positions either side of
//                            fleet.advance(), and RobotState.status
//   conflict attribution   - AgentDecision.reason, the field the agent already
//                            computes for the dashboard and which the commit
//                            protocol overwrites whenever it demotes a move
//   route efficiency       - Manhattan progress of the agent's OWN route, which
//                            is a lower bound on true graph progress in a rack
//   travel lower bound     - a policy-independent per-scenario minimum
//
// THREE DENOMINATORS, NEVER MIXED. Each table states its own:
//   (1) task time        sumTaskCompletionTime over scenarios that COMPLETED
//   (2) productive ticks travel + wait while holding an assigned task
//   (3) all robot-ticks  including idle and charging
// A robot sitting idle with no task is fleet slack, not delay, so it is reported
// separately and never counted as a loss.

import { planPath } from "../../pathfinding/astar";
import { layoutMap } from "./scenario";
import type { WarehouseMap, WorldState } from "../../types";
import type { ScenarioRecord } from "./scenario";
import type { ArmRun } from "./runner";

const ARTIFACT_DIR_PATH = "artifacts/sih-acceptance-v1";

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

/** Decision reasons, grouped by what they mean for elapsed time. */
export const REASON_GROUPS: Record<string, string[]> = {
  /** Took the planned next cell. Elapsed time here is genuine travel. */
  progress: ["free"],
  /** Conflict resolution: gave up the preferred cell or was demoted at commit. */
  conflictYield: ["occupied", "sensor-yield", "lost-claim", "swap-blocked", "docked-peer"],
  /** Local courtesy relocation to get out of somebody's way. */
  deadlockRecovery: ["step-aside"],
  /** Stood still. */
  hold: ["no-move", "sensor-stop"],
};

type StaticWorld = WorldState;

function staticWorldOf(map: WarehouseMap): StaticWorld {
  return {
    tick: 0,
    map: { ...map, cells: map.cells.map((c) => ({ ...c, congestion: 0 })) },
    robots: [], tasks: [],
    metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 },
  };
}

/**
 * A POLICY-INDEPENDENT lower bound on the travel any execution of this scenario
 * must perform: for every task, the shortest approach from the best-placed robot
 * start plus the shortest delivery leg. It ignores that one robot may have to
 * serve several tasks in sequence, so it is a strict under-estimate, which makes
 * every ratio computed against it CONSERVATIVE in the direction that matters:
 * `travel / lowerBound` is an upper bound on the excess travel.
 */
function travelLowerBound(record: ScenarioRecord): number {
  const world = staticWorldOf(layoutMap(record.layout));
  let total = 0;
  for (const task of record.tasks) {
    const leg = planPath(task.pickup, task.dropoff, world);
    if (!leg.found) return 0;
    let best = Infinity;
    for (const robot of record.robots) {
      const approach = planPath(robot.start, task.pickup, world);
      if (approach.found) best = Math.min(best, approach.distance);
    }
    total += leg.distance + (Number.isFinite(best) ? best : 0);
  }
  return total;
}

type Unit = { unit: string };
type PhaseComponents = { releaseToAssignment: number; assignmentToPickup: number; pickupToCompletion: number };
type ArmScopeReport = {
  scope: string;
  scenarios: number;
  completedScenarios: number;
  denominator1_taskTime: Unit & {
    completedScenarios: number;
    sumTaskCompletionTime: number;
    components: PhaseComponents;
    shares: Record<string, number | null>;
    sumOfComponents: number;
    sumOfComponentsMatchesFlowTime: boolean;
  };
  denominator2_productiveTicks: Unit & { ticks: number; travel: number; wait: number; congestionWaitShare: number | null };
  denominator3_allRobotTicks: Unit & {
    ticks: number; chargingHold: number; chargingShare: number | null;
    idle: number; idleShare: number | null; fleetUtilisation: number | null;
  };
  routeEfficiency: Unit & {
    travelTicks: number; advancing: number; lateral: number; retreating: number;
    advancingShare: number | null; lateralShare: number | null; retreatingShare: number | null;
    travelLowerBound: number; travelOverLowerBound: number | null;
  };
  conflictAttribution: Unit & { reasons: Record<string, number>; groups: Record<string, number>; sharesOfProductiveTicks: Record<string, number | null> };
  planningAndEnergy: Record<string, number | null>;
};

export type DelayHeadline = {
  dominantComponent: string | null;
  rankedShares: { component: string; share: number }[];
  allShares: Record<string, number | null>;
};

export function delayBreakdown(suite: ScenarioRecord[], runs: ArmRun[]) {
  const bounds = new Map<string, number>();
  for (const record of suite) bounds.set(record.id, travelLowerBound(record));

  const arms = [...new Set(runs.map((r) => r.arm))].sort();
  const byArm: Record<string, unknown> = {};

  for (const arm of arms) {
    const mine = runs.filter((r) => r.arm === arm);
    for (const scope of [
      { name: "all", filter: () => true },
      { name: "low", filter: (r: ArmRun) => r.regime === "low" },
      { name: "recoverable", filter: (r: ArmRun) => r.regime === "recoverable" },
      { name: "severe", filter: (r: ArmRun) => r.regime === "severe" },
    ]) {
      const rs = mine.filter(scope.filter);
      if (!rs.length) continue;
      // Denominator 1 counts only scenarios that COMPLETED, so the two arms are
      // compared on the same set of workloads. A timed-out run's partial sum is
      // reported nowhere in this table; it belongs to the reliability analysis.
      const complete = rs.filter((r) => r.completed);

      const flow = sum(complete.map((r) => r.sumTaskCompletionTime));
      const phases = {
        releaseToAssignment: sum(complete.map((r) => r.releaseToAssignmentTicks)),
        assignmentToPickup: sum(complete.map((r) => r.assignmentToPickupTicks)),
        pickupToCompletion: sum(complete.map((r) => r.pickupToCompletionTicks)),
      };
      const phaseTotal = phases.releaseToAssignment + phases.assignmentToPickup + phases.pickupToCompletion;

      const travel = sum(rs.map((r) => r.phaseTicks.approach.travel + r.phaseTicks.loaded.travel));
      const wait = sum(rs.map((r) => r.phaseTicks.approach.wait + r.phaseTicks.loaded.wait));
      const productive = travel + wait;
      const charging = sum(rs.map((r) => r.phaseTicks.charging.travel + r.phaseTicks.charging.wait));
      const idle = sum(rs.map((r) => r.phaseTicks.idle.travel + r.phaseTicks.idle.wait));
      const allTicks = productive + charging + idle;

      const reasons: Record<string, number> = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.decisionReasons)) reasons[k] = (reasons[k] ?? 0) + v;
      const reasonGroups: Record<string, number> = {};
      for (const [group, keys] of Object.entries(REASON_GROUPS)) reasonGroups[group] = sum(keys.map((k) => reasons[k] ?? 0));

      // Rows recorded before the route-efficiency instrumentation existed simply
      // have no counter here; they report zero rather than aborting the analysis.
      const prog = (r: ArmRun) => r.progressTicks ?? { advancing: 0, lateral: 0, retreating: 0 };
      const advancing = sum(rs.map((r) => prog(r).advancing));
      const lateral = sum(rs.map((r) => prog(r).lateral));
      const retreating = sum(rs.map((r) => prog(r).retreating));
      const lowerBound = sum(rs.map((r) => bounds.get(r.scenarioId) ?? 0));
      const energyHold = sum(rs.map((r) => r.energyHoldTicks));

      byArm[`${arm}:${scope.name}`] = {
        scope: scope.name,
        scenarios: rs.length,
        completedScenarios: complete.length,
        denominator1_taskTime: {
          unit: "ticks; percentage of sumTaskCompletionTime over the scenarios this arm COMPLETED. A timed-out run contributes nothing here.",
          completedScenarios: complete.length,
          sumTaskCompletionTime: flow,
          components: phases,
          shares: {
            ownershipAndCertificationWait: share(phases.releaseToAssignment, flow),
            approachTravelAndCongestion: share(phases.assignmentToPickup, flow),
            loadedTravelAndCongestion: share(phases.pickupToCompletion, flow),
          },
          sumOfComponents: phaseTotal,
          sumOfComponentsMatchesFlowTime: phaseTotal === flow,
        },
        denominator2_productiveTicks: {
          unit: "robot-ticks while holding an assigned task (approach + loaded). Idle and charging are excluded: a robot with no task is fleet slack, not delay.",
          ticks: productive,
          travel,
          wait,
          congestionWaitShare: share(wait, productive),
        },
        denominator3_allRobotTicks: {
          unit: "every live robot-tick, including idle and charging",
          ticks: allTicks,
          chargingHold: charging,
          chargingShare: share(charging, allTicks),
          idle,
          idleShare: share(idle, allTicks),
          fleetUtilisation: share(productive, allTicks),
        },
        routeEfficiency: {
          unit: "movement ticks classified by whether they reduced the Manhattan distance to the robot's OWN route goal. Manhattan is a lower bound on graph distance in a rack layout, so advancingShare is a lower bound on true route efficiency.",
          travelTicks: travel,
          advancing, lateral, retreating,
          advancingShare: share(advancing, travel),
          lateralShare: share(lateral, travel),
          retreatingShare: share(retreating, travel),
          travelLowerBound: lowerBound,
          travelOverLowerBound: lowerBound > 0 ? travel / lowerBound : null,
        },
        conflictAttribution: {
          unit: "robot-ticks by AgentDecision.reason; groups sum to all robot-ticks in scope, shares are of PRODUCTIVE ticks",
          reasons,
          groups: reasonGroups,
          sharesOfProductiveTicks: Object.fromEntries(Object.entries(reasonGroups).map(([k, v]) => [k, share(v, productive)])),
        },
        planningAndEnergy: {
          energyHoldTicks: energyHold,
          energyHoldShareOfProductiveTicks: share(energyHold, productive),
          reroutes: sum(rs.map((r) => r.reroutes)),
          replans: sum(rs.map((r) => r.replans)),
          reroutesPerScenario: mean(rs.map((r) => r.reroutes)),
          reroutesPerMovingTick: travel > 0 ? sum(rs.map((r) => r.reroutes)) / travel : null,
        },
      } satisfies ArmScopeReport;
    }
  }

  // ---- the question Phase 9 asks: which component actually dominates? ----
  const headline: Record<string, DelayHeadline> = {};
  for (const arm of arms) {
    const rec = byArm[`${arm}:recoverable`] as ArmScopeReport | undefined;
    if (!rec) continue;
    const shares: Record<string, number | null> = {
      ownershipAndCertificationWaitShareOfTaskTime: rec.denominator1_taskTime.shares.ownershipAndCertificationWait,
      approachTravelAndCongestionShareOfTaskTime: rec.denominator1_taskTime.shares.approachTravelAndCongestion,
      loadedTravelAndCongestionShareOfTaskTime: rec.denominator1_taskTime.shares.loadedTravelAndCongestion,
      congestionWaitShareOfProductiveTicks: rec.denominator2_productiveTicks.congestionWaitShare,
      nonAdvancingShareOfTravel: share(
        (rec.routeEfficiency.lateral + rec.routeEfficiency.retreating),
        rec.routeEfficiency.travelTicks,
      ),
      conflictYieldShareOfProductiveTicks: rec.conflictAttribution.sharesOfProductiveTicks.conflictYield,
      deadlockRecoveryShareOfProductiveTicks: rec.conflictAttribution.sharesOfProductiveTicks.deadlockRecovery,
    };
    const ranked = Object.entries(shares)
      .filter(([, v]) => typeof v === "number")
      .sort((a, b) => (b[1] as number) - (a[1] as number));
    headline[`arm${arm}:recoverable`] = {
      dominantComponent: ranked[0]?.[0] ?? null,
      rankedShares: ranked.map(([k, v]) => ({ component: k, share: v as number })),
      allShares: shares,
    };
  }

  return {
    version: "sih-acceptance-v1",
    generatedBy: "npx vite-node scripts/sih-benchmark.ts delay",
    source: `${ARTIFACT_DIR_PATH}/per-scenario.json`,
    method: {
      taskTime:
        "releaseToAssignment = firstAssignmentTick - createdAt (ownership, certification and allocation wait); assignmentToPickup = pickupTick - firstAssignmentTick (approach travel plus its congestion waits); pickupToCompletion = completionTick - pickupTick (loaded travel plus its congestion waits). The three sum exactly to flowTime per completed task, which the sumOfComponentsMatchesFlowTime flag verifies per slice.",
      productiveTicks:
        "one robot-tick per live robot per tick while it holds an assigned task. travel = its cell changed; wait = it did not. Idle robots and robots on a dock are excluded from this denominator and reported separately, because a robot with no work is fleet slack and counting it as delay would flatter any system that keeps more robots busy.",
      conflictAttribution:
        "progress=free; conflictYield=occupied|sensor-yield|lost-claim|swap-blocked|docked-peer; deadlockRecovery=step-aside; hold=no-move|sensor-stop. 'lost-claim' is also the reason the commit protocol stamps on any hold it forces, so it is a lower bound on arbitration losses.",
      chargingHold: "ticks in which a robot's status was charging (travel + wait), i.e. en route to or parked on a dock.",
      travelLowerBound:
        "per scenario, sum over tasks of (shortest approach from the best-placed robot start + shortest delivery leg), all on the static congestion-free map. It ignores multi-task sequencing, so it under-estimates; travelOverLowerBound is therefore an UPPER bound on excess travel.",
      nonPerturbation:
        "the runner only reads world state, agent decisions and task status. It installs no callback, no override and no planner hook outside the explicitly labelled route-guidance arms, so it cannot change what it measures.",
    },
    suiteSize: suite.length,
    headline,
    byArm,
  };
}
