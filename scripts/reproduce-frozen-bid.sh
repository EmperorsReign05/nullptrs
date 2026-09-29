#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(git rev-parse --show-toplevel)
replay_dir=$(mktemp -d /tmp/sih-frozen-bid.XXXXXX)
rmdir "$replay_dir"
cleanup() { git -C "$repo_dir" worktree remove --force "$replay_dir" >/dev/null; }
git -C "$repo_dir" worktree add --detach "$replay_dir" 9c7335b >/dev/null
trap cleanup EXIT
ln -s "$repo_dir/node_modules" "$replay_dir/node_modules"
cd "$replay_dir"
BID_ENERGY_ACCEPTANCE=1 "$repo_dir/node_modules/.bin/vitest" run tests/bid-mlp.test.ts --maxWorkers=1 --minWorkers=1
mkdir -p "$repo_dir/artifacts/final-audit"
cp artifacts/bid-energy-v4/acceptance.json "$repo_dir/artifacts/final-audit/frozen-bid-reproduction.json"
