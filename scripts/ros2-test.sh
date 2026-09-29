#!/bin/bash
# Build a real Jazzy/Fast DDS image and exercise three independent ROS peers.
set -euo pipefail
cd "$(dirname "$0")/.."
engine=${CONTAINER_ENGINE:-podman}
image=${ROS_BRIDGE_IMAGE:-localhost/teamrocket-ros2:jazzy}
"$engine" build -f containers/ros2.Containerfile -t "$image" .
"$engine" run --rm --network=host -e ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-83}" \
  --entrypoint /bin/bash "$image" -lc \
  'source /opt/ros/jazzy/setup.bash; source /opt/teamrocket/install/setup.bash; python3 -m unittest discover -s /opt/teamrocket/src/teamrocket_bridge/test -v'
