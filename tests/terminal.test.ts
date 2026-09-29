import { describe, it } from "vitest";
import { runDispatchTick } from "../src/core/simulation/dispatch";
import { createInitialWorld } from "../src/core/simulation/state";
import { CHARGING_STATIONS } from "../src/core/map/warehouse";
import { LOW_BATTERY_STREAK_THRESHOLD } from "../src/core/simulation/robotModels";
import { growFleet, openCells } from "./harness";
import type { WorldState, Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;

function makeTasks(world: WorldState, startIdx: number, open: Position[]) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = startIdx + i;
    const p = open[(n * 7 + 3) % open.length];
    const d = open[(n * 13 + 5) % open.length];
    if (p.x === d.x && p.y === d.y) continue;
    out.push({ id: `L${n}`, pickup: p, dropoff: d, weight: (n % 9) * 10 + 10, createdAt: world.tick, priority: 1, status: "pending" as const });
  }
  return out;
}

describe("H: terminal mechanism 1 — the 2-cycle swap deadlock", () => {
  it("H1: two robots nose-tonose toward each other's cell never resolve, and never replan", () => {
    // Reproduce exactly the AMR-09/AMR-10 configuration seen at tick 515.
    const base = growFleet(createInitialWorld(), 2);
    let world: WorldState = {
      ...base,
      robots: [
        { ...base.robots[0], id: "A", position: { x: 19, y: 8 }, home: { x: 19, y: 8 }, status: "waiting", path: [{ x: 19, y: 8 }, { x: 18, y: 8 }], priority: 23, battery: 51, currentTaskId: "T", queuedTaskIds: [] },
        { ...base.robots[1], id: "B", position: { x: 18, y: 8 }, home: { x: 18, y: 8 }, status: "charging", path: [{ x: 18, y: 8 }, { x: 19, y: 8 }], priority: 31, battery: 19, currentTaskId: undefined, queuedTaskIds: [] },
      ],
      tasks: [{ id: "T", pickup: { x: 10, y: 4 }, dropoff: { x: 10, y: 4 }, weight: 1, createdAt: 0, priority: 1, status: "assigned", assignedRobotId: "A" }],
    };
    const startReplans = world.metrics.replans;
    for (let i = 0; i < 10; i++) {
      world = runDispatchTick(world);
      const a = world.robots.find((r) => r.id === "A")!;
      const b = world.robots.find((r) => r.id === "B")!;
      console.log(`H1 t=${world.tick} A@${key(a.position)} next=${a.path.length > 1 ? key(a.path[1]) : "-"} | B@${key(b.position)} next=${b.path.length > 1 ? key(b.path[1]) : "-"} | replans=+${world.metrics.replans - startReplans} conflicts=+${world.metrics.conflictCount}`);
    }
    const a = world.robots.find((r) => r.id === "A")!;
    const b = world.robots.find((r) => r.id === "B")!;
    console.log(`H1 VERDICT: A still at ${key(a.position)} wanting ${key(a.path[1] ?? a.position)}, B still at ${key(b.position)} wanting ${key(b.path[1] ?? b.position)}`);
    console.log(`H1 replans over 10 ticks = ${world.metrics.replans - startReplans}  => committed paths are never re-evaluated because the next step is OCCUPIED, not BLOCKED.`);
  });
});

