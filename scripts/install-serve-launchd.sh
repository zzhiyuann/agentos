#!/usr/bin/env bash
#
# install-serve-launchd.sh — Install and load the AgentOS serve launchd plist.
#
# Usage: ./install-serve-launchd.sh
#
set -euo pipefail

PLIST_NAME="com.agentos.serve"
PLIST_SRC="$(dirname "$0")/com.agentos.serve.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME/.aos/logs"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Stop existing service if loaded
if launchctl list "$PLIST_NAME" &>/dev/null; then
    echo "Stopping existing $PLIST_NAME..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    sleep 2
fi

# Kill tmux-based serve if running. A tmux serve-loop and the launchd instance
# fight over port 3848 (EADDRINUSE crash-loop — this killed the launchd layer
# on 2026-03-27). launchd must be the sole owner of serve.
if tmux has-session -t aos-serve 2>/dev/null; then
    echo "Killing tmux session aos-serve (launchd owns serve from now on)..."
    tmux kill-session -t aos-serve
    sleep 1
fi

# Kill any leftover serve process
if lsof -ti :3848 &>/dev/null; then
    echo "Killing leftover process on port 3848..."
    lsof -ti :3848 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Copy plist
cp "$PLIST_SRC" "$PLIST_DST"
echo "Installed plist to $PLIST_DST"

# Load
launchctl load "$PLIST_DST"
echo "Loaded $PLIST_NAME"

# Verify
sleep 3
if launchctl list "$PLIST_NAME" &>/dev/null; then
    echo "Service is running."
    echo "Logs: $LOG_DIR/serve-launchd.{stdout,stderr}.log"
else
    echo "WARNING: Service may not have started. Check logs."
fi
