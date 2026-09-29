import { describe, it, expect } from "vitest";
import { DistributedFleet } from "../src/core/distributed/fleet";
import { mapFromOpen } from "../src/core/bench/scenarios";
import { latticeScenario } from "./ml-scenarios";
import type { RobotState, Task } from "../src/core/types";
function contest(cut: boolean) {
  const map = mapFromOpen([{ x:0,y:0 },{ x:1,y:0 },{ x:2,y:0 }]);
  const robots: RobotState[] = [0,2].map((x,i) => ({ id: String(i), position: {x,y:0}, home: {x,y:0}, path: [], battery: 100, model: {model:"test",payloadCapacity:100}, status:"assigned", priority:0, currentTaskId:`t${i}` }));
  const tasks: Task[] = robots.map((r,i) => ({ id:`t${i}`,pickup:r.position,dropoff:{x:1,y:0},status:"in_progress",assignedRobotId:r.id,weight:1,createdAt:0,priority:1 }));
  return new DistributedFleet(map,robots,tasks,{ localCommit:true,commRange:2,severed:cut?[["0","1"]]:[] });
}
describe("per-agent synchronized commit", () => {
  it("independently resolves two simultaneous claims on an empty cell", () => {
    const f=contest(false); f.advance(0);
    expect(f.getRobots().map(r=>r.position.x)).toEqual([1,2]);
    expect(f.getAgent("1")!.getLastDecision()!.reason).toBe("lost-claim");
  });
  it("unknown contender under partition causes a safe hold", () => {
    const f=contest(true); f.advance(0);
    expect(f.getRobots().map(r=>r.position.x)).toEqual([0,2]);
  });
  it("has no overlap or swaps across small connected and severed scenario sweeps", () => {
    let ticks=0;
    for(const n of [3,6]) for(let seed=1;seed<=20;seed++) for(const severed of [false,true]) {
      const s=latticeScenario(1,n,seed,7);
      const f=new DistributedFleet(s.map,s.robots,s.tasks,{localCommit:true,commRange:6,severed:severed?[[s.robots[0].id,s.robots[1].id]]:[]});
      for(let tick=0;tick<100;tick++) {
        const prev=f.getRobots().map(r=>`${r.position.x},${r.position.y}`); f.advance(tick);
        const next=f.getRobots().map(r=>`${r.position.x},${r.position.y}`);
        expect(new Set(next).size).toBe(n);
        for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) expect(prev[i]===next[j]&&prev[j]===next[i]&&prev[i]!==next[i]).toBe(false);
        ticks++;
      }
    }
    expect(ticks).toBe(8000);
  });
});

it("older motion packets cannot overwrite or refresh newer peer state", async () => {
  const { Agent } = await import("../src/core/distributed/agent");
  const { InMemoryBus, InMemoryTransport } = await import("../src/core/distributed/transport");
  const bus = new InMemoryBus(), transport = new InMemoryTransport("a", bus);
  const map = mapFromOpen([{x:0,y:0},{x:1,y:0},{x:2,y:0}]);
  const agent = new Agent("a", {id:"a",position:{x:0,y:0},path:[],priority:0,docked:false,seq:0}, map, transport, 2);
  const packet = {kind:"tick" as const,from:"b",seq:2,position:{x:2,y:0},intent:null,priority:0,docked:false,stallTicks:0};
  bus.post("a",packet); agent.decide(0);
  bus.post("a",{...packet,seq:1,position:{x:1,y:0}}); agent.decide(1);
  expect(agent.getPeers()[0].position.x).toBe(2);
  expect(agent.getPeers()[0].lastSeenTick).toBe(0);
  bus.post("a",packet); agent.decide(4);
  expect(agent.getPeers()).toEqual([]);
});
