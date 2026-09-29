#!/bin/bash
# Build a real Jazzy/Fast DDS image and exercise the configured N independent ROS peers.
# FLEET_N selects the roster; config/fleet.json is the single source of truth.
set -euo pipefail
cd "$(dirname "$0")/.."
engine=${CONTAINER_ENGINE:-podman}
image=${ROS_BRIDGE_IMAGE:-localhost/teamrocket-ros2:jazzy}
run_config="$PWD/artifacts/.ros2-test-fleet.json"
"$engine" build -f containers/ros2.Containerfile -t "$image" .
node --input-type=module -e "
import {writeRunConfig} from './scripts/fleet-config.mjs';
writeRunConfig(Number(process.env.FLEET_N || 3), process.argv[1]);
" "$run_config"
chmod 644 "$run_config"
# :z relabels the host roster for the container; without it a freshly written
# file is unreadable inside SELinux-enforcing rootless podman.
"$engine" run --rm --network=host -e ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-83}" \
  -e FLEET_CONFIG=/fleet/fleet.json \
  -v "$run_config:/fleet/fleet.json:ro,z" \
  --entrypoint /bin/bash "$image" -lc \
  'source /opt/ros/jazzy/setup.bash; source /opt/teamrocket/install/setup.bash; python3 -m unittest discover -s /opt/teamrocket/src/teamrocket_bridge/test -v'
