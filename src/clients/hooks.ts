/**
 * The session hooks, embedded as text and materialized into the ephemeral run
 * dir on each launch.
 *
 * These are EXECUTABLES, not config, so they live in their own table rather
 * than `OVERLAYS` (whose hygiene test forbids script content). They used to be
 * base64-embedded in an assembled registry installer and written into
 * `~/.claude/plugins/openllm/hooks/`; now they are written to
 * `~/.openllm/run/<client>/<pid>/hooks/` and referenced from the run-local
 * settings, so nothing lands in the user's config tree and a stale hook can't
 * outlive the launch that created it.
 *
 * These remaining scripts implement indexing/status-line behavior. Memory
 * hooks invoke `openllm exec memory …` directly from the client overlays —
 * their configuration, HTTP and extraction live entirely in the compiled CLI.
 */

import ctxGrepNudge from "../../setup/hooks/ctx-grep-nudge.sh" with {
  type: "text",
};
import ctxReindexOnEdit from "../../setup/hooks/ctx-reindex-on-edit.sh" with {
  type: "text",
};
import ctxSessionStart from "../../setup/hooks/ctx-session-start.sh" with {
  type: "text",
};
import statusline from "../../setup/hooks/statusline.sh" with { type: "text" };

/** filename → script body. Materialized 0o700 into `<runDir>/hooks/`. */
export const HOOK_SCRIPTS: Readonly<Record<string, string>> = {
  "ctx-session-start.sh": ctxSessionStart,
  "ctx-grep-nudge.sh": ctxGrepNudge,
  "ctx-reindex-on-edit.sh": ctxReindexOnEdit,
  // Not a hook in the event sense — a `statusLine` command — but it shares the
  // same lifecycle: embedded as text, materialized 0700 into the run dir, and
  // referenced from the run-local settings.
  "statusline.sh": statusline,
};
