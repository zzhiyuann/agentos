#!/bin/bash
# linear-tool.sh — Linear API helper for AI agents
# Usage: ./linear-tool.sh <command> [args...]
# Token is read from ~/.aos/agents/<role>/.oauth-token or $LINEAR_TOKEN

# Auto-source AgentOS env (AOS_LINEAR_TEAM_ID, AOS_LINEAR_TEAM_KEY) if not set.
# Agent sessions don't always inherit these — load from the repo .env so create-issue works.
if [ -z "${AOS_LINEAR_TEAM_ID:-}" ]; then
  for ENV_CANDIDATE in "$HOME/projects/agentos/.env" "$HOME/agentos/.env"; do
    if [ -f "$ENV_CANDIDATE" ]; then
      # Export only the AOS_* vars we need; avoid polluting shell with everything in .env
      while IFS='=' read -r key value; do
        case "$key" in
          AOS_LINEAR_TEAM_ID|AOS_LINEAR_TEAM_KEY)
            # Strip optional surrounding quotes
            value="${value%\"}"
            value="${value#\"}"
            export "$key=$value"
            ;;
        esac
      done < "$ENV_CANDIDATE"
      break
    fi
  done
fi

show_help() {
  cat <<'HELP'
linear-tool — Linear API helper for AI agents

Usage: linear-tool <command> [args...]

Authentication:
  Reads token from ~/.aos/agents/$AGENT_ROLE/.oauth-token or $LINEAR_TOKEN
  Set AGENT_ROLE to use your agent identity (e.g. AGENT_ROLE=lead-engineer)

ISSUE MANAGEMENT
  comment <issue-key> "message"
      Post a comment on an issue.
      Example: linear-tool comment RYA-42 "Fixed the OAuth race condition"

  reply <issue-key> <comment-id> "message"
      Post a threaded reply to a specific comment.
      Example: linear-tool reply RYA-42 abc123 "Good catch, will fix"

  create-issue "title" "description" [priority] [parent-key] [assignee-role]
      Create a new issue. priority: 1=urgent 2=high(default) 3=medium 4=low
      Pass parent-key to make a sub-issue — REQUIRED; omitting it orphans the issue.
      Example: linear-tool create-issue "Fix auth bug" "Details" 2 RYA-40

  set-status <issue-key> <status>
      Change issue status. Values: Backlog, Todo, In Progress, In Review, Done
      Example: linear-tool set-status RYA-42 "In Progress"

  set-priority <issue-key> <1-4>
      Set issue priority: 1=urgent 2=high 3=medium 4=low
      Example: linear-tool set-priority RYA-42 1

  add-label <issue-key> <label-name>
      Add a label (creates the label if it doesn't exist).
      Example: linear-tool add-label RYA-42 "bug"

  update-title <issue-key> "new title"
      Rename an issue.
      Example: linear-tool update-title RYA-42 "Fix OAuth race in adapter.ts"

  assign <issue-key> <role>
      Assign an issue to an agent role.
      Example: linear-tool assign RYA-42 lead-engineer

  list-issues [status]
      List team issues, optionally filtered by status.
      Example: linear-tool list-issues "In Progress"

  search "query"
      Full-text search across issues.
      Example: linear-tool search "OAuth race"

ISSUE RELATIONS
  sub-issues <issue-key>
      List all sub-issues of a parent.
      Example: linear-tool sub-issues RYA-40

  relations <issue-key>
      Show all relations (blocks / blocked-by / related / duplicate).
      Example: linear-tool relations RYA-42

  block <issue-key> <blocking-key>
      Mark <issue-key> as blocked by <blocking-key>.
      Example: linear-tool block RYA-42 RYA-38

  unblock <issue-key> <blocking-key>
      Remove a blocking relation.
      Example: linear-tool unblock RYA-42 RYA-38

  relate <key1> <key2>
      Link two issues as related.
      Example: linear-tool relate RYA-42 RYA-43

  duplicate <issue-key> <original-key>
      Mark an issue as a duplicate of another.
      Example: linear-tool duplicate RYA-42 RYA-10

AGENT COLLABORATION
  dispatch <role> <issue-key> [context]
      Start another agent on an issue immediately.
      Roles: cto, cpo, coo, lead-engineer, research-lead, qa-engineer, ceo-office
      Example: linear-tool dispatch lead-engineer RYA-42 "Implement per spec"

  handoff <role> <issue-key> [context]
      Hand off the issue to another agent (they inherit your workspace + HANDOFF.md).
      Example: linear-tool handoff cto RYA-42 "Ready for architecture review"

  ask <role> <issue-key> "question"
      Send an async question to another agent (non-blocking).
      Example: linear-tool ask cto RYA-42 "Should we use mutex or channel?"

  notify <role> "message"
      Send a non-blocking notification to a running agent.
      Example: linear-tool notify cpo "OAuth bug fixed, demo is green"

  bulk-dispatch <parent-key> <json-file>
      Create sub-issues and dispatch agents from a JSON spec file.
      JSON format: [{"title":"...","description":"...","assignee":"role","priority":2}]
      Example: linear-tool bulk-dispatch RYA-40 ./tasks.json

  plan <issue-key>
      Ask the planner to decompose an issue into sub-issues and dispatch agents.
      Example: linear-tool plan RYA-40

  mention <role> <issue-key> "message"
      Post a comment mentioning another agent (use dispatch for urgent requests).
      Example: linear-tool mention cpo RYA-42 "FYI: auth flow changed"

TEAM & STATUS
  team
      Show all agent roles and their Linear user IDs.

  team-status
      Show all agents' current working state (requires AgentOS server).

  group "message"
      Post a message to the company Discord channel.
      Example: linear-tool group "Completed RYA-42: fixed OAuth race"

DOCUMENTS & ATTACHMENTS
  create-doc <issue-key> "title" [file-path]
      Upload a file as a Linear Document. Prints the document URL on success.
      Reads from stdin if file-path is omitted.
      Example: linear-tool create-doc RYA-42 "Playbook" ./PLAYBOOK.md

  upload-deliverables <issue-key> <file1> [file2] ...
      Upload multiple files as Linear Documents. Prints markdown links.
      Example: linear-tool upload-deliverables RYA-42 ./HANDOFF.md ./CHECKLIST.md

  attach <issue-key> <url> "title" ["subtitle"]
      Add a resource attachment (shows in issue sidebar Resources).
      Example: linear-tool attach RYA-42 "https://..." "Design Doc" "Architecture"

DISCORD
  discord-reply <channel-id> <message-id> "reply"
      Reply to a Discord message.

  discord-react <channel-id> <message-id> <emoji>
      React to a Discord message. Convention: 🚧=working ✅=done

MEMORY
  recall "search query"
      Search your agent memory database.
      Example: linear-tool recall "OAuth race condition"

MISC
  spawn-worker "title" "description" [label]
      Create a labeled issue (typically used to spawn a worker agent).

  help, --help
      Show this help message.
HELP
}

# Handle --help / -h / help before token check (no token needed)
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" || "${1:-}" == "help" ]]; then
  show_help
  exit 0
fi

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

# Per-command --help handler
if [ -n "${1:-}" ] && ([ "${2:-}" = "--help" ] || [ "${2:-}" = "-h" ]); then
  case "$1" in
    comment)      echo "Usage: linear-tool comment <issue-key> \"message\"";;
    reply)        echo "Usage: linear-tool reply <issue-key> <comment-id> \"message\"";;
    create-issue) echo "Usage: linear-tool create-issue \"title\" \"description\" [priority] [parent-issue-key] [assignee-role]"
                  echo "  priority: 1=urgent, 2=high (default), 3=medium, 4=low";;
    set-status)   echo "Usage: linear-tool set-status <issue-key> <status>"
                  echo "  status: Backlog, Todo, In Progress, In Review, Done, Cancelled";;
    set-priority) echo "Usage: linear-tool set-priority <issue-key> <1-4>"
                  echo "  1=urgent, 2=high, 3=medium, 4=low";;
    add-label)    echo "Usage: linear-tool add-label <issue-key> <label-name>";;
    list-issues)  echo "Usage: linear-tool list-issues [status]"
                  echo "  status: Backlog, Todo, In Progress, In Review, Done";;
    dispatch)     echo "Usage: linear-tool dispatch <role> <issue-key> [message]"
                  echo "  Roles: cto, cpo, coo, lead-engineer, research-lead";;
    handoff)      echo "Usage: linear-tool handoff <role> <issue-key> [message]";;
    ask)          echo "Usage: linear-tool ask <role> <issue-key> \"question\"";;
    notify)       echo "Usage: linear-tool notify <role> \"message\"";;
    group)        echo "Usage: linear-tool group \"message\"";;
    block)        echo "Usage: linear-tool block <issue-key> <blocking-issue-key>";;
    unblock)      echo "Usage: linear-tool unblock <issue-key> <blocking-issue-key>";;
    relate)       echo "Usage: linear-tool relate <issue-key1> <issue-key2>";;
    duplicate)    echo "Usage: linear-tool duplicate <issue-key> <duplicate-of-key>";;
    relations)    echo "Usage: linear-tool relations <issue-key>";;
    sub-issues)   echo "Usage: linear-tool sub-issues <issue-key>";;
    assign)       echo "Usage: linear-tool assign <issue-key> <role>";;
    search)       echo "Usage: linear-tool search \"query text\"";;
    recall)       echo "Usage: linear-tool recall \"search query\"";;
    create-doc)   echo "Usage: linear-tool create-doc <issue-key> \"title\" [file-path]";;
    upload-deliverables) echo "Usage: linear-tool upload-deliverables <issue-key> <file1> [file2] ...";;
    plan)         echo "Usage: linear-tool plan <issue-key>";;
    update-title) echo "Usage: linear-tool update-title <issue-key> \"new title\"";;
    bulk-dispatch) echo "Usage: linear-tool bulk-dispatch <parent-issue-key> <json-file>";;
    mention)      echo "Usage: linear-tool mention <role> <issue-key> \"message\"";;
    team)         echo "Usage: linear-tool team";;
    spawn-worker) echo "Usage: linear-tool spawn-worker \"title\" \"description\" [label]";;
    team-status)  echo "Usage: linear-tool team-status";;
    discord-reply) echo "Usage: linear-tool discord-reply <channel-id> <message-id> \"reply\"";;
    discord-react) echo "Usage: linear-tool discord-react <channel-id> <message-id> <emoji>";;
    attach)       echo "Usage: linear-tool attach <issue-key> <url> \"title\" [\"subtitle\"]";;
    *)            echo "Unknown command: $1. Run 'linear-tool --help' for available commands.";;
  esac
  exit 0
