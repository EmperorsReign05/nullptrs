// Locate every remaining cell-overlap event and classify it.
import { DistributedFleet } from "../src/core/distributed/fleet";
import { latticeScenario } from "../tests/ml-scenarios";
import type { Position } from "../src/core/types";

const key = (p: Position) => `${p.x},${p.y}`;
const seeds = Number(process.argv[2] ?? 80);
const maxTicks = Number(process.argv[3] ?? 400);
const ns = (process.argv[4] ?? "10,12").split(",").map(Number);

let events = 0;
for (const n of ns) {
  for (let s = 1; s <= seeds; s++) {
    const sc = latticeScenario(1, n, s, 7);
    const robots = JSON.parse(JSON.stringify(sc.robots));
    const tasks = JSON.parse(JSON.stringify(sc.tasks));
    const f = new DistributedFleet(sc.map, robots, tasks, { commRange: 6 });
    for (let t = 0; t < maxTicks; t++) {
      const before = new Map(f.getRobots().map((r) => [r.id, key(r.position)]));
      const reasons = new Map<string, string>();
      f["replanAll"](t);
      f["step"](t);
      for (const agent of f["agents"].values()) {
        const d = agent.getLastDecision()!;
        reasons.set(agent.id, d.reason);
      }
      f["applyMoves"](t);
      const cells = f.getRobots().map((r) => key(r.position));
      const seen = new Map<string, string[]>();
      f.getRobots().forEach((r) => seen.set(key(r.position), [...(seen.get(key(r.position)) ?? []), r.id]));
      for (const [cell, ids] of seen) if (ids.length > 1) {
        events++;
        const detail = ids.map((id) => `${id} ${before.get(id)}->${cell} (${reasons.get(id)})`).join("  |  ");
        console.log(`n=${n} seed=${s} tick=${t} cell ${cell}: ${detail}`);
      }
      if (tasks.every((x) => x.status === "completed")) break;
    }
  }
}
console.log(`total overlap events: ${events} over ${ns.join(",")} x ${seeds} seeds`);
