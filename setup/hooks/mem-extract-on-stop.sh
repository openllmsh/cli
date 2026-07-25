#!/usr/bin/env bash
# Stop hook — extract durable memories from the most recent exchange and
# persist them. Replaces the old UserPromptSubmit-time extractor, which
# saved off a single user message before the assistant ever responded —
# which meant speculation and rejected proposals could land in memory as
# if they were the user's conclusion.
#
# Why Stop instead of UserPromptSubmit
# ────────────────────────────────────
# By the time Stop fires, the latest exchange is *finished*: we can see the
# user's statement, the assistant's response, AND any follow-up the user
# made (corrections, "yes do that", "no stop"). That's the signal needed to
# distinguish "the user actually concluded X" from "the user floated X and
# the conversation moved on."
#
# What this hook does
# ───────────────────
# 1. Reads the Stop event JSON: transcript_path, session_id, cwd.
# 2. Derives the project slug from cwd (git-root basename, slugified;
#    falls back to cwd basename). No more global "default" bucket.
# 3. Throttles: skips if the transcript byte size hasn't grown since the
#    last extraction for this session. Stop fires often; we don't.
# 4. Pulls the last N messages from the transcript JSONL and the top
#    existing memories for this project.
# 5. Pre-fetches the user's team list (/whoami) and known project slugs
#    (/projects) so the extractor LLM can ROUTE each save to one or more
#    destinations.
# 6. Asks the extractor LLM to emit BOTH save and forget candidates:
#       - save: {content, destinations: [{project?, team?}, ...]} — the
#               dialogue confirmed the item AND the model picked which
#               bucket(s) it belongs to (personal project, default,
#               and/or a team the user is in).
#       - forget: existing memories the latest exchange contradicts or
#                 supersedes. Lets memory evolve as the user's stance does.
# 7. Applies save+forget against the gateway, fanning out per destination.
#
# Wire: hooks.Stop, identified by path substring
#   `openllm/hooks/mem-extract-on-stop.sh`
# for clean uninstall.
#
# Env (gateway URL + key resolved from the shared ~/.openllm/.env via
# openllm-env.sh; a process-env override still wins):
#   OPENLLM_CLOUD_ORIGIN         required
#   OPENLLM_API_KEY              required
#   SUPERMEMORY_AUTO_SAVE        "1" enables (default), "0" disables
#   SUPERMEMORY_AUTO_MODEL       extractor model alias, default "lite"
#   SUPERMEMORY_AUTO_PROJECT     hard override for project slug; if unset,
#                                derived from cwd
#   SUPERMEMORY_AUTO_DEDUPE_SIM  similarity above which a save candidate
#                                is treated as already-saved (0.0-1.0),
#                                default 0.85
#   SUPERMEMORY_AUTO_MAX_TURNS   max recent transcript turns to send to
#                                the extractor, default 12
#   SUPERMEMORY_AUTO_MIN_INTERVAL  minimum seconds between extractions for
#                                the same session, default 30
#   SUPERMEMORY_AUTO_LOG_DIR     where to log activity,
#                                default $HOME/.claude/plugin-state/supermemory
set -u

[ "${SUPERMEMORY_AUTO_SAVE:-1}" = "1" ] || exit 0

# Resolve gateway config from the ONE shared env file (~/.openllm/.env).
# shellcheck source=openllm-env.sh
. "$(dirname "$0")/openllm-env.sh" 2>/dev/null || true

if [ -z "${OPENLLM_CLOUD_ORIGIN:-}" ] || [ -z "${OPENLLM_API_KEY:-}" ]; then
    exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    exit 0
fi

INPUT="$(cat)"
[ -n "$INPUT" ] || exit 0

LOG_DIR="${SUPERMEMORY_AUTO_LOG_DIR:-$HOME/.claude/plugin-state/supermemory}"
# Logs + session state may quote conversation text — owner-only, always.
umask 077
mkdir -p "$LOG_DIR/sessions" 2>/dev/null || true
chmod 700 "$LOG_DIR" "$LOG_DIR/sessions" 2>/dev/null || true

