#!/usr/bin/env bash
# claude-context PreToolUse hook.
#
# Fires on Grep / Glob / Bash(grep|rg). Emits a one-time-per-session
# additionalContext nudge telling the model to prefer search_code for
# conceptual queries. Nudges, never blocks — no permissionDecision is set,
# so the tool call proceeds through the normal permission flow and the
# user's grep still runs.
#
# Why this exists ALONGSIDE the CLAUDE.md guidance region: the region is
# always-loaded advisory prose, but it competes with the harness's own
# (stronger) steering toward Grep/Glob. This nudge lands at the exact
# decision point — attached to the first grep-shaped tool call — where it
# actually changes the next search. One reminder is enough; repeating on
# every call just burns tokens.
#
# Throttling: one nudge per session, keyed by session_id in a marker file
# under $CLAUDE_CONTEXT_STATE_DIR. Stale markers (>7 days) are pruned
# opportunistically so the state dir doesn't grow forever.
set -u

[ "${CLAUDE_CONTEXT_GREP_NUDGE:-1}" = "1" ] || exit 0

if ! command -v jq >/dev/null 2>&1; then
    exit 0
fi

EVENT=$(cat)
# Harness field shim: Claude Code sends snake_case, Grok Build camelCase.
# Read both so ONE hook serves either (Grok also sets CLAUDE_PROJECT_DIR as an
# alias for its own workspace root, so the CWD fallback needs no change).
TOOL=$(printf '%s' "$EVENT" | jq -r '.tool_name // .toolName // empty')
SESSION=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty')
CWD=$(printf '%s' "$EVENT" | jq -r '.cwd // empty')
[ -n "$CWD" ] || CWD="${CLAUDE_PROJECT_DIR:-$PWD}"

# Only nudge on search-shaped tools. Grok renames the tools it reports
# (Bash → run_terminal_command, Grep → grep, Glob/ListDir → list_dir), so
# match its names too — the matcher aliases only govern WHICH events fire,
# not the `toolName` the payload carries.
case "$TOOL" in
    Grep|Glob|grep|list_dir) ;;
    Bash|run_terminal_command)
        CMD=$(printf '%s' "$EVENT" | jq -r '(.tool_input // .toolInput).command // empty')
        # Match `grep`, `rg`, `ag`, `ack` at the start or after a pipe/&&/;.
        if ! printf '%s' "$CMD" | grep -qE '(^|[|&;[:space:]])(grep|rg|ag|ack)([[:space:]]|$)'; then
            exit 0
        fi
        ;;
    *) exit 0 ;;
esac

# Only nudge inside indexed-capable repos (has origin remote). Avoids noise
# in non-repo directories where search_code would error anyway.
ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$ROOT" ] || exit 0
git -C "$ROOT" remote get-url origin >/dev/null 2>&1 || exit 0

STATE_DIR="${CLAUDE_CONTEXT_STATE_DIR:-$HOME/.claude/plugin-state/claude-context}"
mkdir -p "$STATE_DIR"
# Prune markers from long-dead sessions (best-effort, never fails the hook).
find "$STATE_DIR" -maxdepth 1 -name 'grep-nudge.*' -mtime +7 -delete 2>/dev/null || true
# Stable-ish session key: prefer the explicit session_id, fall back to PPID so
# we still throttle within a single `claude` process when session_id is empty.
KEY="${SESSION:-ppid-$PPID}"
# Sanitize (session ids are usually safe, but guard anyway).
KEY=$(printf '%s' "$KEY" | tr -c 'A-Za-z0-9._-' '_')
MARKER="$STATE_DIR/grep-nudge.${KEY}"
[ ! -e "$MARKER" ] || exit 0
: > "$MARKER"

MSG="claude-context: this repo is indexed for semantic search. If this $TOOL is answering a conceptual question (\"where is X handled\", \"how does Y work\", \"what implements Z\") rather than matching a known identifier/regex/filename, prefer \`mcp__openllm__search_code\` — it finds code by meaning and often lands in one call. Grep/Glob remain right for exact strings. This nudge fires once per session."

jq -n --arg ctx "$MSG" '{
    hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: $ctx
    }
}'
