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

Run your AI clients through OpenLLM with **`openllm <client>`**.

`openllm` is one self-contained binary. It holds:

- **the CLI**: it signs you in, runs your clients and applies their config overlays;
- **the local daemon** (`openllm daemon`): it serves your subscriptions (Claude,
  ChatGPT, Grok, …) and local model servers from this machine;
- **one MCP server** (`openllm mcp`): gateway tools plus OpenLLM Memory.

Release binaries need no Bun or Node.js. The vendor clients have their own
requirements.

## Install

```sh
curl -fsSL https://www.openllm.sh/install | bash
```

Supported targets are **macOS and Linux, arm64 and x64**. The installer checks
each download against its published SHA-256, then:

1. **Asks Full or Minimal** in a terminal (Enter picks Full). A headless run
   picks Full without asking.
2. **Signs you in.** A browser window opens on OpenLLM. If it can't open, the
   link is printed so you can finish on another device. Approve there and the
   CLI receives its API key by itself, with nothing to copy. A key you already
   have is reused. Use `openllm login --api-key` to paste a key instead.
3. **Full only:** installs the vendor CLIs you don't have yet (Claude Code,
   Codex, …) and starts the daemon.

You sign in to your subscriptions later, on the **Providers** page or through
MCP. The installer never asks for them.

| Mode | What you get |
| --- | --- |
| **Full** (default) | CLI + vendor CLIs + the daemon running. This machine serves its own subscriptions. |
| **Minimal** | CLI only. Clients go to the cloud, which reaches your subscriptions on another online device. A missing client CLI is offered for install the first time you run it. |

```sh
# Minimal
curl -fsSL https://www.openllm.sh/install | bash -s -- --minimal

# Headless, with a key (the dashboard's Add a computer command does this)
curl -fsSL https://www.openllm.sh/install | OPENLLM_API_KEY=sk-llm-... bash
```

The mode is saved, so updates and re-runs keep it. To switch a Minimal machine
to Full, run `openllm login --start`.

Useful installer variables: `OPENLLM_CLOUD_ORIGIN` (another gateway),
`OPENLLM_SETUP_MODE=full|minimal`, `OPENLLM_SKIP_VENDOR_CLIS=1`,
`OPENLLM_ONLY_VENDOR_CLIS=claude_code,chatgpt` and `OPENLLM_DAEMON_PORT` (8787
by default). The full list is at the top of [`install.sh`](./install.sh).

Everything is saved in `~/.openllm/.env`, which the CLI and the daemon share.

> If `openllm` is not on PATH afterwards, run `~/.openllm/bin/openllm setup`
> and open a new terminal.

## Run a client

```sh
openllm claude         # Claude Code
openllm codex          # Codex
openllm grok           # Grok Build
openllm hermes         # Hermes TUI
openllm opencode       # OpenCode
openllm raycast        # apply OpenLLM to Raycast (uninstall to remove)
openllm chatgpt        # macOS: the ChatGPT app launcher (uninstall to remove)
```

Arguments after the client name go to the client (`openllm claude --resume`).
OpenLLM's own flags go **before** it: `openllm -d claude` skips every approval
prompt.

Session clients get their OpenLLM config at run time and leave your own client
config untouched. Raycast and the ChatGPT launcher are applied once and stay
until removed.

Where requests go:

- **Full:** to the local daemon when it answers, otherwise to the cloud.
- **Minimal:** always to the cloud.
- `OPENLLM_GATEWAY=local|cloud` overrides both.

The cloud sends subscription models to one of your online devices.

You can also get a reply without opening a client:

```sh
openllm -p "summarise this repo" -m lite --json
```

## Local daemon

When the daemon runs, any OpenAI- or Anthropic-compatible tool can use it at
`http://127.0.0.1:8787`. Send no API key, or any placeholder (`dummy-key`,
`ollama`, …), and the daemon uses the key you signed in with. An `sk-llm-` key
you send yourself is used as-is.

```sh
openllm start | stop | restart | status
openllm sessions [list|attach|kill]
openllm auth providers                 # this machine's provider logins
openllm auth status [provider]
```

## Commands

Every command accepts `-h` / `--help`.

