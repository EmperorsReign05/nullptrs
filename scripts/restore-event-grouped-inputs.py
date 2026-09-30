"""Restore exact frozen inputs omitted from PR #28 git; never overwrite a mismatch."""
import gzip
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
inputs = root / 'artifacts/event-grouped/frozen-inputs'
manifest = json.loads((inputs / 'manifest.json').read_text())
for entry in manifest['files']:
    data = gzip.decompress((inputs / entry['archive']).read_bytes())
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise SystemExit(f"Invalid frozen archive: {entry['archive']}")
    target = root / entry['target']
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != entry['sha256']:
            raise SystemExit(f"Existing input differs; refusing to overwrite: {entry['target']}")
        print(f"Verified existing {entry['target']}")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as destination:
            destination.write(data)
        print(f"Restored exact {entry['target']}")
