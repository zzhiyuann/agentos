#!/usr/bin/env bash
#
# uninstall-distill-launchd.sh — Stop and remove the AgentOS distill launchd plist.
#
set -euo pipefail

PLIST_NAME="com.agentos.distill"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

if launchctl list "$PLIST_NAME" &>/dev/null; then
    echo "Unloading $PLIST_NAME..."
    launchctl unload "$PLIST_DST"
    sleep 1
    echo "Unloaded."
else
    echo "$PLIST_NAME is not loaded."
fi

if [ -f "$PLIST_DST" ]; then
    rm "$PLIST_DST"
    echo "Removed $PLIST_DST"
fi

echo "Done. Distill schedule disabled."
