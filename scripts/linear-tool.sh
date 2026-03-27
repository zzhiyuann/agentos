#!/bin/bash
# linear-tool.sh — Linear API helper for AI agents
# Usage: ./linear-tool.sh <command> [args...]
# Token is read from ~/.aos/agents/<role>/.oauth-token or $LINEAR_TOKEN

TOKEN="${LINEAR_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -n "$AGENT_ROLE" ]; then
  TOKEN=$(cat ~/.aos/agents/$AGENT_ROLE/.oauth-token 2>/dev/null)
fi
if [ -z "$TOKEN" ]; then
  TOKEN=$(cat ~/.aos/.oauth-token 2>/dev/null)
fi

if [ -z "$TOKEN" ]; then
  echo "Error: No LINEAR_TOKEN or agent token found"
  exit 1
fi

API="https://api.linear.app/graphql"
AUTH="Bearer $TOKEN"

gql() {
  curl -s -H "Authorization: $AUTH" -H "Content-Type: application/json" \
    -X POST "$API" -d "$1"
}

case "$1" in
  comment)
    # linear-tool.sh comment <issue-id-or-key> "message"
    ISSUE_KEY="$2"
    shift 2
    BODY="$*"
    # Guard: reject flag-like bodies (e.g. --list, --help) — likely a misused command
    if [[ "$BODY" =~ ^--[a-z] ]]; then
      echo "Error: comment body looks like a flag ('$BODY'). Did you mean a different command?"
      echo "  To list issues: linear-tool list-issues [status]"
      echo "  To post a comment: linear-tool comment <issue-key> \"Your message here\""
      exit 1
    fi
    # Resolve issue key to ID
    if [[ "$ISSUE_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
      NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
      ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    else
      ISSUE_ID="$ISSUE_KEY"
    fi
    # Use Python to properly JSON-encode the body with variables
    PAYLOAD=$(python3 -c "
import json, sys
body = sys.stdin.read()
print(json.dumps({
    'query': 'mutation(\$i: CommentCreateInput!) { commentCreate(input: \$i) { success } }',
    'variables': {'i': {'issueId': '$ISSUE_ID', 'body': body}}
}))
" <<< "$BODY")
    gql "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('data',{}).get('commentCreate',{}).get('success') else d)"
    ;;

  reply)
    # linear-tool.sh reply <issue-key> <parent-comment-id> "message"
    # Creates a threaded reply under a specific comment
    ISSUE_KEY="$2"
    PARENT_COMMENT_ID="$3"
    shift 3
    BODY="$*"
    if [[ "$ISSUE_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
      NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
      ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    else
      ISSUE_ID="$ISSUE_KEY"
    fi
    PAYLOAD=$(PARENT_ID="$PARENT_COMMENT_ID" python3 -c "
import json, sys, os
body = sys.stdin.read()
inp = {'issueId': '$ISSUE_ID', 'body': body, 'parentId': os.environ['PARENT_ID']}
print(json.dumps({
    'query': 'mutation(\$i: CommentCreateInput!) { commentCreate(input: \$i) { success } }',
    'variables': {'i': inp}
}))
" <<< "$BODY")
    gql "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('data',{}).get('commentCreate',{}).get('success') else d)"
    ;;

  create-issue)
    # linear-tool.sh create-issue "title" "description" [priority] [parent-issue-key] [assignee-role]
    TITLE="$2"
    DESC="$3"
    PRIORITY="${4:-2}"
    PARENT_KEY="${5:-}"
    ASSIGNEE_ROLE="${6:-}"
    TEAM_ID="${AOS_LINEAR_TEAM_ID:?Set AOS_LINEAR_TEAM_ID}"

    # Resolve parent issue key to ID if provided
    PARENT_ID=""
    if [[ -n "$PARENT_KEY" && "$PARENT_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      PTEAM=$(echo "$PARENT_KEY" | cut -d- -f1)
      PNUM=$(echo "$PARENT_KEY" | cut -d- -f2)
      PARENT_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$PTEAM\\\" } }, number: { eq: $PNUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    fi

    # Resolve assignee: explicit role > AGENT_ROLE env var
    ASSIGNEE_ID=""
    RESOLVE_ROLE="${ASSIGNEE_ROLE:-$AGENT_ROLE}"
    if [ -n "$RESOLVE_ROLE" ]; then
      ASSIGNEE_ID=$(python3 -c "import json; print(json.load(open('$HOME/.aos/agents/$RESOLVE_ROLE/config.json')).get('linearUserId',''))" 2>/dev/null)
    fi

    PAYLOAD=$(TITLE="$TITLE" DESC="$DESC" PRIORITY="$PRIORITY" TEAM_ID="$TEAM_ID" PARENT_ID="$PARENT_ID" ASSIGNEE_ID="$ASSIGNEE_ID" python3 -c "
import json, os
inp = {
    'teamId': os.environ['TEAM_ID'],
    'title': os.environ['TITLE'],
    'description': os.environ['DESC'],
    'priority': int(os.environ['PRIORITY'])
}
if os.environ.get('PARENT_ID'):
    inp['parentId'] = os.environ['PARENT_ID']
if os.environ.get('ASSIGNEE_ID'):
    inp['assigneeId'] = os.environ['ASSIGNEE_ID']
print(json.dumps({
    'query': 'mutation(\$i: IssueCreateInput!) { issueCreate(input: \$i) { success issue { identifier url } } }',
    'variables': {'i': inp}
}))
")
    gql "$PAYLOAD" | python3 -c "import sys,json; i=json.load(sys.stdin)['data']['issueCreate']['issue']; print(f\"{i['identifier']}: {i['url']}\")" 2>/dev/null
    ;;

  set-status)
    # linear-tool.sh set-status <issue-key> <status-name>
    ISSUE_KEY="$2"
    STATUS="$3"
    TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
    NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
    # Get issue ID and state ID
    python3 -c "
import json, subprocess
def gql(q):
    r = subprocess.run(['curl','-s','-H','Authorization: $AUTH','-H','Content-Type: application/json','-X','POST','$API','-d',json.dumps({'query':q})], capture_output=True, text=True)
    return json.loads(r.stdout)
issue = gql('{ issues(filter: { team: { key: { eq: \"$TEAM\" } }, number: { eq: $NUM } }) { nodes { id } } }')
issue_id = issue['data']['issues']['nodes'][0]['id']
states = gql('{ workflowStates(filter: { team: { key: { eq: \"$TEAM\" } } }) { nodes { id name } } }')
state_id = next(s['id'] for s in states['data']['workflowStates']['nodes'] if s['name'] == '$STATUS')
result = gql('mutation { issueUpdate(id: \"' + issue_id + '\", input: { stateId: \"' + state_id + '\" }) { success } }')
print('OK' if result['data']['issueUpdate']['success'] else 'FAILED')
"
    ;;

  set-priority)
    # linear-tool.sh set-priority <issue-key> <1-4>
    ISSUE_KEY="$2"
    PRIORITY="$3"
    TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
    NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
    ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    gql "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { priority: $PRIORITY }) { success } }\"}" | python3 -c "import sys,json; print('OK' if json.load(sys.stdin).get('data',{}).get('issueUpdate',{}).get('success') else 'FAILED')"
    ;;

  add-label)
    # linear-tool.sh add-label <issue-key> <label-name>
    echo "TODO: implement add-label"
    ;;

  list-issues)
    # linear-tool.sh list-issues [status]
    STATUS="${2:-}"
    if [ -n "$STATUS" ]; then
      FILTER="filter: { team: { key: { eq: \\\"${AOS_LINEAR_TEAM_KEY:-RYA}\\\" } }, state: { name: { eq: \\\"$STATUS\\\" } } }"
    else
      FILTER="filter: { team: { key: { eq: \\\"${AOS_LINEAR_TEAM_KEY:-RYA}\\\" } } }"
    fi
    gql "{\"query\": \"{ issues($FILTER, first: 20) { nodes { identifier title state { name } priority assignee { name } } } }\"}" | python3 -c "
import sys,json
for i in json.load(sys.stdin)['data']['issues']['nodes']:
    a = i.get('assignee',{})
    print(f\"{i['identifier']} [{i['state']['name']}] P{i['priority']} {i['title'][:50]}  {'→ '+a['name'] if a else ''}\")
" 2>/dev/null
    ;;

  mention)
    # linear-tool.sh mention <target-role> <issue-key> "message"
    TARGET_ROLE="$2"
    ISSUE_KEY="$3"
    BODY="$4"
    TARGET_USER_ID=$(python3 -c "import json; c=json.load(open('$HOME/.aos/agents/$TARGET_ROLE/config.json')); print(c.get('linearUserId',''))" 2>/dev/null)
    if [ -z "$TARGET_USER_ID" ]; then
      echo "Error: No linearUserId for $TARGET_ROLE"
      exit 1
    fi
    # Resolve issue key to ID
    if [[ "$ISSUE_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
      NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
      ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    else
      ISSUE_ID="$ISSUE_KEY"
    fi
    # Post comment mentioning the target agent
    MENTION_BODY="@${TARGET_ROLE} ${BODY}"
    PAYLOAD=$(python3 -c "
import json, sys
body = sys.stdin.read()
print(json.dumps({
    'query': 'mutation(\$i: CommentCreateInput!) { commentCreate(input: \$i) { success } }',
    'variables': {'i': {'issueId': '$ISSUE_ID', 'body': body}}
}))
" <<< "$MENTION_BODY")
    gql "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('data',{}).get('commentCreate',{}).get('success') else d)"
    ;;

  team)
    # linear-tool.sh team — show all agent roles and their Linear user IDs
    echo "Agent Directory"
    echo "─────────────────────────────────────────────"
    for role_dir in $HOME/.aos/agents/*/; do
      role=$(basename "$role_dir")
      config="$role_dir/config.json"
      if [ -f "$config" ]; then
        USER_ID=$(python3 -c "import json; c=json.load(open('$config')); print(c.get('linearUserId','unknown'))" 2>/dev/null)
        MODEL=$(python3 -c "import json; c=json.load(open('$config')); print(c.get('baseModel','?'))" 2>/dev/null)
        printf "  %-18s %-7s %s\n" "$role" "$MODEL" "$USER_ID"
      fi
    done
    ;;

  spawn-worker)
    # linear-tool.sh spawn-worker "title" "description" [label]
    TITLE="$2"
    DESC="$3"
    LABEL="${4:-agent:lead-engineer}"
    TEAM_ID="${AOS_LINEAR_TEAM_ID:?Set AOS_LINEAR_TEAM_ID}"
    # Get label ID
    LABEL_ID=$(gql "{\"query\": \"{ issueLabels(filter: { name: { eq: \\\"$LABEL\\\" } }) { nodes { id } } }\"}" | python3 -c "import sys,json; nodes=json.load(sys.stdin)['data']['issueLabels']['nodes']; print(nodes[0]['id'] if nodes else '')" 2>/dev/null)
    if [ -n "$LABEL_ID" ]; then
      PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'query': 'mutation(\$i: IssueCreateInput!) { issueCreate(input: \$i) { success issue { identifier url } } }',
    'variables': {'i': {'teamId': '$TEAM_ID', 'title': '$TITLE', 'description': '$DESC', 'priority': 2, 'labelIds': ['$LABEL_ID']}}
}))
")
    else
      PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'query': 'mutation(\$i: IssueCreateInput!) { issueCreate(input: \$i) { success issue { identifier url } } }',
    'variables': {'i': {'teamId': '$TEAM_ID', 'title': '$TITLE', 'description': '$DESC', 'priority': 2}}
}))
")
    fi
    gql "$PAYLOAD" | python3 -c "import sys,json; i=json.load(sys.stdin)['data']['issueCreate']['issue']; print(f\"{i['identifier']}: {i['url']}\")" 2>/dev/null
    ;;

  ask)
    # linear-tool ask <target-role> <issue-key> "question"
    # Non-blocking: sends the question and returns immediately. Response arrives via tmux.
    TARGET_ROLE="$2"
    ISSUE_KEY="$3"
    shift 3
    QUESTION="$*"
    if [ -z "$TARGET_ROLE" ] || [ -z "$ISSUE_KEY" ] || [ -z "$QUESTION" ]; then
      echo "Usage: linear-tool ask <role> <issue-key> \"question\""
      exit 1
    fi
    RESULT=$(curl -s -X POST http://localhost:3848/ask \
      -H 'Content-Type: application/json' \
      -d "$(python3 -c "
import json, os
print(json.dumps({
    'from': os.environ.get('AGENT_ROLE', 'unknown'),
    'to': '$TARGET_ROLE',
    'issueKey': '$ISSUE_KEY',
    'question': '''$QUESTION'''
}))
")" --max-time 10 2>/dev/null)
    if [ -z "$RESULT" ]; then
      echo "Error: server unreachable"
      exit 1
    fi
    echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail') or d.get('error', 'Question sent. Response will arrive in your tmux session.'))"
    ;;

  notify)
    # linear-tool notify <target-role> "message"
    # Non-blocking notification to a running agent
    TARGET_ROLE="$2"
    shift 2
    MESSAGE="$*"
    if [ -z "$TARGET_ROLE" ] || [ -z "$MESSAGE" ]; then
      echo "Usage: linear-tool notify <role> \"message\""
      exit 1
    fi
    curl -s -X POST http://localhost:3848/notify \
      -H 'Content-Type: application/json' \
      -d "$(python3 -c "
import json, os
print(json.dumps({
    'from': os.environ.get('AGENT_ROLE', 'unknown'),
    'to': '$TARGET_ROLE',
    'message': '''$MESSAGE'''
}))
")" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail', d.get('error', 'sent')))"
    ;;

  team-status)
    # linear-tool team-status — show all agents' current state
    RESULT=$(curl -s http://localhost:3848/status 2>/dev/null)
    if [ -z "$RESULT" ]; then
      echo "Error: Could not reach AgentOS server"
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('Agent Roster')
print('─' * 60)
for a in data.get('agents', []):
    icon = '🟢' if a['status'] == 'active' else '⚫'
    task = a.get('currentTask') or 'idle'
    print(f'  {icon} {a[\"role\"]:18s} {a[\"model\"]:7s} {task}')
q = data.get('queue', {})
print(f'\nQueue: {q.get(\"length\", 0)} items | Uptime: {data.get(\"uptime\", 0)}s')
"
    ;;

  group)
    shift 1
    MESSAGE="$*"
    if [ -z "$MESSAGE" ]; then
      echo "Usage: linear-tool group \"message\""
      exit 1
    fi
    ROLE="${AGENT_ROLE:-system}"
    TMPFILE=$(mktemp)
    python3 -c "import json,sys; json.dump({'role':'$ROLE','message':sys.stdin.read()}, open('$TMPFILE','w'))" <<< "$MESSAGE"
    curl -s -X POST http://localhost:3848/group-post \
      -H 'Content-Type: application/json' \
      -d @"$TMPFILE" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('sent' if d.get('ok') else d.get('error', 'failed'))"
    rm -f "$TMPFILE"
    ;;

  dispatch)
    # linear-tool dispatch <role> <issue-key> [message]
    # Direct agent-to-agent dispatch via AgentOS serve endpoint
    TARGET_ROLE="$2"
    ISSUE_KEY="$3"
    MESSAGE="${4:-}"
    if [ -z "$TARGET_ROLE" ] || [ -z "$ISSUE_KEY" ]; then
      echo "Usage: linear-tool dispatch <role> <issue-key> [message]"
      echo "Roles: cto, cpo, coo, lead-engineer, research-lead"
      exit 1
    fi
    PAYLOAD=$(python3 -c "
import json, os
d = {'role': '$TARGET_ROLE', 'issueKey': '$ISSUE_KEY'}
msg = '''$MESSAGE'''
if msg.strip():
    d['message'] = msg
fr = os.environ.get('AGENT_ROLE', '')
if fr:
    d['from'] = fr
print(json.dumps(d))
")
    RESULT=$(curl -s -X POST http://localhost:3848/dispatch \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD" 2>/dev/null)
    if [ -z "$RESULT" ]; then
      echo "Error: Could not reach AgentOS server at localhost:3848"
      exit 1
    fi
    echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('action','error')}: {d.get('detail','unknown')}\")"
    ;;

  handoff)
    # linear-tool handoff <role> <issue-key> [message]
    # Same-issue handoff: current agent finishes, target agent picks up
    TARGET_ROLE="$2"
    ISSUE_KEY="$3"
    MESSAGE="${4:-}"
    if [ -z "$TARGET_ROLE" ] || [ -z "$ISSUE_KEY" ]; then
      echo "Usage: linear-tool handoff <role> <issue-key> [message]"
      echo "Roles: cto, cpo, coo, lead-engineer, research-lead"
      exit 1
    fi
    PAYLOAD=$(python3 -c "
import json, os
d = {'role': '$TARGET_ROLE', 'issueKey': '$ISSUE_KEY', 'handoff': True}
msg = '''$MESSAGE'''
if msg.strip():
    d['message'] = msg
fr = os.environ.get('AGENT_ROLE', '')
if fr:
    d['from'] = fr
print(json.dumps(d))
")
    RESULT=$(curl -s -X POST http://localhost:3848/dispatch \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD" 2>/dev/null)
    if [ -z "$RESULT" ]; then
      echo "Error: Could not reach AgentOS server at localhost:3848"
      exit 1
    fi
    echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('action','error')}: {d.get('detail','unknown')}\")"
    ;;

  update-title)
    # linear-tool update-title <issue-key> "New title"
    ISSUE_KEY="$2"
    shift 2
    NEW_TITLE="$*"
    if [ -z "$ISSUE_KEY" ] || [ -z "$NEW_TITLE" ]; then
      echo "Usage: linear-tool update-title <issue-key> \"New title\""
      exit 1
    fi
    TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
    NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
    python3 -c "
import json, subprocess
def gql(q):
    r = subprocess.run(['curl','-s','-H','Authorization: $AUTH','-H','Content-Type: application/json','-X','POST','$API','-d',json.dumps({'query':q})], capture_output=True, text=True)
    return json.loads(r.stdout)
issue = gql('{ issues(filter: { team: { key: { eq: \"$TEAM\" } }, number: { eq: $NUM } }) { nodes { id } } }')
issue_id = issue['data']['issues']['nodes'][0]['id']
import sys
title = sys.stdin.read().strip()
result = gql('mutation { issueUpdate(id: \"' + issue_id + '\", input: { title: \"' + title.replace('\"', '\\\\\"') + '\" }) { success } }')
print('OK' if result.get('data',{}).get('issueUpdate',{}).get('success') else 'FAILED')
" <<< "$NEW_TITLE"
    ;;

  search)
    # linear-tool search "query text"
    shift 1
    QUERY="$*"
    if [ -z "$QUERY" ]; then
      echo "Usage: linear-tool search \"query text\""
      exit 1
    fi
    TMPFILE=$(mktemp)
    python3 -c "import json,sys; json.dump({'query':'{ issueSearch(query: \"' + sys.stdin.read().strip() + '\", first: 10) { nodes { identifier title state { name } assignee { name } } } }'}, open('$TMPFILE','w'))" <<< "$QUERY"
    curl -s -X POST "$API" -H "Authorization: $AUTH" -H "Content-Type: application/json" \
      -d @"$TMPFILE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for n in data.get('data',{}).get('issueSearch',{}).get('nodes',[]):
    state = n.get('state',{}).get('name','?')
    assignee = n.get('assignee',{}).get('name','unassigned') if n.get('assignee') else 'unassigned'
    print(f\"{n['identifier']} [{state}] {n['title']} ({assignee})\")
"
    rm -f "$TMPFILE"
    ;;

  discord-reply)
    CHANNEL_ID="$2"
    MESSAGE_ID="$3"
    shift 3
    REPLY_BODY="$*"
    if [ -z "$CHANNEL_ID" ] || [ -z "$REPLY_BODY" ]; then
      echo "Usage: linear-tool discord-reply <channel-id> <message-id> \"reply text\""
      exit 1
    fi
    RESULT=$(curl -s -X POST "http://localhost:3848/discord-reply" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c "
import json, sys
print(json.dumps({
    'channelId': '$CHANNEL_ID',
    'messageId': '$MESSAGE_ID',
    'content': sys.stdin.read().strip(),
    'role': '${AGENT_ROLE:-system}'
}))
" <<< "$REPLY_BODY")")
    OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
    if [ "$OK" = "True" ]; then
      echo "replied"
    else
      echo "Failed to reply: $RESULT" >&2
      exit 1
    fi
    ;;

  plan)
    # linear-tool plan <issue-key>
    # Triggers the planner to decompose the issue, create sub-issues, and dispatch agents.
    ISSUE_KEY="$2"
    if [ -z "$ISSUE_KEY" ]; then
      echo "Usage: linear-tool plan <issue-key>"
      echo "Decomposes the issue into sub-issues and dispatches agents in parallel."
      exit 1
    fi
    RESULT=$(curl -s -X POST http://localhost:3848/plan \
      -H 'Content-Type: application/json' \
      -d "{\"issueKey\": \"$ISSUE_KEY\"}" --max-time 10 2>/dev/null)
    if [ -z "$RESULT" ]; then
      echo "Error: Could not reach AgentOS server at localhost:3848"
      exit 1
    fi
    echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('action','error')}: {d.get('detail','unknown')}\")"
    ;;

  sub-issues)
    # linear-tool sub-issues <issue-key>
    ISSUE_KEY="$2"
    if [ -z "$ISSUE_KEY" ]; then
      echo "Usage: linear-tool sub-issues <issue-key>"
      exit 1
    fi
    RESULT=$(curl -s http://localhost:3848/sub-issues/$ISSUE_KEY --max-time 10 2>/dev/null)
    if [ -z "$RESULT" ]; then
      echo "Error: Could not reach AgentOS server at localhost:3848"
      exit 1
    fi
    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data.get('ok'):
    print(f\"Error: {data.get('error', 'unknown')}\")
    sys.exit(1)
subs = data.get('subIssues', [])
if not subs:
    print(f'No sub-issues found for {data[\"parentKey\"]}')
else:
    print(f'Sub-issues of {data[\"parentKey\"]} ({len(subs)} total):')
    for s in subs:
        icon = 'v' if s['state'] == 'Done' else '*' if s['state'] == 'In Progress' else 'o'
        assignee = f' -> {s[\"assignee\"]}' if s.get('assignee') else ''
        print(f'  {icon} {s[\"key\"]} [{s[\"state\"]}] {s[\"title\"][:50]}{assignee}')
"
    ;;

  assign)
    # linear-tool assign <issue-key> <role>
    ISSUE_KEY="$2"
    TARGET_ROLE="$3"
    if [ -z "$ISSUE_KEY" ] || [ -z "$TARGET_ROLE" ]; then
      echo "Usage: linear-tool assign <issue-key> <role>"
      echo "Assigns the issue to the specified agent role."
      exit 1
    fi
    # Get agent's Linear user ID
    TARGET_USER_ID=$(python3 -c "import json; c=json.load(open('$HOME/.aos/agents/$TARGET_ROLE/config.json')); print(c.get('linearUserId',''))" 2>/dev/null)
    if [ -z "$TARGET_USER_ID" ]; then
      echo "Error: No linearUserId for $TARGET_ROLE"
      exit 1
    fi
    # Resolve issue key to ID
    if [[ "$ISSUE_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
      NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
      ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    else
      ISSUE_ID="$ISSUE_KEY"
    fi
    # Update both assignee and delegate
    gql "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { assigneeId: \\\"$TARGET_USER_ID\\\", delegateId: \\\"$TARGET_USER_ID\\\" }) { success } }\"}" | python3 -c "import sys,json; print('OK: assigned to $TARGET_ROLE' if json.load(sys.stdin).get('data',{}).get('issueUpdate',{}).get('success') else 'FAILED')"
    ;;

  bulk-dispatch)
    # linear-tool bulk-dispatch <parent-key> <json-file>
    # JSON format: [{"title":"...","description":"...","assignee":"role"}, ...]
    PARENT_KEY="$2"
    JSON_FILE="$3"
    if [ -z "$PARENT_KEY" ] || [ -z "$JSON_FILE" ]; then
      echo "Usage: linear-tool bulk-dispatch <parent-issue-key> <json-file>"
      echo "JSON file: [{\"title\":\"...\",\"description\":\"...\",\"assignee\":\"role\"}, ...]"
      exit 1
    fi
    if [ ! -f "$JSON_FILE" ]; then
      echo "Error: File not found: $JSON_FILE"
      exit 1
    fi
    python3 -c "
import json, subprocess, sys

parent_key = '$PARENT_KEY'

with open('$JSON_FILE') as f:
    subtasks = json.load(f)

print(f'Creating {len(subtasks)} sub-issues under {parent_key}...')
for task in subtasks:
    title = task['title']
    desc = task.get('description', '')
    assignee = task.get('assignee', 'lead-engineer')
    priority = str(task.get('priority', 2))

    # Create sub-issue
    result = subprocess.run(
        ['linear-tool', 'create-issue', title, desc, priority, parent_key],
        capture_output=True, text=True
    )
    output = result.stdout.strip()
    issue_key = output.split(':')[0] if ':' in output else None

    if issue_key and issue_key.startswith('RYA'):
        print(f'  + {issue_key}: {title}')
        # Dispatch agent
        result2 = subprocess.run(
            ['linear-tool', 'dispatch', assignee, issue_key, f'Sub-task of {parent_key}'],
            capture_output=True, text=True
        )
        status = result2.stdout.strip()
        print(f'    -> {assignee}: {status}')
    else:
        print(f'  ! Failed to create: {title} ({output})')
print('Done.')
"
    ;;

  block)
    # linear-tool block <issue-key> <blocking-issue-key>
    # Creates a "blocked by" relation: issue-key is blocked by blocking-issue-key
    ISSUE_KEY="$2"
    BLOCKING_KEY="$3"
    if [ -z "$ISSUE_KEY" ] || [ -z "$BLOCKING_KEY" ]; then
      echo "Usage: linear-tool block <issue-key> <blocking-issue-key>"
      echo "  Marks <issue-key> as blocked by <blocking-issue-key>"
      exit 1
    fi
    # Linear relation type 'blocks': blocking-issue blocks issue
    # So we create: issueId=BLOCKING_KEY blocks relatedIssueId=ISSUE_KEY
    PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'query': 'mutation(\$i: IssueRelationCreateInput!) { issueRelationCreate(input: \$i) { success issueRelation { id } } }',
    'variables': {'i': {'issueId': '$BLOCKING_KEY', 'relatedIssueId': '$ISSUE_KEY', 'type': 'blocks'}}
}))
")
    RESULT=$(gql "$PAYLOAD")
    echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('data',{}).get('issueRelationCreate',{}).get('success'):
    print(f'OK: $ISSUE_KEY is now blocked by $BLOCKING_KEY')
else:
    errors = d.get('errors', [{}])
    print(f'FAILED: {errors[0].get(\"message\", d)}')
"
    ;;

  unblock)
    # linear-tool unblock <issue-key> <blocking-issue-key>
    # Removes the blocking relation between two issues
    ISSUE_KEY="$2"
    BLOCKING_KEY="$3"
    if [ -z "$ISSUE_KEY" ] || [ -z "$BLOCKING_KEY" ]; then
      echo "Usage: linear-tool unblock <issue-key> <blocking-issue-key>"
      echo "  Removes the blocking relation between the two issues"
      exit 1
    fi
    # Find the relation ID by querying issue relations, then delete it
    TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
    NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
    python3 -c "
import json, subprocess
def gql(q):
    r = subprocess.run(['curl','-s','-H','Authorization: $AUTH','-H','Content-Type: application/json','-X','POST','$API','-d',json.dumps({'query':q})], capture_output=True, text=True)
    return json.loads(r.stdout)

# Get issue with both relation directions
data = gql('''
{
  issues(filter: { team: { key: { eq: \"$TEAM\" } }, number: { eq: $NUM } }) {
    nodes {
      relations { nodes { id type relatedIssue { identifier } } }
      inverseRelations { nodes { id type issue { identifier } } }
    }
  }
}
''')
nodes = data['data']['issues']['nodes']
if not nodes:
    print('Error: Issue $ISSUE_KEY not found')
    exit(1)

issue = nodes[0]
found = False

# Check forward relations (this issue blocks something)
for rel in issue.get('relations',{}).get('nodes',[]):
    if rel['type'] == 'blocks' and rel['relatedIssue']['identifier'] == '$BLOCKING_KEY':
        result = gql('mutation { issueRelationDelete(id: \"' + rel['id'] + '\") { success } }')
        if result.get('data',{}).get('issueRelationDelete',{}).get('success'):
            print(f'OK: removed relation ($ISSUE_KEY blocks $BLOCKING_KEY)')
            found = True

# Check inverse relations (something blocks this issue)
for rel in issue.get('inverseRelations',{}).get('nodes',[]):
    if rel['type'] == 'blocks' and rel['issue']['identifier'] == '$BLOCKING_KEY':
        result = gql('mutation { issueRelationDelete(id: \"' + rel['id'] + '\") { success } }')
        if result.get('data',{}).get('issueRelationDelete',{}).get('success'):
            print(f'OK: $ISSUE_KEY is no longer blocked by $BLOCKING_KEY')
            found = True

if not found:
    print(f'No blocking relation found between $ISSUE_KEY and $BLOCKING_KEY')
"
    ;;

  relate)
    # linear-tool relate <issue-key1> <issue-key2>
    # Creates a generic "related" relation between two issues
    KEY1="$2"
    KEY2="$3"
    if [ -z "$KEY1" ] || [ -z "$KEY2" ]; then
      echo "Usage: linear-tool relate <issue-key1> <issue-key2>"
      echo "  Creates a 'related' link between two issues"
      exit 1
    fi
    PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'query': 'mutation(\$i: IssueRelationCreateInput!) { issueRelationCreate(input: \$i) { success } }',
    'variables': {'i': {'issueId': '$KEY1', 'relatedIssueId': '$KEY2', 'type': 'related'}}
}))
")
    gql "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK: $KEY1 <-> $KEY2 related' if d.get('data',{}).get('issueRelationCreate',{}).get('success') else f'FAILED: {d}')"
    ;;

  duplicate)
    # linear-tool duplicate <issue-key> <duplicate-of-key>
    # Marks issue-key as a duplicate of duplicate-of-key
    ISSUE_KEY="$2"
    DUP_OF_KEY="$3"
    if [ -z "$ISSUE_KEY" ] || [ -z "$DUP_OF_KEY" ]; then
      echo "Usage: linear-tool duplicate <issue-key> <duplicate-of-key>"
      echo "  Marks <issue-key> as a duplicate of <duplicate-of-key>"
      exit 1
    fi
    PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'query': 'mutation(\$i: IssueRelationCreateInput!) { issueRelationCreate(input: \$i) { success } }',
    'variables': {'i': {'issueId': '$ISSUE_KEY', 'relatedIssueId': '$DUP_OF_KEY', 'type': 'duplicate'}}
}))
")
    gql "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK: $ISSUE_KEY marked as duplicate of $DUP_OF_KEY' if d.get('data',{}).get('issueRelationCreate',{}).get('success') else f'FAILED: {d}')"
    ;;

  relations)
    # linear-tool relations <issue-key>
    # Lists all relations (blocking, blocked-by, related, duplicate) for an issue
    ISSUE_KEY="$2"
    if [ -z "$ISSUE_KEY" ]; then
      echo "Usage: linear-tool relations <issue-key>"
      echo "  Shows all issue relations (blocks, blocked-by, related, duplicate)"
      exit 1
    fi
    TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
    NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
    python3 -c "
import json, subprocess
def gql(q):
    r = subprocess.run(['curl','-s','-H','Authorization: $AUTH','-H','Content-Type: application/json','-X','POST','$API','-d',json.dumps({'query':q})], capture_output=True, text=True)
    return json.loads(r.stdout)

data = gql('''
{
  issues(filter: { team: { key: { eq: \"$TEAM\" } }, number: { eq: $NUM } }) {
    nodes {
      relations { nodes { id type relatedIssue { identifier title state { name } } } }
      inverseRelations { nodes { id type issue { identifier title state { name } } } }
    }
  }
}
''')
nodes = data.get('data',{}).get('issues',{}).get('nodes',[])
if not nodes:
    print(f'Error: Issue $ISSUE_KEY not found')
    exit(1)

issue = nodes[0]
rels = []

# Forward relations
for rel in issue.get('relations',{}).get('nodes',[]):
    ri = rel.get('relatedIssue',{})
    rtype = rel['type']
    if rtype == 'blocks':
        label = 'blocks'
    elif rtype == 'duplicate':
        label = 'duplicate of'
    else:
        label = 'related to'
    rels.append((label, ri.get('identifier','?'), ri.get('title','?')[:50], ri.get('state',{}).get('name','?')))

# Inverse relations
for rel in issue.get('inverseRelations',{}).get('nodes',[]):
    src = rel.get('issue',{})
    rtype = rel['type']
    if rtype == 'blocks':
        label = 'blocked by'
    elif rtype == 'duplicate':
        label = 'duplicate of'
    else:
        label = 'related to'
    rels.append((label, src.get('identifier','?'), src.get('title','?')[:50], src.get('state',{}).get('name','?')))

if not rels:
    print(f'$ISSUE_KEY has no relations')
else:
    print(f'Relations for $ISSUE_KEY ({len(rels)} total):')
    for label, key, title, state in rels:
        icon = '!' if 'block' in label else '~' if 'duplicate' in label else '-'
        print(f'  {icon} {label:14s} {key} [{state}] {title}')
"
    ;;

  create-doc)
    # linear-tool create-doc <issue-key> "title" <file-path-or-stdin>
    # Creates a Linear Document attached to an issue and prints the document URL.
    # Usage: linear-tool create-doc ENG-42 "Brand Playbook" ./BRAND-PLAYBOOK.md
    #        cat report.md | linear-tool create-doc ENG-42 "Report"
    ISSUE_KEY="$2"
    DOC_TITLE="$3"
    FILE_PATH="${4:-}"
    if [ -z "$ISSUE_KEY" ] || [ -z "$DOC_TITLE" ]; then
      echo "Usage: linear-tool create-doc <issue-key> \"title\" [file-path]"
      echo "  If file-path is omitted, reads from stdin."
      echo "  Prints the document URL on success."
      exit 1
    fi
    # Resolve issue key to ID
    if [[ "$ISSUE_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
      NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
      ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    else
      ISSUE_ID="$ISSUE_KEY"
    fi
    # Read content from file or stdin
    if [ -n "$FILE_PATH" ]; then
      if [ ! -f "$FILE_PATH" ]; then
        echo "Error: File not found: $FILE_PATH"
        exit 1
      fi
      DOC_CONTENT=$(cat "$FILE_PATH")
    else
      DOC_CONTENT=$(cat)
    fi
    # Create the document via GraphQL
    PAYLOAD=$(DOC_TITLE="$DOC_TITLE" ISSUE_ID="$ISSUE_ID" python3 -c "
import json, sys, os
content = sys.stdin.read()
print(json.dumps({
    'query': 'mutation(\$input: DocumentCreateInput!) { documentCreate(input: \$input) { success document { id url } } }',
    'variables': {'input': {
        'issueId': os.environ['ISSUE_ID'],
        'title': os.environ['DOC_TITLE'],
        'content': content
    }}
}))
" <<< "$DOC_CONTENT")
    RESULT=$(gql "$PAYLOAD")
    DOC_URL=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); doc=d.get('data',{}).get('documentCreate',{}).get('document',{}); print(doc.get('url',''))" 2>/dev/null)
    if [ -n "$DOC_URL" ]; then
      echo "$DOC_URL"
    else
      echo "Error: Failed to create document"
      echo "$RESULT" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))" 2>/dev/null
      exit 1
    fi
    ;;

  upload-deliverables)
    # linear-tool upload-deliverables <issue-key> <file1> [file2] [file3] ...
    # Uploads multiple files as Linear Documents and prints markdown links.
    # Usage: linear-tool upload-deliverables ENG-42 ./PLAYBOOK.md ./CHECKLIST.md
    ISSUE_KEY="$2"
    shift 2
    if [ -z "$ISSUE_KEY" ] || [ $# -eq 0 ]; then
      echo "Usage: linear-tool upload-deliverables <issue-key> <file1> [file2] ..."
      echo "  Uploads each file as a Linear Document and prints markdown links."
      exit 1
    fi
    for FILE in "$@"; do
      if [ ! -f "$FILE" ]; then
        echo "# Skipped (not found): $FILE"
        continue
      fi
      BASENAME=$(basename "$FILE")
      TITLE="${BASENAME%.*}"
      # Use create-doc to upload
      URL=$(linear-tool create-doc "$ISSUE_KEY" "$TITLE" "$FILE" 2>/dev/null)
      if [ -n "$URL" ] && [[ "$URL" == http* ]]; then
        echo "- [📄 $BASENAME]($URL)"
      else
        echo "# Failed to upload: $FILE"
      fi
    done
    ;;

  *)
    echo "Usage: linear-tool.sh <command> [args...]"
    echo "Commands: comment, create-issue, set-status, set-priority, add-label, list-issues, mention, team, spawn-worker, group, dispatch, handoff, ask, notify, team-status, update-title, search, reply, discord-reply, plan, sub-issues, assign, bulk-dispatch, block, unblock, relate, duplicate, relations, create-doc, upload-deliverables"
    ;;

esac
