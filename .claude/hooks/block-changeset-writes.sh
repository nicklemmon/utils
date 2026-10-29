#!/bin/sh
# PreToolUse hook. Deny direct writes to `.changeset/`. Tell the agent to use the npm script.
# Reads the hook payload (JSON) on stdin. Needs `jq`.

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')

blocked=0
case "$tool" in
  Write | Edit | MultiEdit)
    target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')
    ;;
  NotebookEdit)
    target=$(printf '%s' "$payload" | jq -r '.tool_input.notebook_path // ""')
    ;;
  Bash)
    command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
    # Match a write verb or redirect that is followed by a `.changeset/` path.
    if printf '%s' "$command" | grep -Eq '(>>?|\btee\b|\bcp\b|\bmv\b|\btouch\b|\bsed +-i)[^|;&]*\.changeset/'; then
      blocked=1
    fi
    ;;
esac

case "$target" in
  */.changeset/* | .changeset/*) blocked=1 ;;
esac

if [ "$blocked" -eq 1 ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Do not write to .changeset/ directly. Run `npm run changesets:add -- --patch <package> -m \"<summary>\"` to create a changeset without prompts. Use --minor or --major for other bumps. Pass a comma-separated list for several packages. If the CLI fails, tell the user and ask how to proceed."
    }
  }'
fi
