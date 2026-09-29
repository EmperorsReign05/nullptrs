from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import os

def generate_launch_description():
    cfg = os.path.join(get_package_share_directory('teamrocket_nav_sim'), 'config', 'nav2.yaml')
    return LaunchDescription([
        Node(package='teamrocket_nav_sim', executable='base', output='screen'),
        Node(package='robot_localization', executable='ekf_node', name='ekf_filter_node', parameters=[cfg], output='screen'),
        Node(package='tf2_ros', executable='static_transform_publisher', arguments=['--frame-id', 'map', '--child-frame-id', 'odom']),
        Node(package='nav2_controller', executable='controller_server', name='controller_server', parameters=[cfg], remappings=[('cmd_vel', 'cmd_vel_nav')], output='screen'),
        Node(package='nav2_collision_monitor', executable='collision_monitor', name='collision_monitor', parameters=[cfg], output='screen'),
        Node(package='nav2_lifecycle_manager', executable='lifecycle_manager', name='lifecycle_manager_execution', parameters=[{'autostart': True, 'node_names': ['controller_server', 'collision_monitor'], 'bond_timeout': 0.0}], output='screen'),
        Node(package='teamrocket_nav_sim', executable='executor', output='screen'),
    ])
