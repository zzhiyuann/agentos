#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title AgentOS Spawn
# @raycast.mode fullOutput
# @raycast.packageName AgentOS
# @raycast.argument1 { "type": "text", "placeholder": "Issue key (e.g., RYA-5)" }

# Optional parameters:
# @raycast.icon ⚡
# @raycast.description Spawn an agent session for a Linear issue

/opt/homebrew/bin/aos spawn "$1" 2>&1