fi

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
    # Guard: reject flag-like titles (e.g. --help) — likely a misused command
    if [[ "${TITLE:-}" =~ ^-- ]]; then
      echo "Error: issue title looks like a flag ('$TITLE'). Did you mean 'linear-tool create-issue --help'?"
      exit 1
    fi
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
    # Adds a label to an issue. Creates the label at team level if it doesn't exist.
    ISSUE_KEY="$2"
    shift 2
    LABEL_NAME="$*"
    if [ -z "$ISSUE_KEY" ] || [ -z "$LABEL_NAME" ]; then
      echo "Usage: linear-tool add-label <issue-key> <label-name>"
      exit 1
    fi
    AUTH="$AUTH" API="$API" ISSUE_KEY="$ISSUE_KEY" LABEL_NAME="$LABEL_NAME" python3 <<'ADDLABEL_PYEOF'
import json, os, subprocess, sys

API = os.environ['API']
AUTH = os.environ['AUTH']

def gql(query, variables=None):
    payload = {'query': query}
    if variables is not None:
        payload['variables'] = variables
    r = subprocess.run(
        ['curl', '-s', '-H', 'Authorization: ' + AUTH, '-H', 'Content-Type: application/json',
         '-X', 'POST', API, '-d', json.dumps(payload)],
        capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        print(f'FAILED: bad API response: {r.stdout[:200]}')
        sys.exit(1)
    if d.get('errors'):
        e = d['errors'][0]
        msg = e.get('extensions', {}).get('userPresentableMessage') or e.get('message') or str(e)
        print(f'FAILED: {msg}')
        sys.exit(1)
    return d['data']

issue_key = os.environ['ISSUE_KEY']
label_name = os.environ['LABEL_NAME'].strip()
team_key, _, num = issue_key.partition('-')
if not num.isdigit():
    print(f'FAILED: invalid issue key: {issue_key}')
    sys.exit(1)

data = gql(
    'query($team: String!, $num: Float!) { issues(filter: { team: { key: { eq: $team } }, number: { eq: $num } }) '
    '{ nodes { id team { id } labels { nodes { id name } } } } }',
    {'team': team_key, 'num': int(num)})
nodes = data['issues']['nodes']
if not nodes:
    print(f'FAILED: issue {issue_key} not found')
    sys.exit(1)
issue = nodes[0]
issue_id = issue['id']
team_id = (issue.get('team') or {}).get('id', '')

for l in issue['labels']['nodes']:
    if l['name'].lower() == label_name.lower():
        print(f'OK: {issue_key} already has label "{l["name"]}"')
        sys.exit(0)

data = gql(
    'query($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }) '
    '{ nodes { id name team { id } } } }',
    {'name': label_name})
candidates = data['issueLabels']['nodes']
# Prefer a label scoped to the issue's team; fall back to a workspace label
label_id = ''
for l in candidates:
    if (l.get('team') or {}).get('id') == team_id:
        label_id = l['id']
        break
if not label_id and candidates:
    label_id = candidates[0]['id']

created = False
if not label_id:
    # Workspace-level create: agent tokens lack permission for team-scoped labels
    data = gql(
        'mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }',
        {'input': {'name': label_name}})
    label_id = data['issueLabelCreate']['issueLabel']['id']
    created = True

data = gql(
    'mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }',
    {'id': issue_id, 'labelId': label_id})
if data['issueAddLabel']['success']:
    suffix = ' (label created)' if created else ''
    print(f'OK: added label "{label_name}" to {issue_key}{suffix}')
else:
    print('FAILED: issueAddLabel returned success=false')
    sys.exit(1)
ADDLABEL_PYEOF
    ;;

  list-issues)
    # linear-tool.sh list-issues [status]
    STATUS="${2:-}"
    if [ -n "$STATUS" ]; then
      FILTER="filter: { team: { key: { eq: \\\"${AOS_LINEAR_TEAM_KEY:-RYA}\\\" } }, state: { name: { eq: \\\"$STATUS\\\" } } }"
    else
      FILTER="filter: { team: { key: { eq: \\\"${AOS_LINEAR_TEAM_KEY:-RYA}\\\" } } }"
    fi
    gql "{\"query\": \"{ issues($FILTER, first: 100) { nodes { identifier title state { name } priority assignee { name } } } }\"}" | python3 -c "
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
    # Build payload via env vars to avoid bash 3.2 nested-quote bug in `-d "$(python3 -c "...")"`
    # and to safely handle special chars (quotes, backticks) in the question body.
    PAYLOAD=$(TARGET_ROLE="$TARGET_ROLE" ISSUE_KEY="$ISSUE_KEY" QUESTION="$QUESTION" python3 -c "
import json, os
print(json.dumps({
    'from': os.environ.get('AGENT_ROLE', 'unknown'),
    'to': os.environ['TARGET_ROLE'],
    'issueKey': os.environ['ISSUE_KEY'],
    'question': os.environ['QUESTION']
}))
")
    RESULT=$(curl -s -X POST http://localhost:3848/ask \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD" --max-time 10 2>/dev/null)
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
    PAYLOAD=$(TARGET_ROLE="$TARGET_ROLE" MESSAGE="$MESSAGE" python3 -c "
import json, os
print(json.dumps({
    'from': os.environ.get('AGENT_ROLE', 'unknown'),
    'to': os.environ['TARGET_ROLE'],
    'message': os.environ['MESSAGE']
}))
")
    curl -s -X POST http://localhost:3848/notify \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail', d.get('error', 'sent')))"
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
    python3 -c "import json,sys; json.dump({'query':'{ searchIssues(term: \"' + sys.stdin.read().strip() + '\", first: 10) { nodes { identifier title state { name } assignee { name } } } }'}, open('$TMPFILE','w'))" <<< "$QUERY"
    curl -s -X POST "$API" -H "Authorization: $AUTH" -H "Content-Type: application/json" \
      -d @"$TMPFILE" | python3 -c "
import sys, json
resp = json.load(sys.stdin)
errors = resp.get('errors')
if errors:
    msg = errors[0].get('extensions',{}).get('userPresentableMessage') or errors[0].get('message','unknown error')
    print(f'Linear API error: {msg}', file=sys.stderr)
    sys.exit(1)
payload = (resp.get('data') or {}).get('searchIssues') or {}
nodes = payload.get('nodes') or []
if not nodes:
    print('No results')
    sys.exit(0)
for n in nodes:
    state = (n.get('state') or {}).get('name','?')
    assignee = (n.get('assignee') or {}).get('name','unassigned')
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
    # Build JSON payload via python3 (avoids bash 3.2 nested $() quoting bugs)
    JSON_PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'channelId': sys.argv[1],
    'messageId': sys.argv[2],
    'content': sys.argv[3],
    'role': sys.argv[4]
}))" "$CHANNEL_ID" "$MESSAGE_ID" "$REPLY_BODY" "${AGENT_ROLE:-system}")
    RESULT=$(curl -s -X POST "http://localhost:3848/discord-reply" \
      -H "Content-Type: application/json" \
      -d "$JSON_PAYLOAD")
    OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
    if [ "$OK" = "True" ]; then
      echo "replied"
    else
      echo "Failed to reply: $RESULT" >&2
      exit 1
    fi
    ;;

  discord-react)
    # linear-tool discord-react <channel-id> <message-id> <emoji>
    # RYA-1299 claim-status protocol: 🚧 = working on it, ✅ = done (👀 is added by the bot on claim)
    CHANNEL_ID="$2"
    MESSAGE_ID="$3"
    EMOJI="$4"
    if [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE_ID" ] || [ -z "$EMOJI" ]; then
      echo "Usage: linear-tool discord-react <channel-id> <message-id> <emoji>"
      exit 1
    fi
    JSON_PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'channelId': sys.argv[1],
    'messageId': sys.argv[2],
    'emoji': sys.argv[3]
}))" "$CHANNEL_ID" "$MESSAGE_ID" "$EMOJI")
    RESULT=$(curl -s -X POST "http://localhost:3848/discord-react" \
      -H "Content-Type: application/json" \
      -d "$JSON_PAYLOAD")
    OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
    if [ "$OK" = "True" ]; then
      echo "reacted"
    else
      echo "Failed to react: $RESULT" >&2
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
    echo "$RESULT" | ISSUE_KEY="$ISSUE_KEY" BLOCKING_KEY="$BLOCKING_KEY" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
