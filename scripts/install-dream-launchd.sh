#!/usr/bin/env bash
#
# install-dream-launchd.sh — Install and load the AgentOS dream launchd plist.
#
# The plist fires daily at 04:00 local time and runs:
#   scripts/distill-loop.sh --dream-only   (→ aos memory dream)
#
# Usage: ./install-dream-launchd.sh
#
set -euo pipefail

PLIST_NAME="com.agentos.dream"
PLIST_SRC="$(dirname "$0")/com.agentos.dream.plist"
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
    echo "✓ Dream schedule installed."
    echo "  Next run: daily 04:00 local."
    echo "  Manual fire: launchctl start $PLIST_NAME"
    echo "  Logs: $LOG_DIR/dream-launchd.{stdout,stderr}.log"
else
    echo "WARNING: Service may not have loaded. Check logs."
    exit 1
fi
