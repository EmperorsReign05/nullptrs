#!/usr/bin/env python3
"""Verify direct Fast DDS exchange between three separate rootless containers."""
import json
import os
import queue
import subprocess
import threading
import time

image = os.environ.get('ROS_BRIDGE_IMAGE', 'localhost/teamrocket-ros2:jazzy')
engine = os.environ.get('CONTAINER_ENGINE', 'podman')
domain = os.environ.get('ROS_DOMAIN_ID', '84')
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
    raise RuntimeError(f'AMR-0{index+1}: expected DDS event timed out')


try:
    for i in range(3):
        proc = subprocess.Popen([engine, 'run', '--rm', '-i', '--network=host',
                                 '-e', 'ROS_DOMAIN_ID=' + domain, image,
                                 '--id', f'AMR-0{i+1}', '--members', 'AMR-01,AMR-02,AMR-03',
                                 '--session', 'container-smoke'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        processes.append(proc)
        inbox = queue.Queue()
        queues.append(inbox)
        threading.Thread(target=read, args=(proc, inbox), daemon=True).start()
    ready = [take(i, lambda e: e.get('event') == 'ready') for i in range(3)]
    assert all(e['rmw'] == 'rmw_fastrtps_cpp' for e in ready)
    deadline = time.monotonic() + 30
    while True:
        stats = []
        for i in range(3):
            send(i, {'op': 'stats'})
            stats.append(take(i, lambda e: e.get('event') == 'stats'))
        if all(min(s['subscriptions'].values()) >= 3 for s in stats):
            break
        assert time.monotonic() < deadline, 'discovery timeout'
        time.sleep(0.1)
    deliveries = 0
    for sender in range(3):
        for channel in ('motion', 'ownership'):
            marker = f'{sender}-{channel}'
            send(sender, {'op': 'send', 'channel': channel,
                          'message': {'from': f'AMR-0{sender+1}', 'marker': marker}})
            for recipient in range(3):
                if recipient != sender:
                    take(recipient, lambda e: e.get('event') == 'message' and
                         e['message']['marker'] == marker)
                    deliveries += 1
    print(json.dumps({'passed': True, 'containers': 3, 'channels': 2,
                      'directDeliveries': deliveries, 'rmw': 'rmw_fastrtps_cpp',
                      'transport': 'UDPv4-only, no shared-memory transport',
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
