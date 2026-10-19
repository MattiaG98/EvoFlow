#!/bin/sh
# EvoFlow hook: forwards one Claude Code hook event to the EvoFlow dashboard.
# Claude Code passes the event as JSON on stdin. This script never blocks or fails the session:
# the upload runs in the background and every error is swallowed.
#
# Needs EVOFLOW_URL and EVOFLOW_TOKEN, from the environment (cloud environments) or from
# ~/.claude/evoflow/env (written by install.sh on your computer).

[ -z "$EVOFLOW_URL" ] && [ -f "$HOME/.claude/evoflow/env" ] && . "$HOME/.claude/evoflow/env"
if [ -z "$EVOFLOW_URL" ] || [ -z "$EVOFLOW_TOKEN" ] || ! command -v curl >/dev/null 2>&1; then
  cat >/dev/null
  exit 0
fi

payload=$(cat)
[ -n "$payload" ] || exit 0

esc() { printf '%s' "$1" | tr -d '\n\r' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

dir=${CLAUDE_PROJECT_DIR:-$PWD}
branch=$(git -C "$dir" symbolic-ref --short -q HEAD 2>/dev/null || git -C "$dir" rev-parse --short HEAD 2>/dev/null)
# owner/repo from any remote URL form (https, ssh, or the cloud git proxy), without credentials.
repo=$(git -C "$dir" remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/]+)$#\1#')
host=$(hostname 2>/dev/null)
source=local
[ -n "$CLAUDE_CODE_REMOTE_SESSION_ID" ] && source=cloud

body=$(printf '{"v":1,"meta":{"source":"%s","remote_session_id":"%s","entrypoint":"%s","host":"%s","repo":"%s","branch":"%s"},"payload":%s}' \
  "$source" "$(esc "$CLAUDE_CODE_REMOTE_SESSION_ID")" "$(esc "$CLAUDE_CODE_ENTRYPOINT")" "$(esc "$host")" \
  "$(esc "$repo")" "$(esc "$branch")" "$payload")

(printf '%s' "$body" | curl -sS -m 8 -X POST "${EVOFLOW_URL%/}/api/events" \
  -H "Authorization: Bearer $EVOFLOW_TOKEN" -H 'Content-Type: application/json' --data-binary @-) \
  </dev/null >/dev/null 2>&1 &

exit 0
