import { describe, expect, it } from "vitest";
import { DistributedCharging } from "../src/core/distributed/charging";
import { executionActiveTaskAllowed } from "../src/core/distributed/execution-energy";
import { planPath } from "../src/core/pathfinding/astar";
import type { RobotState, Task, WorldState } from "../src/core/types";
function setup(battery = 21) {
  const task: Task = { id: "T1", pickup: { x: 18, y: 4 }, dropoff: { x: 19, y: 8 }, status: "assigned", assignedRobotId: "R1", weight: 1, priority: 1, createdAt: 0 };
  const robot: RobotState = { id: "R1", position: { x: 2, y: 4 }, home: { x: 2, y: 4 }, battery, status: "assigned", currentTaskId: task.id, queuedTaskIds: ["T2"], path: [], priority: 0, model: { model: "test", payloadCapacity: 10 } };
  const world: WorldState = { tick: 0, map: { width: 20, height: 13, cells: Array.from({ length: 260 }, (_, n) => ({ position: { x: n % 20, y: Math.floor(n / 20) }, blocked: false, congestion: 0 })) }, robots: [robot], tasks: [task, { ...task, id: "T2" }], metrics: { replans: 0, conflictCount: 0, waitMoves: 0, inheritedPriorities: 0, backtracks: 0 } };
  return { robot, task, world, charging: new DistributedCharging() };
}
describe("local distributed charging lifecycle", () => {
  it("interrupts before pickup, recharges and resumes without changing ownership or queue", () => {
    const { robot, task, world, charging } = setup();
    const ids = [robot.currentTaskId, ...robot.queuedTaskIds!];
    expect(charging.prepare(robot, world, 0).mode).toBe("transit");
    expect(robot.status).toBe("charging");
    expect(charging.afterMotion(robot, world, 0)).toBe(0);
    for (let tick = 1; tick < 50 && charging.active; tick++) {
      const state = charging.prepare(robot, world, tick);
      if (state.mode === "transit") {
        const to = planPath(robot.position, state.goal!, world).path[1];
        expect(charging.allowsMove(robot, to, world)).toBe(true);
        robot.position = to; robot.battery -= 0.5;
      }
      charging.afterMotion(robot, world, tick);
      expect(robot.battery).toBeGreaterThanOrEqual(15);
    }
    expect(charging.active).toBe(false);
    expect(robot.battery).toBeGreaterThanOrEqual(50);
    expect(task.status).toBe("assigned");
    expect(task.assignedRobotId).toBe("R1");
    expect([robot.currentTaskId, ...robot.queuedTaskIds!]).toEqual(ids);
    const to = planPath(robot.position, task.pickup, world).path[1];
    expect(executionActiveTaskAllowed(robot, task, to, world)).toBe(true);
  });
  it("charges at most once per committed tick and can recover depleted robot already docked", () => {
    const { robot, world, charging } = setup(0);
    robot.position = { x: 0, y: 4 };
    expect(charging.prepare(robot, world, 3).mode).toBe("charging");
    expect(charging.afterMotion(robot, world, 3)).toBe(2);
    expect(charging.afterMotion(robot, world, 3)).toBe(0);
    expect(charging.afterMotion(robot, world, 2)).toBe(0);
    expect(robot.battery).toBe(2);
    robot.status = "failed";
    expect(charging.afterMotion(robot, world, 4)).toBe(0);
  });
  it("never releases or redirects cargo with insufficient delivery energy", () => {
    const { robot, task, world, charging } = setup(20);
    task.status = "in_progress";
    expect(charging.prepare(robot, world, 0).reason).toBe("cargo-recovery-required");
    expect(charging.state.hold).toBe(true);
    expect(charging.allowsMove(robot, { x: 1, y: 4 }, world)).toBe(false);
    expect(robot.currentTaskId).toBe(task.id);
    expect(task.status).toBe("in_progress");
    robot.battery = 80;
    expect(charging.prepare(robot, world, 1).reason).toBe("deliver-cargo");
  });
  it("refuses charging trips or detours that consume the safety reserve", () => {
    const { robot, world, charging } = setup(15.5);
    expect(charging.prepare(robot, world, 0).reason).toBe("no-charger-reachable-with-reserve");
    robot.battery = 16;
    expect(charging.prepare(robot, world, 1).mode).toBe("transit");
    expect(charging.allowsMove(robot, { x: 3, y: 4 }, world)).toBe(false);
    expect(charging.allowsMove(robot, { x: 1, y: 4 }, world)).toBe(true);
    expect(charging.allowsMove(robot, { x: 0, y: 4 }, world)).toBe(false);
  });
  it("invalidates a blocked station and never gains energy on it", () => {
    const { robot, world, charging } = setup();
    charging.prepare(robot, world, 0);
    const target = charging.goal!;
    world.map.cells.find(c => c.position.x === target.x && c.position.y === target.y)!.blocked = true;
    robot.position = target;
    expect(charging.afterMotion(robot, world, 1)).toBe(0);
    expect(charging.prepare(robot, world, 2).mode).toBe("hold");
  });
  it("certifies jobs individually while retaining a full queue for later recharge", () => {
    const { robot, task, world, charging } = setup(30);
    robot.position = { x: 17, y: 4 };
    robot.queuedTaskIds = ["T2", "T3", "T4", "T5"];
    for (const id of ["T3", "T4", "T5"]) world.tasks.push({ ...task, id });
    expect(charging.prepare(robot, world, 0).mode).toBe("work");
    expect(executionActiveTaskAllowed(robot, task, { x: 18, y: 4 }, world)).toBe(true);
    expect(robot.queuedTaskIds).toHaveLength(4);
  });
  it("does not cycle charging forever for an unreachable active job", () => {
    const { robot, task, world, charging } = setup(100);
    world.map.cells.find(c => c.position.x === task.pickup.x && c.position.y === task.pickup.y)!.blocked = true;
    expect(charging.prepare(robot, world, 0).reason).toBe("task-not-feasible-at-full-charge");
    expect(charging.goal).toBeUndefined();
  });
});

it("allows a cargo delivery below bid floor when delivery and charger retain the hard reserve", () => {
  const { robot, task, world, charging } = setup(16);
  robot.position = { x: 1, y: 4 };
  task.status = "in_progress"; task.dropoff = { x: 0, y: 4 };
  expect(charging.prepare(robot, world, 0).mode).toBe("work");
  expect(executionActiveTaskAllowed(robot, task, task.dropoff, world)).toBe(true);
  robot.battery = 15;
  expect(executionActiveTaskAllowed(robot, task, task.dropoff, world)).toBe(false);
});
