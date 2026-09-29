#!/usr/bin/env bash
set -eo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT=${1:-/tmp/teamrocket-nav2-acceptance}
mkdir -p "$OUTPUT"
OUTPUT=$(realpath "$OUTPUT")
podman build -t localhost/teamrocket-nav2:jazzy -f "$ROOT/ros2/teamrocket_nav_sim/Containerfile" "$ROOT"
podman run --rm --network host --security-opt label=disable -e ROS_DOMAIN_ID=93 -e RMW_IMPLEMENTATION=rmw_fastrtps_cpp -e NAV2_RESULT=/results/result.json -v "$ROOT/ros2/teamrocket_nav_sim:/ws/src/teamrocket_nav_sim:ro" -v "$OUTPUT:/results" localhost/teamrocket-nav2:jazzy '
set -eo pipefail
source /opt/ros/jazzy/setup.bash
cd /ws
colcon build --packages-select teamrocket_nav_sim > /results/build.log 2>&1
source install/setup.bash
ros2 launch teamrocket_nav_sim simulation.launch.py > /results/launch.log 2>&1 &
launch_pid=$!
trap "kill $launch_pid 2>/dev/null || true" EXIT
sleep 5
ros2 run teamrocket_nav_sim acceptance > /results/acceptance.log 2>&1
'
cat "$OUTPUT/result.json"
