#!/bin/sh
# UserPromptSubmit hook (owner, 2026-11-14): "create agent that is responsible for deployment.
# that agent will always monitor when we say deploy. everytime."
# When the prompt says deploy / redeploy, remind the main session to hand the deploy to the
# devops-release agent (.claude/agents/devops-release.md). Never blocks a prompt.
prompt=$(jq -r '.prompt // empty' 2>/dev/null)
if printf '%s' "$prompt" | grep -qiwE 'deploy|redeploy'; then
  jq -nc --arg c "DEPLOY REQUEST DETECTED. If the user is asking to ship/deploy (not just asking a question about deploys), hand the whole deploy to the devops-release agent (subagent_type: devops-release, defined in .claude/agents/devops-release.md). It owns every deploy end to end: commit + branch + PR, CI green before merge, merge, prod db:setup when the change needs it, one live check. Brief it with: what to ship (branch / worktree path / PR number), whether the change adds schema (db:setup), which e2e specs cover it, and anything the user said about order (e.g. QA first). Relay its result to the user faithfully, including anything it could not do." \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}'
fi
exit 0
