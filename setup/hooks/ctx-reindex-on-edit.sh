#!/usr/bin/env bash
# claude-context PostToolUse hook.
#
# Fires on Edit / Write / NotebookEdit. Keeps the semantic index tracking the
# code AS IT CHANGES within a session — without this, the index only syncs on
# SessionStart, so anything the agent writes mid-session is invisible to
# search_code until the next session.
#
# Fire-and-forget like ctx-session-start.sh: the sync runs detached in the
# background and the hook returns immediately, so an edit is never slowed
# down. `openllm exec ctx index` is incremental — unchanged files reuse their
# embeddings — so repeated syncs on a mostly-unchanged tree are cheap.
#
# Throttling: at most one background sync per repo per
# $CLAUDE_CONTEXT_REINDEX_INTERVAL seconds (default 120), keyed by a
# mtime-checked marker file under $CLAUDE_CONTEXT_STATE_DIR. Edits arrive in
# bursts; the trailing edits of a burst are picked up by the next interval's
# sync (or the next session's).
set -u

[ "${CLAUDE_CONTEXT_AUTO_INDEX:-1}" = "1" ] || exit 0
[ "${CLAUDE_CONTEXT_REINDEX_ON_EDIT:-1}" = "1" ] || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
ROOT=$(git -C "$PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$ROOT" ] || exit 0
git -C "$ROOT" remote get-url origin >/dev/null 2>&1 || exit 0

OPENLLM="${OPENLLM_BIN:-$HOME/.openllm/bin/openllm}"
[ -x "$OPENLLM" ] || exit 0

STATE_DIR="${CLAUDE_CONTEXT_STATE_DIR:-$HOME/.claude/plugin-state/claude-context}"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/auto-index.log"

INTERVAL="${CLAUDE_CONTEXT_REINDEX_INTERVAL:-120}"
case "$INTERVAL" in *[!0-9]*|'') INTERVAL=120 ;; esac

# Marker keyed by a HASH of the canonical repo path — throttles per repo, not
# per session, and distinct paths can never collide (the old character
# sanitizer mapped /tmp/foo_bar and /tmp/foo/bar to the same key).
if command -v shasum >/dev/null 2>&1; then
    KEY=$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-16)
elif command -v sha256sum >/dev/null 2>&1; then
    KEY=$(printf '%s' "$ROOT" | sha256sum | cut -c1-16)
else
    KEY=$(printf '%s' "$ROOT" | cksum | tr ' ' '_')
fi
MARKER="$STATE_DIR/reindex.${KEY}"
LOCK_DIR="$STATE_DIR/reindex.${KEY}.lock"

if [ -e "$MARKER" ]; then
    NOW=$(date +%s)
    THEN=$(stat -f %m "$MARKER" 2>/dev/null || stat -c %Y "$MARKER" 2>/dev/null || echo 0)
    [ $((NOW - THEN)) -ge "$INTERVAL" ] || exit 0
fi

# Serialize launches per repo: the mtime check above only rate-limits, so two
# concurrent hook firings (or a sync outliving the interval) could otherwise
# overlap `ctx index` runs. `mkdir` is the portable atomic test-and-set (no
# flock on macOS); the lock is held for the LIFETIME of the background sync
# and released when it finishes. A crashed holder can't wedge us forever:
# a lock older than 30 min is treated as stale and reclaimed.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    NOW=$(date +%s)
    LOCK_TS=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo "$NOW")
    [ $((NOW - LOCK_TS)) -ge 1800 ] || exit 0
    rmdir "$LOCK_DIR" 2>/dev/null || true
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
: > "$MARKER"

# Fire-and-forget, exactly like the SessionStart hook. Incremental: only
# changed content re-embeds. The subshell releases the lock when the sync
# exits (success or failure).
(
    "$OPENLLM" exec ctx index --path "$ROOT" >>"$LOG" 2>&1
    rmdir "$LOCK_DIR" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
