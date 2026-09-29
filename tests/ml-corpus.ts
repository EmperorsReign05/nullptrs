import { headOnScenario } from "./ml-scenarios";
import { collectRun } from "./ml-sampler";

export type Family = "head-on" | "convoy" | "mixed";
export function randomSource(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function trafficScenario(seed: number, family: Family) {
  const rand = randomSource(seed);
  const n = 3 + Math.floor(rand() * 4);
  const sc = headOnScenario(n, seed);
  const shuffled = (values: number[]) => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };
  if (family === "head-on") return sc;
  const convoy = family === "convoy";
  const starts = shuffled(Array.from({ length: convoy ? 7 : 13 }, (_, i) => i)).slice(0, n);
  const goals = shuffled(Array.from({ length: convoy ? 6 : 13 }, (_, i) => convoy ? i + 7 : i)).slice(0, n);
  // Matching ordered positions and ordered goals permits a convoy to finish
  // without needing overtaking. Mixed runs keep the random assignment.
  if (convoy) { starts.sort((a, b) => a - b); goals.sort((a, b) => a - b); }
  const reflect = rand() < 0.5;
  for (let i = 0; i < n; i++) {
    const start = { x: 6, y: reflect ? 12 - starts[i] : starts[i] };
    const goal = { x: 6, y: reflect ? 12 - goals[i] : goals[i] };
    sc.robots[i].position = start;
    sc.robots[i].home = start;
    sc.tasks[i].pickup = start;
    sc.tasks[i].dropoff = goal;
  }
  return sc;
}

export function signature(sc: ReturnType<typeof headOnScenario>) {
  return JSON.stringify({
    open: sc.map.cells.filter((c) => !c.blocked).map((c) => c.position),
    routes: sc.robots.map((r, i) => [r.position, sc.tasks[i].dropoff]),
  });
}

export type Episode = ReturnType<typeof collectRun> & { seed: number; family: Family; signature: string };
export function buildCorpus(start: number, countPerFamily: number, seen: Set<string>): Episode[] {
  const episodes: Episode[] = [];
  for (const [index, family] of (["head-on", "convoy", "mixed"] as const).entries()) {
    let accepted = 0;
    for (let offset = 0; accepted < countPerFamily; offset++) {
      if (offset > 10000) throw new Error("scenario uniqueness exhausted");
      const seed = start + offset * 3 + index;
      const sc = trafficScenario(seed, family);
      const key = signature(sc);
      if (seen.has(key)) continue;
      seen.add(key);
      const run = collectRun(sc, seed);
      episodes.push({ ...run, seed, family, signature: key });
      accepted++;
    }
  }
  return episodes;
}
