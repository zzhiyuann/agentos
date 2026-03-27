#!/bin/bash
# Install AgentOS hook on the execution host
# Run this from the control machine to deploy the hook to the execution host

set -e

EXEC_HOST="${AOS_USER:-$USER}@${AOS_HOST:?Set AOS_HOST to your execution host IP/hostname}"
HOOK_SRC="$(dirname "$0")/aos-report.sh"
HOOK_DST="~/.aos/hooks/aos-report.sh"

echo "Deploying AgentOS hook to execution host..."

# Copy hook script
ssh "$EXEC_HOST" "mkdir -p ~/.aos/hooks ~/.aos/events"
scp "$HOOK_SRC" "$EXEC_HOST:~/.aos/hooks/aos-report.sh"
ssh "$EXEC_HOST" "chmod +x ~/.aos/hooks/aos-report.sh"

echo "✓ Hook deployed to execution host"
echo ""
echo "Now add to the host's ~/.claude/settings.json:"
echo ""
echo '  "hooks": {'
echo '    "Stop": ['
echo '      {'
echo '        "command": "bash ~/.aos/hooks/aos-report.sh",'
echo '        "event": "Stop"'
echo '      }'
echo '    ]'
echo '  }'
echo ""
echo "Or ssh into the host and manually add the hook to ~/.claude/settings.json"