# Detach so Stop returns immediately. Stop hooks can keep the agent paused
# until they exit, and we never want a slow gateway to stall the user.
(
# The API key travels via the ENVIRONMENT, never argv — positional args are
# visible to every local user in the process table for the python3 lifetime.
SUPERMEMORY_INPUT="$INPUT" \
OPENLLM_API_KEY="$OPENLLM_API_KEY" \
python3 - \
    "$OPENLLM_CLOUD_ORIGIN" \
    "${SUPERMEMORY_AUTO_MODEL:-lite}" \
    "${SUPERMEMORY_AUTO_PROJECT:-}" \
    "${SUPERMEMORY_AUTO_DEDUPE_SIM:-0.85}" \
    "${SUPERMEMORY_AUTO_MAX_TURNS:-12}" \
    "${SUPERMEMORY_AUTO_MIN_INTERVAL:-30}" \
    "$LOG_DIR" \
    <<'PYEOF' >/dev/null 2>&1
import atexit, fcntl, json, os, sys, urllib.request, urllib.error, urllib.parse, re, time, subprocess, hashlib

(gateway, model, project_override, dedupe_sim_s,
 max_turns_s, min_interval_s, log_dir) = sys.argv[1:8]
api_key = os.environ["OPENLLM_API_KEY"]  # env, not argv — see the caller
log_file = os.path.join(log_dir, "auto-save.log")
sessions_dir = os.path.join(log_dir, "sessions")

try:
    dedupe_sim = float(dedupe_sim_s)
except ValueError:
    dedupe_sim = 0.85
try:
    max_turns = max(2, min(40, int(max_turns_s)))
except ValueError:
    max_turns = 12
try:
    min_interval = max(0, int(min_interval_s))
except ValueError:
    min_interval = 30

raw = os.environ.get("SUPERMEMORY_INPUT") or ""
try:
    event = json.loads(raw)
except Exception:
    sys.exit(0)

# Harness field shim. Claude Code sends snake_case; Grok Build sends the same
# event in camelCase (`hookEventName`, `stopHookActive`, `transcriptPath`) —
# read both so ONE hook serves either. Grok's `transcriptPath` is real but
# undocumented as of grok 0.2.111; it is verified present on the live Stop
# payload, and the guard below already no-ops when it is missing or unreadable.
def field(*names):
    for n in names:
        v = event.get(n)
        if v is not None:
            return v
    return None


# Ignore re-entrant Stop firings — the hook itself doesn't continue, but
# defensively: if the harness says it's already mid-loop, bail.
if field("stop_hook_active", "stopHookActive") is True:
    sys.exit(0)

session_id = field("session_id", "sessionId") or ""
transcript_path = field("transcript_path", "transcriptPath") or ""
cwd = event.get("cwd") or os.getcwd()

if not transcript_path or not os.path.isfile(transcript_path):
    sys.exit(0)


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"-+", "-", s)
    s = s.strip("-._")
    s = s[:64]
    return s if (s and re.match(r"^[a-z0-9]", s)) else ""


def derive_project(cwd: str) -> str:
    if project_override:
        slug = slugify(project_override)
        if slug:
            return slug
    if cwd:
        try:
            out = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=2.0,
            )
            if out.returncode == 0:
                root = out.stdout.strip()
                if root:
                    slug = slugify(os.path.basename(root))
                    if slug:
                        return slug
        except Exception:
            pass
        slug = slugify(os.path.basename(cwd.rstrip("/")))
        if slug:
            return slug
    return "default"


project = derive_project(cwd)

# ── Throttle: skip if transcript hasn't changed since last run ────────────
state_key = hashlib.sha1(
    (session_id + "|" + transcript_path).encode()
).hexdigest()[:16]
state_file = os.path.join(sessions_dir, state_key + ".json")

# Serialize concurrent extractions for the same session/transcript. Keep an
# ownership-safe kernel lock for this process's lifetime; crashes release it
# automatically, and a later process cannot unlink a live owner's lock.
lock_file = state_file + ".lock"
try:
    lock_fd = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    try:
        os.close(lock_fd)
    except Exception:
        pass
    sys.exit(0)
except Exception:
    try:
        os.close(lock_fd)
    except Exception:
        pass
    sys.exit(0)

