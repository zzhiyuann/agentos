#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title AgentOS Jump
# @raycast.mode silent
# @raycast.packageName AgentOS
# @raycast.argument1 { "type": "text", "placeholder": "Issue key (e.g., RYA-5)" }

# Optional parameters:
# @raycast.icon 🚀
# @raycast.description Jump to an agent session terminal

/opt/homebrew/bin/aos jump "$1" 2>&1