result = (d.get('data') or {}).get('issueRelationCreate') or {}
if result.get('success'):
    print(f\"OK: {os.environ['ISSUE_KEY']} is now blocked by {os.environ['BLOCKING_KEY']}\")
else:
    errors = d.get('errors') or []
    if errors:
        e = errors[0]
        msg = e.get('userPresentableMessage') or e.get('message') or str(e)
        print(f'FAILED: {msg}')
    else:
        print(f'FAILED: {d}')
    sys.exit(1)
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
    gql "$PAYLOAD" | KEY1="$KEY1" KEY2="$KEY2" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
result = (d.get('data') or {}).get('issueRelationCreate') or {}
if result.get('success'):
    print(f\"OK: {os.environ['KEY1']} <-> {os.environ['KEY2']} related\")
else:
    errors = d.get('errors') or []
    if errors:
        e = errors[0]
        msg = e.get('userPresentableMessage') or e.get('message') or str(e)
        print(f'FAILED: {msg}')
    else:
        print(f'FAILED: {d}')
    sys.exit(1)
"
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
    gql "$PAYLOAD" | ISSUE_KEY="$ISSUE_KEY" DUP_OF_KEY="$DUP_OF_KEY" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
result = (d.get('data') or {}).get('issueRelationCreate') or {}
if result.get('success'):
    print(f\"OK: {os.environ['ISSUE_KEY']} marked as duplicate of {os.environ['DUP_OF_KEY']}\")
else:
    errors = d.get('errors') or []
    if errors:
        e = errors[0]
        msg = e.get('userPresentableMessage') or e.get('message') or str(e)
        print(f'FAILED: {msg}')
    else:
        print(f'FAILED: {d}')
    sys.exit(1)
"
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
    # Usage: linear-tool create-doc RYA-42 "Brand Playbook" ./BRAND-PLAYBOOK.md
    #        cat report.md | linear-tool create-doc RYA-42 "Report"
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
    # Usage: linear-tool upload-deliverables RYA-42 ./PLAYBOOK.md ./CHECKLIST.md
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
      EXT="${BASENAME##*.}"
      # Use create-doc to upload
      URL=$(linear-tool create-doc "$ISSUE_KEY" "$TITLE" "$FILE" 2>/dev/null)
      if [ -n "$URL" ] && [[ "$URL" == http* ]]; then
        echo "- [📄 $BASENAME]($URL)"
        # Also create an issue attachment (shows in Resources sidebar)
        SUBTITLE="Document"
        [ "$EXT" = "html" ] && SUBTITLE="HTML presentation"
        linear-tool attach "$ISSUE_KEY" "$URL" "📄 $BASENAME" "$SUBTITLE" >/dev/null 2>&1
      else
        echo "# Failed to upload: $FILE"
      fi
    done
    ;;

  attach)
    # linear-tool attach <issue-key> <url> "title" ["subtitle"]
    # Creates a resource attachment on an issue (shows in sidebar Resources).
    # Usage: linear-tool attach RYA-42 "https://example.com/doc" "My Document" "Description"
    ISSUE_KEY="$2"
    ATTACH_URL="$3"
    ATTACH_TITLE="$4"
    ATTACH_SUBTITLE="${5:-}"
    if [ -z "$ISSUE_KEY" ] || [ -z "$ATTACH_URL" ] || [ -z "$ATTACH_TITLE" ]; then
      echo "Usage: linear-tool attach <issue-key> <url> \"title\" [\"subtitle\"]"
      exit 1
    fi
    if [[ "$ISSUE_KEY" =~ ^[A-Z]+-[0-9]+$ ]]; then
      TEAM=$(echo "$ISSUE_KEY" | cut -d- -f1)
      NUM=$(echo "$ISSUE_KEY" | cut -d- -f2)
      ISSUE_ID=$(gql "{\"query\": \"{ issues(filter: { team: { key: { eq: \\\"$TEAM\\\" } }, number: { eq: $NUM } }) { nodes { id } } }\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issues']['nodes'][0]['id'])" 2>/dev/null)
    else
      ISSUE_ID="$ISSUE_KEY"
    fi
    PAYLOAD=$(ATTACH_URL="$ATTACH_URL" ATTACH_TITLE="$ATTACH_TITLE" ATTACH_SUBTITLE="$ATTACH_SUBTITLE" ISSUE_ID="$ISSUE_ID" python3 -c "
import json, os
inp = {
    'issueId': os.environ['ISSUE_ID'],
    'url': os.environ['ATTACH_URL'],
    'title': os.environ['ATTACH_TITLE'],
}
sub = os.environ.get('ATTACH_SUBTITLE', '')
if sub:
    inp['subtitle'] = sub
print(json.dumps({
    'query': 'mutation(\$input: AttachmentCreateInput!) { attachmentCreate(input: \$input) { success } }',
    'variables': {'input': inp}
}))
")
    RESULT=$(gql "$PAYLOAD")
    SUCCESS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('attachmentCreate',{}).get('success', False))" 2>/dev/null)
    if [ "$SUCCESS" = "True" ]; then
      echo "OK"
    else
      echo "Error: Failed to create attachment"
      echo "$RESULT" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))" 2>/dev/null
      exit 1
    fi
    ;;

  recall)
    # linear-tool recall "search query" — search agent's memory database
    shift 1
    QUERY="$*"
    if [ -z "$QUERY" ]; then
      echo "Usage: linear-tool recall \"search query\""
      exit 1
    fi
    ROLE="${AGENT_ROLE:-cto}"
    npx tsx ${AGENTOS_DIR:-$(npm root -g)/../..}/src/cli.ts memory search "$ROLE" "$QUERY" --json 2>/dev/null || \
      aos memory search "$ROLE" "$QUERY" --json 2>/dev/null || \
      echo "[]"
    ;;

  help | --help)
    show_help
    ;;

  *)
    echo "Usage: linear-tool.sh <command> [args...]"
    echo "Commands: comment, create-issue, set-status, set-priority, add-label, list-issues, mention, team, spawn-worker, group, dispatch, handoff, ask, notify, team-status, update-title, search, reply, discord-reply, discord-react, plan, sub-issues, assign, bulk-dispatch, block, unblock, relate, duplicate, relations, create-doc, upload-deliverables, attach, recall"
    echo "Run 'linear-tool help' for full documentation."
    ;;

esac