atexit.register(lambda: os.close(lock_fd))

prev_state = {}
try:
    with open(state_file) as f:
        prev_state = json.load(f)
except Exception:
    prev_state = {}

try:
    cur_size = os.path.getsize(transcript_path)
except OSError:
    sys.exit(0)
now = int(time.time())

if (
    prev_state.get("size") == cur_size
    or (now - int(prev_state.get("ts", 0))) < min_interval
):
    sys.exit(0)

# ── Transcript entry parsers (one per harness) ───────────────────────────
# Both harnesses write JSONL, one entry per line, but with different shapes.
# Each parser returns (role, text) for a user/assistant turn, or None when the
# entry is not one (tool plumbing, hook bookkeeping, …). Trying Claude first
# then Grok keeps ONE reader for both — the shapes are disjoint, so a wrong
# guess yields None rather than a mis-parse.


def _parse_claude_entry(obj):
    """Claude Code: {type: "user"|"assistant", message: {role, content}}."""
    if not isinstance(obj, dict):
        return None
    ttype = obj.get("type")
    if ttype not in ("user", "assistant"):
        return None
    message = obj.get("message") or {}
    if not isinstance(message, dict):
        return None
    role = message.get("role") or ttype
    content = message.get("content")
    if isinstance(content, str):
        return role, content
    if not isinstance(content, list):
        return role, ""
    chunks = []
    for c in content:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "text" and isinstance(c.get("text"), str):
            chunks.append(c["text"])
        elif c.get("type") == "tool_use":
            chunks.append(f"[tool_use:{c.get('name') or 'tool'}]")
        elif c.get("type") == "tool_result":
            chunks.append("[tool_result]")
    return role, "\n".join(chunks)


# Grok Build: {method: "…/session/update", params: {update: {sessionUpdate: …}}}.
# Turn text arrives as `user_message_chunk` / `agent_message_chunk` with
# {content: {type: "text", text: …}}. `agent_thought_chunk` (reasoning) is
# deliberately skipped — it is not what the user or the model *said*. A
# `tool_call` maps to the same [tool_use:…] marker Claude's branch emits, so
# the extractor sees one vocabulary regardless of harness.
_GROK_ROLE = {"user_message_chunk": "user", "agent_message_chunk": "assistant"}


def _parse_grok_entry(obj):
    if not isinstance(obj, dict):
        return None
    params = obj.get("params")
    if not isinstance(params, dict):
        return None
    update = params.get("update")
    if not isinstance(update, dict):
        return None
    kind = update.get("sessionUpdate")
    role = _GROK_ROLE.get(kind)
    if role is not None:
        content = update.get("content")
        if not isinstance(content, dict):
            return None
        text = content.get("text")
        return (role, text) if isinstance(text, str) else None
    if kind == "tool_call":
        return "assistant", f"[tool_use:{update.get('title') or 'tool'}]"
    return None


# ── Load last N user/assistant text turns from the transcript JSONL ───────
def _coalesce_same_role(items: list[tuple[str, str]]):
    """Merge consecutive same-role chunks (Grok streams one line per delta).

    Walk is oldest→newest so concatenation preserves utterance order.
    """
    coalesced: list[dict] = []
    for role, text in items:
        if coalesced and coalesced[-1]["role"] == role:
            coalesced[-1]["text"] = f"{coalesced[-1]['text']}\n{text}".strip()
        else:
            coalesced.append({"role": role, "text": text})
    return coalesced


def load_recent_turns(path: str, limit: int):
    lines = []
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    lines.append(line)
    except Exception:
        return []

    # Oldest → newest so same-role Grok chunks concatenate in utterance order.
    parsed_chunks: list[tuple[str, str]] = []
    for raw_line in lines:
        try:
            obj = json.loads(raw_line)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        parsed = _parse_claude_entry(obj)
        if parsed is None:
            parsed = _parse_grok_entry(obj)
        if parsed is None:
            continue
        role, text = parsed
        if not isinstance(role, str) or not isinstance(text, str):
            continue
        text = text.strip()
        if not text:
            continue
        # Skip injected system-reminder / hook-context blocks — they are
        # noise for the extractor and can drown the real user signal.
        if text.startswith("<system-reminder>") or text.startswith("[supermemory]"):
            continue
        parsed_chunks.append((role, text))

    # Coalesce first (so Grok deltas become real turns), then take the latest N
    # and trim each turn so we don't blow the extractor's context budget.
    turns = _coalesce_same_role(parsed_chunks)
    if limit > 0:
        turns = turns[-limit:]
    for t in turns:
        if len(t["text"]) > 2000:
            t["text"] = t["text"][:2000] + "…"
    return turns


