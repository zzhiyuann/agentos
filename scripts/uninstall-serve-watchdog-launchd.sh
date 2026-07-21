#!/usr/bin/env bash
#
# uninstall-serve-watchdog-launchd.sh — Unload and remove the serve watchdog.
#
set -euo pipefail

PLIST_NAME="com.agentos.serve-watchdog"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

if launchctl list "$PLIST_NAME" &>/dev/null; then
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    echo "Unloaded $PLIST_NAME"
fi

if [ -f "$PLIST_DST" ]; then
    rm "$PLIST_DST"
    echo "Removed $PLIST_DST"
fi

echo "✓ Serve watchdog uninstalled."
