"""Actual Next proxy + independent N-process edge simulation smoke check."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/edge-choke-v1'
out.mkdir(parents=True, exist_ok=True)
processes = []
logs = []

def launch(args, name, env=None):
    log = (out / name).open('w')
    logs.append(log)
    p = subprocess.Popen(args, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(p)
    return p

def request(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)

def wait_state(url):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            return request(url)
        except Exception:
            time.sleep(.2)
    raise RuntimeError('Endpoint did not become ready: ' + url)

def stop(p):
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()

try:
    backend = launch(['node', 'scripts/edge-demo.mjs'], 'dashboard-backend.txt')
    direct = 'http://127.0.0.1:4011/state'
    first = wait_state(direct)
    env = dict(os.environ, FLEET_URL='http://127.0.0.1:4011')
    dashboard = launch(['node_modules/.bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3031'], 'dashboard-next.txt', env)
    proxy = 'http://127.0.0.1:3031/api/fleet'
    state = wait_state(proxy)
    # Fleet size and the deployment description both come from the fleet config.
    fleet = json.load(open(os.environ.get('FLEET_CONFIG', 'config/fleet.json')))
    size = len(fleet['robots'])
    assert len(state['world']['robots']) == size
    assert state['deployment'].startswith(f'{size} ')
    pids = [request(f'http://127.0.0.1:{18401+i}/state')['pid'] for i in range(size)]
    assert len(set(pids)) == size
    paused = request(proxy, {'kind': 'pause'})
    time.sleep(.3)
    assert request(proxy)['world']['tick'] == paused['world']['tick']
    assert request(proxy, {'kind': 'ai-off'})['aiEnabled'] is False
    assert request(proxy, {'kind': 'ai-on'})['aiEnabled'] is True
    task = {'id': 'HTTP-EDGE-SMOKE', 'pickup': {'x': 6, 'y': 2}, 'dropoff': {'x': 12, 'y': 10}, 'weight': 1, 'priority': 1, 'createdAt': paused['world']['tick'], 'status': 'pending'}
    announced = request(proxy, {'kind': 'task', 'task': task})
    assert any(t['id'] == task['id'] for t in announced['world']['tasks'])
    request(proxy, {'kind': 'run'})
    before = request(direct)['world']['tick']
    stop(dashboard)
    deadline = time.monotonic() + 10
    after = request(direct)
    while after['world']['tick'] <= before + 2 and time.monotonic() < deadline:
        time.sleep(.2)
        after = request(direct)
    assert after['world']['tick'] > before + 2
    assert backend.poll() is None
    for pid in pids:
        os.kill(pid, 0)
    record = {'passed': True, 'robotProcessIds': pids, 'dashboardStopped': True, 'ticksBeforeDashboardStop': before, 'ticksAfterDashboardStop': after['world']['tick'], 'controlsVerified': ['pause', 'run', 'ai-off', 'ai-on', 'task announcement'], 'snapshot': after, 'hardwareValidated': False}
    (out / 'dashboard-smoke.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({k: v for k, v in record.items() if k != 'snapshot'}))
finally:
    for p in reversed(processes):
        stop(p)
    for log in logs:
        log.close()
