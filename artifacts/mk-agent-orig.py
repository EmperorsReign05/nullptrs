import io

src = open("src/core/distributed/agent.ts").read()
o = src

o = o.replace(
    'const EMPTY_BAYS: ReadonlySet<string> = new Set<string>();\n'
    '\n'
    '// ---- TEMPORARY MEASUREMENT SWITCHES. Remove before committing. ----\n'
    'const DIST_NO_COLLINEAR_RETREAT = process.env.DIST_NO_COLLINEAR_RETREAT ?? "1";\n'
    'const DIST_YIELD = process.env.DIST_YIELD ?? "shuffle";',
    'const EMPTY_BAYS: ReadonlySet<string> = new Set<string>();')

start = o.index("  /**\n   * Remember a cell that kept physically blocking me")
end = o.index("  /** Would stepping into `bay` put me somewhere I have no right to be? */")
o = o[:start] + o[end:]

o = o.replace(
    '\n/**\n'
    ' * Consecutive ticks the same physical cell must block my next step before I\n'
    ' * treat it as a wall for planning. One tick of blockage is ordinary traffic and\n'
    ' * must not re-plan; a robot standing still in a single-file corridor blocks me\n'
    ' * on every tick, and that is the case A* cannot see through on its own.\n'
    ' */\n'
    'export const PERSISTENT_BLOCK_TICKS = 3;\n'
    '\n'
    '/**\n'
    ' * How long a learned obstruction is remembered. Long enough to route around a\n'
    ' * robot that is parked for the rest of the run, short enough that a robot that\n'
    ' * has genuinely moved on stops distorting my routes.\n'
    ' */\n'
    'export const BLOCKER_MEMORY_TICKS = 60;', '')

o = o.replace(
    '  private lastScan: SensorScan | null = null;\n'
    '  /** Cell -> when I learned it was impassable for me. Learned from my sensor. */\n'
    '  private rememberedBlockers = new Map<string, { pos: Position; until: number }>();\n'
    '  /** Consecutive ticks each candidate blocker has denied me my next step. */\n'
    '  private blockerStreak = new Map<string, number>();',
    '  private lastScan: SensorScan | null = null;')

o = o.replace('      this.noteBlocker(preferredCell, sensorScan, currentTick);\n', '')
o = o.replace('      // A robot is physically sitting on the cell I was about to enter. Note\n      // it: if the SAME cell keeps blocking me, the route through it is not\n      // merely slow, it is impossible, and I have to plan around it. See\n      // noteBlocker() for why A* will not do this on its own.\n', '')

NEW_CHOSEN = (
    '      const chosen =\n'
    '        progressing[0] ??\n'
    '        (DIST_YIELD === "shuffle"\n'
    '          ? this.offLineOrSafe(safe, from, preferredCell)\n'
    '          : DIST_YIELD === "offline"\n'
    '            ? this.offLineOrSafe(safe, from, preferredCell)\n'
    '            : null);')
OLD_CHOSEN = ('      const chosen = progressing[0] ?? safe[0] ?? '
              'emergencyEscape(from, sensorScan, this.map);')
assert NEW_CHOSEN in o, "chosen block not found"
o = o.replace(NEW_CHOSEN, OLD_CHOSEN)

ts = o.index("  /**\n   * Announce ourselves, then return the move to be executed.")
te = o.index("  /** Apply our own move and advance local state. */")
TICK = (
    '  /** Announce ourselves, then return the move to execute. */\n'
    '  tick(currentTick: number): AgentDecision {\n'
    '    const decision = this.decide(currentTick);\n'
    '    this.transport.send(undefined, {\n'
    '      kind: "tick",\n'
    '      from: this.id,\n'
    '      seq: this.local.seq,\n'
    '      position: this.local.position,\n'
    '      intent: positionsEqual(decision.to, this.local.position) ? null : decision.to,\n'
    '      priority: this.local.priority,\n'
    '      docked: this.local.docked,\n'
    '      stallTicks: this.stallTicks,\n'
    '    });\n'
    '    return decision;\n'
    '  }\n\n')
o = o[:ts] + TICK + o[te:]

for a, b in [
    ('from "../map/warehouse"', 'from "../src/core/map/warehouse"'),
    ('from "../map/graph"', 'from "../src/core/map/graph"'),
    ('from "../types"', 'from "../src/core/types"'),
    ('from "./protocol"', 'from "../src/core/distributed/protocol"'),
    ('from "./transport"', 'from "../src/core/distributed/transport"'),
    ('from "./sensor"', 'from "../src/core/distributed/sensor"'),
]:
    o = o.replace(a, b)

bad = [t for t in ["noteBlocker", "offLineOrSafe", "DIST_", "PERSISTENT_BLOCK",
                   "rememberedBlockers", "blockerStreak", "scanSees",
                   "routeRunsIntoBlocker", "getRememberedBlockers"] if t in o]
assert not bad, "leftover: %r" % bad
open("artifacts/agentOrig.ts", "w").write(o)
print("reconstructed artifacts/agentOrig.ts:", len(o), "bytes, no new constructs remain")
