<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="./assets/openllm-light.svg">
    <img alt="OpenLLM" src="./assets/openllm.svg" width="300">
  </picture>
</p>

<p align="center"><b>openllm</b> — the OpenLLM CLI (also <b>ollm</b>).</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue.svg"></a>
  <img alt="source-available" src="https://img.shields.io/badge/source-available-informational.svg">
  <img alt="targets" src="https://img.shields.io/badge/targets-darwin%20%C2%B7%20linux%20(arm64%2Fx64)-lightgrey.svg">
</p>

---

Run your AI clients through OpenLLM with **`openllm <client>`**. The CLI also
manages the local daemon and serves one MCP server with:

- **Inference and read-only gateway tools**, generated from the gateway's OpenAPI
  spec. Account/configuration writes and duplicate raw plugin endpoints are not
  exposed through MCP.
- **Semantic code and documentation search** (`openllm-context`, paid tiers).
- **Persistent cross-session memory** (`openllm-memory`, including the free tier).

The compiled binary is self-contained: the SDK and client overlays ship with it.
The SDK is [generated and committed](./src/sdk/generated), so the public source
mirror builds without private runtime workspace packages.

## Install

For most users, install **the full product: daemon + CLI**:

```sh
curl -fsSL https://www.openllm.sh/install | bash
openllm version
openllm status
```

Supported targets are **macOS and Linux, arm64 and x64**. Release binaries do not
require Bun or Node.js to run; the vendor clients have their own requirements.
The installer verifies downloaded binaries against their published SHA-256.

You can install before obtaining an API key. In an interactive terminal, the
installer starts credential setup; if setup could not run, continue with:

```sh
openllm start
```

This guides you to the gateway's sign-in page and accepts your `sk-llm-...` key.
For a non-interactive install, supply `OPENLLM_API_KEY` to the installer process.
Use `OPENLLM_CLOUD_ORIGIN` as well when installing against a different gateway.
Configuration is shared with the daemon in `~/.openllm/.env`.

> If `openllm` is not on PATH after installation, run
> `~/.openllm/bin/openllm setup`, then open a new terminal. Sandboxed dashboard
> installs can skip PATH and shell-completion setup.

### CLI only

If you only need the CLI/MCP tools and do not need a local subscription daemon:

```sh
curl -fsSL https://raw.githubusercontent.com/openllmsh/cli/main/install.sh | bash
openllm version
```

This installs the CLI and runs `openllm setup`; it does **not** install or start
`openllmd`. Configure `OPENLLM_CLOUD_ORIGIN` and `OPENLLM_API_KEY` through your
environment or the shared `~/.openllm/.env` file. Subscription requests still
require a reachable, configured daemon.

## Run a client

```sh
openllm claude
openllm codex
openllm grok
openllm hermes
openllm opencode
openllm raycast
```

The corresponding client must be installed; follow any missing-client guidance.
Arguments after the client name are passed through, for example
`openllm claude --resume`. Session clients use runtime configuration overlays.
Raycast applies persistent configuration; `openllm raycast uninstall` removes it.
Hermes manages a named profile; see `openllm hermes --help` for profile controls.

`openllm -r codex` forces the cloud route for that session. OpenLLM flags go
**before** the client name; flags after it belong to the client.

## Commands

Every command accepts `-h` / `--help`.

| Command | What |
| --- | --- |
| `openllm <client> [...args]` | Run Claude Code, Codex, Grok Build, Hermes, OpenCode, or configure Raycast |
| `openllm start` / `stop` / `restart` / `status` | Manage the local daemon; start/restart guide credential setup when needed |
| `openllm update` | Update the full product using the configured gateway's installer |
| `openllm self-update` | Update **only the CLI binary** to the gateway's pinned release |
| `openllm auto-update <on\|off\|status>` | Control daemon automatic updates |
| `openllm sessions [list\|attach\|kill]` | Manage local daemon sessions |
| `openllm doctor [report\|opt-out\|opt-in\|reporting-status\|--fix]` | Diagnostics, reporting preferences, and leftover install-state cleanup |
| `openllm uninstall [--yes] [--keep-logins\|--remove-logins]` | Remove the full product: daemon + CLI |
| `openllm mcp [--only <group>]` | MCP over stdio: `openllm`, `openllm-context`, `openllm-memory`; tier restrictions still apply |
| `openllm exec ctx <index\|search\|status\|index-docs> …` | Code/docs-search hook commands |
| `openllm exec memory <recall\|extract>` | Automatic memory hooks (event JSON on stdin; extraction runs in a detached worker) |
| `openllm setup` | PATH symlink and shell completion (idempotent) |
| `openllm completion <bash\|zsh\|fish\|install>` | Print or install shell completion |
| `openllm api --spec` | Print the embedded OpenAPI spec |
| `openllm version` | Print this CLI's version |