turns = load_recent_turns(transcript_path, max_turns)
if len(turns) < 2:
    # Need at least one user + one assistant turn to read intent + confirmation.
    try:
        with open(state_file, "w") as f:
            json.dump({"size": cur_size, "ts": now}, f)
    except Exception:
        pass
    sys.exit(0)


def log_line(tag: str, msg: str):
    try:
        with open(log_file, "a") as f:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S")
            f.write(f"{ts} {tag}  {msg}\n")
    except Exception:
        pass


def post(path: str, payload, timeout: float, url: str = "", hops: int = 0,
         no_daemon_retry: bool = False):
    # urllib REFUSES to re-POST across a 307/308 (it raises HTTPError instead
    # of following), but the gateway 307s /v1/* subscription hops to the local
    # daemon when it's running — so we follow Location by hand, re-POSTing the
    # same body. Bounded to 3 hops.
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if no_daemon_retry:
        # The proxy's negative-liveness protocol (subscription-guard.ts):
        # suppresses the daemon redirect, corrects stale presence, and serves
        # the chain's API-key hop on the cloud instead.
        headers["x-openllm-no-daemon"] = "1"
    r = urllib.request.Request(
        url or (gateway.rstrip("/") + path),
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code in (307, 308) and hops < 3:
            loc = e.headers.get("Location")
            if loc:
                target = urllib.parse.urljoin(r.full_url, loc)
                try:
                    return post(path, payload, timeout, url=target,
                                hops=hops + 1, no_daemon_retry=no_daemon_retry)
                except (urllib.error.URLError, TimeoutError, OSError) as e2:
                    # 307 target (the loopback daemon) unreachable — stale
                    # presence. Retry the ORIGINAL gateway URL once with
                    # `x-openllm-no-daemon` so the cloud serves an API-key
                    # hop instead of the extraction dying silently. Guarded
                    # to one retry: the retry itself carries the header, so
                    # the gateway won't 307 it again.
                    if not no_daemon_retry and target.startswith(
                            ("http://127.0.0.1", "http://localhost")):
                        log_line("WARN", f"[{project}] daemon 307 target unreachable "
                                 f"({type(e2).__name__}); retrying cloud with x-openllm-no-daemon")
                        return post(path, payload, timeout, no_daemon_retry=True)
                    raise
        raise


def get(path: str, timeout: float):
    r = urllib.request.Request(
        gateway.rstrip("/") + path,
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


# ── Routing context: team membership + known project slugs. The router LLM ─
# uses these to decide where each save lands. Failures are non-fatal — we
# fall back to project-only routing scoped to the cwd-derived slug.
teams_for_user = []  # list of {"id","name"} dicts
try:
    who = get("/api/plugins/supermemory/whoami", timeout=3.0)
    raw_teams = who.get("teams") if isinstance(who, dict) else None
    if isinstance(raw_teams, list):
        for t in raw_teams:
            if isinstance(t, dict) and t.get("id"):
                teams_for_user.append({
                    "id": str(t["id"]),
                    "name": str(t.get("name") or t["id"]),
                })
except Exception:
    pass

known_projects = []
try:
    pdata = get("/api/plugins/supermemory/projects", timeout=3.0)
    raw_projects = pdata.get("projects") if isinstance(pdata, dict) else None
    if isinstance(raw_projects, list):
        known_projects = [str(p) for p in raw_projects if isinstance(p, str) and p]
except Exception:
    pass


# ── Pull existing memories for this project so the LLM can detect ─────────
# contradictions (forget candidates) and skip duplicates more accurately. ─
existing = []
try:
    last_user = next(
        (t["text"] for t in reversed(turns) if t["role"] == "user"),
        "",
    )
    seed_query = (last_user or " ".join(t["text"] for t in turns[-3:]))[:800]
    sdata = post(
        "/api/plugins/supermemory/search",
        {"query": seed_query, "limit": 20, "project": project},
        timeout=3.0,
    )
    for r in sdata.get("results") or []:
        c = (r.get("content") or "").strip()
        if c:
            existing.append({"id": r.get("id"), "content": c})
except Exception:
    pass

existing_block = (
    "\n".join(f"- {e['content']}" for e in existing[:20])
    if existing else "(none)"
)

transcript_block = "\n\n".join(
    f"[{t['role']}]\n{t['text']}" for t in turns
)

teams_block = (
    "\n".join(f"- id={t['id']}  name={t['name']}" for t in teams_for_user)
    if teams_for_user else "(none — user is not in any team; do NOT emit team destinations)"
)

# Surface up to 30 known project slugs so the router prefers an existing
# bucket over inventing a near-duplicate. The current cwd project is always
# listed first.
def _format_projects():
    seen = set()
    out = []
    for slug in [project, "default"] + known_projects:
        if slug and slug not in seen:
            seen.add(slug)
            out.append(slug)
        if len(out) >= 30:
            break
    return out


known_block = ", ".join(_format_projects())

SYSTEM = (
    "You curate a long-term memory store for a single user across Claude Code "
    "sessions. You receive (a) the most recent turns of one conversation, "
    "(b) the existing memories already saved for the user's CURRENT project, "
    "and (c) the user's team memberships and known project slugs. "
    "Your job is to decide what to SAVE, where to ROUTE each save, and what "
    "to FORGET so the store stays accurate and current.\n"
    "\n"
    "── WHAT TO SAVE ──────────────────────────────────────────────────────\n"
    "Only emit a SAVE when the dialogue itself confirms the user has CONCLUDED "
    "the item — not merely brainstormed it. A safe save looks like:\n"
    "  • The user states a preference, rule, fact, or constraint in their own "
    "    words (\"I prefer X\", \"my team uses Y\", \"never Z\").\n"
    "  • The user explicitly accepts an assistant proposal (\"yes do that\", "
    "    \"perfect, keep doing that\", \"that bundled PR was the right call\").\n"
    "  • The user gives concrete corrective feedback that should change future "
    "    behavior (\"stop doing X\", \"don't use Y\", \"always do Z instead\").\n"
    "Do NOT save:\n"
    "  • Speculation or proposals from EITHER party that the user has not "
    "    confirmed.\n"
    "  • Ideas the user rejected or walked back later in the same exchange.\n"
    "  • Ephemeral task state (\"I'm working on X right now\").\n"
    "  • Code patterns, architecture, file paths — derivable from the repo.\n"
    "  • Greetings, thanks, meta-questions about the assistant.\n"
    "\n"
    "── WHERE TO ROUTE ────────────────────────────────────────────────────\n"
    "Each save carries a `destinations` array. Each entry picks ONE bucket:\n"
    "  {\"project\": \"<slug>\"}      — write to a personal project bucket.\n"
    "  {\"team\": \"<team-id>\"}      — write to a team's shared bucket so "
    "every member can recall it.\n"
    "  {\"project\": \"<slug>\", \"team\": \"<team-id>\"}  — both: tagged "
    "to the team in that project slug.\n"
    "Routing rules:\n"
    "  • Personal preferences, working style, facts about the user → "
    "`{\"project\": \"default\"}`.\n"
    "  • Project-specific facts (this codebase's deadlines, stakeholders, "
    "gotchas, conventions specific to this repo) → "
    "`{\"project\": \"<current-project>\"}`.\n"
    "  • Team-shared knowledge that any teammate would benefit from — shared "
    "infra, runbooks, on-call info, cross-cutting team conventions, vendor "
    "decisions, ops links — → `{\"team\": \"<team-id>\"}`. ONLY use a team "
    "id from the team list provided. NEVER invent ids.\n"
    "  • Cross-cutting facts (relevant both personally AND to a team) → emit "
    "MULTIPLE destinations in the array, one per bucket.\n"
    "  • Prefer an EXISTING project slug from the known list over a new one.\n"
    "  • If the user is in NO teams, never emit a team destination.\n"
    "  • If unsure, fall back to a single `{\"project\": "
    "\"<current-project>\"}` destination.\n"
    "If you omit `destinations`, the save defaults to "
    "`[{\"project\": \"<current-project>\"}]`.\n"
    "\n"
    "── WHAT TO FORGET ────────────────────────────────────────────────────\n"
    "Emit a FORGET for any existing memory the latest exchange CONTRADICTS, "
    "SUPERSEDES, or invalidates (e.g. user changed stack, switched tooling, "
    "reversed a preference, ended a project). Use the existing memory's exact "
    "content string. If the user is just refining (\"actually it's X not Y\"), "
    "emit forget(old) AND save(new). Do NOT forget memories that are merely "
    "off-topic for the current turn.\n"
    "\n"
    "── PHRASING ──────────────────────────────────────────────────────────\n"
    "Phrase saves in third person about the user (\"User prefers …\", \"User's "
    "team uses …\") so they read sensibly in isolation in a future session. "
    "Include the *why* if the dialogue gave one.\n"
    "\n"
    "── OUTPUT ────────────────────────────────────────────────────────────\n"
    "Return STRICT JSON of the form:\n"
    "{\n"
    "  \"save\": [\n"
    "    {\"content\": \"…\", \"destinations\": [{\"project\": \"default\"}, "
    "{\"team\": \"<team-id>\"}]},\n"
    "    …\n"
    "  ],\n"
    "  \"forget\": [{\"content\": \"…\"}, …]\n"
    "}\n"
    "Either array may be empty. `destinations` is optional per item. "
    "No prose, no markdown fences."
)

USER_BLOCK = (
    f"CURRENT PROJECT: {project}\n"
    f"KNOWN PROJECTS (prefer these slugs): {known_block}\n"
    f"\n"
    f"USER'S TEAMS (use only these team ids when routing to a team):\n"
    f"{teams_block}\n"
    f"\n"
    f"EXISTING MEMORIES FOR THIS PROJECT:\n{existing_block}\n"
    f"\n"
    f"RECENT CONVERSATION TURNS (oldest → newest):\n{transcript_block}"
)

body = {
    "model": model,
    "messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": USER_BLOCK},
    ],
    "max_tokens": 700,
    "temperature": 0.0,
}

