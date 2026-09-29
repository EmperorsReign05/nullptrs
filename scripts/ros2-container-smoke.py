#!/usr/bin/env python3
"""Verify direct Fast DDS exchange between N separate rootless containers.

The roster comes from the canonical fleet config, so the containers spawned and
the membership string handed to each bridge always describe the same fleet.
"""
import json
import os
import queue
import subprocess
import threading
import time

image = os.environ.get('ROS_BRIDGE_IMAGE', 'localhost/teamrocket-ros2:jazzy')
engine = os.environ.get('CONTAINER_ENGINE', 'podman')
domain = os.environ.get('ROS_DOMAIN_ID', '84')
fleet_config = os.environ.get('FLEET_CONFIG', 'config/fleet.json')
with open(fleet_config) as handle:
    ids = [robot['id'] for robot in json.load(handle)['robots']]
members = ','.join(ids)
processes = []
queues = []


def read(proc, inbox):
    for line in proc.stdout:
        inbox.put(json.loads(line))


def send(index, command):
    processes[index].stdin.write(json.dumps(command) + '\n')
    processes[index].stdin.flush()


def take(index, predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = queues[index].get(timeout=max(0.001, deadline - time.monotonic()))
        except queue.Empty:
            break
        if predicate(event):
            return event
    raise RuntimeError(f'{ids[index]}: expected DDS event timed out')


try:
    for peer_id in ids:
        proc = subprocess.Popen([engine, 'run', '--rm', '-i', '--network=host',
                                 '-e', 'ROS_DOMAIN_ID=' + domain, image,
                                 '--id', peer_id, '--members', members,
                                 '--session', 'container-smoke'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        processes.append(proc)
        inbox = queue.Queue()
        queues.append(inbox)
        threading.Thread(target=read, args=(proc, inbox), daemon=True).start()
    ready = [take(i, lambda e: e.get('event') == 'ready') for i in range(len(ids))]
    assert all(e['rmw'] == 'rmw_fastrtps_cpp' for e in ready)
    deadline = time.monotonic() + 30
    while True:
        stats = []
        for i in range(len(ids)):
            send(i, {'op': 'stats'})
            stats.append(take(i, lambda e: e.get('event') == 'stats'))
        # Full roster, not a hardcoded peer count.
        if all(min(s['subscriptions'].values()) >= len(ids) for s in stats):
            break
        assert time.monotonic() < deadline, 'discovery timeout'
        time.sleep(0.1)
    deliveries = 0
    for sender in range(len(ids)):
        for channel in ('motion', 'ownership'):
            marker = f'{sender}-{channel}'
            send(sender, {'op': 'send', 'channel': channel,
                          'message': {'from': ids[sender], 'marker': marker}})
            for recipient in range(len(ids)):
                if recipient != sender:
                    take(recipient, lambda e: e.get('event') == 'message' and
                         e['message']['marker'] == marker)
                    deliveries += 1
    print(json.dumps({'passed': True, 'containers': len(ids), 'roster': ids,
                      'channels': 2, 'directDeliveries': deliveries,
                      'rmw': 'rmw_fastrtps_cpp',
                      'transport': 'UDPv4-only, no shared-memory transport',
                      'broker': 'none; peer-to-peer only',
                      'hardware': 'one x86_64 host, not edge-board validation'}))
finally:
    for i, proc in enumerate(processes):
        if proc.poll() is None:
            try:
                send(i, {'op': 'shutdown'})
                proc.wait(timeout=10)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                proc.terminate()
                proc.wait(timeout=5)
