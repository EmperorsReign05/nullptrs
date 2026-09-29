"""Per-robot trusted loopback FollowPath adapter. No fleet routing decisions.
Cell progress is acknowledged only after action success and measured arrival.
Partial failures latch and retain pose; a clock host must stop, not teleport.
"""
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from geometry_msgs.msg import PoseStamped
from nav_msgs.msg import Path, Odometry
from nav2_msgs.action import FollowPath
from std_msgs.msg import Int32, String, Bool
from rclpy.qos import QoSProfile, DurabilityPolicy

class FleetExecutor(Node):
    def __init__(self):
        super().__init__('fleet_executor')
        self.port = self.declare_parameter('port',19700).value
        self.origin = {'x':self.declare_parameter('grid_x',1).value,'y':self.declare_parameter('grid_y',1).value}
        self.lock=threading.Lock(); self.pose_time=0; self.cancel_pending=False; self.heartbeat_time=time.monotonic()
        self.session = None; self.pose = None; self.truth = None; self.collisions = 0
        self.pending = None; self.active = None; self.goal = None; self.fault = None; self.actions = 0
        self.obstacle=self.create_publisher(Bool,'sim/obstacle',10)
        self.geometry=self.create_publisher(String,'sim/geometry',QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL))
        self.client = ActionClient(self,FollowPath,'follow_path')
        self.create_subscription(Odometry,'odometry/filtered',self.odometry,10)
        self.create_subscription(PoseStamped,'sim/ground_truth',lambda m:setattr(self,'truth',m.pose),10)
        self.create_subscription(Int32,'sim/collisions',lambda m:setattr(self,'collisions',m.data),10)
        self.create_timer(0.05,self.update)
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                try:
                    body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    if self.path=='/initialize':
                        if body['origin']!=owner.origin or body['cellMetres']!=0.6: raise ValueError('World/grid transform mismatch')
                        if owner.session is not None: raise ValueError('Reset requires restarting physical execution')
                        owner.heartbeat_time=time.monotonic(); owner.session=body['session']; owner.geometry.publish(String(data=json.dumps(body['map']))); result=owner.result(True)
                    elif self.path=='/heartbeat':
                        if body['session']!=owner.session: raise ValueError('Wrong heartbeat session')
                        owner.heartbeat_time=time.monotonic(); result=owner.result(True)
                    elif self.path=='/obstacle':
                        owner.obstacle.publish(Bool(data=bool(body['blocked']))); result=owner.result(True)
                    elif self.path=='/cancel':
                        owner.cancel_pending=True; owner.fault='Execution revoked by local control'
                        if owner.goal: owner.goal.cancel_goal_async()
                        result=owner.result(True)
                    elif self.path=='/inspect': result=owner.result(True)
                    elif self.path=='/execute':
                        with owner.lock:
                            if body['session']!=owner.session or owner.fault or owner.pending or owner.active: raise ValueError('Invalid session, fault or concurrent execution')
                            event=threading.Event(); job={'body':body,'event':event,'result':None}
                            owner.pending=job
                        if not event.wait(40): raise TimeoutError('Executor timeout')
                        result=job['result']
                    else: raise ValueError('Unknown route')
                    self.send_response(200 if result['ok'] else 409)
                except Exception as e:
                    result=owner.result(False,str(e)); self.send_response(409)
                self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(result).encode())
        self.server=ThreadingHTTPServer(('127.0.0.1',self.port),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()

    def odometry(self,msg):
        self.pose=msg.pose.pose; self.pose_time=time.monotonic()

    def result(self,ok,error=None):
        def xy(p): return None if p is None else {'x':p.position.x,'y':p.position.y}
        return {'ok':ok,'error':error,'pose':xy(self.pose),'groundTruth':xy(self.truth),'origin':self.origin,'cellMetres':0.6,'actions':self.actions,'collisions':self.collisions,'fault':self.fault,'poseAgeSeconds':time.monotonic()-self.pose_time,'cancellationPending':self.cancel_pending}

    def finish(self,ok,error=None):
        if not ok: self.fault=error
        job=self.active; self.active=None; self.goal=None
        job['result']=self.result(ok,error); job['event'].set()

    def update(self):
        if self.active:
            if (time.monotonic()-self.active['started']>35 or time.monotonic()-self.heartbeat_time>2) and not self.cancel_pending:
                self.cancel_pending=True; self.fault='Wall-clock execution/heartbeat timeout; waiting for Nav2 terminal cancellation'
                if self.goal: self.goal.cancel_goal_async()
            if self.cancel_pending and time.monotonic()-self.active['started']>38:
                self.finish(False,'Cancellation unconfirmed; physical execution fault, partial pose retained')
            return
        if self.pending is None: return
        with self.lock:
            self.active=self.pending; self.pending=None
        self.active['started']=time.monotonic()
        body=self.active['body']; a=body['from']; b=body['to']
        if any(not isinstance(p[k],int) for p in (a,b) for k in ('x','y')) or abs(a['x']-b['x'])+abs(a['y']-b['y'])>1:
            self.finish(False,'Nonadjacent authorization'); return
        start=((a['x']-self.origin['x'])*0.6,(a['y']-self.origin['y'])*0.6)
        target=((b['x']-self.origin['x'])*0.6,(b['y']-self.origin['y'])*0.6)
        if self.pose is None or time.monotonic()-self.pose_time>0.5 or math.hypot(self.pose.position.x-start[0],self.pose.position.y-start[1])>0.1:
            self.finish(False,'Measured start does not match committed cell'); return
        if a==b: self.finish(True); return
        if not self.client.server_is_ready(): self.finish(False,'Nav2 action unavailable'); return
        yaw=math.atan2(target[1]-start[1],target[0]-start[0]); path=Path(); path.header.frame_id='map'; path.header.stamp=self.get_clock().now().to_msg()
        for i in range(13):
            x=self.pose.position.x+(target[0]-self.pose.position.x)*i/12
            y=self.pose.position.y+(target[1]-self.pose.position.y)*i/12
            pose=PoseStamped(); pose.header=path.header; pose.pose.position.x=x; pose.pose.position.y=y
            pose.pose.orientation.z=math.sin(yaw/2); pose.pose.orientation.w=math.cos(yaw/2); path.poses.append(pose)
        self.active['target']=target
        goal=FollowPath.Goal(); goal.path=path; goal.controller_id='FollowPath'; goal.goal_checker_id='goal_checker'; goal.progress_checker_id='progress_checker'
        self.actions+=1; self.client.send_goal_async(goal).add_done_callback(self.accepted)

    def accepted(self,future):
        handle=future.result()
        if self.active is None:
            if handle.accepted: handle.cancel_goal_async()
            return
        self.goal=handle
        if not handle.accepted: self.finish(False,'Nav2 rejected'); return
        handle.get_result_async().add_done_callback(self.finished)
        if self.cancel_pending: handle.cancel_goal_async()

    def finished(self,future):
        if self.active is None: return
        result=future.result(); target=self.active['target']
        arrived=self.pose is not None and math.hypot(self.pose.position.x-target[0],self.pose.position.y-target[1])<=0.09
        if self.cancel_pending:
            self.cancel_pending=False; self.finish(False,f'Timeout terminal status={result.status}; partial pose retained')
        elif result.status==4 and result.result.error_code==0 and arrived and time.monotonic()-self.pose_time<=0.5: self.finish(True)
        else: self.finish(False,f'Nav2 status={result.status} code={result.result.error_code} arrived={arrived}')

def main():
    rclpy.init(); node=FleetExecutor()
    try:rclpy.spin(node)
    finally:node.server.shutdown(); node.destroy_node(); rclpy.shutdown()
