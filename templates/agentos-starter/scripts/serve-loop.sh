#!/usr/bin/env bash
#
# serve-loop.sh — Run `aos serve` with auto-restart support.
#
# Exit codes from `aos serve`:
#   100 = auto-deploy rebuild succeeded, restart immediately
#   0 / 130 (SIGINT) = clean shutdown, stop the loop
#   anything else = crash, restart after delay
#
# Usage:
#   scripts/serve-loop.sh [-p 3848]
#
# For production, run under launchd (see install-serve-launchd.sh).

set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env if present so serve inherits config (launchd supplies env directly,
# but interactive runs rely on this).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

MAX_CRASH_RESTARTS=5
CRASH_DELAY=5
crash_count=0

while true; do
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  AgentOS serve starting ($(date '+%H:%M:%S'))"
  echo "═══════════════════════════════════════════════"
  echo ""

  # Prefer the globally-installed `aos` binary; fall back to npx if not on PATH.
  if command -v aos >/dev/null 2>&1; then
    aos serve "$@" || EXIT_CODE=$?
  else
    npx --no-install aos serve "$@" || EXIT_CODE=$?
  fi
  EXIT_CODE=${EXIT_CODE:-0}

  case $EXIT_CODE in
    100)
      echo ""
      echo "[serve-loop] Auto-deploy: rebuild complete, restarting immediately..."
      crash_count=0
      continue
      ;;
    0|130)
      echo ""
      echo "[serve-loop] Clean shutdown (exit $EXIT_CODE)."
      break
      ;;
    *)
      crash_count=$((crash_count + 1))
      if [ $crash_count -ge $MAX_CRASH_RESTARTS ]; then
        echo ""
        echo "[serve-loop] Too many crashes ($crash_count). Stopping."
        exit 1
      fi
      echo ""
      echo "[serve-loop] Serve crashed (exit $EXIT_CODE). Restart $crash_count/$MAX_CRASH_RESTARTS in ${CRASH_DELAY}s..."
      sleep $CRASH_DELAY
      ;;
  esac
done