# The extractor call goes through post() too — the gateway 307s subscription
# models to the local daemon, and urllib won't re-POST across a redirect on
# its own (this silently killed every extraction when `lite` resolved to a
# daemon-served chain hop).
try:
    data = post("/v1/chat/completions", body, timeout=30.0)
except Exception as e:
    # Stamp the run anyway so we don't hammer the gateway on the same
    # transcript size if it's down — and LOG it: a broken extractor must be
    # visible in auto-save.log, not silent.
    log_line("ERROR", f"[{project}] extractor LLM call failed: {type(e).__name__}: {e}")
    try:
        with open(state_file, "w") as f:
            json.dump({"size": cur_size, "ts": now}, f)
    except Exception:
        pass
    sys.exit(0)

def stamp_state():
    try:
        with open(state_file, "w") as f:
            json.dump({"size": cur_size, "ts": now}, f)
    except Exception:
        pass


try:
    text = data["choices"][0]["message"]["content"] or ""
except Exception:
    log_line("ERROR", f"[{project}] extractor response had no message content")
    stamp_state()
    sys.exit(0)

# Tolerate models that wrap JSON in fences or surrounding prose.
m = re.search(r"\{[\s\S]*\}", text)
if not m:
    stamp_state()
    sys.exit(0)
try:
    parsed = json.loads(m.group(0))
