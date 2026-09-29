"""Actual Fast DDS integration, not a mocked ROS bus. Run after colcon build."""
import json
import os
import queue
import subprocess
import sys
import threading
import time
import unittest

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from std_msgs.msg import String


class Child:
    def __init__(self, peer):
        self.id = peer
        self.proc = subprocess.Popen([
            sys.executable, '-m', 'teamrocket_bridge.peer_bridge', '--id', peer,
            '--members', 'AMR-01,AMR-02,AMR-03', '--session', 'dds-test-v1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
        self.events = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()
        ready = self.take(lambda e: e.get('event') == 'ready')
        assert ready['rmw'] == 'rmw_fastrtps_cpp', ready

    def read(self):
        for line in self.proc.stdout:
            self.events.put(json.loads(line))

    def send(self, command):
        self.proc.stdin.write(json.dumps(command) + '\n')
        self.proc.stdin.flush()

    def take(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=max(0.001, deadline-time.monotonic()))
            except queue.Empty:
                break
            if predicate(event):
                return event
        raise AssertionError(f'{self.id}: expected DDS event not received')

    def message(self, marker, timeout=10):
        return self.take(lambda e: e.get('event') == 'message' and
                         e['message'].get('marker') == marker, timeout)

    def no_message(self, marker):
        with unittest.TestCase().assertRaises(AssertionError):
            self.message(marker, 0.35)

    def close(self):
        if self.proc.poll() is None:
            self.send({'op': 'shutdown'})
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdin.close()
        self.proc.stdout.close()


class DdsExchange(unittest.TestCase):
    def test_real_peers_and_fences(self):
        peers = []
        rclpy.init()
        injector = Node('integration_injector')
        qos = QoSProfile(depth=256, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        publisher = injector.create_publisher(String, '/teamrocket/motion', qos)
        try:
            peers = [Child(f'AMR-0{i}') for i in range(1, 4)]
            a, b, c = peers
            deadline = time.monotonic() + 20
            while True:
                counts = []
                for peer in peers:
                    peer.send({'op': 'stats'})
                    counts.append(peer.take(lambda e: e.get('event') == 'stats')['subscriptions'])
                if all(min(count.values()) >= 3 for count in counts):
                    break
                self.assertLess(time.monotonic(), deadline, 'DDS peer discovery timed out')
                time.sleep(0.1)
            # Actual planner channels carry state/intents and auction/heartbeat traffic.
            for channel, kind in [('motion', 'tick'), ('ownership', 'bid'),
                                  ('ownership', 'heartbeat')]:
                marker = channel + '-' + kind
                payload = {'from': a.id, 'type': kind, 'marker': marker,
                           'position': {'x': 3, 'y': 4}, 'intent': {'x': 4, 'y': 4}}
                a.send({'op': 'send', 'channel': channel, 'message': payload})
                for recipient in (b, c):
                    event = recipient.message(marker)
                    self.assertEqual(event['message'], payload)
                    self.assertEqual(event['channel'], channel)
                a.no_message(marker)
            a.send({'op': 'send', 'channel': 'ownership', 'to': b.id,
                    'message': {'from': a.id, 'marker': 'unicast'}})
            b.message('unicast')
            c.no_message('unicast')
            # Cutting one endpoint must block both incoming and outgoing messages.
            b.send({'op': 'link', 'peer': a.id, 'reachable': False})
            b.take(lambda e: e.get('event') == 'link')
            a.send({'op': 'send', 'channel': 'motion', 'message': {'from': a.id, 'marker': 'cut-in'}})
            c.message('cut-in')
            b.no_message('cut-in')
            b.send({'op': 'send', 'channel': 'ownership', 'message': {'from': b.id, 'marker': 'cut-out'}})
            c.message('cut-out')
            a.no_message('cut-out')
            b.send({'op': 'link', 'peer': a.id, 'reachable': True})
            b.take(lambda e: e.get('event') == 'link')
            a.send({'op': 'send', 'channel': 'motion', 'message': {'from': a.id, 'marker': 'healed'}})
            b.message('healed')
            # Inject stale-session, unknown-peer and sender-spoof frames via real DDS.
            for marker, changes in [('stale', {'session': 'previous-run'}),
                                    ('unknown', {'from': 'AMR-99'}),
                                    ('spoof', {'payload': {'from': 'AMR-03', 'marker': 'spoof'}})]:
                frame = dict(version=1, session='dds-test-v1', channel='motion',
                             to=b.id, payload={'from': a.id, 'marker': marker})
                frame['from'] = a.id
                frame.update(changes)
                publisher.publish(String(data=json.dumps(frame)))
                b.no_message(marker)
            b.send({'op': 'stats'})
            stats = b.take(lambda e: e.get('event') == 'stats')
            self.assertGreaterEqual(stats['dropped'], 3)
            self.assertGreaterEqual(stats['invalid'], 1)
            print(json.dumps({'test': 'real_fast_dds_exchange', 'passed': True,
                              'rmw': 'rmw_fastrtps_cpp', 'peers': 3,
                              'checks': ['state-intent', 'bid', 'heartbeat', 'unicast',
                                         'no-self-delivery', 'bidirectional-link-cut',
                                         'link-heal', 'session-fence', 'roster-fence',
                                         'payload-sender-fence'], 'receiverStats': stats}))
        finally:
            for peer in peers:
                peer.close()
            injector.destroy_node()
            rclpy.shutdown()


if __name__ == '__main__':
    unittest.main()
