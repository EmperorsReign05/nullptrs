#!/usr/bin/env bash
# Real Nav2 acceptance for an arbitrary-N fleet.
#
#   FLEET_N=5 scripts/nav2-fleet-acceptance.sh artifacts/n-robot/nav2-n5
#
# A config for FLEET_N is generated and becomes the single source of truth for
# this run: the ROS launch, the peer bridges, the executors and the host scenario
# all read it. Nothing here encodes a robot count beyond FLEET_N itself.
set -eo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FLEET_N=${FLEET_N:-3}
OUTPUT=${1:-"$ROOT/artifacts/n-robot/nav2-n$FLEET_N"}
mkdir -p "$OUTPUT"
OUTPUT=$(realpath "$OUTPUT")
cd "$ROOT"
npm run fleet:build
RUN_CONFIG="$OUTPUT/fleet.json"
node --input-type=module -e "
import {writeRunConfig} from './scripts/fleet-config.mjs';
writeRunConfig(Number(process.env.FLEET_N), process.argv[1]);
" "$RUN_CONFIG"
export FLEET_CONFIG="$RUN_CONFIG"
ROS_DOMAIN_ID=$(node -e "console.log(require('./.fleet-dist/src/core/fleet/config.js').loadFleetConfig().rosDomainId)")
EXEC_PORTS=$(node -e "console.log(require('./.fleet-dist/src/core/fleet/config.js').loadFleetConfig().robots.map(r=>r.executorPort).join(','))")
echo "fleet: N=$FLEET_N config=$RUN_CONFIG domain=$ROS_DOMAIN_ID executors=$EXEC_PORTS"
container_name="teamrocket-nav2-fleet-n${FLEET_N}-$$"
podman run --name "$container_name" --rm --network host --security-opt label=disable -e ROS_DOMAIN_ID="$ROS_DOMAIN_ID" -e RMW_IMPLEMENTATION=rmw_fastrtps_cpp -v "$ROOT/ros2/teamrocket_nav_sim:/ws/src/teamrocket_nav_sim:ro" -v "$OUTPUT:/results" localhost/teamrocket-nav2:jazzy '
set -eo pipefail
source /opt/ros/jazzy/setup.bash
cd /ws
colcon build --packages-select teamrocket_nav_sim > /results/build.log 2>&1
source install/setup.bash
exec ros2 launch teamrocket_nav_sim fleet.launch.py fleet_config:=/results/fleet.json
' > "$OUTPUT/launch.log" 2>&1 &
container_pid=$!
trap 'podman stop --time 2 "$container_name" >/dev/null 2>&1 || true; wait "$container_pid" 2>/dev/null || true' EXIT
# Every configured executor must answer before the fleet is considered up. A miss
# is a hard failure: proceeding would test a half-initialised fleet.
ready=0
for iteration in $(seq 1 $((30 + FLEET_N * 15))); do
  if EXEC_PORTS="$EXEC_PORTS" python3 -c '
import os, socket, sys
for p in os.environ["EXEC_PORTS"].split(","):
    socket.create_connection(("127.0.0.1", int(p)), 0.2).close()
' 2>/dev/null; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "FATAL: not all $FLEET_N executors ($EXEC_PORTS) became ready" >&2
  tail -30 "$OUTPUT/launch.log" >&2 || true
  exit 1
fi
sleep 3
if [ "${NAV2_FLEET_DEMO:-0}" = "1" ]; then
  EDGE_TRANSPORT=ros2 ROS_BRIDGE_COMMAND="[\"podman\",\"run\",\"--rm\",\"-i\",\"--network=host\",\"-e\",\"ROS_DOMAIN_ID=$ROS_DOMAIN_ID\",\"localhost/teamrocket-ros2:jazzy\"]" node scripts/edge-demo.mjs
else
  NAV2_FLEET_OUTPUT="$OUTPUT" node scripts/nav2-fleet-smoke.mjs > "$OUTPUT/smoke.log" 2>&1 || {
    echo "FATAL: Nav2 fleet smoke failed for N=$FLEET_N" >&2
    tail -40 "$OUTPUT/smoke.log" >&2
    exit 1
  }
  cat "$OUTPUT/result.json"
fi
