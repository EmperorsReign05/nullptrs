import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createInitialWorld } from "../src/core/simulation/state";
import type { BidModel } from "../src/core/ml/bidmodel";
import type { Task } from "../src/core/types";
function setup() {
  const world = createInitialWorld(); world.tasks = [];
  world.robots = world.robots.slice(0, 3).map((r, i) => ({ ...r, position: { x: [3,9,12][i], y: 0 }, home: { x: [3,9,12][i], y: 0 }, battery: 95, currentTaskId: undefined, queuedTaskIds: [], path: [], status: "idle" as const }));
  return world;
}
const task = (id: string): Task => ({ id, pickup: { x: 6, y: 4 }, dropoff: { x: 12, y: 10 }, weight: 10, createdAt: 0, priority: 1, status: "pending" });
function until(runtime: FleetRuntime, condition: () => boolean, budget = 300) {
  for (let i = 0; i < budget && !condition(); i++) runtime.step();
  expect(condition(), JSON.stringify(runtime.snapshot())).toBe(true);
}
describe("integrated fleet demo", () => {
  it("three local bidders, AI and fallback, blocked route, owner failure, partition, recovery and telemetry", () => {
    const r = new FleetRuntime(setup()); r.command({ kind: "task", task: task("E2E-1") });
    const job = r.world.tasks[0];
    until(r, () => !!job.assignedRobotId);
    const failed = job.assignedRobotId!;
    expect(job.status).toBe("assigned");
    r.command({ kind: "fail", robotId: failed });
    expect(r.world.robots.find(x => x.id === failed)!.currentTaskId).toBeUndefined();
    until(r, () => !!job.assignedRobotId && job.assignedRobotId !== failed);
    const replacement = job.assignedRobotId!;
    r.step();
    const robot = r.world.robots.find(x => x.id === replacement)!;
    const obstruction = robot.path.slice(2).find(p => !r.world.robots.some(x => x.position.x === p.x && x.position.y === p.y) && !(p.x === job.pickup.x && p.y === job.pickup.y) && !(p.x === job.dropoff.x && p.y === job.dropoff.y));
    expect(obstruction).toBeDefined();
    r.command({ kind: "block", position: obstruction!, blocked: true });
    r.step();
    expect(r.fleet.getAgent(replacement)!.getLocal().path.some(p => p.x === obstruction!.x && p.y === obstruction!.y)).toBe(false);
    r.command({ kind: "block", position: obstruction!, blocked: false });
    const live = r.world.robots.filter(x => x.id !== failed).map(x => x.id);
    r.command({ kind: "link", a: live[0], b: live[1], reachable: false });
    for (let i = 0; i < 40; i++) r.step();
    const waiting = r.world.robots.find(x => x.id === replacement)!;
    expect(waiting.currentTaskId).toBe(job.id);
    const heldAt = { ...waiting.position };
    r.step();
    expect(waiting.position).toEqual(heldAt);
    expect(live.every(id => !r.peers.get(id)!.mayExecute(job.id))).toBe(true);
    r.command({ kind: "heal" });
    until(r, () => job.status === "completed", 400);
    expect(r.metrics.nonzeroCorrections).toBeGreaterThan(0);
    r.command({ kind: "ai-off" }); r.command({ kind: "task", task: { ...task("E2E-2"), pickup: { x: 12, y: 8 }, dropoff: { x: 14, y: 10 } } });
    until(r, () => r.world.tasks.every(t => t.status === "completed"), 400);
    expect(r.metrics.disabledFallbacks).toBeGreaterThan(0);
    expect(Object.values(r.safety).every(x => x === 0)).toBe(true);
    const snapshot = r.snapshot(), previous = snapshot.world.tick; r.step();
    expect(snapshot.world.tick).toBe(previous); expect(r.snapshot().world.tick).toBe(previous + 1);
    expect(r.snapshot().events.length).toBeGreaterThan(0);
    mkdirSync("artifacts/final-audit", { recursive: true });
    writeFileSync("artifacts/final-audit/end-to-end.json", JSON.stringify({ passed: true, scenario: "three agents, crash before pickup, blocked route, live-pair partition and heal, AI disable", failed, replacement, obstruction, snapshot: r.snapshot(), limitations: ["simulation shared tick", "in-memory peer transport", "no physical sensors", "not a speed benchmark"] }, null, 2));
  });
  it("model failure falls back and a rejected physical control cannot mutate state", () => {
    const r = new FleetRuntime(setup(), {} as BidModel); r.command({ kind: "task", task: task("bad-model") });
    for (let i = 0; i < 12; i++) r.step();
    expect(r.metrics.failedModelFallbacks).toBeGreaterThan(0);
    const before = r.snapshot();
    expect(() => r.command({ kind: "block", position: r.world.robots[0].position, blocked: true })).toThrow("occupied");
    expect(r.snapshot()).toEqual(before);
  });
});
