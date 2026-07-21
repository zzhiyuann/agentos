#!/usr/bin/env bash
#
# build-locked.sh — Single-builder mutex around `npx tsc` (RYA-1195).
#
# Two builders can race: the git post-commit hook and the auto-deploy
# watcher inside serve (src/serve/auto-deploy.ts). Without a lock,
# whichever tsc finishes LAST can rewrite dist/ after serve-loop has
# already spawned a fresh node — leaving the running process with stale
# code in memory (deploy-gap variant #4: RYA-1058, RYA-1141, RYA-1195).
#
# Uses a mkdir-based mutex (atomic on POSIX, no flock needed on macOS).
# Waits up to LOCK_WAIT_SECS for a concurrent build, steals locks older
# than LOCK_STALE_SECS (crashed builder).
#
# Usage: scripts/build-locked.sh [tsc args...]

set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
build-locked.sh — Single-builder mutex around 'npx tsc'.

Usage: scripts/build-locked.sh [tsc-args...]

Acquires a mkdir-based lock (.build.lock in the project root) before running
'npx tsc'. Waits for concurrent builds and steals stale locks. All arguments
are forwarded to tsc unchanged.

Environment overrides:
  LOCK_STALE_SECS   Seconds before a held lock is stolen (default: 180)
  LOCK_WAIT_SECS    Max seconds to wait for a concurrent build (default: 240)

Exit codes:
  0   Build succeeded
  1   Lock wait timed out or tsc failed
HELP
    exit 0
    ;;
esac

LOCK_DIR=".build.lock"
LOCK_STALE_SECS=180
LOCK_WAIT_SECS=240

waited=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  # Steal the lock if its holder appears dead (mkdir mtime too old).
  lock_mtime=$(stat -f '%m' "$LOCK_DIR" 2>/dev/null || stat -c '%Y' "$LOCK_DIR" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$lock_mtime" -gt 0 ] && [ $((now - lock_mtime)) -gt "$LOCK_STALE_SECS" ]; then
    echo "[build-locked] Stealing stale build lock (held >${LOCK_STALE_SECS}s)."
    rmdir "$LOCK_DIR" 2>/dev/null || true
    continue
  fi
  if [ "$waited" -ge "$LOCK_WAIT_SECS" ]; then
    echo "[build-locked] Timed out after ${LOCK_WAIT_SECS}s waiting for concurrent build."
    exit 1
  fi
  if [ "$waited" -eq 0 ]; then
    echo "[build-locked] Another build is running — waiting for it to finish..."
  fi
  sleep 1
  waited=$((waited + 1))
done

trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

npx tsc "$@"
