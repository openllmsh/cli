# `packages/cli/daemon` Architecture

> The headless **local daemon** — the daemon half (`openllm daemon`) of the
> single source-free compiled `openllm` binary (coreless: built from
> `@openllmsh/wire` + `@openllmsh/protocol` + `@openllmsh/tunnel`, NOT
> `@openllm/core`). A plain folder of `packages/cli` — its dependencies are
> declared in `packages/cli/package.json` — that runs the **local-provider**
> data plane on the user's machine: oauth subscription hops (vendor-CLI
> credentials + identity — never minting, storing, or forging a subscription
> token) **and** discovered loopback model servers (`local-servers/`). It
> records request metadata to the cloud, and accepts management commands from
> the dashboard over the relay or from owner-authorized local CLI/MCP control.
>
> Compliance rationale lives in
> [`docs/proposals/subscription-oauth-terms-compliance.md`](../../docs/proposals/subscription-oauth-terms-compliance.md).
> Referenced from the root [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

---

## Why this package exists

Subscription-OAuth providers (`claude_code`, `chatgpt`, `kimi_code`, and
`grok`) cannot be served by the hosted gateway without (T1) putting a third
party in the credential path and (T2) forging a CLI identity. The daemon
moves that data plane onto the user's machine and **delegates to the official
vendor CLI** for each provider, clearing both triggers. It also owns the
`cursor-agent` CLI's login, status, usage, and model discovery; Cursor
inference uses its ACP bridge rather than a manual upstream HTTP transport.
Muse (`muse`) is also bridge-only: official CLI login/logout own the local
credential store, and the pinned official `@muse-code/sdk` controls `muse serve`
through MSP. Subscription credentials are never exported for direct Meta API
calls. Muse session token usage is not subscription allowance, and its gateway
distribution authorization remains a separate launch requirement; see the
[Muse implementation plan](../../docs/plan/2026-09-23-muse-subscription-native-runtime.md).

Cursor chat completion follows the ACP `session/prompt` terminal response, or
an intentional caller-MCP tool handoff. Prompt/transport failures and retained
60s idle / 180s turn deadlines error the stream after partial output; they never
manufacture successful `stop`. Cancellation waits for the outstanding prompt's
response before disposal, with a 1-second teardown guard for an unresponsive
child (not a generation cutoff). Explicit model-set rejection declines before
submission; a matching `session/new.models.currentModelId` skips the redundant
set, with exact matching for explicitly bracketed variants. Native stderr and
raw RPC error bodies are not exposed in diagnostics. Closed phase offsets and
RPC counts distinguish setup and MCP discovery from native completion. Cold
sessions per caller-tool round remain intentional. When the canonical request
ends in tool results, `cursorRequestOf` appends continuation framing so replayed
history is not mistaken for a fresh request to repeat completed calls; it keeps
additional tools available and leaves a subsequent user turn unchanged. Connected
`cursor/grok-4.6` probes reproduced that repetition and validated the candidate
prompt wording, including a needed-next-tool control. Full local-binary live
latency and multi-round acceptance remain unverified. The separate image lifecycle
has not been brought to chat parity. See the
[Cursor follow-up](../../docs/todo/cursor-native-runtime-muse-parity.md).

Muse selects the host's `onRequest` approval mode and verifies it alongside
its exact model before submission. Controlled native 1.4.0 probes found that
`denyUnmatched` delayed authoritative turn completion by roughly a minute;
`onRequest` completed the same simple requests in seconds. The runtime still
waits for SDK `turn.completed`, drains its item/delta streams, and then closes
the proxy stream. Output silence is not a terminal signal; client/stream
cancellation, setup-RPC timeouts, and the shared pre-commit first-output
budget remain the bounded failure paths (no absolute post-submit turn cutoff).

**Muse read containment remains a release limitation.** Both tested modes
allowed an absolute read of a synthetic file in the disposable overlay HOME
without an approval callback, including with the daemon OS sandbox active.
`--disable-write` / `--disable-shell` remain enforced, but neither these flags
nor the narrow search approval callback establish workspace-only reads.
No test read real credentials. Enterprise tool-rule documents can validate
offline, but no supported per-process policy loading mechanism was verified;
the daemon does not install machine-wide policies or experimental overrides.

Caller-MCP live acceptance is also unresolved on native 1.4.0: the isolated
settings registration was not contacted in the live probe. A grant-negotiated
`session/start.config.mcpServers` diagnostic was rejected with `session MCP
base configuration is unavailable`; an undocumented process-gate experiment
did not resolve it and is not part of the runtime. Hermetic handoff tests do
not establish live native discovery. Plain-text completion validation must not
be presented as caller-tool or Instagram/Facebook-search acceptance.

API-key (BYOK) providers keep running on the cloud unchanged.

## Dependency boundary (load-bearing)

The daemon links `@openllmsh/wire`, `@openllmsh/protocol`, `@openllmsh/tunnel`,
and `effect` — it is **`@openllm/core`-free** (the §7.5 cut-over is done: the
core-backed `dispatch.ts`/`encode.ts` are deleted and the walker is the
sole data path). `@openllmsh/wire` is the dependency-light package of pure
wire-format transforms extracted from `core` (request/response/streaming
adapters, the per-provider transforms, SSE decode/encode + accumulate);
see
[`coreless-daemon-passthrough.md`](../../docs/proposals/coreless-daemon-passthrough.md).
A static invariant test
(`tests/deployment/daemon-walker-coreless.test.ts`) asserts no daemon
source imports `@openllm/core`. It must NOT link
`@openllm/api`, `@openllm/db`, `@openllm/vault`,
`drizzle`, `@neondatabase/serverless`, `@vercel/functions`, or `next` —
those are cloud-only. The daemon holds **no DEK and decrypts no vault
credential**; its only secret is the user's `sk-llm-...` key (for cloud
control-plane calls). Catalog + routing config are **pulled from the
cloud at runtime** (not compiled in) to keep the closure clean.

## Modules

