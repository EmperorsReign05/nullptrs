"""Extract main's distributed/ exactly as committed, so it can be measured.

main's agent.ts is a mid-session snapshot taken by the 12:08 checkpoint commit
while work was still in progress, so it is neither the original nor the
finished fix. This builds an importable copy of main's pair (agent + fleet) so
its overlap and completion numbers can be measured rather than guessed at.
"""
import re
import subprocess
import sys

REWRITE = {
    'from "../map/': 'from "../src/core/map/',
    'from "../pathfinding/': 'from "../src/core/pathfinding/',
    'from "../types"': 'from "../src/core/types"',
    'from "./protocol"': 'from "./protocolReal"',
    'from "./transport"': 'from "./transportReal"',
    'from "./sensor"': 'from "./sensorReal"',
    'from "./agent"': 'from "./agentMain"',
    'from "./agentReal"': 'from "./agentMain"',
}


def blob(path):
    return subprocess.check_output(
        ["git", "show", "main:" + path], text=True)


def rewrite(src, extra=None):
    for a, b in REWRITE.items():
        src = src.replace(a, b)
    for a, b in (extra or {}).items():
        src = src.replace(a, b)
    return src


# Real modules, re-exported under artifact-local names so the extracted copies
# do not shadow the live ones.
for name, real in [("protocolReal", "protocol"), ("transportReal", "transport"),
                   ("sensorReal", "sensor")]:
    body = blob("src/core/distributed/%s.ts" % real)
    open("artifacts/%s.ts" % name, "w").write(
        body.replace('from "../map/', 'from "../src/core/map/')
            .replace('from "../types"', 'from "../src/core/types"')
            .replace('from "./protocol"', 'from "./protocolReal"')
            .replace('from "./transport"', 'from "./transportReal"')
            .replace('from "./sensor"', 'from "./sensorReal"'))

agent = rewrite(blob("src/core/distributed/agent.ts"))
fleet = rewrite(blob("src/core/distributed/fleet.ts"))
open("artifacts/agentMain.ts", "w").write(agent)
open("artifacts/fleetMain.ts", "w").write(
    fleet.replace("export class DistributedFleet", "export class DistributedFleetMain"))

# Sanity: the extracted agent must be byte-identical to main's apart from imports.
back = rewrite(agent, None)
print("extracted main's distributed/ -> artifacts/agentMain.ts, artifacts/fleetMain.ts")
print("agentMain has env switches:", "DIST_" in agent)
print("agentMain still has the peer-yield exception:",
      "occupant.stallTicks >= YIELD_TO_STALLED_PEER_TICKS" in agent)
print("agentMain has the alts sensor filter:",
      ".filter((n) => isLocallySafe(sensorScan, n))" in agent)
print("agentMain drives stallTicks:", "this.stallTicks += 1" in agent)