except Exception:
    log_line("ERROR", f"[{project}] extractor output was not valid JSON")
    stamp_state()
    sys.exit(0)

save_items = parsed.get("save") if isinstance(parsed, dict) else None
forget_items = parsed.get("forget") if isinstance(parsed, dict) else None
if not isinstance(save_items, list):
    save_items = []
if not isinstance(forget_items, list):
    forget_items = []

saved, forgot, skipped_dup, errors = [], [], 0, 0

# ── Apply forgets first (so a paired update lands cleanly) ────────────────
for fm in forget_items:
    if not isinstance(fm, dict):
        continue
    content = (fm.get("content") or "").strip()
    if not content or len(content) < 6 or len(content) > 4000:
        continue
    try:
        post(
            "/api/plugins/supermemory/forget",
            {"content": content, "project": project},
            timeout=5.0,
        )
        forgot.append(content)
    except Exception:
        # Fall back to id-based forget if the LLM gave us one.
        fid = fm.get("id")
        if isinstance(fid, str) and fid:
            try:
                post(
                    "/api/plugins/supermemory/forget",
                    {"id": fid},
                    timeout=5.0,
                )
                forgot.append(content)
                continue
            except Exception:
                pass
        errors += 1

# Set of team ids the user actually belongs to — defensive guard against
# the LLM hallucinating an id. Hallucinated ids are dropped; the project
# legs of the destinations are still honored so the memory isn't lost.
known_team_ids = {t["id"] for t in teams_for_user}


