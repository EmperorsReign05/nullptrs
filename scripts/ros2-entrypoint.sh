#!/bin/bash
set -eo pipefail
source /opt/ros/jazzy/setup.bash
source /opt/teamrocket/install/setup.bash
set -u
export RMW_IMPLEMENTATION=rmw_fastrtps_cpp
exec ros2 run teamrocket_bridge peer_bridge "$@"