```
daemon/
  index.ts                  re-exports
  (build, verify, dist and installer scripts live in ../scripts — one binary)
  src/
    main.ts                 runDaemon(args): runCli() dispatch, else migrate a legacy install → refresh bootstrap → Bun.serve(127.0.0.1)
    cli.ts                  `openllm daemon <cmd>` dispatch (also reached as `openllmd <cmd>`) (start/stop/status/restart/skill/plugin/setup/auto-update/uninstall/set-token/completion/help)
    auto-update-pref.ts     auto-update opt-out flag in the shared .env (`OPENLLM_DAEMON_AUTO_UPDATE`, default ON; legacy `~/.openllm/auto-update` file migrated in); gates updater.ts AND the CLI's launch check; reported on DaemonStatus.auto_update
    cli-version-cache.ts    stamp-keyed `--version` cache: durable successes (schema v2), process-local misses, optional `reprobe` (not `force`); v1 persisted nulls dropped on load
    updater.ts              the single-binary updater: converge ~/.openllm/bin/openllm, then restart ONLY if the new file's daemon fingerprint differs, and only once idle
    self-update.ts          shared plumbing: in-flight /v1 tracking + waitUntilIdle, host target, verified fetches, the apply lease
    cli-path.ts             where the daemon finds the `openllm` CLI it spawns (dev override → managed install)
    integrations.ts         shared executor: fetch a gateway install.sh (mode=install|uninstall|state) → verify SHA-256 (fail-closed) → bash. Behind the CLI verbs + the relay's install/uninstall_integration kinds
    device-state.ts         manifest-driven probe: run each integration's `install.sh?mode=state` (`{"installed":bool,…}`) → cached DaemonStatus.integrations (stateful dashboard buttons)
    service.ts              self-managed launch agent / systemd unit (start = self-restore; stop = disable; serviceUninstall = stop + delete registration)
    uninstall.ts            `openllm daemon uninstall` — confirm → stop+unregister → strip completion + owned PATH symlink → delete all state (credentials)
    completion.ts           bash/zsh/fish shell completion (emit + `completion install` / `uninstallCompletion`)
    harden-binary.ts        macOS dequarantine + ad-hoc sign (shared by service + updater)
    sandbox/
      working-set.ts        the daemon's filesystem allow-list — ONE source consumed by every sandbox backend
      landlock.ts           cross-platform applyDaemonSandbox() dispatcher + the Linux Landlock backend (bun:ffi, inherited by children)
      seatbelt.ts           macOS Seatbelt backend — in-process sandbox_init() deny-by-default profile (bun:ffi, inherited by children)
      exec.ts               per-child sandboxing — sandboxSpawnArgs() wrap + the --sandbox-exec shim verb + the boot capability probe
    command-scheduler.ts    bounded admission: per-provider mutation lanes, usage worker cap, cancel/continuation fast path, update apply drain
    listener.ts             /v1/* inference: parse → optional-model media default
                            (metadata-only plan fetch) → verify signed plan →
                            runWalker (the only path)
    walker.ts               coreless §3.3 plan-walker — the daemon's sole data path; @openllm/core-free
    sub-method.ts           per-provider execution-method table (bridge|handrolled) + per-hop selection
                            of the cloud's bootstrap-published ACTIVE_SUB_METHOD preference — a
                            `handrolled` selection never probes/spawns the native bridge
                            (docs/proposals/active-sub-method.md)
    plan-cache.ts           flag-gated signed-plan cache (bootstrap `plan_cache`, cloud default ON,
                            DAEMON_PLAN_CACHE=0 disables): a direct plan-less /v1/* request replays
                            the last cloud-signed tuple for its alias within a short TTL —
                            signature still verified per request
    client-encode.ts        client-wire encoders + the SHARED DELIVERY TAIL both execution methods
                            end in (deliverChunkStream: tee → meter → encode + heartbeat;
                            deliverJsonResponse; sseResponseForClient for pre-metered turns)
    auth-cli.ts             `openllm daemon auth` command adapter; protected local calls, JSON/human output
    local-auth.ts           /local/auth — runtime discovery, local flow handles, existing scheduled handlers
    local-http.ts           shared CLI-only loopback authorization and bounded request parsing
    scheduled-command.ts    shared scheduler admission for relay and local commands
    control-relay.ts        transport-independent command executor
    control-channel.ts      outbound relay WebSocket (partysocket) — hello/status/ack frames, heartbeat, and migrateIfRelayMoved (bootstrap-tick channel re-fetch: reconnect when a deploy moved the relay to a new content-addressed box)
    status.ts               computeStatus() — shared snapshot for relay status_push (cheap local store/metadata; not token refresh)
    usage-cache.ts          per-provider TTL cache over delegate.usage() (rate-limit safe)
    model-report.ts         demand-driven live catalog POST: login/`refresh_models` via listModels; auto/`refresh_models_due` via discoverModels — never idle bootstrap
    local-servers/          loopback model-server discovery + per-port keys + chat/embeddings serve
      presets.ts            re-exports protocol `LOCAL_SERVER_PRESETS` (never fork the port table)
      keys.ts               `OPENLLM_LOCAL_KEY_<PORT>` in `~/.openllm/.env` (0600); status exposes `has_key` only
      discover.ts           probe `http://127.0.0.1:<port>/v1/models` (presets + `OPENLLM_LOCAL_PORTS`); push `local_entries` + `local_servers` on status
      serve.ts              `serveLocalHop` / `serveLocalEmbeddings` — OpenAI-wire passthrough, no delegate/CLI
    events.ts               /events SSE: push status on change (replaces polling)
    cors.ts                 shared CORS + PNA preflight for both surfaces
    cli-paths.ts            isolated-CLI paths + per-provider run env
    cli-install.ts          link the isolated run-view symlink + probe state (the daemon NEVER installs a vendor CLI — installs are user-run, unsandboxed, via the daemon install script; cliInstallState auto-links lazily)
    cloud-client.ts         sk-llm-authed cloud calls (bootstrap + record)
    config.ts               cached bootstrap snapshot (catalog + fallback config); @openllm/core-free
    forward.ts              forward an API-key hop in a mixed chain to the cloud /v1/*
    mux-host.ts             mux2/rtc1 channel negotiation, media1 capability advertisement, relay duplex ownership, and OPEN dispatch
    session-core.ts         transport-neutral PTY state machine: fan-out output, merged input, bounded per-consumer queues, and detached-idle reaping
    session-host.ts         durable session-host registry/status adapter and boot reconciler; never owns a daemon PTY
    session-host-proc/      detached per-session host: owns one durable PTY, scrollback, idle reaping, meta.json, and ctl.sock
    rtc-host.ts             werift RTCPeerConnection answerer: browser or fleet rtc_offer/answer/ice/nack + mux over data channel
    rtc-client.ts           fleet WebRTC offerer: rtc_offer/answer/ice/nack + mux over data channel
    tunnel-client.ts        consuming subscription tunnel: RTC (when open) → relay binary mux only (no JSON splice)
    tunnel-server.ts        serving in-process tunneled request dispatch for mux streams
    audio-walker.ts         transcription/speech; speech persists in the daemon by default, or acknowledges explicit browser-owned persistence over mux so only the browser uploads
    image-walker.ts         locally delegated image generation + cloud media-library upload
    video-walker.ts         locally delegated video operations + cloud media-library upload
    version.ts/env.ts       version metadata and environment-file loader
    delegation/             isolated-CLI delegates per provider
      types.ts              TProviderDelegate contract
      auth-config.ts        per-provider `config.json` sidecar: capture the real CLI
                            exec request's upstream URL (drift-safe) + CLI meta. Feeds
                            the request TARGET — NOT inference identity (the originator's
                            headers do that)
      claude-code.ts chatgpt.ts kimi-code.ts grok.ts cursor.ts
      observation-cache.ts  metadata-keyed determinate idle status for Claude/Cursor
      util.ts index.ts
```

## Integration triggers (skill / plugin / setup install + uninstall)

The daemon can install/uninstall any catalogued **skill**, **plugin**, or
**setup** on its own machine, two ways through ONE executor
(`integrations.ts`, coreless — `fetch` + `Bun.spawn`):

- **CLI:** `openllmd {skill|plugin|setup} <install|uninstall|list> [slug]` —
  foreground one-shot (no server boot), completion-derived from `commands.ts`.
- **Relay:** the dashboard's "Install with the daemon" button sends an
  `install_integration` / `uninstall_integration` command over the live relay
  control channel; `control-relay.ts` dispatches the typed command. There is no
  cloud command mailbox or polling leg.

`runIntegration` requests the gateway's validated non-executable pointer,
validates its full-commit raw GitHub URL, downloads the script directly into a
mode-0600 daemon temp file with redirects disabled, and hashes the exact bytes
against `script_sha256`. Only then does it add `OPENLLM_API_KEY` for install and
launch `bash <file>` with the requested mode/target. Uninstall/state receive no
key. The script performs its independent embedded self-check before side
effects; the daemon never fetches gateway script bytes or `/api/daemon/integrity`.

`device-state.ts` is catalog-driven: it runs each verified script with `-s`,
parses the single JSON line, and compares its `installed_sha256` with the
current pointer's script SHA to compute `diverged`. The result is cached on
`DaemonStatus.integrations`, so the dashboard renders Install vs installed /
Reinstall / Uninstall. Re-probed after each install/uninstall, not every status
refresh. See
[`docs/proposals/daemon-owned-state-stateless-relay.md`](../../docs/proposals/daemon-owned-state-stateless-relay.md).

## Coreless walker (the data path)

`walker.ts` is the thin `@openllm/core`-free executor of the coreless
proposal's §3.3 — the daemon's **sole** data path. Every plan the walker runs
is a cloud-signed `<provider/model,…>` tuple from `GET /api/daemon/plan`
(see [`coreless-daemon-passthrough.md`](../../docs/proposals/coreless-daemon-passthrough.md));
there is no URL-carried plan and no 307 arrival path. Whether a request comes
from a local client or over a relay tunnel (browser, fleet peer, or the origin
handing over a daemon-only hop), `listener.ts` first reuses a valid cached
plan or fetches one from the cloud without sending the request body; a pure
BYOK plan, or a failed explicit-model plan fetch, is forwarded to the cloud.
**Model-less media** (image, image edit, transcription, speech, video create)
does not cache under an empty alias: the listener sends
`GET /api/daemon/plan?media_default=` with surface + sanitized format
constraints only (never prompt, image, audio, or speech text). The cloud's
catalog-ranked resolver returns a **full signed chain** (subscription hops
then compatible API-key tails). After HMAC verifies, the listener
materializes the first hop id into JSON or a re-serialized multipart body
(new boundary; stale Content-Length/Content-Type dropped) for schema decode
only — walkers still iterate remaining hops. A failed or unverifiable
media-default plan returns an error and never forwards the original media
body to origin. Explicit-model plan-fetch failures still passthrough as
before. The plan is verified **before** required-model decode (including
image-edit multipart); unsigned/tampered plans never authorize inference; an
explicit caller model is never rewritten. Requests the daemon passes through or
forwards to origin carry `x-openllm-tunneled`, so the origin never tunnels them
back to a daemon. The listener validates the body and hands the signed
plan to the walker. Media walkers (`image-walker`, `audio-walker`,
`video-walker`) iterate the **full signed plan**. Advance uses protocol
`decideMediaChainAdvance` (429/auth/quota/missing credential before accept,
including API hops). Timeout, network, 5xx after submit, accepted 2xx,
delivered output, and persist-after-success are terminal. Image edits never
forward a paid generation hop. Successful responses set
`x-openllm-resolved-model` / `x-openllm-chain` from protocol header constants.
Bodyless video retrieve/content/cancel (mux GET) carry no model: the
listener `decodeVideoId`s the opaque job and `GET /api/daemon/plan?video_job=`
with `{model, provider}` only (never prompt, aliases, or cooldown rewrite),
verifies HMAC, and requires the plan to contain that exact model id.
Subscription jobs poll the job's own provider; API-key (Google) jobs
pin-forward GET to the cloud — never the first Grok hop. API-key media hops
rewrite JSON/multipart `model` to the current hop before `forwardToCloud`.

The walker makes **zero** routing decisions — the cloud already resolved the
alias + cooldowns — it walks the ordered plan, serving each oauth subscription
hop locally (delegate credential injected, vendor called directly), each
`local_*` / `local_port_*` hop via `serveLocalHop` (plain HTTP to the
discovered loopback server), and forwarding each API-key hop to the cloud
(`forward.ts`, pinned). Every non-abort candidate failure before commitment
walks via the same `@openllmsh/wire/lib/error-class` policy as the cloud;
routing never depends on provider-specific status/message allow-lists. The
walker commits on first output, after which switching models is intentionally
unsafe. On chain exhaustion the final hop's real upstream response is preserved.

### Local model servers (`local-servers/`)

Device-discovered OpenAI-compatible loopback servers — the `local` variant of
the local-provider path. No vault, no DEK, no `TProviderDelegate`.

- **Discovery** (`discover.ts`): on start, every 60 s, and on `local_rescan`,
  probe preset ports (Ollama 11434, LM Studio 1234, llama.cpp/LocalAI 8080,
  vLLM 8000, Jan 1337, text-generation-webui 5000) plus optional
  `OPENLLM_LOCAL_PORTS`. Literal `http://127.0.0.1:<port>/v1/models` only —
  no hostnames, so no DNS. `redirect: "manual"` (any 3xx → unreachable),
  1 MB body cap, 2 s timeout, concurrency 4, single-flight scan. Auth header
  is **omitted** when keyless (blank Bearer breaks several servers). 401/403
  → `needs_key` with no models; with a stored key the port is re-probed with
  `Authorization: Bearer`. Fingerprint preset from headers/models when
  possible; else `local_port_<port>`. Snapshot rides `DaemonStatus.local_servers`
  (`has_key` only) and is pushed as `local_entries` on `POST /api/daemon/models`
  (replace semantics for this device key).
- **Keys** (`keys.ts` + control `set_local_key`): sealed in the browser to the
  daemon's X25519 pubkey (same posture as `submit_login_code`); plaintext
  never crosses the relay. Persisted as `OPENLLM_LOCAL_KEY_<PORT>` in the
  daemon env file; empty sealed clears. Status never carries the secret.
- **Serve** (`serve.ts`): chat completions / messages / responses via shared
  wire transforms; embeddings as a single-shot. Preflight the port, refuse
  redirects, attach the stored key if any, record usage (tokens, cost 0).
  Model gone / port dead → `null` so the walker advances (or
  `local_requires_daemon` when nothing remains).
- **Media refuses local.** `image-walker` / `audio-walker` / `video-walker`
  skip `local_*` hops with `local_surface_unsupported` (chat + embeddings
  only in v1) and continue the chain.

**The manual mini-runner serves four subscription providers + cross-wire**
(§9(a)) — it is built from the `@openllmsh/wire` transforms:

| Provider | Upstream wire | Anthropic-wire client | OpenAI-wire client |
| --- | --- | --- | --- |
| `claude_code` | anthropic | **passthrough** (verbatim) | `toAnthropicRequest` → decode/re-encode |
| `chatgpt` | Codex/Responses | `toChatGptRequest` → decode → Anthropic SSE | `toChatGptRequest` → decode → OpenAI SSE |
| `kimi_code` | openai | canonical re-encode | **passthrough** (verbatim) |
| `grok` | Responses | `toChatGptRequest` → decode → Anthropic SSE | `toChatGptRequest` → decode → OpenAI SSE |

`cursor` is intentionally absent from this manual-wire table: its official
`cursor-agent acp` bridge is the walker's native-runtime transport, with no
manual upstream HTTP transport to describe here. The same bridge supplies model
discovery.

The REQUEST side — body + wire-derived headers for every `(client wire ×
upstream wire)` cell, including the passthrough-vs-transform decision and
the Anthropic adaptive-thinking / `anthropic-beta` handling — is NOT
open-coded here. The walker calls
[`buildUpstreamRequest`](../wire/providers/upstream-request.ts) from
`@openllmsh/wire`, the **single** recipe the cloud runner also calls. This is
load-bearing: the recipe used to be forked between the cloud's runner and
this walker (which can't share `@openllm/core`), and the two drifted —
dropping the client's `anthropic-beta` and skipping
`normaliseAdaptiveThinking` (→ haiku 400). One builder, two thin callers,
pinned together by `tests/transport/upstream-request-parity.test.ts`. See
[`unified-upstream-request-builder.md`](../../docs/proposals/unified-upstream-request-builder.md).

The walker supplies only what's transport-local: the resolved
`providerModelId`, the client's `stream` intent (the daemon PINS both off
the signed plan; the cloud passthrough preserves the body's), and `baseHeaders` —
the **ORIGINATOR's own headers** (denylist passthrough via
`@openllmsh/wire/lib/forwarded-headers` `originatorHeadersFrom`), with the
delegate's CREDENTIAL-INTRINSIC headers (codex `chatgpt-account-id` — the
user's own account; none for claude/kimi) + the refreshed bearer layered on
top. Wire-derived headers (anthropic-version/-beta/content-type) are layered
last by the builder. The daemon forges NO CLI identity — a genuine vendor-CLI
request reaches the vendor with its own headers, and an unsupported one is
rejected upstream (terms compliance, see "Originator passthrough" below). On the RESPONSE
side the walker decodes the upstream SSE/JSON to canonical chunks
(`@openllmsh/wire/lib/streaming/provider-decode` — the `@openllm/core`-free
analogue of `providerEventStream`) and re-encodes to the client wire
(`chunksToMessagesSseBytes` for Anthropic clients, `chunksToSseBytes` for
OpenAI clients). `canWalkPlan` decides up front for the whole plan
(declining only an unknown subscription provider with no upstream), so a
chain is never half-attempted then bailed.

> **Standing rule.** `@openllmsh/wire` owns wire transforms **and their
> composition** (the request recipe + the response decode/encode). The
> cloud runner and this walker are thin callers — neither re-derives the
> recipe. A new provider/wire pairing is added in `upstream-request.ts`
> once, not in two places.

**Tool boundary.** The walker does not execute model-emitted function tools or
create hidden follow-up turns. Search-shaped function calls follow ordinary tool
behavior and are returned to the client. Exact Anthropic native server-tool
descriptors remain available only on the byte-verbatim Anthropic passthrough
path. Codex native hops run with PROVIDER-HOSTED web search enabled always-on
via `thread/start.config` (`codex-web-search.ts` — Codex owns execution and
continuation; a client function tool literally named `web_search` is dropped
from `dynamicTools` so the turn has exactly one search owner). Hosted-search
lifecycle items are not yet re-emitted onto client wires; the grounded answer
streams normally. The Claude native runtime still strips tools on the text path
and claims no search support.

**Cost is computed cloud-side.** For inference records, the daemon reports
metadata only — token counts plus model/provider, outcome, latency, endpoint,
and optional account/cache/cooldown fields — to `POST /api/daemon/requests`;
it never records prompt or completion content. The cloud's
`daemonRecordHandler` recomputes `cost_usd` from the tokens (the single pricing
source of truth — no pricing table is shipped to the box, and `cost_usd` is not
on the daemon→cloud record wire). The row carries the prompt-cache split
(`cached_tokens` / `cache_creation_tokens`, both optional so an older daemon
still records) because `tokens_in` INCLUDES those tokens and the cloud prices
them at the cache rates, not the input rate. Token counts are accurate for
streaming too: the walker tees the canonical-chunk stream and accumulates usage
off one branch while the client reads the other. This does not describe the
separate, explicit media-library feature: `image-walker.ts` and
`video-walker.ts` may upload locally generated image/video bytes to
`/api/daemon/media` so the user can retrieve them from the cloud library.

**Diagnostic reports (`src/doctor-report/`).** Uploads are blocked when
`NODE_ENV === "development"`. Otherwise the permission path requires an API key, a valid unexpired bootstrap
reporting policy, and no explicit local opt-out. The cloud derives that policy
from current accepted cookie consent and the account preference (omitted means
enabled; explicit false stays off), without an environment rollout switch.
Cloud denial suspends reporting in memory; it never rewrites the saved machine
choice. An upload authorization rejection requires a fresh successful eligible
bootstrap before retrying. Refresh revisions reject delayed bootstrap callbacks,
and transition revisions fence stale upload completions. Explicit opt-out
(local disable or cloud `enabled === false`) and recovery from that suspension
purge pending reports and move the cursor to the current tail, so disabled-period
history is not replayed. The first allow after consent — no cursor, or a
same-account/origin generation change (typical pre-policy → policy stamp) —
instead rewinds the cursor by the pending-spool TTL (`DOCTOR_REPORT_PENDING_TTL_MS`,
24h) and schedules a flush so onboarding failures recorded before consent are
backfilled; an account or origin change still discards so one identity cannot
upload another's journal lines. Ordinary same-generation refreshes retain pending retries.
Historical local opt-outs and malformed existing preference files remain disabled.
Delivery uses one active timer: observation debounce (`DOCTOR_REPORT_DEBOUNCE_MS`)
or upload backoff (bounded by `DOCTOR_REPORT_MAX_BACKOFF_MS`), never both.
`scheduleRetry` replaces debounce; `scheduleDoctorFlush` and observation are
no-ops while backoff is armed. Eligible same-scope journal backlog (not only a
pending spool file) is armed on bootstrap, after an in-flight completion, and
after a thrown upload via backoff. Local `reportingStatus` exposes optional
`upload_eligible` / `upload_blocker` (closed literals: missing key, development
environment, inactive/expired policy, local opt-out, cloud suspended/revoked),
in-scope `pending_report_upload`, and process-local last attempt time/outcome —
older daemons omit those fields (unknown, not false). Last attempt is in-memory
and cleared on identity/window discard; status never includes raw HTTP bodies,
exception text, keys, URLs, or paths.
Capture is severity-first, with no diagnostic category/producer/trigger
registry: `logInfo`, `logWarn`, and `logError` are the only application
reporting ingress and submit before the local log-level filter. Debug stays
local and never submits. Safe interpolation-free message tags, a generically
validated log scope (invalid values fall back; there is no scope catalog),
actual binary version, occurrence time, opaque IDs, and bounded factual
measurements form the report. Arbitrary metadata, CLI output, stacks, argv,
paths, login material, credentials, and model content are not report fields.
Unsafe message details fall back to a severity-appropriate notice rather than
removing the observation; an invalid optional measurement removes only that
measurement. There is no parallel `note*` reporting surface. Repeat
cooldowns and CLI version-probe streaks stay as local domain counters.
No additional status, authentication, or provider probes are started.

Browser commands may carry an optional UUIDv7 `replay_session_id`. The existing
`op-context.ts` ALS owns a per-admitted-command lease, closed in `finally`;
logger observations alone read it (ordinary local log metadata does not).
Detached work loses attribution when the lease closes. Shared status/usage/model
workers, bootstrap and auth-event subscribers explicitly run outside that lease;
CLI work and unrelated background diagnostics stay unlinked. Command
`correlation_id` remains separate. Replay attribution is not session ownership
proof and does not guarantee a retained recording.

**Receiver-first rollout:** deploy the optional doctor parser and relay support
before enabling browser emission/new-daemon attribution. Older v3 origins reject
unknown report fields; the daemon-before-app release flow needs separate receiver
and producer releases. Publishing a binary alone does not deploy its receiver.

New events use report schema v3 exclusively. There is no legacy decoder,
normalizer, downgrade, or special old-server retry path. Old-format journal
records and reports are unsupported; cloud and daemon must use matching report
contracts. Bootstrap consent policy remains separately versioned. Existing
spool/TTL limits, suppression counters, retry/acknowledgment semantics, and
consent/account/origin purges still apply.

**Validated live** (`RUN_DAEMON_LIVE=1`, `tests/server/daemon-walker-live
.e2e.test.ts`) against the real authenticated CLIs, through the full
production flow (client → daemon → signed plan fetch → walker → vendor): the core
Claude/Codex/Kimi providers + cross-wire, stream + non-stream, and the
forged-signature → 403 gate. The remaining §8 byte-identical-upstream diff
is a belt-and-braces confidence check, not a ship gate.

**Native runtime path (`src/native-runtime/`).** `claude_code` and `chatgpt`
are served through the OFFICIAL vendor runtime FIRST
(`isNativeRuntimeProvider`), with the MANUAL upstream-HTTP transport (bearer
export + hand-built request + direct `fetch`, still in `UPSTREAM_WIRE`) as the
fallback when the native path declines — see "Native decline → manual
fallback" below. Both paths authenticate + refresh through the CLI via the
delegate. The native bridges:

- `claude_code` → the isolated Claude Code CLI in headless stream-json mode
  (`claude -p --output-format stream-json --include-partial-messages`, under
  `cliEnv("claude_code")`). The runtime owns auth/refresh/identity and the
  upstream request; the daemon never reads the credential store on this
  path. Its `stream_event` lines carry the raw Anthropic SSE events, decoded
  by the SAME `fromAnthropicStreamEvent` the manual wire uses. **Two
  non-obvious requirements** (verified live against the isolated home, both
  load-bearing): (1) NO `--bare` — that flag disables the setting sources
  that carry the Claude subscription credential, so `claude -p --bare`
  reports "Not logged in" even when logged in; `--tools ""` alone gives the
  empty tool set safely. (2) the spawn env INHERITS the full session env
  (macOS keychain access needs it — an `env -i` minimal env breaks the
  credential read) minus the `ANTHROPIC_*` auth-poison keys
  (`cleanNativeSpawnEnv`).
- `chatgpt` → `codex app-server` JSON-RPC over stdio (one child per daemon,
  fresh EPHEMERAL thread per request, `approvalPolicy: "never"` + read-only
  sandbox, under `cliEnv("chatgpt")`). The runtime owns auth.json parsing,
  refresh, endpoint discovery, Codex identity headers, request shape, and
  cache/thread affinity — the manual path's whole private-API surface.
  Usage maps from `thread/tokenUsage/updated` (`total`; cached input stays a
  SUBSET of `tokens_in`).

**Multi-turn via session resume (`session-store.ts`).**
OpenLLM is a STATELESS gateway (the client resends the full history every
request); the native runtimes are STATEFUL agents that only accept the NEW
turn. The session store bridges them: it correlates a conversation to a
provider session by a content-derived prefix hash (`deriveConversation`) and
feeds only the delta. The DELTA is fed to the resumed session
(`claude -p --resume <session_id>` / `thread/resume` + `turn/start`). After
the runtime answers, the store re-keys under
`nextPrefixHash(... assistant)`. State is daemon-resident (in-memory LRU +
TTL, per-key lock). Known limitation: independent identical-prefix
conversations can overwrite each other's vendor-session mapping — see
`docs/plan/bridge-request-capture/session-continuity.md` (deferred; not a
capture blocker).

**Bridge/capture ownership rule.** Capture is a transport wrapper over each
provider's bridge, not a parallel bridge implementation. CLI arguments, SDK
query configuration, RPC request shapes, authentication/spawn configuration,
and common session-resource setup/cleanup must each have one provider-owned
implementation used by both modes. Capture supplies interception, destination
relocation, direct dispatch and response/control handling. Necessary differences
(such as isolated versus shared clients, inert versus paused caller-tool handlers,
and Muse's native hosted-search mode) are explicit policy inputs at the shared
boundary, not copied orchestration. Tests must exercise both consumers of that
boundary so a future bridge change carries through to capture automatically.

The shared owners live alongside each provider, not in a cross-provider framework:
- Claude: `claude-spawn.ts` owns CLI arguments and spawning;
  `claude-tool-sdk-options.ts` owns common SDK query/MCP configuration. Held
  caller-tool callbacks and inert capture callbacks remain explicit policies.
- Codex: `codex-app-server.ts` owns dynamic-tool mapping and thread/turn request
  builders. Shared bridge clients and isolated capture clients use those same
  builders; capture still owns its private `CODEX_HOME` and exit-before-cleanup.
- Cursor: `runCursorNativeCapture` wraps `runCursorNative` itself. Both modes
  receive the same normalized serve inputs; capture adds only transport controls.
- Muse: `openMuseTurnSession` in `muse-runtime.ts` owns turn directories, MCP,
  overlay configuration, host/session creation and partial-failure cleanup for
  both modes. Native approval/turn processing and direct captured-response
  processing remain separate. Capture selects native hosted search through the
  shared overlay, without substituting a caller tool or rewriting vendor bytes.

**Bridge request capture (`bridge-capture` sub-method).** Cloud
`ACTIVE_SUB_METHOD` may select `bridge-capture` (global or
`provider:bridge-capture`). Serve activates only **ready** paths declared in
the capability table — Claude/Codex/Muse/Cursor text + first-turn tools + a
tool-result follow-up have each now passed real authenticated live smoke (see
`docs/plan/bridge-request-capture/live-validation.md` for the current measured
status, validation results, review status, and remaining coverage limits;
selection does not certify every scenario). Muse capture uses overlay `settings.endpoint_transport` +
Responses decode; history under Muse capture is cold text via `museRequestOf`
(not MSP role inject). Cursor multi-turn history is likewise the existing
cold-text rendered transcript (`cursor-request.ts`) — not native structured
continuation — over the HTTP/2 Connect path; Cursor's HTTP/1 duplex/BidiAppend
path has not been live-checked, and a native tool-call execution failure fails
closed rather than retrying or relabeling. A scratch localhost probe used
during the Cursor investigation applied a prohibited TLS bypass and relied
only on local server logs; its "zero egress" claim is retracted and none of
the live results above depend on it — do not read Cursor's Connect-path
results as native compressed-envelope proof beyond what was captured through
the production path. See `sub-method.ts`,
`bridge-request-capture-readiness.ts`, and `docs/plan/bridge-request-capture/`.

**Execution defaults (`execution-registry.ts` / `sub-method.ts`).**
The registry's `defaultSelection` explicitly owns the default, including capture;
`variants` and legacy `methods` are capability lists, not array-index priority.
`resolveHopExecution` resolves the outer transport and the concrete native
selection together, after applying caller policy and provider overrides.

| Provider | Default | Caller-policy fallback |
| --- | --- | --- |
| `claude_code` | `handrolled` for eligible first-party callers | `sdk-facade-capture` for other callers |
| `chatgpt` | `handrolled` | — |
| `cursor` | `acp` | — |
| `muse` | `msp-capture` | — |
| `kimi_code`, `grok` | `handrolled` | — |

An unset preference uses these defaults. Global `ACTIVE_SUB_METHOD=handrolled`
uses handrolled only where supported/permitted; otherwise it uses the provider's
own default. A provider override in either vocabulary beats the global preference;
caller policy beats both. Explicit legacy `bridge`/`bridge-capture` selectors keep
their historical dispatch, and explicit concrete vendor selections remain exact.
The registry's `legacyBridgeVariant` freezes old-daemon projection independently
of the current default. See [configuration examples](../../docs/proposals/active-sub-method.md)
and the exploratory [benchmark](../../routing-variants-bench.md). Handrolled-first
is a policy choice, not a claim that it won the Codex benchmark. Defaults require
an updated daemon binary; older binaries retain their shipped defaults.

**Named execution variants (`execution-registry.ts` / `execution-identity.ts`).**
An admin may configure an EXPLICIT provider-unprefixed integration id
through the SAME `ACTIVE_SUB_METHOD` env (`stream-json`/`app-server`/`acp`/
`msp`/`sdk-facade`, each with an optional `-capture` suffix — `agent-sdk` is
still reserved but unregistered). The cloud decodes both grammars from one env
string (`packages/api/lib/sub-method.ts`) and ships the explicit selection as
versioned bootstrap fields (`execution_selection`/`execution_selections`) only
to a daemon that negotiated `EXECUTION_SELECTION2_CAP`. `walker.ts` samples it
once per request (same per-provider-override-then-global precedence as the
legacy fields) and hands it to `native-runtime/serve.ts`, which resolves it
through `execution-registry.ts`'s `PROVIDER_EXECUTION_REGISTRY` +
`resolveExecutionSelection` for all four native-runtime providers (Claude
direct `stream-json`, Codex `app-server`, Cursor `acp`, Muse `msp`) before
either the tool or text dispatch branch. With no preference, the walker supplies
the provider's concrete default; explicit legacy selectors instead retain the
`shouldActivateBridgeRequestCapture` dispatch. A concrete selection either
dispatches through the SAME base integration (its `capture` flag replaces the
legacy heuristic, still gated by the same dynamic capture-readiness table) or
refuses pre-dispatch with a typed reason — never a silent fallback to another
variant/provider. The one request-shape gate this baseline defines: explicit
Claude `stream-json`(`-capture`) refuses a caller-tool-bearing turn rather
than silently invoking the held Agent SDK (`agent-sdk`) behind the
`stream-json` label — legacy `bridge`/`bridge-capture` is unaffected and keeps
its existing text→CLI / tools→SDK split. `execution-identity.ts` partitions
native session/continuation state by `(provider, variant, capture)` so an
explicit selection and a legacy dispatch for the same provider (or a sibling
Claude variant — `sdk-facade` alongside `stream-json`) can never collide. See
`docs/plan/bridge-variants-and-capture-adapters/09-implementation-plan.md`.

**Claude `sdk-facade`/`sdk-facade-capture` (`claude-sdk-facade.ts` /
`claude-sdk-facade-capture.ts` /`claude-facade-mcp-server.ts`, phase 6,
`docs/plan/bridge-variants-and-capture-adapters/12-hermes-adoption-plan.md`
H1-H4).** Reachable through an explicit `sdk-facade`/`sdk-facade-capture`
selection or Claude's non-first-party default (`sdk-facade-capture`). It is an
independently-selectable Claude integration; explicit `stream-json` and legacy
Agent SDK dispatch remain available. Unlike `stream-json` (single buffered
stdin write, `--resume`-based session persistence) or `agent-sdk` (a held
`query()`), `sdk-facade` drives `claude -p --input-format stream-json
--output-format stream-json` with the ENTIRE canonical history replayed as
framed input lines every turn — `--no-session-persistence`, no vendor session
at all. The `shouldQuery: false` acknowledgment contract is ROLE-SPECIFIC,
matching the reference implementation this facade is adapted from exactly
(`tmp/hermes-claude-sdk-reference/directsdk.py:581-595`): only a non-final
`type:"user"` frame carries `shouldQuery: false` and must receive a zero-turn
`result` acknowledgment before the next frame is sent; a `type:"assistant"`
historical frame is always written unconditionally and is never acknowledged
(Hermes-inspired structured full-history replay); the final frame (always
`type:"user"`) is the turn's one real model call. This makes the variant
STATELESS at the daemon level — no session-store
lease, no new conversation identifier (00-requirements.md req. 5) — the
client's own message history already correlates the turn, exactly like an
ordinary completion call. `claude-facade-history.ts` follows Hermes's structured
history rules, reusing the shared Anthropic content converter and Claude tool
name/history helpers rather than the older text-only capture decomposition.
Adjacent user/tool-result blocks are grouped into one user frame; images and
supported documents retain their native block shapes. Unsigned reasoning and
portable foreign summaries remain visible context, never fabricated thinking
signatures. Native assistant blocks (including signed/redacted thinking) use a
versioned `reasoning_items` carrier whose model and visible text/tool projection
must match before replay; edited projections and encrypted-only foreign state
fail closed. Messages JSON/SSE transports preserve that carrier in a separate
`openllm-cn1:` envelope, and cumulative snapshots supersede earlier ones.
Native projection text is not padded or deduplicated by compaction helpers.
Terminal finish chunks wait for the CLI's validated result, after the carrier
has been emitted. Caller tools are declared (schema only, never executed) via a
dedicated loopback MCP server
(`claude-facade-mcp-server.ts`) — `--max-turns 1` means the model's `tool_use`
ends the turn before the CLI would ever invoke it. `sdk-facade-capture`
attaches interception BEFORE spawning the SAME base runtime and reuses the
existing Claude capture loopback/session/commit machinery
(`claude-capture.ts#startClaudeCaptureLoopback`/`commitFromChunkStream`/
`declinedForNonOkCapturedResponse`, `request-capture.ts`) rather than a
duplicated relay — replay itself makes no network request, so only the final
frame's one real `/v1/messages` POST is ever intercepted. Hermetic protocol
fixture: `tests/transport/native-runtime-fixtures/fake-claude-facade.ts`
(`tests/transport/claude-sdk-facade{,-capture}.test.ts`). REAL-CLI construction
proof (H1, opt-in `RUN_DAEMON_LIVE=1`, no login —
`tests/transport/claude-sdk-facade-real-cli-construction.e2e.test.ts`)
confirms the role-specific contract above against the real installed CLI: a
`type:"user"` `shouldQuery:false` replay frame IS acknowledged with a
zero-turn `result`; a `type:"assistant"` frame written WITHOUT `shouldQuery`
is never acknowledged and never waited on. Proven end to end through the
ACTUAL production functions, never a hand-rolled spawn: `runClaudeSdkFacade
Capture` reaches exactly one real `/v1/messages` POST for a single-turn
request, for a genuinely multi-turn request (system + user + assistant +
user, each turn a unique sentinel) — with the captured body's `messages`
array structurally verified as the ORDERED `[user, assistant, user]` triple,
each turn's sentinel in the right slot and no other turn's bled in — and for
a tool_use/tool_result continuation, with the captured `tool_use` block
carrying the CLI's `mcp__openllm__`-prefixed wire name, original call id and
parsed input, and the `tool_result` block carrying the original id and
content. `runClaudeSdkFacade` — the NORMAL, non-capture path — separately
replays the same multi-turn history against a real local fake SSE upstream
and produces a COMMITTED run with matching output and confirmed history
delivery. **An earlier stage of this facade mis-adapted the reference
protocol** (assigning `shouldQuery: false` to every non-final frame BY
INDEX, including assistant frames, rather than by role) and, on finding the
real CLI never acks an assistant-typed frame, concluded multi-turn history
was unsupported by the vendor CLI and added a pre-spawn refusal for it. That
refusal has been REMOVED: with the corrected, role-specific construction, an
assistant frame is never assigned the flag that would make the replay loop
wait for a nonexistent acknowledgment, so there is no hang to guard against
and no unsupported shape to refuse. All of the above is CONSTRUCTION/SHAPE
proof against a local mock upstream — never proof under genuine
authenticated inference, a different CLI version, or real network
conditions. Subsequent live-authenticated text, caller-tool, tool-result and
three-turn measurements are recorded in [routing-variants-bench.md](../../routing-variants-bench.md),
run `1790691747528`; those measurements, not the isolated construction proof,
inform the new provider default.
Capture turns force cold construction + full-history seed
(`captureAwareTextBuilderPlan` / `historyTurnsFromCanonicalMessages` +
`captureAwareHistoryBuilderPlan`) and never publish a warm resume handle.
Under capture, tool turns route through `serveCapturedToolTurn`
(`runClaudeToolCapture` / `runCodexCapturedToolTurn`) — never the ordinary
held SDK / app-server execution path. Claude multi-turn tool continuation is
**live-proven** via `sdk_session_resume`: the daemon writes an owned synthetic
session JSONL under the isolated `CLAUDE_CONFIG_DIR` (assistant `tool_use` +
caller `tool_result`) and resumes it through the Agent SDK — a direct
`AsyncIterable<SDKUserMessage>` with a forged assistant-role message is
rejected by the real CLI, so this on-disk resume is the only proven path, and
reasoning/thinking-block history remains explicitly refused rather than
invented. Codex multi-turn tool continuation is also **live-proven** via
`thread/inject_items` (real builder/auth/sender; the validation run set an
explicit `codexStructuredInjectProven` override, which is now the production
default following that proof). Neither Claude's nor Codex's continuation
carries a warm-session or cache-ID stability claim, and no number in the live
report is a statistical or speedup claim — every measurement is a single
observation. Accepted/uncertain capture ownership terminates the entire walk
(no second send).

**Execution-selection diagnostics and phase timing (plan phase 8,
09-implementation-plan.md §8.3).** Every concrete selection (configured or default)
`native-runtime/serve.ts`'s `resolveExplicitDispatch` resolves — for all four
migrated providers, one shared call site — logs a `debug`-level "execution
selection resolved" line with the requested token
(`formatActiveExecutionToken`) alongside the effective outcome: `accepted`
with its resolved variant/capture, or `refused` with a typed refusal kind
(`unsupported_execution_variant`/`unsupported_execution_shape`/
`capture_not_supported`/`capture_not_ready`/`handrolled_unreachable`). The
explicit legacy-selector hop has no concrete selection and retains its own
diagnostics; concrete provider defaults use the same resolution diagnostics. Metadata-only: provider/variant/
capture/outcome tags, never the request body, prompt, or credentials. Claude
`sdk-facade`/`sdk-facade-capture` additionally share ONE phase-timing emitter
(`claude-sdk-facade.ts#logSdkFacadePhaseTiming`, called by both the native
runner and `claude-sdk-facade-capture.ts` rather than a second
implementation) that logs elapsed milliseconds and the run's closed
`committed`/`declined` outcome — the same numbers-plus-outcome convention
`muse-runtime.ts`'s existing phase timings already use, common to both base
and capture mode so neither variant's timing signal drifts from the other's.

**Claude tool-passthrough (`claude-tool-session.ts` + `claude-tool-serve.ts`).**
A tool-bearing `claude_code` request (client function tools present) is served
through the `@anthropic-ai/claude-agent-sdk` `query()` in a completion shape,
so a `/v1/*` client that runs its OWN tools can use the subscription. The
client's function tools become in-process SDK MCP tools (`alwaysLoad`, granted
via `canUseTool`); the tool HANDLER PAUSES awaiting the client's result, so the
model's `tool_use` is returned to the client (as OpenAI `tool_calls` /
Anthropic `tool_use`) instead of executed. The live `query()` is held (indexed
by its pending tool-call ids); the client's `tool_result` on the next request
resolves the paused handler and drives the query to its next tool call or final
text. A whole agentic task is ONE held query: the opening user turn starts it,
each tool round-trip continues it. Verified live: `get_weather("Paris")` →
client supplies "21C and sunny" → "The weather in Paris is currently 21°C and
sunny."

**Codex tools (`codex-tool-session.ts`) — NATIVE.** Codex's protocol has a
completion-tool mechanism: `thread/start.dynamicTools` (client function tools,
`inputSchema` = raw JSON) + the server→client `item/tool/call` request (the
app-server asks US to run the tool, we respond with the client's result). The
held-turn orchestrator mirrors the Claude path. A 2026-07-14 live probe (audit
`docs/audit/2026-07-14-codex-upstream-wire-openclaw-comparison.md` §6) settled
the one non-obvious protocol fact: dynamic tools default to Codex **code-mode**
(a `codex-code-mode-host` sidecar the isolated install doesn't ship), so with
code-mode ON `item/tool/call` never reaches the client (once misread as
"0.144.0 doesn't emit it"). Setting `features.code_mode:false` on `thread/start`
routes the call to us and the turn completes. A native decline still falls back
to the MANUAL Codex Responses path (`function_call` for client execution), so a
protocol mismatch degrades to slower, never broken.

Current native scope (`nativeRequestOf`): multi-turn TEXT (system +
user/assistant text) via the CLI resume path; claude_code tool requests take
the SDK tool path. **Native decline → manual fallback.** Anything the native
path declines — images, structured output, chatgpt tools (until Codex
activates), or ANY pre-commit failure — falls through to the MANUAL transport
on the SAME hop (`claude_code` → Anthropic Messages with the OAuth bearer,
`chatgpt` → Codex Responses), so no client workflow is blocked. Auth + refresh
run through the CLI (the delegate's `credentialForUpstream`) on both paths.
Only if the manual transport ALSO fails pre-stream does the walker advance to
the next PLAN hop. Cloud plan signing, model pins, mixed-chain BYOK forwarding,
and metadata-only token reporting are unchanged; the recorder rides the
walker's own `report`. Offline coverage:
`tests/transport/native-runtime.test.ts` (fixture runtimes). See
`docs/audit/2026-07-13-t3code-provider-routing-comparison.md` §5.

## Tunnel transport

Consumer ladder (browser and fleet daemon): **RTC (when open) → relay binary
mux**. The legacy JSON `tunnel_*` / `session_*` splice has been removed — if
neither RTC nor mux is available the hop fails and the walker continues. Mux
peers carry the `mux2` channel-id envelope on every relay binary message
(per-device channels multiplex on one watcher socket). RTC refusals return an
explicit `rtc_nack` (seedgate / overloaded / disabled / not_capable) instead of
silent signaling timeouts. Detail lives in
`@packages/daemon-relay/ARCHITECTURE.md` (relay) and
`@packages/tunnel/ARCHITECTURE.md` (codec / envelope / RTC helpers).

- `mux-host.ts` owns relay duplex/channel state, negotiates `channel_open` /
  `channel_open_ack`, receives mux OPEN frames, and dispatches via
  `serveStream` into `tunnel-server.ts`. Advertises `mux` (wire `mux2`) +
  `rtc1`, and layers `seedgate1` when a device-access pubkey is pinned from
  bootstrap.
- `rtc-host.ts` is the werift RTC answerer for browser or fleet-peer offers:
  same-user `rtc_offer` / `rtc_answer` / `rtc_ice` / `rtc_nack` traverse the
  relay, then the mux runs over the data channel (signaling-only relay;
  payload-cap negotiation; kill-switch / failure-cache fallthrough to mux).
- `rtc-client.ts` is the fleet WebRTC offerer for daemon→daemon tunnels.
  It reuses `rtc-auth`, `rtc-duplex`, and mux; it does not introduce a second
  direct-path or hole-punch transport.
- `tunnel-client.ts` uses the consumer ladder **RTC (when open) → relay binary
  mux** for daemon→daemon fleet hops (mirrors browser `tunnelFetch`).
- `tunnel-server.ts` maps a closed tunnel-surface vocabulary to the daemon's
  in-process `/v1/*` handler and streams the result. Stamps
  `x-openllm-tunneled` **only** when the stream OPEN carries
  `consumer:"daemon"` (fleet hop from another daemon) so the peer walker
  cannot re-tunnel. Browser tunnels omit the stamp so the selected device
  may still `tryFleetTunnel` once (browser→A→B).
- `device-access-verify.ts` verifies vault-signed device grants (node:crypto)
  with ts window + nonce map; browser-only enforcement (daemon fleet hops
  skip grant). Locked-vault consumers fail closed before probing transports.

**Kill-switches.** `OPENLLM_MUX_DISABLE=1` withdraws the mux transport
wholesale — including the terminal sessions that ride it. `OPENLLM_RTC_DISABLE=1`
withdraws only `rtc1`, so the browser never offers, no ICE agent is built, no
UDP leaves the host, and everything still works over relay mux one hop slower.
Reach for the latter on a network where the peer-to-peer path is a liability.

**A remote peer's socket is never fatal.** An ICE agent probes the browser's
candidates over UDP; an unreachable one is answered with ICMP port-unreachable,
which Linux reports as `ECONNREFUSED` on the next receive. `werift` attaches no
`"error"` listener to that socket, so it surfaces as an uncaughtException — and
the daemon used to exit on any of those, turning one dead candidate into a
permanent crash loop (and a remote DoS: anything that makes the daemon send a
datagram to a closed port took it down). `crash-policy.ts` classifies a closed
set of transport errnos as survivable; every other uncaught throw still exits
for the supervisor to restart clean.

### Durable device-session host

A local session is a detached `openllm __session-host` sibling process (this
same binary), not a
child of the daemon. It owns one vendor-cli PTY, scrollback, multi-attach fan-out,
and the 15-second idle-reap poll. Its private registry is
`~/.openllm/sessions/<id>/`: `meta.json` records the host pid and session
metadata; `ctl.sock` carries the existing open/ctrl/reset/exit Unix-WebSocket
attach envelope. An attach adds a consumer, fans output to independent ordered
write tails, and merges input. A lagging consumer is removed without affecting
the PTY or other consumers.

**Sizing: the PTY fits whoever focused last.** The PTY has one size, so with
several viewers attached one of them — the PRIMARY — decides it, and its
viewport IS the canonical size. Primacy moves on exactly two signals: a `focus`
claim and an explicit `resize`. Both are deliberate acts on a specific viewer.

Input deliberately moves nothing. It used to: the input path re-ran an election
on every keystroke, hedged with a shrink rule, a "did these dims come from a
real resize" flag, and a debounce window. With two viewers attached that
alternated the canonical size as the user typed — re-sizing the PTY and
re-serializing the other viewer mid-keystroke. Every guard was an attempt to
tame a signal that should not have been driving size at all.

The primary is on the raw byte-identical fast path (its size already matches the
PTY). Every other viewer keeps a private `@xterm/headless` emulator at its own
size and is repainted from the shared screen — reflowed for the normal buffer,
letterboxed for the alt buffer, which cannot be reflowed by any mux. Those
repaints are full-screen serializes wrapped in synchronized output (DEC 2026),
emitted only when there is genuinely new output, and only once the emulator has
PARSED it (`xterm` writes are asynchronous — serializing earlier paints the
screen as it was before the chunk).

A terminal has no focus events to forward, so the local attach client claims
focus on its first keystroke after a ≥1s lull; that is what lets a terminal
sharing a session with a browser pane take the size back. When the primary
detaches, the most recently focused survivor inherits it.

The host, rather than the daemon, reaps an unattached session after both output
and process-tree CPU have been idle for `OPENLLM_SESSION_IDLE_TIMEOUT_MIN`
(default 60; `0` disables it): SIGTERM then SIGKILL after 10 seconds. Consequently
a daemon shutdown, fatal exit, update, or crash cannot kill a durable local
session. On boot the daemon reconciles the socket-directory registry: valid
`meta.json` + live host pid + present socket is **adopted** (kept, never
signalled); a dead or incomplete directory is removed.

`mux-host.ts` attaches browser mux session streams to the durable host through
`attachSessionHostViaCli`; `session-host.ts` is now only the durable
registry/status adapter and boot reconciler. There is no legacy JSON
`session_*` relay splice. See
[`durable-session-host.md`](../../docs/proposals/durable-session-host.md) and
[`shared-session-viewing.md`](../../docs/proposals/shared-session-viewing.md).

The session PTY spawn remains deliberately outside the per-child sandbox: it
runs the user's real vendor CLI against the user's real `$HOME`; only its
standalone host owns lifecycle and transport fan-out.

## Localhost surfaces and provider auth

`Bun.serve` on `127.0.0.1:<port>` (default 8787; 8788 in dev mode) routes
by path:

- **`/v1/*` — inference.** `listener.ts` validates the request, verifies the
  cloud-signed plan and invokes the coreless walker. Subscription hops run
  locally; API-key hops in mixed chains go to the cloud (`forward.ts`) rather
  than decrypting credentials locally. Inference recording is metadata-only;
  generated media may separately be uploaded to the media library.
- **Public local diagnostics.** `/status` returns the secret-free health
  snapshot (`buildHealth`), not provider auth/usage. `/whoami` returns an opaque
  device ID. Their browser CORS/PNA grant is not authorization for management.
- **CLI-only control.** Local auth and doctor routes require loopback Host,
  reject browser Origin, and authenticate an owner-only per-boot capability.
  These are not cloud-forwarded endpoints or dashboard CORS mutations.

`openllm daemon auth` invokes the running daemon; `openllm auth` is a thin mirror,
with local stdio MCP tools layered on the same command contract. The daemon
registry supplies provider names and available primary/alternate login methods.
Login, code submission, cancellation, logout and explicit refresh reuse
`control-relay.ts` handlers and the same scheduler as relay-originated commands.
No provider login runs independently in a CLI subprocess. Pending auth remains
in the running daemon, and originator-specific prompts stay out of shared status.

Provider status and cached usage reads are observational. Explicit `refresh`
requests new usage with the existing manual/deferral semantics. A command ACK
or pending login is not proof of connection. Flow IDs scope continuation and
cancellation; code input is passed through stdin, never shell arguments.

Dashboard management still travels through the relay WebSocket and retains
its device-grant checks. Local control does not select remote devices or mutate
the browser's “this machine” preference, and it needs no recovery phrase.

## API key — onboarding and the shared configuration

The installer accepts `OPENLLM_API_KEY` and persists it in the shared
`~/.openllm/.env` before starting the service. Without a usable key it can
install the binaries without starting a keyless service; interactive
`openllm start` prompts for the key obtained through web onboarding or Keys.
The CLI and daemon share this configuration rather than maintaining separate
pairings. Do not send API keys to a browser-facing localhost config route.

The key remains the daemon's identity for cloud control-plane requests and
BYOK forwarding. It is distinct from the per-boot local capability used for
owner-authorized CLI management and from vault-derived remote device grants.

**Dev-mode config isolation.** With `OPENLLM_DAEMON_DEV=1` the daemon's
config file is `~/.openllm/.dev.env` (not the shared `.env`), the default
port is `8788`, and the cloud origin defaults to the local Next server —
so a source-run dev daemon coexists with the installed daemon without
clobbering its config. The ONLY dev read of the shared `.env` is a live,
read-only `OPENLLM_API_KEY` fallback when `.dev.env` is keyless (dev
reuses the paired key without forking it); every dev write — key, origin,
minted device id, auto-update pref — lands in `.dev.env`. Local auth follows
the configured daemon port; it does not infer or change browser device selection.

## Isolated CLIs (install + run)

The daemon does **not** use whatever `claude` / `codex` / `kimi` the user
has on their PATH — that would race with and mutate the user's personal
`~/.claude` / `~/.codex` / `~/.kimi-code` state. Instead it installs and
runs its OWN copy of each CLI under `<stateDir>/cli/<provider>/`
(`stateDir` = `~/.openllm`, overridable via `OPENLLM_DAEMON_STATE_DIR`):

```
~/.openllm/cli/<provider>/
  bin/<binary>     # codex/kimi land here; claude at home/.local/bin/claude
  home/            # the CLI's isolated $HOME + config + credentials
```

- **`cli-paths.ts`** — `cliRoot/cliBin/cliHome/cliConfigDir/cliEnv` per
  provider. `cliEnv` is the single source of truth for the isolation
  env: `HOME` pointed at the isolated home for all providers, plus the
  explicit home knobs each vendor CLI honors — `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `KIMI_CODE_HOME`. Every spawn
  (`spawnLogin`/`runCapture`/`cliVersion`) merges `cliEnv(slug)`; every
  store read derives from `cliConfigDir`, so the read location and the run
  location can't drift.
- **`cli-install.ts`** — the daemon NEVER installs a vendor CLI; installs
  are user-run + unsandboxed (the daemon install script background-runs the
  official installer for any missing CLI, or the user runs it by hand).
  `linkIsolatedCli(provider, hostBin)` points the isolated run-view
  (`<state>/cli/<provider>/…`) at the user's host binary via a symlink (no
  copy). `cliInstallState(provider)` → `{ installed, version }` is the single
  chokepoint every delegate reads: SELF-HEALING — if the isolated symlink is
  missing but the host binary exists (`hostCliCandidates`), it links it before
  probing `--version`, so a newly-installed CLI shows up on the next status
  push with no command.
- **`vendor-cli-install.ts`** — a passive reader of installer-owned progress
  under `<state>/vendor-cli-install/<provider>.json`. First-run `install.sh`
  runs the official installers in the background and records each attempt
  independently. The reader verifies process identity for running attempts and
  attaches safe optional `cli_install` metadata **after** provider/auth overlays,
  including when a vendor status probe times out. Success means
  `awaiting_detection`, not readiness; actual `cli_installed: true` clears the
  progress. No installer output, PIDs, or host paths leave the machine. Existing
  status change detection + the 15-second observer relay/persist the metadata;
  no new cloud endpoint, table, diagnostics consent, or sandbox grant is needed.
  `openllm update` still does not start vendor installs, and externally managed
  installs never acquire progress records.
- **`host-sign-in.ts`** — the optional `host_signed_in` hint: is the user
  already signed in to the vendor CLI in their OWN home (`~/.claude.json`
  `oauthAccount` + Linux `~/.claude/.credentials.json`, `~/.codex/auth.json`
  tokens, `~/.kimi-code/credentials/kimi-code*.json`, `~/.grok/auth.json`,
  Linux `~/.config/cursor/auth.json`; the vendors' own env overrides honoured).
  Plain file reads only — never a `security`/keychain call, so it cannot raise
  a SecurityAgent prompt; keychain-only stores (Cursor on macOS, Muse,
  Antigravity) stay unknown and the field is omitted. A file that holds a
  credential is never opened — `stat` only (present and larger than an empty
  store); the one file whose content is read is `~/.claude.json`, scanned (not
  parsed — it can be tens of MB) for the account id, which is not a secret.
  Nothing is copied, logged or sent but the boolean, and the isolation rule above is unchanged (Connect
  still logs in inside the isolated home). Cached per provider for 60s and
  attached after installer metadata, so last-known never persists it.
  Onboarding uses it to lead with providers that are one approval away.

## OS sandbox + typed control vocabulary (hardening)

Two orthogonal hardenings from
[`docs/proposals/daemon-os-sandbox-and-typed-control.md`](../../docs/proposals/daemon-os-sandbox-and-typed-control.md):

- **Closed command vocabulary (the parse boundary).** `DaemonCommand` /
  `DaemonCmdRequest` (`packages/schema/daemon.ts`) are a **discriminated
  union** — one struct per kind, literal-discriminated, every payload field a
  constrained scalar (provider-slug enum, charset-pinned artifact slug,
  boolean, opaque base64 blob). No field can carry a command string, script
  body, args array, URL, or free filesystem path. An unmodelled command fails
  decode at EVERY boundary: the cloud enqueue (`enqueueCommand` in
  `packages/api/lib/daemon-commands.ts`), the relay's watcher `enqueue` frame
  + delivery push (`packages/daemon-relay`), and the daemon's own relay
  socket (`RelayCommandFrame` embeds the union) — before `runCommandInner`
  ever runs. `control-relay.ts` narrows each `case` from the union (no
  hand-cast). The union ⇔ executor lockstep is machine-checked by
  `tests/deployment/daemon-command-vocabulary.test.ts`.
- **Filesystem confinement (the blast-radius bound).** The path isolation
  below is **kernel-enforced on Linux AND macOS**, not just env-redirected —
  and it is **PER-CHILD**, not process-wide
  (`docs/audits/daemon-sandbox-scoping.md`): the daemon process boots
  UNCONFINED (device-session PTYs must run the user's real CLI over their real
  files), and each risky child argv is wrapped by
  `sandboxSpawnArgs()` (`sandbox/exec.ts`) into the
  `openllm --sandbox-exec -- <argv…>` self-re-exec shim, which applies
  `applyDaemonSandbox({ force: true })` to itself before running the child
  (inheritance across `execve` does the rest). Wrapped: delegation capture /
  login / keychain spawns, the `open`/`xdg-open` browser launch, and the
  long-lived native runtimes. NOT wrapped: the session-host PTY spawn (the
  exemption), read-only diagnostics (`ps`, `journalctl`/`tail`), and CLI-verb
  paths. `sandbox/working-set.ts` derives ONE allow-list from
  `env.ts`/`cli-paths.ts`
  (the state dir — which contains the binary, CLI homes, and logs — plus the
  claude-code integration footprint `~/.claude`/`~/.claude.json` read-write;
  system trees read-only; everything else, notably `~/.ssh`/`~/.aws`/the
  user's real CLI homes, implicitly denied). `applyDaemonSandbox()`
  (`sandbox/landlock.ts`) dispatches by platform to one of two in-process,
  unprivileged, self-applied backends — applied in the SHIM process, both
  inherited across `execve` (so `bash` running a SHA-gated
  integration script, `curl`, and the vendor CLIs are confined too):
  - **Linux → Landlock** (`sandbox/landlock.ts`) — a deny-by-default Landlock
    ruleset over the working set (kernel ≥ 5.13, `bun:ffi` → `syscall(2)`).
    Landlock is file-only, so non-file ops are untouched; `/dev` is in the
    working set because every `Bun.spawn` with `stdout:"ignore"` opens
    `/dev/null` (without it `posix_spawn` of `bash`/the vendor CLIs fails
    `EACCES` and connect/integrations silently break).
  - **macOS → Seatbelt** (`sandbox/seatbelt.ts`) — an SBPL profile applied via
    `sandbox_init()` (`bun:ffi` → `libsandbox`), deprecated-but-functional, no
    Developer ID signing (App Sandbox is Phase C). BOTH WRITES and READS are
    deny-by-default whitelists (parity with Landlock): WRITES grant only the
    working set + workflow targets (tamper guard); READS stay open OUTSIDE
    `$HOME` — where the dynamic loader's broad `exec`-time read lives and no
    user secret does (`(allow file-read* (require-not (subpath $HOME)))`) — but
    deny-by-default INSIDE `$HOME`, re-allowing only the daemon footprint, so
    `~/.ssh`, `~/.aws`, `~/Library/Keychains`, browser data, and any
    unenumerated `$HOME` secret are unreadable. (The two vendor credential files
    inside the re-allowed config dirs — `~/.codex/auth.json`,
    `~/.claude/.credentials.json` — are re-denied last, SBPL being
    last-match-wins.) The earlier "a read-whitelist SIGABRTs every child" note
    was a too-narrow system-read set, not a hard limit — validated in-process
    (`sandbox_init` + child inheritance, `tests/sandbox`). Non-file ops stay
    allowed so the OAuth-browser + keychain login flows run.

  The **systemd user unit** (`renderUnitHardening()` in `service.ts`) carries
  NO hardening directives. In a `systemctl --user` unit every seccomp/prctl
  directive implies `NoNewPrivileges=yes`, inherited by device-session PTYs —
  which broke `sudo` there; capability/mount directives fail with
  `218/CAPABILITIES`. FS confinement is Landlock's job, per child.

  Posture rides every status push as `DaemonStatus.sandbox`
  (`enforced`/`off`/`unsupported`/`error` — fail-open with a loud log, never
  silent). Under the per-child model it comes from a boot-time CAPABILITY
  probe (`probeSandboxCapability` in `sandbox/exec.ts` — gates + platform +
  Linux Landlock ABI, restricting nothing): `enforced` means "risky children
  are wrapped", not "this process is confined". Kill switch
  `OPENLLM_DAEMON_NO_SANDBOX=1` (children spawn unwrapped); dev source runs
  opt in via `OPENLLM_DAEMON_SANDBOX=1` (wraps via `bun <entry>
  --sandbox-exec`). CLI verbs run unconfined (service registration/uninstall
  touch paths outside the working set).

## Delegation (the compliance core)

Each `TProviderDelegate` wraps the daemon's isolated CLI: `detect`
(`cliInstallState`), `connect` (trigger the CLI's native login under the
isolated env), and `usage` (read locally with the CLI's own credential).
Inference-capable delegates additionally provide `credentialForUpstream`
(bearer + only the credential-intrinsic headers, e.g. Codex's account id + the
captured upstream URL — the local runner adds the ORIGINATOR's headers and the
wire-derived ones). Cursor has no manual credential-to-upstream path; the
walker serves it through the `cursor-agent acp` native-runtime bridge instead.
Nothing a delegate reads from a CLI store is sent off-box as request recording.

**Usage is read ON DEMAND, never polled (`usage-cache.ts`).** The vendor usage
endpoints (e.g. Claude's `api/oauth/usage`) rate-limit **independently of
inference** — reading them on the status-push cadence 429'd them after ~5 min
("Claude usage is rate-limited right now") on a daemon **nobody was even looking
at**. So `computeStatus()` — which runs on every status push (hello/reconnect,
the ~2.5s flow watcher, post-command) — only **peeks** the cache (`peekUsage`,
never a vendor call); it attaches whatever was last fetched, or nothing.
Explicit reads use the `refresh` command (`control-relay.ts` → `refreshUsage`
in `status.ts`): the manual **"Refresh usage"** button and a **one-shot
providers-page mount** when a connected provider has no snapshot. Real
requests also drive detached usage sampling after successful bursts or quota
exhaustion. A routing read with a revalidation callback can refresh a passed
reset (once per reset: success freshness is bypassed only while the last
good observation predates that deadline; failure retry still applies) or an
exhausted snapshot beyond the freshness TTL, even if its reset is still
ahead: an external tier upgrade may have restored capacity. The current
request keeps its cached routing decision; subsequent demand sees the
refreshed tier and quota. Passive status and `peekUsage` never schedule
these reads, and mere age-out while idle is not a demand signal.

`cachedUsage(slug, () => delegate.usage())` wraps demand reads in TTL,
back-off and shared in-flight work; forced request samples use their existing
sampling bounds. Successful quota reads stamp `as_of_ms` before caching and
persistence so repeated status frames retain the original observation time.
Legacy disk entries use their persisted observation time, never restart time.
The live cache remains provider/account-scoped: a successful tier change
replaces its snapshot, and routing never resurrects a historical tier bucket
as current quota. Failed refreshes preserve last-good figures stamped `stale`,
with sanitized `refresh_failure` metadata so the dashboard can explain why its
figures remain cached. A successful read clears that metadata without ever
re-dating a failed read as a fresh observation.

**Passive status does not refresh tokens or provision vendor config.** File-backed
delegates (`chatgpt`, `kimi_code`, `grok`) derive `status()` from **one** typed
store snapshot (`present` / `absent` / `indeterminate`). They never call
`readToken()` on that path, so a status tick cannot native-refresh, spawn
`codex doctor` / `kimi -p` / `grok models`, fetch `/models`, or write Kimi's
managed `config.toml`. Expired-but-stored credentials stay `connected`; a
read error stays `unknown` (`store_unreadable`) and is not collapsed to
`credential_absent`. `readToken()` remains the demand path for inference and requested
(refresh-capable) `listModels()`. Ordinary `usage()` is a stored-credential read
(`readStoredToken`) — an expired token yields `unavailable` /
`credential_expired` and does not spawn a native refresh. The explicit dashboard
Refresh button sends `refresh { manual: true }`: only this scoped operation
permits usage to call the existing native `readToken()` path and bypasses the
usage-cache TTL without discarding last-good figures. Automatic refresh and old
payloads omit the flag and remain non-renewing. Automatic catalog observation
uses `discoverModels` instead and must not call `readToken()`.

**Claude / Cursor idle observations are reused while store identity is stable
(`delegation/observation-cache.ts`).** Reuse is keyed by path + inode + mtime +
size (and on macOS, keychain replacement identity), not a clock TTL. Determinate
connected/absent answers may be reused; unknown/indeterminate, aborted, and
invalidated results are never cached. A producer started before `invalidate`
must not overwrite a newer generation; reuse also requires the store fingerprint
to match from start to end of the probe. Passive macOS reads go through
`observeKeychainReady` / `observeOnly`: an existing chain may be unlocked, but
status must not create, recreate, rename, or mutate ACL/settings/partition-list.
Active `ensureKeychainReady` on login / `readToken` / refresh still repairs.
mtime is not proof the chain is unlocked, and a locked store is not dumped.
Cold, changed, or unknown stores keep bounded guarded probes. Connect/logout,
successful refresh, and credential mutations invalidate the cache. This is
presence metadata, not vendor-validity proof, and does not replace request-time
`readToken`.

**Live model catalogs are demand-driven (`model-report.ts`).** Healthy cloud
bootstrap and the 5-minute (or unhealthy-retry) tick in `main.ts` MUST NOT call
`maybeReportModels` / `listModels` / `discoverModels` / a vendor catalog fetch.
Boot only `observeLoginModelReports()` once (subscribe to auth events — zero
vendor I/O). The local 30m success / 15m failure throttle applies to demand
callers; it is not a background timer. An idle skip never stamps failure
backoff and never POSTs an empty list.

Two listing authorities (do not collapse them):
- **`listModels()`** — refresh-capable. Explicit `refresh_models` and
  successful login may acquire a live token (`readToken`) and native-refresh
  as they always did.
- **`discoverModels({ cliVersion? })`** — auto only. Returns `success` (non-empty
  models), `skipped` (no usable existing credential / cached CLI identity /
  remaining lifetime for a bounded fetch), or `failed` (an HTTP/list attempt
  actually ran). Never renews auth, never probes CLI version, never mints
  device id / repairs keychain / writes vendor config / captures endpoints.
  Uses an existing unexpired store snapshot, observe-only reads, no-capture
  URL resolution, and the cached `cliVersion` (or last-known identity) passed
  in. Missing metadata → `skipped` so a later successful use can retry;
  real fetch failure → `failed` (backoff). Empty vendor lists are `failed`,
  not a wipe.

Discovery still runs:
- **Unscoped force:** control command `refresh_models` (dashboard “Available
  models”). Awaits `maybeReportModels()` with `listModels`. Not cron, not
  `model-lists-sweep`, not `GET /v1/models`, not a cache-read auto-enqueue.
- **Scoped login:** `auth.login.succeeded` only. One slug; `listModels` for that
  provider; last-known CLI version via `peekLastKnownConnection` — does not join
  an in-flight unknown/pending status probe. Connect /
  `connect_device_code` / `submit_login_code` acks do **not** report.
- **Automatic (use-triggered):** `discoverModels` after real provider use and
  on model-management activation, gated by the existing TTL/single-flight.
  Exact command/capability wiring is owned by the scheduler (`refresh_models_due`
  / `control_caps`); auto must never fall back to `listModels`. Cursor auto
  discovery captures **only** advertised `session/new` models from an **actual
  inference** turn — never a standalone ACP client and never an extra
  same-client `cursor/list_available_models` RPC (even while inference is
  active). A generation ticket is taken at request entry; the trusted store
  fingerprint is recorded after native authenticate and before `session/new`;
  a late result from a switched account is dropped.

Cloud cache: `MODEL_CACHE_TTL_MS` (30m) is freshness for cloud/BYOK writers
(`scheduleModelListRefresh` skips fresh rows). `MODEL_CACHE_MAX_AGE_MS` (24h)
still drops `source=cloud` rows to catalog fallback. `source=daemon` rows stay
servable past 24h as last-known fallback (`liveCacheRowIsServable`). An idle
skip never POSTs an empty list. An older CLI must not overwrite a newer
parseable daemon row even after 24h (`shouldSkipDaemonModelWrite` + upsert
`setWhere`; the old 24h write escape hatch is gone). Per-provider failure
isolation and CLI-version invalidation on demand reports are unchanged.

**Originator passthrough (the compliance core, `auth-config.ts`).** The daemon
is a transparent, credential-injecting reverse proxy: each inference request
carries the **originator's own headers** to the vendor (denylist passthrough —
pass everything except a small stable deny set: auth, host, content-*,
accept-encoding, hop-by-hop, `sec-websocket-*`, cookie, the separately-composed
`anthropic-beta`), and the daemon injects ONLY the subscription bearer + the
credential-intrinsic bits the request can't work without — those vary by
provider's binding model:
- **claude_code** — bearer only (the OAuth `anthropic-beta` is wire-derived).
- **chatgpt** — bearer + `chatgpt-account-id` (the user's own account).
- **kimi_code** — bearer + kimi's `x-msh-*` device identity (`x-msh-device-id`
  the daemon registered during kimi's OWN device-code OAuth, + `x-msh-platform`
  / `x-msh-version` / device-name / model / os-version). Kimi's managed endpoint
  BINDS the token to its kimi-code client identity and 403s without the full set
  (confirmed live), so it's credential-intrinsic here — not a forged identity:
  the daemon genuinely holds a kimi-code device credential. (The DESCRIPTIVE
  bits still come from the live `identityHeaders()`; the originator's UA is
  overridden for this hop because kimi requires its own.)

It forges no CLI identity for claude/codex. So a genuine vendor-CLI request (the
real path: Claude Code → `claude_code`) reaches the vendor byte-for-byte, and a
request in a shape/identity the vendor doesn't support is rejected upstream —
which is the correct, compliant outcome (the daemon doesn't launder it). The
denylist is single-sourced with the cloud's allow-list policy in
[`@openllmsh/wire/lib/forwarded-headers`](../wire/lib/forwarded-headers.ts) (two
policies, one home): the cloud is a multi-tenant BYOK proxy that must CURATE
what reaches first-party providers; the local daemon, in front of the user's own
subscription CLI, passes the originator through.

**The upstream URL is captured, not hardcoded (`auth-config.ts`).** The only
thing the daemon still captures is the inference URL — it drifts on CLI updates
(by Claude CLI 2.1.159 the token host had moved `console.anthropic.com` →
`platform.claude.com`; codex's `/responses` host likewise) and can't be
hardcoded. The daemon runs the CLI once in headless `exec` mode (`claude -p`,
`codex exec`, `kimi -p`) pointed at a loopback recorder, reads the exact PATH it
POSTs to, kills it before anything reaches the vendor (zero token cost), and
stores ONLY that URL + the CLI version — never an identity-header set to replay.
`resolveUpstreamUrl` prefers the captured URL and falls back to the retained
ORIGIN + default path per provider.

**Token refresh is the CLI's own job (`delegation/refresh.ts`), on demand.** The
daemon never refreshes a subscription token itself — no `grant_type=refresh_token`
calls, no extracted or hardcoded token endpoint / client id. When a demand path
(`credentialForUpstream`, requested `listModels`, explicit manual usage refresh,
login) calls `readToken`, it
checks the stored access token's expiry and, when it's within the leeway window,
TRIGGERS the official CLI's OWN native refresh: a bounded spawn whose side
effect is the CLI refreshing + persisting its token to its own store. Passive
`status()` and automatic `usage()` must not take this path — usage reads the
stored token only unless the explicit manual-refresh permit is present.
Shared refresh producers are not cancelled
because a status observer timed out.
claude → a minimal `claude -p` query (the CLI refreshes mid-request); codex →
`codex doctor` (its websocket-reachability check forces the proactive refresh —
no inference); kimi → a minimal `kimi -p` query under a PTY (subscription model).
The refresher (`makeRefresher`) fires in the BACKGROUND while the token is still
valid — no hot-path stall — and only AWAITS the spawn once the token is
hard-expired ("no latency unless the refresh is close"); single-flight per
provider. A hard-expired refresh that the daemon itself killed (`abandoned` /
`timeout`) or otherwise failed is a **local** miss: the walker cools the hop
`upstream_auth_cooldown` with `refresh_abandoned` / `refresh_failed` *before*
returning the stale token, so the request falls through the chain instead of
spending a 401 to discover it. An expired token inside the failure-backoff
window is the same typed stale (counted in `fallbacks`); a still-valid token
in that window stays `"fresh"` and does not re-spawn. Being the SINGLE
refresher means claude's URL capture stays disabled and the old refresh-token
rotation race is gone. (kimi's device-code LOGIN — which the daemon must drive,
the CLI having only an in-TUI `/login` — keeps its public OAuth
`client_id`/host; that is login infra, not refresh.)

The captured URL (+ `cli_version` and a TTL timestamp) persists to a per-provider
`config.json` sidecar (`<cliRoot>/config.json`, plain JSON), version-keyed with a
24h TTL, re-captured on a CLI version bump or after a re-login
(`ensureAuthConfig({ force })`). See
[`delegation-exec-fixtures.md`](../../docs/proposals/delegation-exec-fixtures.md)
(amended).

Login per provider (the CLI opens the user's browser, the user signs in,
and the CLI completes via its own localhost callback then exits;
`spawnLogin` BLOCKS on that, so `connect` re-reads the store and reports
connected/failed directly — the dashboard's Connect button stays in its
"Signing in…" state for the duration):

- **claude_code** — `claude auth login --claudeai` (the real subcommand;
  NOT the REPL `/login`, which errors "isn't available in this
  environment" when spawned). `claude auth status` (JSON `loggedIn` +
  `authMethod`) is the authoritative connection check. Credential storage
  is platform-split (no file override exists on macOS): **macOS → the
  login Keychain**, **Linux/Windows → `<cliConfigDir>/.credentials.json`**.
  Claude resolves the login keychain by HOME path, so on macOS the daemon
  gives the isolated HOME its OWN keychain — `ensureIsolatedKeychain`
  (create + unlock at `<home>/Library/Keychains/login.keychain-db`, empty
  password, auto-lock off) runs before login, or the credential WRITE
  pops the system "Keychain Not Found" dialog. It deliberately does NOT
  touch `security default-keychain`/`list-keychains` (those mutate the
  live securityd session, polluting the user's real keychain); reads name
  the isolated keychain by explicit path (`readIsolatedKeychain`), and
  `set-key-partition-list` after login keeps reads prompt-free. Passive
  `status()` reuses a determinate observation while keychain/file identity
  is unchanged (`observation-cache.ts`); it uses `observeKeychainReady`
  (unlock-only, no create/repair) and does not call `readToken`. A timed-out
  `claude auth status` returns unknown (`probe_timeout`) without a keychain
  dump/find fallback; a parse failure or definite `loggedIn: false` still
  consults the store. See `delegation/util.ts` and `delegation/keychain.ts`.
- **chatgpt** — `codex login`; token at `<CODEX_HOME>/auth.json`. Passive
  `status()` reads that file once and does not run `codex doctor`.
- **kimi_code** — the Kimi CLI has NO spawnable login (sign-in is the
  in-TUI `/login`, which needs a raw-mode TTY), so the daemon drives
  Kimi's OWN device-code OAuth flow directly — the exact flow the CLI runs
  internally (`packages/oauth`): POST `<oauth host>/api/oauth/
  device_authorization` (same public client id) → `open` the
  verification URL (code pre-embedded) → background-poll
  `/api/oauth/token` (grant_type=device_code) → write the region's
  credential slot under `<KIMI_CODE_HOME>/credentials/` in the CLI's exact
  wire shape (+ persist `device_id` and the `region` marker). The region
  (`delegation/kimi-region.ts`) defaults to **global** (`auth.kimi.ai` /
  `api.kimi.ai`), unlike the CLI's own mainland default; `KIMI_CODE_OAUTH_HOST`,
  a `<KIMI_CODE_HOME>/region` marker (`mainland-cn`), or a pre-existing legacy
  mainland credential select mainland-cn (`auth.kimi.com` / `api.kimi.com`). The status watcher then flips the card to
  connected (~5s). `connect` returns immediately with the device code /
  URL; no terminal, no TUI. Passive `status()` reads the credential file
  once and does not refresh or provision `config.toml`.
- **grok** — `grok login` (or `grok login --device-auth` for a headless
  device-code flow). Demand-path `readToken` may spawn a bounded `grok models`
  so the CLI can refresh; passive `status()` only reads `auth.json`. The
  isolated run-view points to the user's `grok` executable.
- **cursor** — `cursor-agent login`; its local credential store is checked for
  status/usage (idle status reuses a determinate observation while store
  identity is unchanged). Manual `listModels` may still spawn ACP and call
  `cursor/list_available_models`. Automatic `discoverModels` only reads models
  advertised on `session/new` of a real inference turn (observation age is
  that capture time); generation is ticketed at request entry, the trusted
  store fingerprint is taken after native authenticate and before
  `session/new`, and a late switched-account result is dropped. Logout /
  connect / refresh invalidate via `clearCursorStatusObservationCache`. The
  walker still uses the ACP bridge for native-runtime inference.

The dashboard's `/providers` subscription tab drives a flow off `/status`'s
per-provider `cli_installed`, optional `cli_install`, and auth observation:
OpenLLM-started install → indeterminate progress → binary detected → **Connect**
(sign in) → connected (usage panel). A failed/interrupted install has recovery
copy; an offline or cached active report is **unconfirmed**, not proof of failure,
and cannot offer a duplicate install command. Older daemons and external installs
retain presence-only behavior without fabricated progress. Onboarding uses the
same presentation. The daemon never installs the CLI itself — it auto-links its
isolated run-view to whatever the user-run installer lands.

> ⚠️ The delegates are **research-derived**. `claude_code` install +
> isolation is validated (binary in the isolated dir; `auth status` reads
> isolated state; user's real `~/.claude` untouched). The macOS
> isolated-keychain mechanism is validated for create→write→read with
> zero pollution of the real keychain, but the live `claude auth login`
> WRITE landing in the isolated keychain (vs the session default) is only
> inferred from the "Keychain Not Found" failure mode — confirm with a
> real browser login. `chatgpt`/`kimi_code` install knobs are confirmed
> from the vendor scripts but the full connect→usage path still wants a
> live pass; each carries `RESEARCH` notes + `⚠️` markers.

## Build + distribution

There is ONE binary. `packages/cli/scripts/compile.ts` → `bun build --compile
--minify --bytecode --target=bun-<os>-<arch>` for darwin-{arm64,x64} +
linux-{x64,arm64} (no Windows), entry `packages/cli/src/main.ts`, which routes
daemon argv here. Compile-time defaults are injected via `--define` GLOBALS
(`__OPENLLM_CLOUD_ORIGIN_DEFAULT__`, `__OPENLLM_DAEMON_VERSION__` — the same
release tag as the CLI — and `__OPENLLM_DAEMON_FINGERPRINT__`) — those are NOT
`process.env.*`, so the runtime env read still wins for cloud origin.
`process.env.NODE_ENV` is the exception: Bun inlines it from the compile host
unless `--define` bakes it. A release/`daemon:dist` version bakes
`"production"`; the `0.0.0-dev` sentinel (`compile:host`, `dev:dist`) bakes
`"development"` so local compiled binaries keep the source `NODE_ENV ===
"development"` gate.

`DAEMON_FINGERPRINT` (`packages/cli/scripts/daemon-fingerprint.ts`) is a
sha-256 over every module `src/main.ts` reaches as the bundler resolves it —
daemon source, the trio, npm modules. It is the daemon's code identity: after
the binary is swapped, `updater.ts` runs `openllm daemon --fingerprint` on the
NEW file and restarts only when it differs. It must never cover
`packages/cli/manifest.ts` (that pin changes every release); the fingerprint
script refuses to build if the daemon imports it.

Distribution is `packages/cli/install.sh` (`curl … | bash`): it reads
`/api/install`, downloads the binary from `/api/cli/binary/<target>`, verifies
it against the published `.sha256` (a checksum sidecar, not a detached
signature), installs it as `~/.openllm/bin/openllm` with `openllmd` as a
symlink to it, writes the shared config file `~/.openllm/.env` (`0600`) with
`OPENLLM_CLOUD_ORIGIN` + `OPENLLM_DAEMON_PORT` + `OPENLLM_API_KEY` (the daemon
mints `OPENLLM_DEVICE_ID` into the same file on first boot; legacy standalone
`api-key` / `device-id` files from older installs are migrated into the env
file and removed), then hands off to `openllm daemon start`. That one file is
what both the installed service (systemd `EnvironmentFile=` / the macOS launch
agent's `OPENLLM_DAEMON_ENV_FILE`) and `bun dev:daemon` boot from.

**Updates and the restart rule.** One file, two triggers (see
`packages/cli/ARCHITECTURE.md` §5): the CLI converges it at launch (throttled,
detached) and `updater.ts` converges it on each bootstrap tick, plus a 30 s
stat watch notices a file someone else swapped. The daemon restarts only when
the new file's daemon fingerprint differs from its own, and only once idle —
no in-flight `/v1` request (`waitUntilIdle`), and the apply lease free (no
login flow); a busy daemon defers and retries on the next check. A CLI-only
release never bounces the daemon.

**Upgrading a pre-merge install.** An old two-binary daemon still self-updates
through `/api/daemon/binary/<target>`, which now serves the single binary. It
renames the new bytes over `bin/openllmd` and restarts into them; the binary
routes an `openllmd`-named run to its daemon half, and the first boot runs
`migrateLegacyInstall` (`src/service.ts`): move the regular `bin/openllmd` file
over `bin/openllm` (the running process keeps its inode), leave `openllmd` as a
symlink, and rewrite a registered launch agent / systemd unit that still execs
bare `openllmd` to exec `openllm daemon`. Idempotent and best-effort; launchd
and systemd read the rewritten file on the next (re)start.

**Anyone can verify a published binary.** `packages/cli/scripts/verify.ts`
(`bun run verify`) downloads each published `openllm-<target>.gz` straight
from the GitHub Release named in `packages/cli/manifest.ts`, decompresses it,
sha256's the decompressed bytes (what runs), and asserts the digest equals the
committed pin — exiting non-zero on any mismatch. It is NOT a
reproducible-build check: `--compile --bytecode` is not byte-deterministic, so
a fresh local build won't hash-match — the trust anchor is the committed
manifest plus the published asset, not two identical builds.

**The binary supervises itself.** Service registration is NOT open-coded in
`install.sh` — it lives in `src/service.ts`, exposed as `openllm daemon
start|stop|status|restart` (`src/cli.ts`; the top-level `openllm start|stop|…`
mirror the same commands), so the installer and a user run the exact same code
path. `start` writes + enables the launch agent (`KeepAlive`+`RunAtLoad`) /
systemd unit (`Restart=always` + boot start + linger) — both exec
`~/.openllm/bin/openllm daemon` — in **full self-restore mode** and (re)starts
it; `stop` stops it AND disables all self-restore (launchd
`bootout`+`disable`, systemd `disable --now`) so it stays down until the next
`start`. A from-source run (`0.0.0-dev`) is refused — only the compiled binary
registers. `openllm daemon uninstall [--yes]` is the full inverse of install
(`src/uninstall.ts`): after a typed-`yes` confirmation (warning it deletes
credentials), it stops + **unregisters** the service (deletes the plist /
unit, not just `stop`'s disable), strips shell completion, removes the owned
`PATH` symlink, and deletes the entire state dir — leaving the machine clean.
It only ever removes a symlink resolving to our own binary and files under the
state dir. `openllm daemon completion <bash|zsh|fish|install>` emits/installs
shell completion for every subcommand. The CLI surface is defined once in
`src/commands.ts` (consumed by both `cli.ts`'s help and `completion.ts`). See
[`daemon-self-managing-cli.md`](../../docs/proposals/daemon-self-managing-cli.md).

**Local install without a release.** `packages/cli/scripts/dist.ts` (`bun run
daemon:dist`) compiles all four targets and emits a self-contained installer
per target — the real `packages/cli/install.sh` embedded verbatim with the
locally-built binary appended, so the produced `openllm-<target>.install.sh`
replicates the exact production install flow offline.
`packages/cli/scripts/dist-install.ts` (`bun run daemon:dist:install --
<target>`, default: this host) runs the emitted installer without copying a
dist path. Credentials use the same OpenLLM-prefixed env as the real install —
`OPENLLM_CLOUD_ORIGIN` + `OPENLLM_API_KEY` — and an existing `~/.openllm/.env`
is reused when present (a re-run re-pairs in place; the minted
`OPENLLM_DEVICE_ID` is kept).

## Layering rules

- Depends on `wire` + `protocol` + `tunnel` + `effect` (with schema used through
  protocol), never `core`; no db/vault/vercel/next.
- Holds no DEK; never decrypts a vault credential.
- Never transmits a subscription token or CLI-store contents off-box;
  request-recording payloads are metadata only. The separate media-library
  feature may upload locally generated image/video bytes for cloud retrieval.