def _collapse_destinations(raw, fallback_project):
    """Reduce the LLM's destinations array to (projects[], teams[]) — one
    save call covers every destination. Bogus team ids are filtered. If the
    LLM gave us nothing usable, default to a single-project fallback."""
    projects = []
    teams = []
    pseen = set()
    tseen = set()
    if isinstance(raw, list):
        for d in raw:
            if not isinstance(d, dict):
                continue
            proj = d.get("project")
            team = d.get("team")
            if isinstance(proj, str):
                slug = proj.strip().lower()
                if slug and slug not in pseen:
                    pseen.add(slug)
                    projects.append(slug)
            if isinstance(team, str):
                tid = team.strip()
                if tid and tid in known_team_ids and tid not in tseen:
                    tseen.add(tid)
                    teams.append(tid)
    if not projects:
        projects.append(fallback_project)
    return projects, teams


# ── Then apply saves with semantic dedupe — one call per memory ───────────
for mem in save_items:
    if not isinstance(mem, dict):
        continue
    content = (mem.get("content") or "").strip()
    if not content or len(content) < 12 or len(content) > 4000:
        continue

    projects_for_mem, teams_for_mem = _collapse_destinations(
        mem.get("destinations"), project,
    )

    # Semantic dedupe across the union of destination projects: if a
    # near-duplicate already lives in any of them (visible via overlay
    # union — own + team), don't save again. The chunk would just be
    # merged anyway, but skipping spares an extra round-trip on the
    # gateway.
    try:
        sdata = post(
            "/api/plugins/supermemory/search",
            {"query": content, "limit": 3, "projects": projects_for_mem},
            timeout=3.0,
        )
        if any(
            isinstance(r.get("similarity"), (int, float))
            and r["similarity"] >= dedupe_sim
            for r in (sdata.get("results") or [])
        ):
            skipped_dup += 1
            continue
    except Exception:
        pass

    body_save = {"content": content, "projects": projects_for_mem}
    if teams_for_mem:
        body_save["teams"] = teams_for_mem
    try:
        post(
            "/api/plugins/supermemory/save",
            body_save,
            timeout=5.0,
        )
        proj_tag = ",".join(projects_for_mem)
        team_tag = ("|teams=" + ",".join(teams_for_mem)) if teams_for_mem else ""
        saved.append((proj_tag + team_tag, content))
    except Exception:
        errors += 1

try:
    with open(state_file, "w") as f:
        json.dump({"size": cur_size, "ts": now}, f)
except Exception:
    pass

if saved or forgot or skipped_dup or errors:
    try:
        with open(log_file, "a") as f:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S")
            for tag, c in saved:
                f.write(f"{ts} SAVE   [{tag}] {c}\n")
            for c in forgot:
                f.write(f"{ts} FORGET [{project}] {c}\n")
            if skipped_dup:
                f.write(f"{ts} DEDUP  [{project}] skipped {skipped_dup} duplicate(s)\n")
            if errors:
                f.write(f"{ts} ERROR  [{project}] {errors} call(s) failed\n")
    except Exception:
        pass
PYEOF
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
