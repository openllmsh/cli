# `@openllmsh/cli` — the OpenLLM CLI

> The single distribution vehicle for every gateway extension AND for client
> configuration: ONE compiled, source-free binary (`~/.openllm/bin/openllm`,
> alias `ollm`) that
>
>  1. runs each supported client through OpenLLM (`openllm <client>`), applying
>     its embedded `setup/<client>/` overlay at RUN time — session clients never
>     have their config written, and Raycast (the one always-on client) gets an
>     explicit, reversible in-place apply;
>  2. serves ONE MCP server exposing the MCP-relevant subset of the native
>     gateway API (inference + read-only ops; §MCP) plus the openllm-context
>     and openllm-memory tool groups.
>
> Installed by [`packages/cli/install.sh`](install.sh) (or by the daemon's
> installer, which installs both binaries), self-updating against the gateway's
> pinned release — the extension-side twin of
> [`packages/daemon`](../daemon/ARCHITECTURE.md). Design:
> [`docs/proposals/remove-registry-runtime-config-merge.md`](../../docs/proposals/remove-registry-runtime-config-merge.md).

---

## 1. Shape

```
packages/cli/
├── package.json          # @openllmsh/cli · 0.0.0-dev placeholder · BUSL-1.1
├── install.sh            # the CLI-only installer (mirrored to the repo root)
├── setup/                # STATIC client overlays, embedded as text
│   ├── claude/ codex/ grok/ opencode/ raycast/
│   └── hooks/            # statusline.sh, materialized into the run dir
├── manifest.ts           # COMMITTED release pin (repo/tag/per-target sha256)
├── release-types.ts      # CLI_TARGETS (SSOT of buildable targets) + TCliRelease
├── index.ts              # barrel: manifest + release-types only (gateway reads the pin)
├── scripts/
│   ├── compile.ts        # bun --compile --minify --bytecode ×4 targets + gzip sidecars
│   └── generate-sdk.ts   # MONOREPO-ONLY: HttpApi → committed SDK artifacts
└── src/
    ├── main.ts           # compile entry: self-version (`--version`/`-v`/`version`) then lazy dispatch
    ├── cli-version.ts    # compile-time CLI_VERSION only (self-version must not import env)
    ├── cli-dispatch.ts   # full command tree, loaded after self-version short-circuit
    ├── clients/          # the runtime client commands
    │   ├── registry.ts   #   SSOT: which clients, session vs always-on
    │   ├── overlays.ts   #   the embedded setup/** text
    │   ├── merge.ts      #   pure merge primitives (substitute/deepMerge/TOML)
    │   ├── launch.ts     #   pure per-client launch plans
    │   ├── session.ts    #   overlay launch + durable-session selection
    │   ├── session-picker.ts # pure, unit-tested session-choice logic
    │   ├── attach.ts     #   terminal/pipe attach to a durable session host
    │   ├── live.ts       #   live-process registry for direct client launches
    │   ├── raycast.ts    #   the always-on apply/uninstall/status
    │   ├── gateway.ts    #   per-launch local-vs-cloud resolution
    │   └── hooks.ts      #   embedded hook scripts
    ├── session-host.ts   # durable session-host discovery and spawning
    ├── sessions-cmd.ts   # `sessions list|attach|kill` management command
    ├── uninstall-cmd.ts  # teardown (reverses always-on clients first)
    ├── doctor-cmd.ts     # report/scrub pre-runtime-merge leftovers
    ├── commands.ts       # SSOT of the command surface (help + completion derive)
    ├── completion.ts     # bash/zsh/fish completion (daemon-parity)
    ├── setup-cmd.ts      # PATH symlink + completion install
    ├── env.ts            # config resolution (env → shared ~/.openllm/.env → baked origin)
    ├── hook-helpers.ts   # bounded stdin, detached self-exec, nonblocking SQLite locks
    ├── context-hooks/    # compiled index lifecycle and advisory search nudge
    ├── memory-hooks/     # compiled recall + detached extraction, private health/retry state
    ├── self-update.ts    # converge to /api/cli/version (checksum-gated atomic swap)
    ├── sdk/
    │   ├── generated/    # COMMITTED: openapi.json + operations.ts (69 ops)
    │   └── client.ts     # thin fetch wrapper over the operations table
    └── mcp/
        ├── server.ts     # the ONE server: composes every tool group over stdio
        ├── openllm/      # native-API tools — MCP-exposed subset of spec ops
        ├── claude-context/  # code+docs search tools + the ctx hook CLI
        └── supermemory/     # memory/recall/whoAmI tools
```

