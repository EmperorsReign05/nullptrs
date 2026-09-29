"""One isolated ROS stack per configured robot; common simulated pose bus for lidar.
No task allocator or movement arbitration runs in this launch file.

Fleet membership, namespaces, grid origins and executor ports all come from the
single fleet config (default /fleet/fleet.json, override with the `fleet_config`
launch argument or $FLEET_CONFIG). Adding a robot is a config edit, never a code
edit. Each robot gets a private namespace, a private TF graph (achieved by
remapping /tf and /tf_static to relative names, which is why every robot may use
the same odom/base_link frame names without cross-linking), a private Nav2 stack
and a private physical executor.
"""
import json
import os
import shutil
import tempfile
import yaml
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction, RegisterEventHandler
from launch.event_handlers import OnShutdown
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory

DEFAULT_FLEET_CONFIG = '/fleet/fleet.json'


def _fleet(context, *args, **kwargs):
    path = LaunchConfiguration('fleet_config').perform(context)
    if not path:
        path = os.environ.get('FLEET_CONFIG') or DEFAULT_FLEET_CONFIG
    with open(path) as handle:
        config = json.load(handle)
    cell = float(config.get('cellMetres', 0.6))
    robots = config.get('robots') or []
    if not robots:
        raise RuntimeError(f'Fleet config {path} declares no robots')

    source = os.path.join(get_package_share_directory('teamrocket_nav_sim'), 'config', 'nav2.yaml')
    workdir = tempfile.mkdtemp(prefix='teamrocket-nav2-')
    actions = []
    seen_ids, seen_namespaces, seen_ports, seen_origins = set(), set(), set(), set()
    for robot in robots:
        rid = robot['id']
        ns = robot['namespace']
        origin = robot['origin']
        port = int(robot['executorPort'])
        for value, bucket, label in ((rid, seen_ids, 'id'), (ns, seen_namespaces, 'namespace'),
                                     (port, seen_ports, 'executor port'),
                                     ((origin['x'], origin['y']), seen_origins, 'origin')):
            if value in bucket:
                raise RuntimeError(f'Duplicate {label} {value!r} in fleet config {path}')
            bucket.add(value)

        # Physical offset is derived from the config origin, never re-hardcoded:
        # the host grid and the ROS world must agree or /initialize is rejected.
        world_x, world_y = origin['x'] * cell, origin['y'] * cell
        with open(source) as handle:
            cfg = yaml.safe_load(handle)
        # Nav2 must read THIS robot's map, never another namespace's.
        cfg['local_costmap']['local_costmap']['ros__parameters']['static_layer']['map_topic'] = f'/{ns}/map'
        params = os.path.join(workdir, f'{ns}.yaml')
        with open(params, 'w') as handle:
            yaml.safe_dump({ns: cfg}, handle)

        def node(package, executable, **node_kw):
            return Node(package=package, executable=executable, namespace=ns, output='screen',
                        remappings=[('/tf', 'tf'), ('/tf_static', 'tf_static')] + node_kw.pop('remappings', []),
                        **node_kw)

        actions += [
            node('teamrocket_nav_sim', 'base', parameters=[{'world_x': world_x, 'world_y': world_y}]),
            node('robot_localization', 'ekf_node', name='ekf_filter_node', parameters=[params]),
            node('tf2_ros', 'static_transform_publisher',
                 arguments=['--frame-id', 'map', '--child-frame-id', 'odom']),
            node('nav2_controller', 'controller_server', name='controller_server', parameters=[params],
                 remappings=[('cmd_vel', 'cmd_vel_nav')]),
            node('nav2_collision_monitor', 'collision_monitor', name='collision_monitor', parameters=[params]),
            node('nav2_lifecycle_manager', 'lifecycle_manager', name='lifecycle_manager_execution',
                 parameters=[{'autostart': True, 'node_names': ['controller_server', 'collision_monitor'],
                              'bond_timeout': 0.0}]),
            node('teamrocket_nav_sim', 'fleet_executor',
                 parameters=[{'port': port, 'grid_x': int(origin['x']), 'grid_y': int(origin['y'])}]),
        ]
    actions.append(RegisterEventHandler(OnShutdown(
        on_shutdown=lambda event, context: shutil.rmtree(workdir, ignore_errors=True))))
    return actions


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('fleet_config', default_value=os.environ.get('FLEET_CONFIG', DEFAULT_FLEET_CONFIG),
                              description='Path to the canonical fleet config.'),
        OpaqueFunction(function=_fleet),
    ])
