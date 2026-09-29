FROM docker.io/library/ros:jazzy-ros-base@sha256:c3706ef0a0aa45413c07803cf433602f543b22e45b4855f6fca955c2d8ecc4e8
ENV RMW_IMPLEMENTATION=rmw_fastrtps_cpp
COPY containers/fastdds-udp.xml /opt/teamrocket/fastdds-udp.xml
ENV FASTRTPS_DEFAULT_PROFILES_FILE=/opt/teamrocket/fastdds-udp.xml
WORKDIR /opt/teamrocket
COPY ros2/teamrocket_bridge/ /opt/teamrocket/src/teamrocket_bridge/
RUN . /opt/ros/jazzy/setup.sh && colcon build --merge-install
COPY scripts/ros2-entrypoint.sh /usr/local/bin/teamrocket-ros2
ENTRYPOINT ["/usr/local/bin/teamrocket-ros2"]
CMD ["--help"]