## 2. Commands

| Command | What |
| --- | --- |
| `openllm <claude\|codex\|grok\|opencode> [...args]` | run that client through OpenLLM — args forwarded VERBATIM, config never written |
| `openllm raycast [uninstall\|status]` | the always-on client: apply in place, or reverse exactly what apply wrote |
| `openllm uninstall [--yes]` | remove the CLI (reverses always-on wiring first) |
| `openllm doctor [--fix]` | report/clean leftovers from the old install model |
| `openllm mcp [--only <group>]` | the unified MCP server over stdio (groups: `openllm`, `openllm-context`, `openllm-memory`; default all — `--only` is debug) |
| `openllm exec ctx <index\|search\|status\|index-docs> …` | manual context commands (`ctx` kept as a hidden compatibility alias) |
| `openllm exec ctx <session-start\|reindex-on-edit\|grep-nudge>` | Context hook events on stdin; `index-worker` is the internal detached command |
| `openllm exec memory <recall\|extract>` | Memory hook events on stdin: foreground recall or detached extraction; `extract-worker` is the internal child command |
| `openllm setup` | PATH symlink + shell completion — run automatically by the curl installer; shown as a copyable follow-up on the dashboard card for sandboxed one-click installs |
| `openllm completion <bash\|zsh\|fish\|install>` | shell completion (derived from `commands.ts`, the single command-surface source) |
| `openllm api --spec` | print the embedded OpenAPI spec |
| `openllm self-update` | converge to the gateway's pinned release |
| `openllm sessions [list\|attach\|kill]` | list, attach to, or kill durable local sessions (`attach` requires an id) |
| `openllm status` | mirror of `openllmd status` — delegates to the managed daemon binary |
| `openllm version` | print this CLI version only (`openllm vX.Y.Z`); `-v`/`--version` are the same. Combined daemon diagnostics stay on `status`/`doctor` |

Config: `OPENLLM_CLOUD_ORIGIN` / `OPENLLM_API_KEY` env (the same contract the
MCP mapping + hooks carry), falling back to the SHARED `~/.openllm/.env` (the
same file the daemon boots from — one pairing covers every tool), falling back
to the compile-time cloud-origin bake.

### Automatic context hooks

Claude and Grok invoke `"$OPENLLM_BIN" exec ctx session-start|reindex-on-edit|grep-nudge`
directly. These hooks are compiled; no jq, Python, Node, or Bun installation is
needed. Git remains required for repository identity. The unrelated
`setup/hooks/statusline.sh` stays embedded and materialized, alongside the
launcher-generated API-key helper.

Index hooks prefer `CLAUDE_PROJECT_DIR`, then the event cwd, then the process
cwd; the search nudge preserves event-cwd-first precedence. Canonical Git roots
must have an origin. Foreground hooks do not resolve credentials: they schedule
a detached self-invocation using the same executable (or the source entry when
running from source), sending only root/trigger over stdin. The worker reuses
`runClaudeContextCli(["index", "--path", root])`, including authentication,
incremental sync, and retry cooldown. `auto-index.log` owns detached output;
the foreground session message reports scheduling, never successful indexing.

