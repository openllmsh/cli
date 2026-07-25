#!/usr/bin/env bash
# UserPromptSubmit hook — auto-recall relevant memories from the gateway's
# supermemory store and inject them as additional context so the agent never
# has to call `recall` itself.
#
# Restored in v1.2.0: unlike the removed guidance/trigger hooks this is
# FUNCTIONAL data injection, not pattern-matched advice — the model cannot
# recall what it doesn't know exists. Only ≥$SUPERMEMORY_RECALL_MIN_SIMILARITY
# hits are injected, so an unrelated prompt injects nothing.
#
# Wire: a Claude Code hook under `hooks.UserPromptSubmit`. Input: the event
# JSON on stdin. Output: a JSON object with hookSpecificOutput.additionalContext,
# or empty stdout (exit 0) when nothing useful matched. Failures are SILENT to
# the user — this hook runs on every prompt, so a down gateway must never
# surface as an error — but ARE logged to $SUPERMEMORY_AUTO_LOG_DIR/recall.log
# so a broken recall path is visible (the same observability the Stop
# extractor's auto-save.log provides).
#
# Env (gateway URL + key resolved from the shared ~/.openllm/.env via
# openllm-env.sh; a process-env override still wins):
#   OPENLLM_CLOUD_ORIGIN  required
#   OPENLLM_API_KEY       required
#   SUPERMEMORY_AUTO_RECALL            "1" enables (default), "0" disables
#   SUPERMEMORY_RECALL_MIN_SIMILARITY  optional, default 0.25 (v1.2.1 —
#                                      was 0.50, which filtered nearly
#                                      everything: live Titan-v2 scores for
#                                      relevant-but-paraphrased prompts sit
#                                      in the 0.28-0.35 band while genuinely
#                                      irrelevant queries top out ~0.13, so
#                                      0.25 separates cleanly; ≥0.50 needs a
#                                      near-verbatim restatement)
#   SUPERMEMORY_RECALL_LIMIT           optional, default 5
#   SUPERMEMORY_RECALL_TIMEOUT         optional, default 5.0s (v1.2.1 — was
#                                      a hardcoded 2.5s that cold-start
#                                      gateway requests routinely blew;
#                                      the hook fails open, so waiting is
#                                      cheap and a timeout loses the recall)
#   SUPERMEMORY_RECALL_PROJECT         optional hard override; if unset the
#                                      project slug is derived per-event from
#                                      the prompt's cwd (git-root basename,
#                                      slugified; falls back to cwd basename).
#                                      Memories from "default" are also
#                                      always searched as a global fallback.
#   SUPERMEMORY_RECALL_MAX_PROMPT      optional, default 1000 chars (the
#                                      gateway's hard cap)
#   SUPERMEMORY_AUTO_LOG_DIR           where to log activity,
#                                      default $HOME/.claude/plugin-state/supermemory
set -u

[ "${SUPERMEMORY_AUTO_RECALL:-1}" = "1" ] || exit 0

# Resolve gateway config from the ONE shared env file (~/.openllm/.env).
# shellcheck source=openllm-env.sh
. "$(dirname "$0")/openllm-env.sh" 2>/dev/null || true

# Guard: missing config → silently no-op.
if [ -z "${OPENLLM_CLOUD_ORIGIN:-}" ] || [ -z "${OPENLLM_API_KEY:-}" ]; then
    exit 0
fi

MIN_SIM="${SUPERMEMORY_RECALL_MIN_SIMILARITY:-0.25}"
RECALL_LIMIT="${SUPERMEMORY_RECALL_LIMIT:-5}"
RECALL_PROJECT="${SUPERMEMORY_RECALL_PROJECT:-}"
RECALL_TIMEOUT="${SUPERMEMORY_RECALL_TIMEOUT:-5.0}"
MAX_PROMPT_CHARS="${SUPERMEMORY_RECALL_MAX_PROMPT:-1000}"
LOG_DIR="${SUPERMEMORY_AUTO_LOG_DIR:-$HOME/.claude/plugin-state/supermemory}"
umask 077
mkdir -p "$LOG_DIR" 2>/dev/null || true
chmod 700 "$LOG_DIR" 2>/dev/null || true

# Read the event JSON from stdin IN BASH and hand it to python via the
# environment — `python3 - <<'PYEOF'` consumes stdin for the program text, so
# `json.load(sys.stdin)` inside would read EOF (this exact bug made the v1.0
# hook a silent no-op). Same pattern as mem-extract-on-stop.sh.
# We require python3 — consistent with install.sh's hard dependency.
if ! command -v python3 >/dev/null 2>&1; then
    exit 0
fi

EVENT="$(cat)"
[ -n "$EVENT" ] || exit 0

# The API key travels via the ENVIRONMENT, never argv — positional args are
# visible to every local user in the process table for the python3 lifetime.
SUPERMEMORY_EVENT="$EVENT" \
OPENLLM_API_KEY="$OPENLLM_API_KEY" \
python3 - "$OPENLLM_CLOUD_ORIGIN" "$MIN_SIM" "$RECALL_LIMIT" "$RECALL_PROJECT" "$MAX_PROMPT_CHARS" "$LOG_DIR" "$RECALL_TIMEOUT" <<'PYEOF' 2>/dev/null || exit 0
import json, os, sys, re, subprocess, time, urllib.request, urllib.error

