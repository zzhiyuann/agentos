#!/bin/bash
# AgentOS "definition of done" gate — Claude Code Stop hook (A1.5).
# Blocks an agent from stopping until the DoD is met: HANDOFF.md written with a
# status_intent, and at least one memory file updated this session. On failure,
# exits 2 with the missing items on stderr — Claude Code feeds that back to the
# agent as an instruction to keep working. Bounce-capped to avoid infinite loops.
#
# Enablement (rollout knob, no redeploy needed): ~/.aos/dod-gate-roles contains
# one role per line, or the single line `all`. Absent file = gate disabled.
# Install: injected into agent workspace settings.local.json by the adapter,
# which also exports AOS_STATE_DIR and writes the .session-started-at marker.

[ -z "$AGENT_ROLE" ] && exit 0
[ -z "$AOS_STATE_DIR" ] && exit 0
[ -d "$AOS_STATE_DIR" ] || exit 0

# Read hook payload; never recurse when our own exit-2 retriggered the stop
PAYLOAD=$(cat)
IS_ACTIVE=$(echo "$PAYLOAD" | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('stop_hook_active') else 'false')" 2>/dev/null)
[ "$IS_ACTIVE" = "true" ] && exit 0

# Follow-up sessions answer questions — no HANDOFF/memory requirements
[ -f "$AOS_STATE_DIR/.follow-up" ] && exit 0

# RYA-1312: nested-session guard. Agents sometimes launch a nested `claude`
# from their own Bash tool (API smoke tests, probes). The nested session
# inherits AOS_STATE_DIR/AOS_ISSUE_KEY, and without this guard the gate
# coerces it into writing a bogus no-task HANDOFF.md into the REAL session's
# state dir — the monitor then completes the attempt out from under the
# still-working agent (this killed RYA-1309's first attempt, 2026-07-20).
# A session whose transcript never mentions the dispatched issue key never
# received the task: let it stop freely and demand nothing.
if [ -n "$AOS_ISSUE_KEY" ]; then
  TRANSCRIPT=$(echo "$PAYLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path') or '')" 2>/dev/null)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    head -c 500000 "$TRANSCRIPT" | grep -qF "$AOS_ISSUE_KEY" || exit 0
  fi
fi

# Rollout gating by role
ROLES_FILE="$HOME/.aos/dod-gate-roles"
[ -f "$ROLES_FILE" ] || exit 0
grep -qx -e all -e "$AGENT_ROLE" "$ROLES_FILE" 2>/dev/null || exit 0

# Bounce cap: after 2 rejections, let the agent stop (monitor quality gates take over)
BOUNCE_FILE="$AOS_STATE_DIR/.dod-bounces"
BOUNCES=$(cat "$BOUNCE_FILE" 2>/dev/null)
case "$BOUNCES" in (''|*[!0-9]*) BOUNCES=0;; esac
[ "$BOUNCES" -ge 2 ] && exit 0

FAILURES=""

HANDOFF="$AOS_STATE_DIR/HANDOFF.md"
if [ ! -f "$HANDOFF" ]; then
  FAILURES="${FAILURES}- HANDOFF.md is missing. Write it to $AOS_STATE_DIR/HANDOFF.md following HANDOFF_TEMPLATE.md (Summary, Memory Updated, Remaining Issues + YAML front matter).\n"
elif ! grep -q '^status_intent:' "$HANDOFF"; then
  FAILURES="${FAILURES}- HANDOFF.md lacks a 'status_intent:' line in its YAML front matter (done | in-review | in-progress | todo | no-change).\n"
fi

# Memory check: at least one .md under the workspace .agent-memory/ updated
# since session start. Skip when the marker or memory dir is absent.
MARKER="$AOS_STATE_DIR/.session-started-at"
if [ -f "$MARKER" ] && [ -e ".agent-memory" ]; then
  NEWMEM=$(find -L .agent-memory -name '*.md' -newer "$MARKER" 2>/dev/null | head -1)
  if [ -z "$NEWMEM" ]; then
    FAILURES="${FAILURES}- No memory written this session. Write at least one .md file under .agent-memory/ capturing what you learned, and update .agent-memory-index.md.\n"
  fi
fi

if [ -z "$FAILURES" ]; then
  rm -f "$BOUNCE_FILE" 2>/dev/null
  exit 0
fi

echo $((BOUNCES + 1)) > "$BOUNCE_FILE" 2>/dev/null
printf "Definition-of-done gate: your session is not complete yet.\n%b\nFinish these items, then stop again.\n" "$FAILURES" >&2
exit 2
