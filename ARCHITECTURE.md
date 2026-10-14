# `@openllmsh/cli` — the OpenLLM binary

> The single distribution vehicle for the local daemon, every gateway extension
> AND client configuration: ONE compiled, source-free binary
> (`~/.openllm/bin/openllm`, alias `ollm`) that
>
>  0. IS the local daemon — `openllm daemon` (bare: boot the service; with a
>     subcommand: `start|stop|restart|status|logs|auto-update|sessions|uninstall`).
>     Its code lives in [`daemon/`](daemon/ARCHITECTURE.md), a plain folder of
>     this package. An `openllmd`-named invocation (the pre-merge name, kept as
>     a symlink so old service units and scripts keep working) routes there
>     too, as do the daemon's internal re-exec flags (`--sandbox-exec`,
>     `__child-supervisor-pdeathsig`, `__session-host`). One Bun runtime is
>     embedded once instead of twice;
>
>  1. runs each supported client through OpenLLM (`openllm <client>`), applying
>     its embedded `setup/<client>/` overlay at RUN time — session clients never
>     have their config written; the always-on clients are Raycast (an
>     explicit, reversible in-place apply) and the ChatGPT Mac app (a launcher
>     `.app` in `/Applications` — no vendor config is written);
>  2. serves ONE MCP server exposing the MCP-relevant subset of the native
>     gateway API (inference + read-only ops; §MCP), local daemon auth commands,
>     and the openllm-memory tool group.
>
> Installed by [`packages/cli/install.sh`](install.sh) — the only installer —
> which installs the one binary, leaves `openllmd` as a symlink to it, and runs
> `openllm daemon start`. Design:
> [`docs/proposals/remove-registry-runtime-config-merge.md`](../../docs/proposals/remove-registry-runtime-config-merge.md).

---

## 1. Shape

```
packages/cli/
├── package.json          # @openllmsh/cli · 0.0.0-dev placeholder · BUSL-1.1
├── install.sh            # THE installer: one binary + the `openllmd` symlink + service start
├── daemon/               # the daemon half (`openllm daemon`) — see daemon/ARCHITECTURE.md
├── setup/                # STATIC client overlays, embedded as text
│   ├── claude/ codex/ grok/ opencode/ raycast/
│   └── hooks/            # statusline.sh, materialized into the run dir
├── manifest.ts           # COMMITTED release pin (repo/tag/per-target sha256)
├── release-types.ts      # CLI_TARGETS (SSOT of buildable targets) + TCliRelease
├── index.ts              # barrel: manifest + release-types only (gateway reads the pin)
├── scripts/
│   ├── compile.ts        # bun --compile --minify --bytecode ×4 targets + gzip sidecars;
│   │                     #   bakes the version + the daemon code fingerprint
│   ├── daemon-fingerprint.ts # sha-256 over the daemon entry's bundled import closure
│   ├── dist.ts · dist-install.ts · dev-dist-run.ts # self-contained offline installers; sandboxed dev daemon
│   └── generate-sdk.ts   # MONOREPO-ONLY: HttpApi → committed SDK artifacts
└── src/
    ├── main.ts           # compile entry: daemon argv → daemon half; self-version; launch update check; lazy dispatch
    ├── daemon-argv.ts    # which argv belongs to the daemon half (import-free)
    ├── launch-update.ts  # throttled, detached update check at CLI launch
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
    │   ├── always-on.ts  #   always-on command/uninstall dispatch by client id
    │   ├── raycast.ts    #   the always-on apply/uninstall/status
    │   ├── chatgpt.ts    #   ChatGPT Mac app: launcher install, app-server shim, uninstall
    │   ├── mac-launcher.ts # logic-free /Applications launcher .app builder
    │   ├── gateway.ts    #   per-launch local-vs-cloud resolution (fast /status probe on the env file's OPENLLM_DAEMON_PORT, else OPENLLM_CLOUD_ORIGIN; .dev.env in dev; no -r flag)
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
    ├── self-update.ts    # converge to /api/cli/version (checksum-gated atomic swap); quiet mode for launch
    ├── sdk/
    │   ├── generated/    # COMMITTED: openapi.json + operations.ts (69 ops)
    │   └── client.ts     # thin fetch wrapper over the operations table
    └── mcp/
        ├── server.ts     # the ONE server: composes every tool group over stdio
        ├── openllm/      # native-API tools — MCP-exposed subset of spec ops
        └── memory/          # memory/recall/whoAmI tools
```