Config resolution: process environment → shared `~/.openllm/.env` → baked gateway
origin. The key variables are `OPENLLM_CLOUD_ORIGIN` and `OPENLLM_API_KEY`.
`OPENLLM_GATEWAY=local|cloud` controls client routing; otherwise the CLI prefers
local routing when the daemon is available.

### Proactive memory

Claude Code and Grok Build sessions automatically recall relevant memories before
prompts and extract confirmed, durable preferences and decisions after a turn.
Both hooks run inside the compiled OpenLLM CLI; **Python, Node, and Bun do not
need to be installed**. Memory storage uses the cloud gateway, while extraction
uses the session's selected inference gateway and the `lite` alias by default
(`SUPERMEMORY_AUTO_MODEL` overrides it).

Set `SUPERMEMORY_AUTO_SAVE=0` or `SUPERMEMORY_AUTO_RECALL=0` to disable either
behavior. Repeated failures produce a rate-limited warning without blocking your
work. Private, content-free health logs live under
`~/.claude/plugin-state/supermemory/scopes/` (override the parent with
`SUPERMEMORY_AUTO_LOG_DIR`). Failed attempts remain retryable; no historical
conversation backfill runs automatically. New hook code takes effect in a fresh
session after updating the CLI.

### MCP model discovery

The `api_v1Models_list` tool lists direct subscription models first and tells
agents to prefer a suitable subscription model over a metered API alternative.
It preserves exact model IDs, capabilities, and format/limit metadata. Aliases
are configurable fallback chains, not subscription guarantees; configured
availability is not a live reachability or remaining-quota check.

## Build from source

Bun is required **for building**, not for running release binaries. Clone the
public mirror rather than treating a source-package dependency as the installer.
`main` tracks stable releases; to build a prerelease, check out its `v...` tag
(or the rolling `prerelease` branch) before installing dependencies:

```sh
git clone https://github.com/openllmsh/cli
cd cli
bun install
bun run compile:host       # → dist/openllm (this machine's target)
./dist/openllm version     # v0.0.0-dev
bun run compile            # all 4 targets: darwin/linux × arm64/x64 (+ .gz)
```

Source builds carry the `0.0.0-dev` sentinel, rather than a pinned release
version. Run the binary directly or point your MCP client's `openllm` server
entry at its absolute `dist/openllm` path with the `mcp` argument. Release builds
receive their version from the release pipeline.

## Verify

Published binaries are pinned by SHA-256 in [`manifest.ts`](./manifest.ts).
From a source checkout, compare downloaded or installed bytes to those pins:

```sh
bun install
bun run verify                         # every published target
bun run verify -- --host               # this machine's target
bun run verify -- --file ./openllm      # a local binary
bun run verify -- --installed          # the openllm on PATH
```

Exit code is `0` only when every checked binary matches its pinned digest. Use
the source revision carrying the pins for the release you intend to verify.

The binary is **not byte-reproducible**: `bun build --compile --bytecode` embeds
non-deterministic bytecode. Rebuilding from source will not hash-match the
release. These checks establish consistency with the committed release digest;
they do not eliminate the need to trust the release source and publisher.

## License

**Source-available** under the [Business Source License 1.1](./LICENSE)
(© OpenLLM, INC) — converts to MIT on the Change Date. Not OSI open-source.

---

> **Read-only mirror.** Regenerated from the OpenLLM monorepo each release.
> PRs welcome — ingested upstream with your authorship preserved. BUSL
> contributions require the CLA (the bot will prompt you).
