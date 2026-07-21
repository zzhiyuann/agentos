#!/usr/bin/env bash
#
# install-distill-launchd.sh — Install and load the AgentOS distill launchd plist.
#
# The plist fires every Sunday 03:00 local time and runs:
#   aos memory distill propose --all-roles --notify
#
# Usage: ./install-distill-launchd.sh
#
set -euo pipefail

PLIST_NAME="com.agentos.distill"
PLIST_SRC="$(dirname "$0")/com.agentos.distill.plist"
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
    echo "✓ Distill schedule installed."
    echo "  Next run: Sunday 03:00 local."
    echo "  Manual fire: launchctl start $PLIST_NAME"
    echo "  Logs: $LOG_DIR/distill-launchd.{stdout,stderr}.log"
else
    echo "WARNING: Service may not have loaded. Check logs."
    exit 1
fi