`CLAUDE_CONTEXT_AUTO_INDEX`, `CLAUDE_CONTEXT_REINDEX_ON_EDIT`,
`CLAUDE_CONTEXT_REINDEX_INTERVAL` (120 seconds), `CLAUDE_CONTEXT_GREP_NUDGE`, and
`CLAUDE_CONTEXT_STATE_DIR` retain their existing behavior. State defaults to
`~/.claude/plugin-state/claude-context`. Each root's worker holds an embedded
SQLite exclusive lock for the whole sync. The edit timestamp is checked and
updated only under that lock; SessionStart shares the lock but neither consumes
nor obeys the edit throttle. OS locks release on worker death, and distinct
`.lock.sqlite` files never collide with old shell `.lock` directories. Edits
remain silent; failures are fail-open with content-free foreground diagnostics.

Claude snake_case and Grok camelCase search events share the advisory-only
PreToolUse nudge. Atomic session markers suppress duplicate concurrent nudges;
old markers are pruned with the previous seven-day `find -mtime +7` semantics.
No permission decision is emitted. Hook stdin is bounded by the same small
helper used by memory hooks, and neither credentials nor event JSON enter argv.

### Automatic memory hooks

Claude and Grok's runtime overlays attach `UserPromptSubmit` recall and `Stop`
extraction by invoking `"$OPENLLM_BIN" exec memory recall|extract` directly.
The launcher supplies `OPENLLM_BIN`; quoting it preserves paths with spaces or
shell metacharacters. There are no memory `.sh` forwarding files and **no
external Python, Node, or Bun runtime is required**. The implementation is
compiled into this binary and reuses `cliConfig`, `MemoryClient`, and the SDK
HTTP client. The command accepts the hook event on stdin; the detached worker
re-executes the same binary, never an ephemeral run-directory script, and never
puts conversation text or credentials in argv.

The launcher supplies its validated key/cloud origin snapshot and
`OPENLLM_INFERENCE_ORIGIN` from its existing gateway selection. Extraction uses
that inference origin (and the configured `SUPERMEMORY_AUTO_MODEL`, default
`lite`); memory reads/writes always use the cloud. Standalone invocation falls
back to the configured cloud origin. `OPENLLM_DAEMON_ENV_FILE` remains the
canonical configuration override; the memory command accepts the historical
`OPENLLM_ENV_FILE` only when the canonical override is absent.

Private, account/key-and-origin-scoped state under
`~/.claude/plugin-state/supermemory` (or `SUPERMEMORY_AUTO_LOG_DIR`) tracks
successful input separately from failed attempts. Session locks serialize
concurrent Stops; failed extraction or partial writes can retry unchanged input
after a bounded cooldown. Valid empty extraction is a healthy no-op. Logs hold
content-free diagnostics, not transcripts, keys, or raw error bodies. Repeated
failure produces a rate-limited advisory in the foreground recall hook rather
than blocking work or silently failing indefinitely. `SUPERMEMORY_AUTO_SAVE=0`
and `SUPERMEMORY_AUTO_RECALL=0` remain independent opt-outs. No historical
transcript backfill runs automatically.

### Brokered session launches

For a plain interactive local TTY launch, `openllm <client>` starts a detached
durable host through an available `openllmd` binary. This does not require the
daemon service to be running: the filesystem registry and the host's private
control socket are the session manager. If no daemon binary is available, or
the host cannot start or attach, the CLI transparently falls back to the
existing inherited-stdio launch.

**Joining a session already running here.** Before spawning a new durable host,
`openllm <client>` scans the filesystem session registry
(`discoverLiveSessionHosts()` — `~/.openllm/sessions/<id>/meta.json` + a live
pid + `ctl.sock`) for hosts of the SAME `daemonCli` and offers them. The
registry is shared by both origins — a browser-started session is spawned by
the daemon's `spawnSessionHostProc`, a local one by the CLI, and both write
under `OPENLLM_DAEMON_STATE_DIR ?? ~/.openllm` — so a local terminal can join a
session the browser started and vice versa. Joining is a real ATTACH to the
live PTY (the same path as `openllm sessions attach <id>`), never a vendor
`--resume`: the host fans output out to every consumer and reflows a private
screen per consumer size, so a second viewer neither kicks the first nor
disturbs its geometry.

