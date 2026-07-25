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
 * They shell out to `openllm exec ctx …` (hooks can't speak MCP stdio) and
 * resolve the gateway origin + key from the shared `~/.openllm/.env` via
 * `openllm-env.sh` — so no secret is written into any hook or settings file.
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
import memExtractOnStop from "../../setup/hooks/mem-extract-on-stop.sh" with {
  type: "text",
};
import memRecallOnPrompt from "../../setup/hooks/mem-recall-on-prompt.sh" with {
  type: "text",
};
import openllmEnv from "../../setup/hooks/openllm-env.sh" with { type: "text" };

/** filename → script body. Materialized 0o700 into `<runDir>/hooks/`. */
export const HOOK_SCRIPTS: Readonly<Record<string, string>> = {
  "openllm-env.sh": openllmEnv,
  "ctx-session-start.sh": ctxSessionStart,
  "ctx-grep-nudge.sh": ctxGrepNudge,
  "ctx-reindex-on-edit.sh": ctxReindexOnEdit,
  "mem-recall-on-prompt.sh": memRecallOnPrompt,
  "mem-extract-on-stop.sh": memExtractOnStop,
};
