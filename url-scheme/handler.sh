#!/bin/bash
# AgentOS URL scheme handler
# Handles: agentos://<command>[/<argument>]
# Invoked by macOS when clicking agentos:// links

URL="$1"
LOG_FILE="$HOME/.aos/url-handler.log"
AOS="/opt/homebrew/bin/aos"

echo "[$(date)] Received URL: $URL" >> "$LOG_FILE"

# Parse command and argument from URL
# agentos://spawn/RYA-42 → command=spawn, arg=RYA-42
# agentos://status → command=status, arg=
COMMAND=$(echo "$URL" | sed -E 's|agentos://([a-z]+).*|\1|')
ARG=$(echo "$URL" | sed -E 's|agentos://[a-z]+/?([A-Za-z0-9_-]*).*|\1|')

echo "[$(date)] Command: $COMMAND, Arg: $ARG" >> "$LOG_FILE"

case "$COMMAND" in
    status)
        $AOS status >> "$LOG_FILE" 2>&1
        ;;
    spawn)
        [ -n "$ARG" ] && $AOS spawn "$ARG" >> "$LOG_FILE" 2>&1
        ;;
    jump|session)
        [ -n "$ARG" ] && $AOS jump "$ARG" >> "$LOG_FILE" 2>&1
        ;;
    kill)
        [ -n "$ARG" ] && $AOS kill "$ARG" >> "$LOG_FILE" 2>&1
        ;;
    logs)
        [ -n "$ARG" ] && $AOS logs "$ARG" >> "$LOG_FILE" 2>&1 || $AOS logs >> "$LOG_FILE" 2>&1
        ;;
    watch)
        $AOS watch >> "$LOG_FILE" 2>&1
        ;;
    *)
        echo "[$(date)] Unknown command: $COMMAND" >> "$LOG_FILE"
        exit 1
        ;;
esac