Ordering is directory-first (same cwd, then newest) so the most relevant
session is listed as `1`, but bare Enter always starts a NEW session — attach
only when the user types a listed number (or a unique id prefix). Attaching
adopts the SESSION's cwd rather than the caller's, so auto-attaching on a
reflexive Enter would silently drop the user into another project's tree.
`--new` skips the offer; `--attach [id]` takes it without asking (bare
`--attach` prefers same-cwd, else the first listed row). Passing any client
argument (`openllm claude --resume x`) also skips it — those describe a NEW
invocation that an already-running process can never receive. The prompt is
skipped entirely for any invocation `brokerEligible` already rejects
(non-TTY, `-r`, print mode, and — critically — inside a device session, where
`OPENLLM_DEVICE_SESSION_ID` prevents a session from offering itself). Picker
logic lives in `clients/session-picker.ts` (pure, unit-tested);
`clients/session.ts` owns the terminal read.

## 3. The generated SDK (why the mirror is self-contained)

`scripts/generate-sdk.ts` runs ONLY in the monorepo: it derives the OpenAPI
doc via the exact same path as the served `/api/swagger`
(`buildSanitizedSpec` in `packages/api/handlers/swagger.ts` — shared
sanitize, so the SDK can never drift from the published spec), then emits
COMMITTED artifacts into `src/sdk/generated/`:

- `openapi.json` — the sanitized spec (also served by `openllm api --spec`).
- `operations.ts` — a dependency-free typed table: one row per spec operation
  (method, path, params, body-presence). Deterministically sorted.
- `subscription-providers.ts` — the protocol-owned subscription provider slugs
  used by MCP discovery, generated without adding a runtime workspace dependency.

`src/mcp/openllm/tools.ts` derives one tool def per row and exports two
surfaces: `openllmToolDefsAll` (**every** operation — the browser chat and the
execution map use it) and `openllmToolDefs`, the MCP-listed subset. The MCP
subset (`isMcpExposed`) keeps inference (`/v1/*`) + read-only ops and drops
account/config/vault writes plus the raw `/plugins/*` HTTP mirrors (the curated
`openllm-context` + `openllm-memory` groups already cover those) — trimming ListTools
to cut agent context. Execution still recognizes every operation, so a trimmed
tool is never uncallable. Mutating operations carry explicit consent copy in
their tool descriptions.

**MCP uses the v2 server SDK** (`@modelcontextprotocol/server`):
`McpServer.registerTool` registers only the tier/group-filtered tool set, with
`fromJsonSchema` validating the existing tool contracts. `serveStdio` negotiates
legacy and current protocol connections from the same server factory. Unlisted
tools cannot be called; logs stay on stderr.

**Model discovery is subscription-first in MCP only.** `api_v1Models_list`
lists direct subscription catalog cards first. Compact `provider/model` IDs
classify as subscription only when `provider` is absent; explicit
`provider_type` / provider / alias metadata wins over an ID that merely looks
namespaced. Provider slugs are generated from protocol's
`SubscriptionProviderSlug` into `sdk/generated/subscription-providers.ts`.
Aliases remain configurable fallback chains, not subscription guarantees.
`provider_type` on HTTP cards is `subscription` or `api_key` (not a metered
billing claim) and is omitted on aliases. The catalog expresses configured
availability, not live daemon reachability or quota.

**Media inference may omit `model`.** Image generation/edit, transcription,
speech, and video create use the catalog's media default class and ranks
(subscription hops first, then a compatible API-key tail). The gateway may
advance the chain only after a failed, unaccepted attempt; explicit models
stay explicit. Caller voice/format/size options are preserved; voiceless
pronunciation is not treated as compatible with an arbitrary voice.
Successful responses report the actual hop via `x-openllm-resolved-model`
and `x-openllm-chain` — never infer the served model from the request if
those headers are absent. Browser chat tunnels omitted media and video
create/follow-up to the selected device; CLI MCP tools use the HTTP SDK
(daemon or cloud origin from `OPENLLM_GATEWAY`). Compact inventory keeps
`provider` / `provider_type` when the catalog sends them.

