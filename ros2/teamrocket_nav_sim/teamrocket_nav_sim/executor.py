"""Follow the supplied authorized path; never generate a global plan.
A replacement cancels the previous action before sending the next one. Empty
path revokes execution. This is an adapter boundary, not an ownership authority.
"""
import json
import math
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from nav_msgs.msg import Path
from nav2_msgs.action import FollowPath
from std_msgs.msg import String

class Executor(Node):
    def __init__(self):
        super().__init__('authorized_path_executor')
        self.client = ActionClient(self, FollowPath, 'follow_path')
        self.status = self.create_publisher(String, 'execution_status', 10)
        self.pending = None; self.goal_handle = None; self.busy = False; self.canceling = False
        self.create_subscription(Path, 'authorized_path', self.authorize, 10)
        self.create_timer(0.1, self.update)

    def report(self, state, **extra):
        self.status.publish(String(data=json.dumps({'state': state, **extra})))

    def authorize(self, path):
        if path.header.frame_id != 'map' or any(not all(math.isfinite(v) for v in (p.pose.position.x, p.pose.position.y, p.pose.orientation.z, p.pose.orientation.w)) for p in path.poses):
            self.report('invalid_path'); return
        self.pending = path
        if self.goal_handle and not self.canceling:
            self.canceling = True
            self.goal_handle.cancel_goal_async()
        self.report('replacement_queued' if self.busy else 'authorized')

    def update(self):
        if self.busy or self.pending is None or not self.client.server_is_ready(): return
        path = self.pending; self.pending = None
        if not path.poses:
            self.report('revoked'); return
        goal = FollowPath.Goal(); goal.path = path; goal.controller_id = 'FollowPath'; goal.goal_checker_id = 'goal_checker'; goal.progress_checker_id = 'progress_checker'
        self.busy = True
        self.client.send_goal_async(goal).add_done_callback(self.accepted)

    def accepted(self, future):
        self.goal_handle = future.result()
        if not self.goal_handle.accepted:
            self.busy = False; self.goal_handle = None; self.report('rejected'); return
        self.report('executing')
        self.goal_handle.get_result_async().add_done_callback(self.finished)
        if self.pending is not None:
            self.canceling = True; self.goal_handle.cancel_goal_async()

    def finished(self, future):
        result = future.result()
        self.report('finished', status=result.status, error_code=result.result.error_code)
        self.goal_handle = None; self.busy = self.canceling = False

def main():
    rclpy.init(); node = Executor()
    try: rclpy.spin(node)
    finally: node.destroy_node(); rclpy.shutdown()
