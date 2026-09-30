"""Stop only old unflagged grouped benchmark processes in this checkout."""
from pathlib import Path
import os
import signal
root=Path(__file__).resolve().parents[1]
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        if (entry/'cwd').resolve()!=root:
            continue
        args=(entry/'cmdline').read_bytes().split(b'\0')
        args=[a.decode() for a in args if a]
        if len(args)==3 and args[1]=='./node_modules/.bin/vite-node' and args[2]=='scripts/grouped-benchmark.ts':
            os.kill(int(entry.name),signal.SIGTERM)
            print('Stopped superseded benchmark',entry.name)
    except (OSError,UnicodeError):
        continue