## 2. Commands

| Command | What |
| --- | --- |
| `openllm <claude\|codex\|grok\|opencode> [...args]` | run that client through OpenLLM — args forwarded VERBATIM, config never written |
| `openllm raycast [uninstall\|status]` | the always-on client: apply in place, or reverse exactly what apply wrote |
| `openllm chatgpt [uninstall\|status]` | install `/Applications/OpenLLM ChatGPT.app`, whose only logic is `exec openllm chatgpt launch`. `launch` (hidden) rewrites `~/.openllm/clients/chatgpt/codex-shim` — the app's embedded `codex` plus the Codex overlay as `-c` overrides (`codexOverrideArgs`, shared with session `codex`) — then reopens ChatGPT with `CODEX_CLI_PATH` at the shim. Real `~/.codex` (chats, auth) is never written. Design: `docs/audit/2026-08-23-cowork-codex-mac-app-setups.md` §9 |
| `openllm uninstall [--yes]` | remove the CLI (reverses always-on wiring first) |
| `openllm doctor [--fix]` | report/clean leftovers from the old install model |
| `openllm mcp [--only <group>]` | the unified MCP server over stdio (groups: `openllm`, `openllm-memory`; default all — `--only` is debug) |
| `openllm exec ctx …` / `openllm ctx …` | removed (code search); hidden no-op exiting 0 so hooks written by released clients don't fail |
| `openllm exec memory <recall\|extract>` | Memory hook events on stdin: foreground recall or detached extraction; `extract-worker` is the internal child command |
| `openllm setup` | PATH symlink + shell completion — run automatically by the curl installer; shown as a copyable follow-up on the dashboard card for sandboxed one-click installs |
| `openllm completion <bash\|zsh\|fish\|install>` | shell completion (derived from `commands.ts`, the single command-surface source) |
| `openllm api --spec` | print the embedded OpenAPI spec |
| `openllm self-update` | converge to the gateway's pinned release now (also runs throttled at launch) |
| `openllm daemon …` | the daemon half — boot / `start` / `stop` / `status` / `logs` / … |
| `openllm sessions [list\|attach\|kill]` | list, attach to, or kill durable local sessions (`attach` requires an id) |
| `openllm status` | mirror of `openllm daemon status` — runs the daemon half in a child process |
| `openllm auth <providers\|status\|usage\|refresh\|login\|submit-code\|cancel\|logout> …` | local provider auth, delegated to the running daemon through `openllm daemon auth`; `--json` for agents, runtime provider/method discovery |
| `openllm version` | print this CLI version only (`openllm vX.Y.Z`); `-v`/`--version` are the same. Combined daemon diagnostics stay on `status`/`doctor` |

**Launch setup guard:** session clients, Hermes sticky launch/install, Raycast
apply, and the ChatGPT launcher install share `clients/provider-preflight.ts`. On a cache miss it reads the resolved
gateway's `GET /v1/models` (the daemon forwards this to the cloud), not local auth
status. A valid empty model list stops before launch/config writes and prints
`<configured cloud origin>/providers`; fleet-backed, BYOK, and custom models use
the same account-owned catalog with no second routing policy in the CLI. Positive
results are cached for five minutes under `~/.openllm/cache/provider-routing/`,
keyed by a SHA-256 hash of cloud origin + API key; only a timestamp is stored.
Empty/error results are never cached. HTTP 401/403 stops with an access error;
unknown/network/malformed responses warn and preserve best-effort launch behavior.
This is a setup guard, not a live fleet-health or quota guarantee. Help, auth,
status, uninstall and existing-session management do not run the guard.

