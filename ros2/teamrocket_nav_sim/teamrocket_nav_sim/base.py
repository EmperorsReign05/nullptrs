"""No fleet decisions: simulated differential-drive actuation and ideal sensors.
Only collision-monitor-filtered cmd_vel actuates the base. A stale command stops.
The injected obstacle is physical, stationary, and ray-cast into the lidar.
"""
import math
import time
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy
from geometry_msgs.msg import Twist, PoseStamped
from nav_msgs.msg import Odometry, OccupancyGrid
from sensor_msgs.msg import LaserScan, Imu
from std_msgs.msg import Bool, Int32

class Base(Node):
    def __init__(self):
        super().__init__('simulated_base')
        self.x = self.y = self.yaw = 0.0
        self.v = self.w = self.last_v = 0.0
        self.command_time = self.last_tick = time.monotonic()
        self.obstacle = None
        self.collisions = 0
        self.create_subscription(Twist, 'cmd_vel', self.command, 10)
        self.create_subscription(Bool, 'sim/obstacle', self.set_obstacle, 10)
        self.scan = self.create_publisher(LaserScan, 'scan', 10)
        self.imu = self.create_publisher(Imu, 'imu', 10)
        self.odom = self.create_publisher(Odometry, 'wheel/odometry', 10)
        self.truth = self.create_publisher(PoseStamped, 'sim/ground_truth', 10)
        self.collision_pub = self.create_publisher(Int32, 'sim/collisions', 10)
        self.map_pub = self.create_publisher(OccupancyGrid, 'map', QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL))
        grid = OccupancyGrid()
        grid.header.frame_id = 'map'; grid.info.resolution = 0.1
        grid.info.width = grid.info.height = 100
        grid.info.origin.position.x = grid.info.origin.position.y = -5.0
        grid.info.origin.orientation.w = 1.0
        grid.data = [100 if x in (0, 99) or y in (0, 99) else 0 for y in range(100) for x in range(100)]
        self.map_pub.publish(grid)
        self.create_timer(0.02, self.step)

    def command(self, msg):
        if math.isfinite(msg.linear.x) and math.isfinite(msg.angular.z):
            self.v, self.w = msg.linear.x, msg.angular.z
            self.command_time = time.monotonic()

    def set_obstacle(self, msg):
        if msg.data and self.obstacle is None:
            self.obstacle = (self.x + 0.36 * math.cos(self.yaw), self.y + 0.36 * math.sin(self.yaw), 0.08)
        elif not msg.data:
            self.obstacle = None

    def step(self):
        now = time.monotonic(); dt = min(now - self.last_tick, 0.1); self.last_tick = now
        v, w = (self.v, self.w) if now - self.command_time <= 0.3 else (0.0, 0.0)
        self.yaw += w * dt
        self.x += v * math.cos(self.yaw) * dt; self.y += v * math.sin(self.yaw) * dt
        # Audit, never fix a collision or veto physics to make safety look good.
        if self.obstacle and math.hypot(self.x-self.obstacle[0], self.y-self.obstacle[1]) < self.obstacle[2]+0.12:
            self.collisions += 1
        stamp = self.get_clock().now().to_msg()
        pose = PoseStamped(); pose.header.stamp = stamp; pose.header.frame_id = 'map'
        pose.pose.position.x = self.x; pose.pose.position.y = self.y
        pose.pose.orientation.z = math.sin(self.yaw/2); pose.pose.orientation.w = math.cos(self.yaw/2)
        self.truth.publish(pose)
        odom = Odometry(); odom.header.stamp = stamp; odom.header.frame_id = 'odom'; odom.child_frame_id = 'base_link'
        odom.pose.pose = pose.pose; odom.twist.twist.linear.x = v; odom.twist.twist.angular.z = w
        for i in (0, 7, 14, 21, 28, 35): odom.pose.covariance[i] = odom.twist.covariance[i] = 0.0001
        self.odom.publish(odom)
        imu = Imu(); imu.header.stamp = stamp; imu.header.frame_id = 'base_link'; imu.orientation = pose.pose.orientation
        imu.angular_velocity.z = w; imu.linear_acceleration.x = (v-self.last_v)/max(dt, 0.0001); self.last_v = v
        for i in (0, 4, 8): imu.orientation_covariance[i] = imu.angular_velocity_covariance[i] = imu.linear_acceleration_covariance[i] = 0.0001
        self.imu.publish(imu)
        scan = LaserScan(); scan.header.stamp = stamp; scan.header.frame_id = 'base_link'
        scan.angle_min = -math.pi; scan.angle_max = math.pi; scan.angle_increment = 2*math.pi/360
        scan.range_min = 0.02; scan.range_max = 8.0; scan.scan_time = 0.02
        ranges = []
        for i in range(361):
            angle = self.yaw+scan.angle_min+i*scan.angle_increment
            dx, dy = math.cos(angle), math.sin(angle)
            distances = [8.0]
            if abs(dx)>1e-9: distances.append(((4.9 if dx>0 else -4.9)-self.x)/dx)
            if abs(dy)>1e-9: distances.append(((4.9 if dy>0 else -4.9)-self.y)/dy)
            if self.obstacle:
                ox, oy = self.x-self.obstacle[0], self.y-self.obstacle[1]
                b = ox*dx+oy*dy; disc = b*b-(ox*ox+oy*oy-self.obstacle[2]**2)
                if disc>=0 and -b-math.sqrt(disc)>0: distances.append(-b-math.sqrt(disc))
            ranges.append(float(min(d for d in distances if d>0)))
        scan.ranges = ranges; self.scan.publish(scan)
        self.collision_pub.publish(Int32(data=self.collisions))

def main():
    rclpy.init(); node = Base()
    try: rclpy.spin(node)
    finally: node.destroy_node(); rclpy.shutdown()
