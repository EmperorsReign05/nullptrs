"""Run existing fleet gates into new experiment artifacts; never overwrite history."""
import json
import os
import signal
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped/phase3/grouped-v4/regression'
out.mkdir(parents=True, exist_ok=True)
results = []
for mode, sizes in [('software', [1, 3, 5, 8]), ('nav2', [3, 5, 8])]:
    for n in sizes:
        dest = out / f'{mode}-n{n}'
        command = ['node', 'scripts/fleet-n.mjs', '--robots', str(n), '--out', str(dest)]
        if mode == 'nav2':
            command.append('--nav2')
        with (out / f'{mode}-n{n}.log').open('w') as log:
            try:
                process = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    code = process.wait(timeout=600)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    code = 'timeout'
            except OSError as error:
                code = str(error)
        results.append({'mode': mode, 'N': n, 'exitCode': code})
        (out / 'fleet-gates.json').write_text(json.dumps(results, indent=2) + '\n')
        print(results[-1], flush=True)
