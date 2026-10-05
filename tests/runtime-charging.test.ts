import { expect, it } from "vitest";
import { FleetRuntime } from "../src/core/distributed/runtime";
import { createInitialWorld } from "../src/core/simulation/state";
import { RECHARGE_TARGET_PERCENT } from "../src/core/simulation/robotModels";
import { OrderBook } from "../src/server/order-book";

function world(fleetSize = 3) {
  const w = createInitialWorld(); w.robots = w.robots.slice(0, fleetSize); w.tasks = [];
  w.map.cells.forEach(c => c.blocked = false);
  // Row 0 and the far column, generated so any fleet size gets distinct starts.
  const starts = Array.from({ length: fleetSize }, (_, i) => (i % 2 ? { x: 18, y: 10 + i } : { x: 2, y: 4 + i }));
  w.robots.forEach((r,i) => { const s=starts[i]; if(!s) throw new Error(`no start for robot ${i}`); r.position={...s};r.home={...s};r.battery=100; });
  return w;
}
it("a low-battery idle peer reaches charging and resumes without zero-battery work", () => {
  const w=world();w.robots[0].battery=19; const runtime=new FleetRuntime(w);
  let reached=false,resumed=false;
  for(let tick=0;tick<160;tick++){
    runtime.step();const r=runtime.world.robots[0],charging=runtime.charging.get(r.id)!;
    reached ||= charging.state.mode==="charging";
    resumed ||= reached && !charging.active && r.battery>=RECHARGE_TARGET_PERCENT-1;
  }
  expect(reached).toBe(true);expect(resumed).toBe(true);
  expect(Object.values(runtime.safety).every(v=>v===0)).toBe(true);
});
it("pre-pickup recharge preserves the lease and task, then completes the delivery", () => {
  const w=world();w.tasks=[{id:"CHARGE-JOB",pickup:{x:5,y:4},dropoff:{x:10,y:4},weight:1,priority:1,createdAt:0,status:"pending"}];
  const runtime=new FleetRuntime(w);let forced=false,charged=false,owner="";
  for(let tick=0;tick<240;tick++){
    runtime.step();const task=runtime.world.tasks[0];
    if(!forced&&task.status==="assigned"&&task.assignedRobotId){
      owner=task.assignedRobotId;runtime.world.robots.find(r=>r.id===owner)!.battery=19;forced=true;
    }
    if(forced){
      const c=runtime.charging.get(owner)!; charged ||= c.state.mode==="charging";
      if(c.active)expect(task.status).not.toBe("in_progress");
      if(task.assignedRobotId)expect(task.assignedRobotId).toBe(owner);
    }
    if(task.status==="completed")break;
  }
  expect(forced).toBe(true);expect(charged).toBe(true);expect(runtime.world.tasks[0].status).toBe("completed");
  expect(Object.values(runtime.safety).every(v=>v===0)).toBe(true);
});

it("recharges an idle heavy-job bidder above the hard battery floor instead of stalling the admission frontier", () => {
  const w = createInitialWorld();
  w.robots = w.robots.slice(0, 3);
  w.robots.forEach((r, i) => {
    r.position = [{ x: 12, y: 11 }, { x: 3, y: 11 }, { x: 13, y: 12 }][i];
    r.battery = [50, 30, 47.5][i];
  });
  w.tasks = [{ id: "HEAD-HEAVY", pickup: { x: 17, y: 4 }, dropoff: { x: 12, y: 12 },
    weight: 75, priority: 1, createdAt: 0, status: "pending" }];
  const runtime = new FleetRuntime(w);
  let recharged = false;
  for (let i = 0; i < 240 && runtime.world.tasks[0].status !== "in_progress"; i++) {
    runtime.step();
    recharged ||= runtime.charging.get("AMR-02")!.active;
  }
  expect(recharged).toBe(true);
  expect(runtime.world.tasks[0].status).toBe("in_progress");
  expect(runtime.world.tasks[0].assignedRobotId).toBe("AMR-02");
  expect(Object.values(runtime.safety).every(v => v === 0)).toBe(true);
});

it("completes an energy-rejected heavy job after idle recharge in an unobstructed aisle", () => {
  const w = world();
  w.robots[1].battery = 30;
  w.tasks = [{ id: "RECHARGE-HEAVY", pickup: { x: 17, y: 4 }, dropoff: { x: 12, y: 12 },
    weight: 75, priority: 1, createdAt: 0, status: "pending" }];
  const runtime = new FleetRuntime(w);
  let recharged = false;
  for (let i = 0; i < 240 && runtime.world.tasks[0].status !== "completed"; i++) {
    runtime.step();
    recharged ||= runtime.charging.get("AMR-02")!.active;
  }
  expect(recharged).toBe(true);
  expect(runtime.world.tasks[0].status).toBe("completed");
  expect(runtime.world.tasks[0].assignedRobotId).toBe("AMR-02");
  expect(Object.values(runtime.safety).every(v => v === 0)).toBe(true);
});

it("keeps the production order stream completing work through repeated recharge cycles", () => {
  const runtime = new FleetRuntime();
  const orders = new OrderBook(runtime);
  let completed = 0;
  for (let tick = 0; tick < 1600; tick++) {
    orders.releaseDue();
    runtime.step();
    if ((tick + 1) % 400 === 0) {
      const next = runtime.world.tasks.filter(t => t.status === "completed").length;
      expect(next).toBeGreaterThan(completed);
      completed = next;
    }
  }
  expect(completed).toBeGreaterThan(40);
  expect(Object.values(runtime.safety).every(v => v === 0)).toBe(true);
});