**Transcription is the local-file exception to the generic MCP input shape.**
`api_v1Audio_transcriptions` lists `{ path, model?, language? }` in MCP only;
`openllmToolDefsAll` retains the HTTP `body` for browser chat. The CLI server
routes this one name, inside its group/listed-tool guard, to
`src/mcp/openllm/transcribe-audio.ts`. That module alone imports filesystem and
subprocess APIs; never import it from the browser-shared `tools.ts`.
Relative paths resolve from the MCP server working directory. Regular-file
checks and bounded reads enforce a 25 MiB input ceiling. WAV/MP3/WebM pass
through by signature (provider codec restrictions still apply); Ogg/Opus,
including `.ogg` voice notes, and FLAC require **system ffmpeg on PATH** and
convert to mono 16 kHz signed PCM16 WAV. Other formats must be converted first.
No codec is downloaded or bundled. Conversion is no-shell, forced-demuxer,
pipe-only input, time/diagnostic/output bounded, and uses a private seekable
WAV file so its headers contain final sizes; cleanup runs on all outcomes.
Converted audio is capped at 25 MiB too, and overflow is an error, not truncation.
The adapter constructs the data URL internally, redacts echoed audio, and reuses
`handleOpenllmTool` / `callOperation` for auth and transport. An absent model
stays absent so the gateway can apply the catalog media default chain
(same omit-`model` contract as the other media tools); supplied
model/language pass unchanged. HTTP data-URL/multipart contracts and the daemon's
existing transcription and subscription redirect behavior are unchanged.

Because the artifacts are committed, `packages/cli` has **zero runtime
workspace deps** — the public `cli` mirror builds standalone
(`bun install && bun run compile`). The drift test
(`tests/cli/sdk-drift.test.ts`) regenerates in-memory and fails when the
committed artifacts lag the HttpApi; `@openllm/schema` appears only under
`devDependencies` for the generator.

## 4. Release model (daemon parity)

Everything follows `packages/daemon` exactly — see
[`packages/release/commands/cli.ts`](../release/commands/cli.ts):

- ONE version identity: the manifest tag. `package.json` stays `0.0.0-dev`
  (the sentinel dev guards key on — a source build never self-updates).
- 4 targets (`CLI_TARGETS`), compiled in parallel, gzipped release assets
  `openllm-<target>.gz` on `openllmsh/cli`; the manifest pins the
  sha256 of the DECOMPRESSED binary.
- Change-gated on `CLI_BINARY_SOURCES`: `cli/src`, embedded `cli/setup`, the
  public-mirror `cli/install.sh` (not compiled, but released at the pinned tag),
  `release-types.ts`, `package.json`, and `scripts/compile.ts` (bake flags,
  including `NODE_ENV`). The compiled binary has no workspace-package
  dependency; an unchanged CLI keeps its lagging pin.
- Mirror: `subtreeSplitAndPush` of `packages/cli` (manifest stamped, no
  depRefs rewrites needed) → binary publish attaches to the mirror's tag.
- Merge gate: the `cli-pins-match` job in
  `.github/workflows/release-guard.yml` — identical to `pins-match` except
  an EMPTY pin passes (the CLI starts life unpublished; `/api/cli/binary`
  503s by design until the first release). Parity test:
  `tests/release/cli-binary-sources.test.ts`; pure decision model:
  `cliPinsMatchDecision` in `packages/release/lib/pins-match.ts`.
- Verify: `scripts/verify-pins.ts` (`verifyCli` leg, `--cli-only` escape
  hatch).

## 5. Serving + self-update

- `GET /api/cli/binary/<target>` → 302 to the pinned release asset;
  `<target>.sha256` serves the committed digest
  (`packages/api/handlers/cli-binary.ts`).
- `GET /api/cli/version` → `{ latest_version }` from the committed pin.
- `openllm self-update` compares the baked version, downloads, gunzips,
  verifies the decompressed sha256, atomically swaps itself via
  same-directory rename. Converge policy (rollbacks supported);
  `0.0.0-dev` never self-updates.
