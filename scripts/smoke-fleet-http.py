#!/usr/bin/env python3
"""After npm run build && npm run fleet:build: verify separate fleet/UI processes."""
import json, os, signal, socket, subprocess, time, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def get(url):
    with urllib.request.urlopen(url, timeout=2) as response: return json.load(response)
def wait(url, process):
    for _ in range(100):
        if process.poll() is not None: raise RuntimeError('Server exited before ready')
        try: return get(url)
        except OSError: time.sleep(.1)
    raise RuntimeError('Server readiness timeout')
backend_port, ui_port = port(), port()
backend = f'http://127.0.0.1:{backend_port}'
ui = f'http://127.0.0.1:{ui_port}/api/fleet'
processes = []
try:
    fleet = subprocess.Popen(['node', '.fleet-dist/src/server/fleet-http.js'], cwd=ROOT,
        env={**os.environ, 'FLEET_PORT': str(backend_port)}, start_new_session=True, stdout=subprocess.DEVNULL)
    processes.append(fleet); wait(backend + '/state', fleet)
    dashboard = subprocess.Popen(['npm', 'run', 'start', '--', '--port', str(ui_port)], cwd=ROOT,
        env={**os.environ, 'FLEET_URL': backend}, start_new_session=True, stdout=subprocess.DEVNULL)
    processes.append(dashboard); wait(ui, dashboard)
    def post(command):
        request = urllib.request.Request(ui, json.dumps(command).encode(), {'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=3) as response: return json.load(response)
    paused = post({'kind':'pause'}); time.sleep(.6); held = get(ui)
    assert paused['world']['tick'] == held['world']['tick']
    post({'kind':'ai-off'})
    post({'kind':'task', 'task':{'id':'HTTP-AUDIT', 'pickup':{'x':6,'y':2}, 'dropoff':{'x':12,'y':10}, 'weight':10, 'status':'pending', 'createdAt':0, 'priority':1}})
    post({'kind':'run'}); before = get(backend + '/state')
    os.killpg(dashboard.pid, signal.SIGTERM); dashboard.wait(timeout=5)
    time.sleep(1.1); after = get(backend + '/state')
    assert after['world']['tick'] > before['world']['tick']
    assert any(t['id'] == 'HTTP-AUDIT' for t in after['world']['tasks'])
    result = {'passed':True, 'dashboardProcessTerminated':True,
        'backendTicksAcrossDashboardFailure':[before['world']['tick'],after['world']['tick']],
        'pauseTicks':[paused['world']['tick'],held['world']['tick']], 'snapshotAfterDashboardFailure':after,
        'scope':'Separate fleet and dashboard OS processes; AMRs are simulated peer contexts within the fleet process.'}
    out = ROOT / 'artifacts/final-audit/http-smoke.json'; out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,indent=2)+'\n')
    print('PASS: dashboard process killed; fleet clock, task state and control inputs remain independent.')
finally:
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
