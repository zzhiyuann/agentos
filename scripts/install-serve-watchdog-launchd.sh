#!/usr/bin/env bash
#
# install-serve-watchdog-launchd.sh — Install the standalone serve liveness
# watchdog (RYA-1180). Fires every 15 min; alerts Discord if the serve
# heartbeat is stale >30 min. Independent of serve and serve-loop.sh so it
# survives their death — that is the whole point.
#
# Usage: ./install-serve-watchdog-launchd.sh
#
set -euo pipefail

PLIST_NAME="com.agentos.serve-watchdog"
PLIST_SRC="$(dirname "$0")/com.agentos.serve-watchdog.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME/.aos/logs"

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

# Stop existing service if loaded
if launchctl list "$PLIST_NAME" &>/dev/null; then
    echo "Stopping existing $PLIST_NAME..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    sleep 1
fi

cp "$PLIST_SRC" "$PLIST_DST"
echo "Installed plist to $PLIST_DST"

launchctl load "$PLIST_DST"
echo "Loaded $PLIST_NAME"

if launchctl list "$PLIST_NAME" &>/dev/null; then
    echo "✓ Serve watchdog installed (checks every 15 min, alerts if heartbeat stale >30 min)."
    if [ ! -f "$HOME/.aos/serve-heartbeat.json" ]; then
        echo "  NOTE: no heartbeat file yet — make sure serve is running a build that"
        echo "  includes the liveness heartbeat (RYA-1180), or the watchdog will alert."
    fi
    echo "  Manual fire: launchctl start $PLIST_NAME"
    echo "  Logs: $LOG_DIR/serve-watchdog.{stdout,stderr}.log"
    echo "  Outage audit trail: ~/.aos/outages.jsonl"
else
    echo "WARNING: Service may not have loaded. Check logs."
    exit 1
fi
