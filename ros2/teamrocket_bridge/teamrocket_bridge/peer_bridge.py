"""A local line protocol bridges one controller to real ROS 2/Fast DDS.

No planning, winner selection, shared fleet state, or discovery server lives here.
Only trusted fixed roster peers are supported; roster checks are not authentication.
The session fence prevents previous-run frames entering a new controller instance.
"""
import argparse
import json
import os
import queue
import re
import sys
import threading

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy, HistoryPolicy
from rclpy.utilities import get_rmw_implementation_identifier
from std_msgs.msg import String

CHANNELS = ('motion', 'ownership')
MAX_FRAME = 2_000_000


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()


class PeerBridge(Node):
    def __init__(self, peer_id, members, session):
        super().__init__('peer_' + re.sub('[^a-zA-Z0-9_]', '_', peer_id))
        self.peer_id, self.members, self.session = peer_id, set(members), session
        self.blocked = set()
        self.commands = queue.Queue(maxsize=4096)
        self.finished = False
        self.stats = dict(sent=0, received=0, dropped=0, invalid=0)
        qos = QoSProfile(depth=256, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE,
                         history=HistoryPolicy.KEEP_LAST)
        self.publishers_by_channel = {
            channel: self.create_publisher(String, '/teamrocket/' + channel, qos)
            for channel in CHANNELS}
        self.listeners = [self.create_subscription(
            String, '/teamrocket/' + channel,
            lambda msg, channel=channel: self.receive(channel, msg), qos)
            for channel in CHANNELS]
        self.timer = self.create_timer(0.002, self.process_commands)
        threading.Thread(target=self.read_commands, daemon=True).start()

    def read_commands(self):
        while True:
            line = sys.stdin.readline(MAX_FRAME + 1)
            if not line:
                self.commands.put({'op': 'shutdown'})
                return
            if len(line) > MAX_FRAME:
                # Drain an oversized line before attempting the next JSON command.
                while line and not line.endswith('\n'):
                    line = sys.stdin.readline(MAX_FRAME + 1)
                self.commands.put({'op': 'invalid'})
                continue
            try:
                command = json.loads(line)
                if not isinstance(command, dict):
                    raise ValueError('object required')
            except (ValueError, TypeError):
                command = {'op': 'invalid'}
            self.commands.put(command)

    def receive(self, channel, msg):
        try:
            if len(msg.data) > MAX_FRAME:
                raise ValueError('oversize')
            frame = json.loads(msg.data)
            if not isinstance(frame, dict) or frame.get('version') != 1:
                raise ValueError('version')
            sender = frame.get('from')
            if sender == self.peer_id:
                return
            if (sender not in self.members or sender in self.blocked or
                    frame.get('session') != self.session or
                    frame.get('channel') != channel or
                    frame.get('to') not in (None, self.peer_id)):
                self.stats['dropped'] += 1
                return
            payload = frame['payload']
            if not isinstance(payload, dict) or payload.get('from') != sender:
                raise ValueError('sender mismatch')
            self.stats['received'] += 1
            emit({'event': 'message', 'channel': channel, 'message': payload})
        except (ValueError, TypeError, KeyError):
            self.stats['invalid'] += 1

    def process_commands(self):
        for _ in range(256):
            try:
                command = self.commands.get_nowait()
            except queue.Empty:
                return
            try:
                op = command.get('op')
                if op == 'shutdown':
                    self.finished = True
                    return
                if op == 'stats':
                    emit({'event': 'stats', 'id': self.peer_id, **self.stats,
                          'requestId': command.get('requestId'),
                          'subscriptions': {c: p.get_subscription_count()
                                            for c, p in self.publishers_by_channel.items()}})
                elif op == 'link':
                    peer, reachable = command.get('peer'), command.get('reachable')
                    if peer not in self.members or type(reachable) is not bool:
                        raise ValueError('invalid link')
                    if reachable:
                        self.blocked.discard(peer)
                    else:
                        self.blocked.add(peer)
                    emit({'event': 'link', 'peer': peer, 'reachable': reachable,
                          'requestId': command.get('requestId')})
                elif op == 'send':
                    channel, target = command.get('channel'), command.get('to')
                    payload = command.get('message')
                    if (channel not in CHANNELS or
                            (target is not None and target not in self.members) or
                            not isinstance(payload, dict) or payload.get('from') != self.peer_id):
                        raise ValueError('invalid outbound frame')
                    # Broadcast as addressed frames so outbound link cuts apply too.
                    targets = [target] if target else sorted(self.members - {self.peer_id})
                    for to in targets:
                        if to == self.peer_id or to in self.blocked:
                            self.stats['dropped'] += 1
                            continue
                        data = json.dumps(dict(version=1, session=self.session,
                                               channel=channel, **{'from': self.peer_id},
                                               to=to, payload=payload), separators=(',', ':'))
                        if len(data) > MAX_FRAME:
                            raise ValueError('oversize')
                        self.publishers_by_channel[channel].publish(String(data=data))
                        self.stats['sent'] += 1
                else:
                    raise ValueError('unknown operation')
            except (ValueError, TypeError, KeyError):
                self.stats['invalid'] += 1
                emit({'event': 'error', 'error': 'invalid bridge command'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--members', required=True)
    parser.add_argument('--session', required=True)
    args = parser.parse_args()
    members = args.members.split(',')
    if not args.session or args.id not in members or len(set(members)) != len(members):
        parser.error('nonempty session and unique membership containing self are required')
    os.environ.setdefault('RMW_IMPLEMENTATION', 'rmw_fastrtps_cpp')
    rclpy.init(args=[])
    rmw = get_rmw_implementation_identifier()
    if rmw != 'rmw_fastrtps_cpp':
        raise RuntimeError('This validated transport requires rmw_fastrtps_cpp')
    node = PeerBridge(args.id, members, args.session)
    emit({'event': 'ready', 'id': args.id, 'rmw': rmw, 'session': args.session})
    try:
        while rclpy.ok() and not node.finished:
            rclpy.spin_once(node, timeout_sec=0.02)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