describe("H: terminal mechanism 2 — the charging thundering herd", () => {
  it("H2: how many robots go to 'charging' at once, vs 4 stations", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    let n = 0;
    let peak = 0, peakTick = 0;
    const hist: string[] = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { world = { ...world, tasks: [...world.tasks, ...makeTasks(world, n, open)] }; n += 3; }
      world = runDispatchTick(world);
      const ch = world.robots.filter((r) => r.status === "charging").length;
      if (ch > peak) { peak = ch; peakTick = world.tick; }
      if (i % 300 === 0) hist.push(`t=${i}:${ch}`);
    }
    console.log(`H2 charging-robot count over time: ${hist.join("  ")}`);
    console.log(`H2 PEAK = ${peak} robots simultaneously in 'charging' status at t=${peakTick}, against only ${CHARGING_STATIONS.length} stations.`);
    const w2 = world;
    const charging = w2.robots.filter((r) => r.status === "charging");
    const parked = charging.filter((r) => CHARGING_STATIONS.some((s) => s.position.x === r.position.x && s.position.y === r.position.y));
    console.log(`H2 at t=3000: ${charging.length} charging, only ${parked.length} actually parked on a station, ${charging.length - parked.length} queued in a pileup with no queue discipline.`);
  });

  it("H3: lowBatteryStreak inflation — how fast does one accumulate it", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    const streaks: Record<number, number> = {};
    for (let i = 0; i < 400; i++) {
      world = { ...world, tasks: [...world.tasks, ...makeTasks(world, i, open)] };
      world = runDispatchTick(world);
      for (const r of world.robots) {
        const s = r.lowBatteryStreak ?? 0;
        streaks[s] = (streaks[s] ?? 0) + 1;
      }
    }
    console.log(`H3 lowBatteryStreak distribution after 400 ticks: ${JSON.stringify(streaks)} (threshold=${LOW_BATTERY_STREAK_THRESHOLD})`);
    console.log("H3 => one dispatch round evaluates up to 30 pending tasks, each incrementing the streak once for every battery-infeasible loss.");
  });

  it("H4: robots on a healthy battery still get pulled into charging", () => {
    let world = growFleet(createInitialWorld(), 20);
    const open = openCells(world);
    for (let i = 0; i < 2000; i++) {
      if (i % 20 === 0) world = { ...world, tasks: [...world.tasks, ...makeTasks(world, i * 3, open)] };
      world = runDispatchTick(world);
    }
    const healthy = world.robots.filter((r) => r.status === "charging" && r.battery > 60);
    console.log(`H4 robots 'charging' despite >60% battery: ${healthy.length}`);
    for (const r of healthy.slice(0, 8)) console.log(`   ${r.id} b=${r.battery.toFixed(1)} streak=${r.lowBatteryStreak ?? 0}`);
    console.log("H4 => streak is a proxy for 'losing bids', not for 'low battery'; a robot that simply keeps losing a CONTESTED auction is sent to charge.");
  });
});

describe("H: terminal mechanism 3 — the idle-AMR complaint", () => {
  it("H5: with the dashboard's real task-creation rate, what does the fleet do?", () => {
    // The dashboard only creates a task when a human clicks "Create Task"
    // (handleCreateTask), and there is no automatic generation. Replicate a
    // realistic human clicking it a few times over a long run.
    let world = growFleet(createInitialWorld(), 20);
    const pickupLocations = [{ x: 1, y: 0 }, { x: 14, y: 0 }, { x: 3, y: 9 }, { x: 9, y: 9 }];
    const dropoffLocations = [{ x: 6, y: 12 }, { x: 17, y: 12 }, { x: 9, y: 1 }, { x: 13, y: 1 }];
    let clicks = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 400 === 0) {
        const p = pickupLocations[clicks % 4], d = dropoffLocations[(clicks + 1) % 4];
        world = { ...world, tasks: [...world.tasks, { id: `T-${105 + clicks}`, pickup: p, dropoff: d, weight: 45, createdAt: world.tick, priority: 1, status: "pending" as const }] };
        clicks++;
      }
      world = runDispatchTick(world);
    }
    const idle = world.robots.filter((r) => r.status === "idle").length;
    const done = world.tasks.filter((t) => t.status === "completed").length;
    console.log(`H5 3000 ticks, ${clicks} human task-creations, 20 AMRs: idle=${idle}/20 completed=${done}/${world.tasks.length}`);
    console.log(`H5 => ${((idle / 20) * 100).toFixed(0)}% of the fleet sits idle because there is no work, and the UI has no backlog generator to feed it.`);
  });
});
