#!/usr/bin/env bash
#
# serve-loop.sh — Run AgentOS serve with auto-restart support.
#
# Exit codes:
#   100 = auto-deploy rebuild succeeded, restart immediately
#   0 / 130 (SIGINT) = clean shutdown, stop the loop
#   anything else = crash, restart after delay
#
# Usage:
#   scripts/serve-loop.sh [-p 3848]
#
# This script should be used to start serve in tmux for production:
#   tmux new-session -d -s aos-serve -c ~/projects/agentos 'scripts/serve-loop.sh'

set -euo pipefail
cd "$(dirname "$0")/.."

MAX_CRASH_RESTARTS=5
CRASH_DELAY=5
crash_count=0

while true; do
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  AgentOS serve starting ($(date '+%H:%M:%S'))"
  echo "═══════════════════════════════════════════════"
  echo ""

  node dist/cli.js serve "$@" || EXIT_CODE=$?
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