Config: `OPENLLM_CLOUD_ORIGIN` / `OPENLLM_API_KEY` env (the same contract the
MCP mapping + hooks carry), falling back to the SHARED `~/.openllm/.env` (the
same file the daemon boots from — one pairing covers every tool), falling back
to the compile-time cloud-origin bake.

### Local provider authentication

`openllm auth` mirrors `openllm daemon auth`; the running daemon, not the short-lived
CLI subprocess, owns login state and provider processes. The same command
contract supplies machine-readable CLI arguments and local MCP tools. Provider
names and supported login methods are discovered from the live daemon rather
than duplicated in MCP. `--method browser|device` selects a supported method
for this invocation; it does not change the dashboard's device designation.

The adapter uses the daemon's owner-only local capability, loopback Host
validation and Origin rejection. Gateway pairing still uses the API key;
neither provider login nor local control asks for the recovery phrase. Status
and cached usage are observational; `refresh` is an explicit action. Pending
login is not connected. Flow inspection/code submission/cancellation preserve
flow identity, and single-use code input travels through stdin, not argv.

Local auth MCP tools register only in the CLI's stdio server (`openllm` group),
not the shared cloud tool definitions consumed by browser chat. They invoke the
same command adapter and never reinterpret local control as a cloud API call.
The public `/llms.txt` guide documents this onboarding path and points agents
to runtime discovery rather than maintaining another provider capability table.

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
that inference origin (and the configured `MEMORY_AUTO_MODEL`, default
`lite`); memory reads/writes always use the cloud. Standalone invocation falls
back to the configured cloud origin. `OPENLLM_DAEMON_ENV_FILE` remains the
canonical configuration override; the memory command accepts the historical
`OPENLLM_ENV_FILE` only when the canonical override is absent.

Private, account/key-and-origin-scoped state under
`~/.claude/plugin-state/memory` (or `MEMORY_AUTO_LOG_DIR`; an existing pre-rename
`plugin-state/supermemory` dir is kept when the new one is absent) tracks
successful input separately from failed attempts. Session locks serialize
concurrent Stops; failed extraction or partial writes can retry unchanged input
after a bounded cooldown. Valid empty extraction is a healthy no-op. Logs hold
content-free diagnostics, not transcripts, keys, or raw error bodies. Repeated
failure produces a rate-limited advisory in the foreground recall hook rather
than blocking work or silently failing indefinitely. `MEMORY_AUTO_SAVE=0`
and `MEMORY_AUTO_RECALL=0` remain independent opt-outs. Every `MEMORY_*`
setting falls back to its pre-rename `SUPERMEMORY_*` name. No historical
transcript backfill runs automatically.

### Brokered session launches

