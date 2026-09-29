#!/usr/bin/env python3
"""Reproduce development-only cadence ablation in an isolated disposable worktree.
Usage: python3 scripts/profile-admission-experiment.py /absolute/new/output-directory
No changes to the caller's production files; failures are retained as evidence.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
with tempfile.TemporaryDirectory(prefix="fleet-admission-profile-") as scratch:
    checkout = Path(scratch) / "checkout"
    subprocess.run(["git", "worktree", "add", "--detach", str(checkout), "HEAD"], cwd=root, check=True)
    try:
        (checkout / "node_modules").symlink_to((root / "node_modules").resolve(), target_is_directory=True)
        source = checkout / "src/core/distributed/ownership.ts"
        original = source.read_text()
        if original.count("OWNERSHIP_EPOCH_TICKS = 32") != 1:
            raise RuntimeError("Expected frozen32-tick implementation; refusing an unreviewed ablation")
        outcomes = {}
        for epoch in [32, 16]:
            source.write_text(original.replace("OWNERSHIP_EPOCH_TICKS = 32", f"OWNERSHIP_EPOCH_TICKS = {epoch}"))
            arm = output / f"epoch{epoch}"
            arm.mkdir()
            env = dict(os.environ, RUN_COMPLETION_PROFILE="1", PROFILE_OUTPUT=str(arm), PROFILE_ROWS=str(arm / "rows.json"))
            with (arm / "profile.log").open("w") as log:
                subprocess.run(["./node_modules/.bin/vitest", "run", "tests/completion-profile.test.ts", "-t", "profile 400"], cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            with (arm / "ownership-tests.log").open("w") as log:
                test = subprocess.run(["./node_modules/.bin/vitest", "run", "tests/ownership.test.ts", "tests/edge-peer.test.ts", "tests/runtime-charging.test.ts"], cwd=checkout, stdout=log, stderr=subprocess.STDOUT)
            outcomes[str(epoch)] = {"testExitCode": test.returncode, "report": str(arm / "report.json")}
        (output / "outcomes.json").write_text(json.dumps(outcomes, indent=2) + "\n")
    finally:
        subprocess.run(["git", "worktree", "remove", "--force", str(checkout)], cwd=root, check=True)
