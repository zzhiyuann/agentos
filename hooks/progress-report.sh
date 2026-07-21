#!/bin/bash
# AgentOS progress reporter — Claude Code Stop hook
# Pushes agent's latest response summary to Linear via AOS serve /progress endpoint.
# Install: automatically injected into agent workspace settings.local.json by adapter.

# Only run for AgentOS sessions
[ -z "$AGENT_ROLE" ] && exit 0

# Read hook payload
PAYLOAD=$(cat)

# Don't recurse
IS_ACTIVE=$(echo "$PAYLOAD" | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('stop_hook_active') else 'false')" 2>/dev/null)
[ "$IS_ACTIVE" = "true" ] && exit 0

# Extract + truncate last assistant message
SUMMARY=$(echo "$PAYLOAD" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msg = d.get('last_assistant_message', '')
lines = [l.strip() for l in msg.split('\n') if l.strip() and not l.strip().startswith('\`\`\`')]
text = '\n'.join(lines[:8])
print(text[:500] if text else '')
" 2>/dev/null)

[ -z "$SUMMARY" ] && exit 0

# Post to AOS serve /progress endpoint (it handles Linear AgentSession + token)
PROGRESS_JSON=$(AGENT_ROLE="$AGENT_ROLE" python3 -c "
import json, sys, os
role = os.environ.get('AGENT_ROLE', '')
msg = sys.stdin.read().strip()
if role and msg:
    print(json.dumps({'role': role, 'message': msg}))
" <<< "$SUMMARY" 2>/dev/null)

[ -n "$PROGRESS_JSON" ] && curl -s -X POST http://localhost:3848/progress \
  -H 'Content-Type: application/json' \
  -d "$PROGRESS_JSON" \
  --max-time 5 >/dev/null 2>&1

exit 0
