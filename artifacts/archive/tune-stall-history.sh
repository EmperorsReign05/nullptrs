set -u
cd /tmp/opencode/tr-core
S=${1:-40}; T=${2:-400}; Z=${3:-2,4,6,8,10}
for sc in 0 1; do
  echo "### unsafe peer-yield exception REMOVED; STALL_COUNTER=$sc"
  DIST_STALL_COUNTER=$sc DIST_PERSIST=2 DIST_MEMORY=60 DIST_NO_COLLINEAR_RETREAT=0 DIST_DOUBLE_DECIDE=0 DIST_BLOCKERS=1 DIST_YIELD=shuffle \
    npx vite-node artifacts/ab.ts -- "$S" "$T" "$Z" 2>&1 | grep -E "^  (ORIG|NEW):"
done
