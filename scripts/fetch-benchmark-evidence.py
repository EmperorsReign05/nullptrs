#!/usr/bin/env python3
"""Restore checksummed historical evidence; leave existing local files untouched."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.request import urlopen


def restore(data, manifest, destination):
    if hashlib.sha256(data).hexdigest() != manifest['sha256']:
        raise ValueError('Archive checksum mismatch')
    expected = {entry['path']: entry for entry in manifest['files']}
    destination = destination.resolve()
    restored = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != set(expected):
            raise ValueError('Archive contents differ from manifest')
        verified = []
        for member in members:
            target = (destination / member.name).resolve()
            if not member.isfile() or not target.is_relative_to(destination):
                raise ValueError('Unsafe archive member')
            content = archive.extractfile(member).read()
            entry = expected[member.name]
            if len(content) != entry['bytes'] or hashlib.sha256(content).hexdigest() != entry['sha256']:
                raise ValueError('File checksum mismatch: ' + member.name)
            verified.append((target, content))
        for target, content in verified:
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            restored += 1
    return restored


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Use a downloaded archive instead of the network')
    parser.add_argument('--destination', type=Path, default=root)
    args = parser.parse_args()
    manifest = json.loads((root / 'artifacts/evidence-manifest.json').read_text())
    if args.archive:
        data = args.archive.read_bytes()
    else:
        with urlopen(manifest['downloadUrl'], timeout=60) as response:
            data = response.read()
    count = restore(data, manifest, args.destination)
    print(f'Verified archive; restored {count} missing files. Existing files were left untouched.')
