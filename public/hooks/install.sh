#!/bin/sh
# EvoFlow installer: registers the EvoFlow hook in Claude Code's settings. Safe to run again (idempotent).
#
# On your computer (stores URL and token in ~/.claude/evoflow/env, readable only by you):
#   curl -fsSL https://<evoflow>/hooks/install.sh | EVOFLOW_URL=https://<evoflow> EVOFLOW_TOKEN=<token> sh
# In a cloud environment's setup script (URL and token come from the environment variables):
#   curl -fsSL "$EVOFLOW_URL/hooks/install.sh" | sh
# Into the current repository's .claude/ instead (no token is written to the repo):
#   ... | sh -s -- --project
# Remove:
#   ... | sh -s -- --uninstall [--project]
set -eu

mode=user
action=install
for arg in "$@"; do
  case $arg in
    --project) mode=project ;;
    --uninstall) action=uninstall ;;
    *) echo "evoflow: unknown option $arg" >&2; exit 2 ;;
  esac
done

if [ "$mode" = project ]; then
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "evoflow: --project must run inside a git repository" >&2; exit 1; }
  settings="$root/.claude/settings.json"
  hook_path="$root/.claude/hooks/evoflow-hook.sh"
  command='"$CLAUDE_PROJECT_DIR"/.claude/hooks/evoflow-hook.sh'
else
  settings="$HOME/.claude/settings.json"
  hook_path="$HOME/.claude/evoflow/hook.sh"
  command='"$HOME"/.claude/evoflow/hook.sh'
fi

# Rewrites the "hooks" section of a settings.json: drops any previous EvoFlow entry, then adds ours on install.
MERGE_JS='
const fs = require("fs");
const [file, command, action] = process.argv.slice(-3);
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) { if (e.code !== "ENOENT") { console.error("evoflow: cannot parse " + file + ", left untouched"); process.exit(1); } }
const mine = (h) => /evoflow(-hook\.sh|\/hook\.sh)/.test(String(h.command || ""));
const hooks = s.hooks || {};
for (const ev of Object.keys(hooks)) {
  hooks[ev] = (hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !mine(h)) })).filter((g) => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (action === "install") {
  const entry = { type: "command", command, timeout: 10 };
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "SessionEnd"]) {
    const group = ev.endsWith("ToolUse") ? { matcher: "*", hooks: [entry] } : { hooks: [entry] };
    (hooks[ev] ||= []).push(group);
  }
}
if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
'
MERGE_PY='
import json, re, sys
file, command, action = sys.argv[-3:]
try:
    s = json.load(open(file))
except FileNotFoundError:
    s = {}
except ValueError:
    sys.exit("evoflow: cannot parse " + file + ", left untouched")
mine = lambda h: re.search(r"evoflow(-hook\.sh|/hook\.sh)", str(h.get("command", "")))
hooks = s.get("hooks", {})
for ev in list(hooks):
    hooks[ev] = [dict(g, hooks=[h for h in g.get("hooks", []) if not mine(h)]) for g in hooks[ev]]
    hooks[ev] = [g for g in hooks[ev] if g["hooks"]]
    if not hooks[ev]:
        del hooks[ev]
if action == "install":
    entry = {"type": "command", "command": command, "timeout": 10}
    for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "SessionEnd"]:
        group = {"matcher": "*", "hooks": [entry]} if ev.endswith("ToolUse") else {"hooks": [entry]}
        hooks.setdefault(ev, []).append(group)
if hooks:
    s["hooks"] = hooks
else:
    s.pop("hooks", None)
open(file, "w").write(json.dumps(s, indent=2) + "\n")
'

merge() {
  mkdir -p "$(dirname "$settings")"
  [ -f "$settings" ] && cp "$settings" "$settings.evoflow-backup"
  if command -v node >/dev/null 2>&1; then
    node -e "$MERGE_JS" "$settings" "$command" "$action"
  elif command -v python3 >/dev/null 2>&1 && python3 -c 'import json' >/dev/null 2>&1; then
    python3 -c "$MERGE_PY" "$settings" "$command" "$action"
  else
    echo "evoflow: need node or python3 to edit $settings. Add the hooks by hand, see docs/SETUP.md." >&2
    exit 1
  fi
}

if [ "$action" = uninstall ]; then
  merge
  rm -f "$hook_path"
  [ "$mode" = user ] && rm -rf "$HOME/.claude/evoflow"
  echo "evoflow: hooks removed from $settings"
  exit 0
fi

# The hook script: next to this installer when run from a checkout, otherwise from the dashboard.
mkdir -p "$(dirname "$hook_path")"
here=$(dirname "$0")
if [ -f "$here/evoflow-hook.sh" ]; then
  cp "$here/evoflow-hook.sh" "$hook_path"
elif [ -n "${EVOFLOW_URL:-}" ]; then
  curl -fsSL "${EVOFLOW_URL%/}/hooks/evoflow-hook.sh" -o "$hook_path"
else
  echo "evoflow: set EVOFLOW_URL so the hook script can be downloaded" >&2
  exit 1
fi
chmod +x "$hook_path"

if [ "$mode" = user ] && [ -n "${EVOFLOW_URL:-}" ] && [ -n "${EVOFLOW_TOKEN:-}" ]; then
  umask 077
  printf 'EVOFLOW_URL=%s\nEVOFLOW_TOKEN=%s\n' "$EVOFLOW_URL" "$EVOFLOW_TOKEN" > "$HOME/.claude/evoflow/env"
fi

merge
echo "evoflow: hooks installed in $settings"

# Reachability check: in a cloud environment the dashboard's domain must be in Allowed domains.
if [ -n "${EVOFLOW_URL:-}" ]; then
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "${EVOFLOW_URL%/}/api/health" 2>/dev/null || echo 000)
  if [ "$code" = 200 ]; then
    echo "evoflow: dashboard reachable at $EVOFLOW_URL"
  else
    echo "evoflow: WARNING dashboard not reachable at $EVOFLOW_URL (HTTP $code). In a cloud environment, add its domain to Allowed domains." >&2
  fi
fi