| Command | What |
| --- | --- |
| `openllm <client> [...args]` | Run a client through OpenLLM (see above) |
| `openllm login [--api-key] [--start] [--no-browser] …` | Sign in through the browser and save an API key. `--start` also switches to Full and starts the daemon |
| `openllm start` / `stop` / `restart` / `status` | Manage the local daemon. `start` signs you in first if needed |
| `openllm auth <verb>` | Provider logins on this machine: `providers`, `status`, `usage`, `login`, … |
| `openllm sessions [list\|attach\|kill]` | Local daemon sessions |
| `openllm mcp [--only <group>]` | MCP over stdio. Groups: `openllm`, `openllm-memory` |
| `openllm config --json` | Print the gateway origin, env file and port in use |
| `openllm update` | Update the whole product from your gateway |
| `openllm self-update` | Update only this binary |
| `openllm auto-update <on\|off\|status>` | Turn the daemon's automatic updates on or off |
| `openllm doctor [report\|--fix\|opt-out\|opt-in\|reporting-status]` | Diagnose the daemon and leftover install state, and choose whether to send diagnostics |
| `openllm uninstall [--yes] [--keep-logins\|--remove-logins]` | Remove OpenLLM from this machine |
| `openllm exec memory <recall\|extract>` | The memory hooks (event JSON on stdin) |
| `openllm setup` | Add `openllm` to PATH and install shell completion |
| `openllm completion <bash\|zsh\|fish\|install>` | Print or install shell completion |
| `openllm api --spec` | Print the embedded OpenAPI spec |
| `openllm version` | Print the version |

Settings are read from the process environment first, then
`~/.openllm/.env`, then the gateway built into the binary.

## MCP

`openllm mcp` is one stdio server. It carries:

- **Gateway tools**, generated from the OpenAPI spec: inference and read-only
  account views. Account and configuration writes are not exposed.
- **Provider login tools** for this machine's daemon.
- **Integrations you turned on** in the dashboard **Marketplace**. OpenLLM
  Memory is on by default; others such as context.dev appear once enabled.

`api_v1Models_list` lists your subscription models first and asks agents to
prefer them over metered API models. Aliases (`ultra`, `plus`, `lite`, your own)
are fallback chains, not a promise that a subscription answers. The list does
not check live reachability or remaining quota.

### Memory in sessions

In Claude Code and Grok Build sessions, OpenLLM Memory:

- recalls relevant memories before each prompt;
- saves durable preferences and decisions after a turn.

The hooks run inside the binary, so no Python, Node or Bun is needed. Memories
are stored in the cloud. Extraction runs on the session's gateway with the
`lite` alias by default (`MEMORY_AUTO_MODEL` overrides it).

`MEMORY_AUTO_SAVE=0` or `MEMORY_AUTO_RECALL=0` turns either off. Failures only
produce a rate-limited warning; they never block you. Content-free health logs
are in `~/.claude/plugin-state/memory/scopes/` (`MEMORY_AUTO_LOG_DIR` moves
them). Updated hooks take effect in your next session.

## Build from source

Bun is needed **to build**, not to run release binaries. `main` tracks stable
releases; for a prerelease, check out its `v...` tag first.

```sh
git clone https://github.com/openllmsh/cli
cd cli
bun install
bun run compile:host       # → dist/openllm (this machine's target)
./dist/openllm version     # v0.0.0-dev
bun run compile            # all 4 targets: darwin/linux × arm64/x64 (+ .gz)
```

Source builds report `0.0.0-dev`; release builds get their version from the
release pipeline. To use a source build as your MCP server, point the client's
`openllm` entry at `dist/openllm` with the `mcp` argument.

## Verify

Published binaries are pinned by SHA-256 in [`manifest.ts`](./manifest.ts).
From a source checkout, compare a binary against those pins:

```sh
bun install
bun run verify                         # every published target
bun run verify -- --host               # this machine's target
bun run verify -- --file ./openllm     # a local binary
bun run verify -- --installed          # the openllm on PATH
```

It exits `0` only when every checked binary matches its pin. Use the source
revision that carries the pins of the release you are checking.

The binary is **not byte-reproducible**: `bun build --compile --bytecode`
embeds non-deterministic bytecode, so a rebuild won't match the release hash.
The check proves a binary is the one that was published. You still have to
trust the release source and the publisher.

## License

**Source-available** under the [Business Source License 1.1](./LICENSE)
(© OpenLLM, INC). It converts to MIT on the Change Date. Not OSI open-source.

---

> **Read-only mirror.** Regenerated from the OpenLLM monorepo each release.
> PRs welcome: they are ingested upstream with your authorship preserved. BUSL
> contributions require the CLA (the bot will prompt you).
