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
>     gateway API (inference + read-only ops; §MCP) plus the claude-context
>     and supermemory tool groups.
>
> Installed by `install.sh` at the repo root (or by the daemon's installer,
> which installs both binaries), self-updating against the gateway's pinned
> release — the extension-side twin of
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
│   └── hooks/            # session hooks, materialized into the run dir
├── manifest.ts           # COMMITTED release pin (repo/tag/per-target sha256)
├── release-types.ts      # CLI_TARGETS (SSOT of buildable targets) + TCliRelease
├── index.ts              # barrel: manifest + release-types only (gateway reads the pin)
├── scripts/
│   ├── compile.ts        # bun --compile --minify --bytecode ×4 targets + gzip sidecars
│   └── generate-sdk.ts   # MONOREPO-ONLY: HttpApi → committed SDK artifacts
└── src/
    ├── main.ts           # entry: <client> | mcp | exec | api | setup | completion
    │                      #        | uninstall | doctor | self-update | version
    ├── clients/          # the runtime client commands
    │   ├── registry.ts   #   SSOT: which clients, session vs always-on
    │   ├── overlays.ts   #   the embedded setup/** text
    │   ├── merge.ts      #   pure merge primitives (substitute/deepMerge/TOML)
    │   ├── launch.ts     #   pure per-client launch plans
    │   ├── session.ts    #   run dir + exec with full arg passthrough
    │   ├── raycast.ts    #   the always-on apply/uninstall/status
    │   ├── gateway.ts    #   per-launch local-vs-cloud resolution
    │   └── hooks.ts      #   embedded hook scripts
    ├── uninstall-cmd.ts  # teardown (reverses always-on clients first)
    ├── doctor-cmd.ts     # report/scrub pre-runtime-merge leftovers
    ├── commands.ts       # SSOT of the command surface (help + completion derive)
    ├── completion.ts     # bash/zsh/fish completion (daemon-parity)
    ├── setup-cmd.ts      # PATH symlink + completion install
    ├── env.ts            # config resolution (env → shared ~/.openllm/.env → baked origin)
    ├── self-update.ts    # converge to /api/cli/version (checksum-gated atomic swap)
    ├── sdk/
    │   ├── generated/    # COMMITTED: openapi.json + operations.ts (58 ops)
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
| `openllm mcp [--only <group>]` | the unified MCP server over stdio (groups: `openllm`, `claude-context`, `supermemory`; default all — `--only` is debug) |
| `openllm exec ctx <index\|search\|status\|index-docs> …` | claude-context hook verbs — what the `openllm` bundle's hooks shell out to (`ctx` kept as a hidden alias for older bundles) |
| `openllm setup` | PATH symlink + shell completion — run automatically by the curl installer; shown as a copyable follow-up on the dashboard card for sandboxed one-click installs |
| `openllm completion <bash\|zsh\|fish\|install>` | shell completion (derived from `commands.ts`, the single command-surface source) |
| `openllm api --spec` | print the embedded OpenAPI spec |
| `openllm self-update` | converge to the gateway's pinned release |
| `openllm version` | print the baked version |

Config: `OPENLLM_CLOUD_ORIGIN` / `OPENLLM_API_KEY` env (the same contract the
MCP mapping + hooks carry), falling back to the SHARED `~/.openllm/.env` (the
same file the daemon boots from — one pairing covers every tool), falling back
to the compile-time cloud-origin bake.

### Brokered session launches

For a plain interactive local TTY launch, `openllm <client>` uses the reachable
local daemon's broker by default, so the daemon is the canonical session
manager. If the daemon is unavailable, the CLI transparently falls back to the
existing inherited-stdio launch; it never requires the daemon.

**Joining a session already running here.** Before spawning a new durable host,
`openllm <client>` scans the filesystem session registry
(`discoverLiveSessionHosts()` — `~/.openllm/sessions/<id>/meta.json` + a live
pid + `ctl.sock`) for hosts of the SAME `daemonCli` and offers them. The
registry is shared by both origins — a browser-started session is spawned by
the daemon's `spawnSessionHostProc`, a local one by the CLI, and both write
under `OPENLLM_DAEMON_STATE_DIR ?? ~/.openllm` — so a local terminal can join a
session the browser started and vice versa. Joining is a real ATTACH to the
live PTY (the same path as `openllm sessions attach`), never a vendor
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
sanitize, so the SDK can never drift from the published spec), then emits two
COMMITTED artifacts into `src/sdk/generated/`:

- `openapi.json` — the sanitized spec (also served by `openllm api --spec`).
- `operations.ts` — a dependency-free typed table: one row per spec operation
  (method, path, params, body-presence). Deterministically sorted.

`src/mcp/openllm/tools.ts` derives one tool def per row and exports two
surfaces: `openllmToolDefsAll` (**every** operation — the browser chat and the
execution map use it) and `openllmToolDefs`, the MCP-listed subset. The MCP
subset (`isMcpExposed`) keeps inference (`/v1/*`) + read-only ops and drops
account/config/vault writes plus the raw `/plugins/*` HTTP mirrors (the curated
`claude-context` + `supermemory` groups already cover those) — trimming ListTools
to cut agent context. Execution still recognizes every operation, so a trimmed
tool is never uncallable. Mutating operations carry explicit consent copy in
their tool descriptions.

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
- Change-gated on `CLI_BINARY_SOURCES` (`cli/src` + `release-types.ts` +
  `package.json` — the actual import closure, no workspace packages): an
  unchanged CLI keeps its lagging pin.
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
