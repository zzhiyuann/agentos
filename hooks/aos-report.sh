#!/bin/bash
# AgentOS session reporter hook for Claude Code
# Install on execution host: add to ~/.claude/settings.json under hooks.Stop
#
# When a Claude Code session with name "aos-*" stops, this hook:
# 1. Reads HANDOFF.md/BLOCKED.md from the workspace
# 2. Updates the Linear issue via the AgentOS CLI

set -e

# Read hook payload from stdin
PAYLOAD=$(cat)

# Extract session name from the hook payload
SESSION_NAME=$(echo "$PAYLOAD" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # The session name might be in different fields depending on hook version
    name = data.get('session_name', '') or data.get('name', '')
    print(name)
except:
    print('')
" 2>/dev/null)

# Only process AgentOS sessions
if [[ ! "$SESSION_NAME" =~ ^aos- ]]; then
    exit 0
fi

# Extract issue key from session name (aos-RYA-42 → RYA-42)
ISSUE_KEY="${SESSION_NAME#aos-}"

LOG_FILE="$HOME/.aos/hook.log"
echo "[$(date)] Stop hook fired for $SESSION_NAME (issue: $ISSUE_KEY)" >> "$LOG_FILE"

# Extract stop reason
STOP_REASON=$(echo "$PAYLOAD" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('stop_reason', 'unknown'))
except:
    print('unknown')
" 2>/dev/null)

# Check for workspace artifacts
WORKSPACE="$HOME/agent-workspaces/$ISSUE_KEY"

if [ -f "$WORKSPACE/HANDOFF.md" ]; then
    echo "[$(date)] Found HANDOFF.md for $ISSUE_KEY" >> "$LOG_FILE"
    # Agent completed successfully - aos watch will pick this up
elif [ -f "$WORKSPACE/BLOCKED.md" ]; then
    echo "[$(date)] Found BLOCKED.md for $ISSUE_KEY" >> "$LOG_FILE"
    # Agent is blocked - aos watch will pick this up
else
    echo "[$(date)] No handoff artifacts for $ISSUE_KEY (reason: $STOP_REASON)" >> "$LOG_FILE"
fi

# --- Post-session memory validation (warn only) ---
MEMORY_DIR="$WORKSPACE/.agent-memory"
MEMORY_INDEX="$WORKSPACE/.agent-memory-index.md"
MEMORY_WARNINGS=""

# Check: session completed work but zero memory files
if [ -f "$WORKSPACE/HANDOFF.md" ]; then
    MEMORY_COUNT=0
    if [ -d "$MEMORY_DIR" ]; then
        MEMORY_COUNT=$(find "$MEMORY_DIR" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    fi
    if [ "$MEMORY_COUNT" -eq 0 ]; then
        MEMORY_WARNINGS="WARN: Agent completed work but wrote zero memory files"
        echo "[$(date)] [MEMORY] $ISSUE_KEY: $MEMORY_WARNINGS" >> "$LOG_FILE"
    fi

    # Check: memory files exist but not referenced in MEMORY.md index
    if [ "$MEMORY_COUNT" -gt 0 ] && [ -f "$MEMORY_INDEX" ]; then
        INDEX_CONTENT=$(cat "$MEMORY_INDEX" 2>/dev/null || echo "")
        for memfile in "$MEMORY_DIR"/*.md; do
            BASENAME=$(basename "$memfile")
            NAMEONLY="${BASENAME%.md}"
            if ! echo "$INDEX_CONTENT" | grep -q "$NAMEONLY"; then
                MSG="WARN: Memory file $BASENAME not indexed in MEMORY.md"
                MEMORY_WARNINGS="${MEMORY_WARNINGS:+$MEMORY_WARNINGS; }$MSG"
                echo "[$(date)] [MEMORY] $ISSUE_KEY: $MSG" >> "$LOG_FILE"
            fi
        done
    fi

    # Check: MEMORY.md exists but memory dir is missing/empty
    if [ -f "$MEMORY_INDEX" ] && [ ! -d "$MEMORY_DIR" ]; then
        MSG="WARN: MEMORY.md exists but .agent-memory/ directory is missing"
        MEMORY_WARNINGS="${MEMORY_WARNINGS:+$MEMORY_WARNINGS; }$MSG"
        echo "[$(date)] [MEMORY] $ISSUE_KEY: $MSG" >> "$LOG_FILE"
    fi
fi

# Write stop event for aos watch to process
mkdir -p "$HOME/.aos/events"
cat > "$HOME/.aos/events/${SESSION_NAME}.json" << EVENTEOF
{
  "session_name": "$SESSION_NAME",
  "issue_key": "$ISSUE_KEY",
  "stop_reason": "$STOP_REASON",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "workspace": "$WORKSPACE",
  "memory_warnings": "${MEMORY_WARNINGS:-}"
}
EVENTEOF

echo "[$(date)] Event written for $ISSUE_KEY" >> "$LOG_FILE"