gateway, min_sim_s, limit_s, project_override, max_chars_s, log_dir, timeout_s = sys.argv[1:8]
api_key = os.environ["OPENLLM_API_KEY"]  # env, not argv — see the caller
log_file = os.path.join(log_dir, "recall.log")

try:
    min_sim = float(min_sim_s)
except ValueError:
    min_sim = 0.25
try:
    timeout = max(0.5, min(15.0, float(timeout_s)))
except ValueError:
    timeout = 5.0
try:
    limit = max(1, min(20, int(limit_s)))
except ValueError:
    limit = 5
try:
    max_chars = max(16, min(1000, int(max_chars_s)))  # gateway hard cap is 1000
except ValueError:
    max_chars = 1000


def log_line(tag: str, msg: str):
    try:
        with open(log_file, "a") as f:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S")
            f.write(f"{ts} {tag}  {msg}\n")
    except Exception:
        pass


try:
    event = json.loads(os.environ.get("SUPERMEMORY_EVENT") or "")
except Exception:
    sys.exit(0)

prompt = (event.get("prompt") or "").strip()
# Grok Build wraps the prompt in <user_query>…</user_query>; Claude Code sends
# it bare. Unwrap so the semantic query is the user's words either way —
# leaving the tags in skews the embedding and the length checks below.
_wrapped = re.match(r"^<user_query>\s*(.*?)\s*</user_query>$", prompt, re.DOTALL)
if _wrapped:
    prompt = _wrapped.group(1).strip()

# Skip trivially short prompts — sending "ok" to semantic search is noise.
if len(prompt) < 6:
    sys.exit(0)

# Skip shell-escapes (`!cmd`) and slash commands (`/skill`) — neither is a
# semantic query about the user's work.
if prompt.startswith("!") or prompt.startswith("/"):
    sys.exit(0)

# Respect the gateway's 1000-char cap.
if len(prompt) > max_chars:
    prompt = prompt[:max_chars]


def _slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"-+", "-", s)
    s = s.strip("-._")[:64]
    return s if (s and re.match(r"^[a-z0-9]", s)) else ""


def _derive_project(cwd: str) -> str:
    if cwd:
        try:
            out = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=2.0,
            )
            if out.returncode == 0 and out.stdout.strip():
                slug = _slugify(os.path.basename(out.stdout.strip()))
                if slug:
                    return slug
        except Exception:
            pass
        slug = _slugify(os.path.basename(cwd.rstrip("/")))
        if slug:
            return slug
    return "default"


# Hard env override > derived from cwd > "default". Memories saved under
# "default" are always included as a fallback so global facts about the
# user surface even outside any project bucket.
if project_override:
    project = _slugify(project_override) or "default"
else:
    project = _derive_project(event.get("cwd") or os.getcwd())

projects = [project]
if project != "default":
    projects.append("default")

url = gateway.rstrip("/") + "/api/plugins/supermemory/search"
body = json.dumps({"query": prompt, "limit": limit, "projects": projects}).encode()
req = urllib.request.Request(
    url,
    data=body,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as e:
    # Gateway down, bad key, malformed response — fail open (no error to the
    # user), but leave a trace so a persistently broken recall is findable.
    log_line("ERROR", f"[{project}] search failed: {type(e).__name__}: {e}")
    sys.exit(0)

results = (data.get("results") if isinstance(data, dict) else None) or []
# Filter on similarity threshold and truncate content per-result so the
# injected context never explodes the conversation budget.
hits = []
for r in results:
    if not isinstance(r, dict):
        continue
    sim = r.get("similarity")
    if not isinstance(sim, (int, float)):
        continue
    if sim < min_sim:
        continue
    content = (r.get("content") or "").strip()
    if not content:
        continue
    if len(content) > 500:
        content = content[:500].rstrip() + "…"
    hits.append((sim, content, r.get("project") or project))

# Don't trust the API's ordering — the "top N%" log line and the injected
# list should always reflect actual similarity, best first. Re-apply the
# configured limit after sorting: a gateway that returns extra entries must
# not inflate the injected context.
hits.sort(key=lambda h: h[0], reverse=True)
hits = hits[:limit]

if not hits:
    # Log the miss WITH the best below-threshold score — "threshold filtered
    # everything" must be distinguishable from "hook never ran" (a 0.50
    # default hid every relevant 0.3x hit for weeks, invisibly).
    best = max(
        (r.get("similarity") for r in results
         if isinstance(r, dict) and isinstance(r.get("similarity"), (int, float))),
        default=None,
    )
    if best is None:
        log_line("MISS", f"[{project}] no results from gateway")
    else:
        log_line("MISS", f"[{project}] {len(results)} result(s), all below "
                 f"threshold (top {round(best * 100)}% < {round(min_sim * 100)}%)")
    sys.exit(0)

log_line("RECALL", f"[{project}] injected {len(hits)} memorie(s) "
         f"(top {round(hits[0][0] * 100)}%)")

lines = ["[supermemory] Relevant saved memories (auto-recalled):"]
for sim, content, proj in hits:
    pct = round(sim * 100)
    lines.append(f"- ({pct}% · {proj}) {content}")

output = {
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "\n".join(lines),
    }
}
json.dump(output, sys.stdout)
PYEOF

exit 0