For a plain interactive local TTY launch, `openllm <client>` starts a detached
durable host by re-running this same binary (`__session-host`). This does not require the
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
(non-TTY, `OPENLLM_GATEWAY=cloud`, print mode, and — critically — inside a device session, where
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
- `src/generated/local-auth.ts` — the dependency-free protocol auth command
  contract, copied by the same generator for CLI/MCP parsing and help. Both the
  working-tree drift test and the push-time committed-tree guard cover it.

`src/mcp/openllm/tools.ts` derives one tool def per row and exports two
surfaces: `openllmToolDefsAll` (**every** operation — the browser chat and the
execution map use it) and `openllmToolDefs`, the MCP-listed subset. The MCP
subset (`isMcpExposed`) keeps inference (`/v1/*`) + read-only ops and drops
account/config/vault writes plus the raw `/plugins/*` HTTP mirrors (the curated
`openllm-memory` group already covers those) — trimming ListTools
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

## 4. Release model (one binary)

See [`packages/release/commands/cli.ts`](../release/commands/cli.ts):

- ONE version identity for both halves: the manifest tag. `package.json`
  stays `0.0.0-dev` (the sentinel dev guards key on — a source build never
  self-updates). The compile also bakes `DAEMON_FINGERPRINT`
  (`scripts/daemon-fingerprint.ts`): a sha-256 over every module the daemon
  entry reaches as the bundler resolves it (daemon source, the trio, npm
  modules). It deliberately excludes `manifest.ts` — the fingerprint refuses
  to build if the daemon ever imports the pin, since that would restart the
  daemon on every release.
- 4 targets (`CLI_TARGETS`), compiled in parallel, gzipped release assets
  `openllm-<target>.gz` on `openllmsh/cli`; the manifest pins the
  sha256 of the DECOMPRESSED binary.
- Change-gated on `CLI_BINARY_SOURCES`: `cli/src`, `cli/daemon/src` (+ its
  `execution-registry.ts`), embedded `cli/setup`, `cli/install.sh` (not
  compiled, but `/install` serves it at the pinned tag), `release-types.ts`,
  `package.json`, the bake scripts (`compile.ts`, `daemon-fingerprint.ts`) and
  the trio `packages/{protocol,wire,tunnel}` (minus the floors metadata). An
  unchanged binary keeps its lagging pin. A parity test also checks that every
  workspace file in the bundler's real daemon import closure is covered.
- Mirror: `subtreeSplitAndPush` of `packages/cli` (it carries `daemon/`), the
  manifest stamped, the trio re-pinned to `github:openllmsh/<pkg>#<tag>`, the
  generator-only `@openllm/schema` dropped → binary publish attaches to the
  mirror's tag.
- Merge gate: the `cli-pins-match` job in
  `.github/workflows/release-guard.yml` (an empty pin fails — the binary
  carries the daemon every install runs). Parity test:
  `tests/release/cli-binary-sources.test.ts`; pure decision model:
  `pinsMatchDecision` in `packages/release/lib/pins-match.ts`.
- Verify: `scripts/verify-pins.ts`.

## 5. Serving + updates

- `GET /api/cli/binary/<target>` → 302 to the pinned release asset;
  `<target>.sha256` serves the committed digest
  (`packages/api/handlers/cli-binary.ts`). `GET /api/daemon/binary/<target>`
  serves the SAME artifact — the upgrade bridge for pre-merge daemons, which
  self-update through it into the single binary.
- `GET /api/cli/version` → `{ latest_version }` from the committed pin; the
  daemon bootstrap carries the same tag (`latest_cli_version`, and
  `latest_version` for pre-merge daemons).
- **At CLI launch** (`src/launch-update.ts`): at most once per 6 h, an
  interactive invocation spawns a DETACHED `openllm __self-update` that runs
  the quiet converge (`convergeSelf` in `src/self-update.ts`): version check,
  download, gunzip, verify the decompressed sha256, atomic same-directory
  rename. The user's command never waits. Skipped for dev builds, non-TTY /
  machine commands (`mcp`, `exec`, …), the auto-update opt-out, and
  `OPENLLM_NO_UPDATE_CHECK=1`. `openllm self-update` is the explicit,
  reporting form.
- **In the daemon** (`daemon/src/updater.ts`): the bootstrap tick converges the
  same file (so a machine whose CLI is never run still updates), and a 30 s
  stat watch notices a file someone else swapped. Either way the daemon then
  asks the NEW file for its fingerprint (`openllm daemon --fingerprint`) and
  restarts only when it differs from its own — and only once idle (no
  in-flight `/v1` request, no login/apply holding the lease); a busy daemon
  defers and retries. A CLI-only release never bounces the daemon.
- Converge policy (rollbacks supported); `0.0.0-dev` never self-updates.
