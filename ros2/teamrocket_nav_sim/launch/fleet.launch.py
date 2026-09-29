"""Three isolated TF graphs; common simulated physical pose bus for lidar.
No task allocator or movement arbitration runs in this launch file.
"""
import os
import tempfile
import yaml
from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory

def generate_launch_description():
    source = os.path.join(get_package_share_directory('teamrocket_nav_sim'), 'config', 'nav2.yaml')
    actions = []
    for i in range(3):
        ns = f'AMR_0{i+1}'
        cfg = yaml.safe_load(open(source))
        cfg['local_costmap']['local_costmap']['ros__parameters']['static_layer']['map_topic'] = f'/{ns}/map'
        handle = tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False)
        yaml.safe_dump({ns: cfg}, handle); handle.close()
        def node(package, executable, **kw):
            return Node(package=package, executable=executable, namespace=ns, output='screen', remappings=[('/tf','tf'),('/tf_static','tf_static')]+kw.pop('remappings',[]), **kw)
        actions += [
            node('teamrocket_nav_sim','base',parameters=[{'world_x':0.6,'world_y':0.6*(1+3*i)}]),
            node('robot_localization','ekf_node',name='ekf_filter_node',parameters=[handle.name]),
            node('tf2_ros','static_transform_publisher',arguments=['--frame-id','map','--child-frame-id','odom']),
            node('nav2_controller','controller_server',name='controller_server',parameters=[handle.name],remappings=[('cmd_vel','cmd_vel_nav')]),
            node('nav2_collision_monitor','collision_monitor',name='collision_monitor',parameters=[handle.name]),
            node('nav2_lifecycle_manager','lifecycle_manager',name='lifecycle_manager_execution',parameters=[{'autostart':True,'node_names':['controller_server','collision_monitor'],'bond_timeout':0.0}]),
            node('teamrocket_nav_sim','fleet_executor',parameters=[{'port':19700+i,'grid_x':1,'grid_y':1+3*i}]),
        ]
    return LaunchDescription(actions)
