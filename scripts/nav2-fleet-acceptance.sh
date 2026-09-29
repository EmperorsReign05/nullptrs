#!/usr/bin/env bash
set -eo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT=${1:-/tmp/teamrocket-nav2-fleet}
mkdir -p "$OUTPUT"
OUTPUT=$(realpath "$OUTPUT")
cd "$ROOT"
npm run fleet:build
container_name="teamrocket-nav2-fleet-$$"
podman run --name "$container_name" --rm --network host --security-opt label=disable -e ROS_DOMAIN_ID=96 -e RMW_IMPLEMENTATION=rmw_fastrtps_cpp -v "$ROOT/ros2/teamrocket_nav_sim:/ws/src/teamrocket_nav_sim:ro" -v "$OUTPUT:/results" localhost/teamrocket-nav2:jazzy '
set -eo pipefail
source /opt/ros/jazzy/setup.bash
cd /ws
colcon build --packages-select teamrocket_nav_sim > /results/build.log 2>&1
source install/setup.bash
exec ros2 launch teamrocket_nav_sim fleet.launch.py
' > "$OUTPUT/launch.log" 2>&1 &
container_pid=$!
trap 'podman stop --time 2 "$container_name" >/dev/null 2>&1 || true; wait "$container_pid" 2>/dev/null || true' EXIT
for iteration in $(seq 1 60); do
  if python3 -c 'import socket; [socket.create_connection(("127.0.0.1",p),.2).close() for p in range(19700,19703)]' 2>/dev/null; then break; fi
  sleep 1
done
sleep 4
if [ "${NAV2_FLEET_DEMO:-0}" = "1" ]; then
  EDGE_TRANSPORT=ros2 NAV2_EXECUTOR_BASE_PORT=19700 ROS_BRIDGE_COMMAND='["podman","run","--rm","-i","--network=host","-e","ROS_DOMAIN_ID=96","localhost/teamrocket-ros2:jazzy"]' node scripts/edge-demo.mjs
else
  NAV2_FLEET_OUTPUT="$OUTPUT" node scripts/nav2-fleet-smoke.mjs > "$OUTPUT/smoke.log" 2>&1
  cat "$OUTPUT/result.json"
fi
