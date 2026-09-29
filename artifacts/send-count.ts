// Does the change alter how many datagrams an agent sends per tick? The flaky
// UDP assertion is "at least one agent observed at least one peer", so if the
// send count is identical the flake cannot have been introduced here.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { DistributedFleetOrig } from "./fleetOrig";
import { latticeScenario } from "../tests/ml-scenarios";

const impls = [
  { name: "ORIG", Impl: DistributedFleetOrig },
  { name: "NEW ", Impl: DistributedFleet },
];

for (const { name, Impl } of impls) {
  const sc = latticeScenario(1, 8, 5, 7);
  const f: any = new (Impl as any)(sc.map, JSON.parse(JSON.stringify(sc.robots)), JSON.parse(JSON.stringify(sc.tasks)), { commRange: 6 });
  let sends = 0;
  let decides = 0;
  for (const agent of f["agents"].values()) {
    const t = agent.getTransportForTest?.() ?? null;
    void t;
    const origTick = agent.tick.bind(agent);
    agent.tick = (tick: number) => { sends++; return origTick(tick); };
    const origDecide = agent.decide.bind(agent);
    agent.decide = (tick: number) => { decides++; return origDecide(tick); };
  }
  for (let t = 0; t < 200; t++) { f["replanAll"](t); f["step"](t); f["applyMoves"](); }
  console.log(`${name}: broadcasts=${sends} (200 ticks x 8 agents = 1600 expected), decide() calls=${decides} (1600 expected)`);
}
