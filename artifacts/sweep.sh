#!/usr/bin/env bash
# Config sweep. Each line is one config; env switches are read at module load
# so every config needs its own process.
#
#   CONTROL      = the pre-change code path (double decide, no blockers,
#                  no collinear guard, shuffle yield)
#   variants     = one change at a time, then combinations
set -u
cd /tmp/opencode/tr-core
SEEDS=${1:-20}
TICKS=${2:-400}
SIZES=${3:-2,4,6,8,10}
ctl() { DIST_DOUBLE_DECIDE=1 DIST_BLOCKERS=0 DIST_NO_COLLINEAR_RETREAT=0 DIST_YIELD=shuffle; }
run() {
  local label="$1"; shift
  echo "### $label"
  env "$@" npx vite-node artifacts/ab.ts -- "$SEEDS" "$TICKS" "$SIZES" 2>&1 | tail -n +2 | grep "new"
}
run "CONTROL (original code path)"  $(ctl)
run "blockers only"                 DIST_DOUBLE_DECIDE=1 DIST_BLOCKERS=1 DIST_NO_COLLINEAR_RETREAT=0 DIST_YIELD=shuffle
run "single-decide only"            DIST_DOUBLE_DECIDE=0 DIST_BLOCKERS=0 DIST_NO_COLLINEAR_RETREAT=0 DIST_YIELD=shuffle
run "single-decide + blockers"      DIST_DOUBLE_DECIDE=0 DIST_BLOCKERS=1 DIST_NO_COLLINEAR_RETREAT=0 DIST_YIELD=shuffle
run "single-decide + blockers + collinear" DIST_DOUBLE_DECIDE=0 DIST_BLOCKERS=1 DIST_NO_COLLINEAR_RETREAT=1 DIST_YIELD=shuffle
run "single-decide + collinear"     DIST_DOUBLE_DECIDE=0 DIST_BLOCKERS=0 DIST_NO_COLLINEAR_RETREAT=1 DIST_YIELD=shuffle
