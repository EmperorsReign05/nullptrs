"""Real ROS/Nav2 acceptance, not a mock controller. Nonzero exit on failure."""
import json
import os
import time
import rclpy
from rclpy.node import Node
from nav_msgs.msg import Path, Odometry
from sensor_msgs.msg import LaserScan, Imu
from geometry_msgs.msg import PoseStamped, Twist
from std_msgs.msg import Bool, Int32, String

class Acceptance(Node):
    def __init__(self):
        super().__init__('nav2_acceptance')
        self.route = self.create_publisher(Path, 'authorized_path', 10)
        self.obstacle = self.create_publisher(Bool, 'sim/obstacle', 10)
        self.x = 0.0; self.samples = {'scan': 0, 'imu': 0, 'wheel_odometry': 0, 'filtered_odometry': 0}; self.collisions = 0
        self.events = []; self.raw_nonzero_during_stop = 0; self.zero_filtered_during_stop = 0; self.phase = 'starting'
        self.create_subscription(PoseStamped, 'sim/ground_truth', lambda m: setattr(self, 'x', m.pose.position.x), 10)
        self.create_subscription(Int32, 'sim/collisions', lambda m: setattr(self, 'collisions', m.data), 10)
        for cls, topic, label in [(LaserScan,'scan','scan'), (Imu,'imu','imu'), (Odometry,'wheel/odometry','wheel_odometry'), (Odometry,'odometry/filtered','filtered_odometry')]:
            self.create_subscription(cls, topic, lambda m, label=label: self.samples.__setitem__(label, self.samples[label]+1), 10)
        self.create_subscription(Twist, 'cmd_vel_nav', self.raw, 10)
        self.create_subscription(Twist, 'cmd_vel', self.filtered, 10)
        self.create_subscription(String, 'execution_status', lambda m: self.events.append(json.loads(m.data)), 10)
    def raw(self, m):
        if self.phase == 'blocked' and abs(m.linear.x)>0.01: self.raw_nonzero_during_stop += 1
    def filtered(self, m):
        if self.phase == 'blocked' and abs(m.linear.x)<0.0001: self.zero_filtered_during_stop += 1
    def send(self, target=2.0):
        path = Path(); path.header.frame_id = 'map'; path.header.stamp = self.get_clock().now().to_msg()
        for i in range(41):
            pose = PoseStamped(); pose.header = path.header; pose.pose.position.x = self.x+(target-self.x)*i/40; pose.pose.orientation.w = 1.0; path.poses.append(pose)
        self.route.publish(path)

def main():
    rclpy.init(); n = Acceptance(); start = time.monotonic(); blocked = None; release = None; min_x = max_x = None; sent = False
    while time.monotonic()-start < 50:
        rclpy.spin_once(n, timeout_sec=0.05); elapsed = time.monotonic()-start
        if not sent and elapsed>3 and all(n.samples.values()): n.send(); sent=True; n.phase='moving'
        if n.phase=='moving' and n.x>0.3:
            blocked=time.monotonic(); n.obstacle.publish(Bool(data=True)); n.phase='blocked'
        if n.phase=='blocked' and time.monotonic()-blocked>0.5:
            min_x=n.x if min_x is None else min(min_x,n.x); max_x=n.x if max_x is None else max(max_x,n.x)
            if time.monotonic()-blocked>3:
                n.obstacle.publish(Bool(data=False)); n.phase='released'; release=n.x
        if n.phase=='released' and any(e.get('status')==4 and e.get('error_code')==0 for e in n.events): break
    result={'schema':1, 'deployment':'real ROS2 Jazzy / Nav2 controller and collision monitor, ideal kinematic simulated sensors; no physical hardware', 'samples':n.samples,'events':n.events,'raw_commands_while_blocked':n.raw_nonzero_during_stop,'filtered_stops_while_blocked':n.zero_filtered_during_stop,'blocked_drift_m':None if min_x is None else max_x-min_x,'final_x_m':n.x,'release_x_m':release,'collision_ticks':n.collisions, 'elapsed_seconds':time.monotonic()-start}
    result['passed']=bool(sent and release is not None and n.x>1.9 and min_x is not None and max_x-min_x<0.02 and n.collisions==0 and n.raw_nonzero_during_stop>0 and n.zero_filtered_during_stop>0 and all(n.samples.values()) and any(e.get('status')==4 and e.get('error_code')==0 for e in n.events))
    # Revocation is safety-relevant: cancel an executing Nav2 action, then
    # establish that the simulated actuator really stops, not just its status.
    n.send(3.0); deadline=time.monotonic()+8
    while n.x<2.15 and time.monotonic()<deadline:
        rclpy.spin_once(n, timeout_sec=0.05)
    was_moving=n.x>=2.15
    revoke=Path(); revoke.header.frame_id='map'; n.route.publish(revoke)
    revoked_at=time.monotonic(); positions=[]
    while time.monotonic()-revoked_at<2:
        rclpy.spin_once(n, timeout_sec=0.05)
        if time.monotonic()-revoked_at>0.5: positions.append(n.x)
    drift=max(positions)-min(positions) if positions else None
    result['revocation']={'started_second_route':was_moving, 'settled_drift_m':drift,
                          'cancelled_action':any(e.get('status')==5 for e in n.events),
                          'revoked_reported':any(e.get('state')=='revoked' for e in n.events)}
    result['passed']=bool(result['passed'] and was_moving and drift is not None and drift<0.02 and result['revocation']['cancelled_action'] and result['revocation']['revoked_reported'])
    result['elapsed_seconds']=time.monotonic()-start
    result['collision_ticks']=n.collisions
    result['final_x_after_revocation_m']=n.x
    result['passed']=bool(result['passed'] and n.collisions==0)
    output=os.environ.get('NAV2_RESULT','/tmp/nav2-result.json')
    with open(output,'w') as f: json.dump(result,f,indent=2)
    print(json.dumps(result),flush=True); n.destroy_node(); rclpy.shutdown()
    raise SystemExit(0 if result['passed'] else 1)
