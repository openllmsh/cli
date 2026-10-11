<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="./assets/openllm-light.svg">
    <img alt="OpenLLM" src="./assets/openllm.svg" width="300">
  </picture>
</p>

<p align="center"><b>openllmd</b> — the local OpenLLM daemon.</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue.svg"></a>
  <img alt="source-available" src="https://img.shields.io/badge/source-available-informational.svg">
  <img alt="targets" src="https://img.shields.io/badge/targets-darwin%20%C2%B7%20linux%20(arm64%2Fx64)-lightgrey.svg">
</p>

---

The local service for OpenLLM's **subscription providers**. Requests run on your
machine through the vendors' official clients and their local credentials:

| Provider | Official client |
| --- | --- |
| `claude_code` | Claude Code (`claude`) |
| `chatgpt` | Codex (`codex`) |
| `kimi_code` | Kimi Code (`kimi`) |
| `grok` | Grok Build (`grok`) |
| `cursor` | Cursor Agent (`cursor-agent`) |

Subscription credentials stay on your machine, rather than being stored by the
hosted gateway. The daemon establishes an outbound control connection so the
dashboard can manage the device. API-key (BYOK) providers can run on the hosted
gateway; subscription requests require a reachable daemon with the relevant
provider connected.

The daemon does not import the cloud proxy pipeline. It shares the public
[protocol](https://github.com/openllmsh/protocol),
[wire transforms](https://github.com/openllmsh/wire), and
[tunnel transport](https://github.com/openllmsh/tunnel) packages, using Effect
and provider-specific dependencies locally.

## Install

Use the **shared installer**, which installs both **`openllmd` and the `openllm`
CLI** (also available as `ollm`):

```sh
curl -fsSL https://www.openllm.sh/install | bash
openllm version
openllm status
```

Supported targets are **macOS and Linux, arm64 and x64**. Published binaries are
compiled and SHA-256-verified during installation; Bun is not required to run
them. Vendor clients have their own requirements; follow the installer or
provider-connect guidance for any missing client.

A key is optional when downloading the binaries. In an interactive terminal,
the installer can hand off to `openllm start` to guide sign-in and key entry.
If setup did not run, continue with:

```sh
openllm start
```

For automation, provide `OPENLLM_API_KEY` in the installer's environment—not a
`--key` argument. For example, if the variable is already set in your shell:

```sh
curl -fsSL https://www.openllm.sh/install | OPENLLM_API_KEY="$OPENLLM_API_KEY" bash
```

The installer saves shared configuration in `~/.openllm/.env`. Set
`OPENLLM_CLOUD_ORIGIN` as well to select a different gateway. With a usable key,
the installer starts the daemon; a separate `openllmd start` is not normally
needed after installation. Service management uses launchd or systemd where
supported.

> If the commands are not on PATH, run `~/.openllm/bin/openllm setup` and open a
> new terminal. Both binaries live under `~/.openllm/bin`.

Once the daemon is connected, configure subscription providers from the
OpenLLM dashboard and run a client, for example `openllm claude` or
`openllm codex`.

## Operate and update

Prefer `openllm` for full-product lifecycle and credential setup. `openllmd`
provides daemon-specific controls; every command accepts `-h` / `--help`.

| Command | What |
| --- | --- |
| `openllm start` / `restart` | Start/restart, with credential setup when needed |
| `openllmd start` / `stop` / `restart` | Manage the daemon service |
| `openllmd status` | Show daemon status |
| `openllmd logs` | Read daemon logs |
| `openllmd auto-update <on\|off\|status>` | Control daemon automatic updates (enabled by default) |
| `openllmd sessions` | Inspect/manage local sessions; use `--help` for subcommands |
| `openllmd completion <bash\|zsh\|fish\|install>` | Shell completion |
| `openllmd version` | Print the daemon version |
| `openllm update` | Update the **full product** from the configured gateway |
| `openllm self-update` | Update the CLI binary only—not the daemon |
| `openllm doctor` | Diagnostics; see `--help` for reporting preferences |
| `openllm uninstall` | Remove daemon + CLI |
| `openllmd uninstall` | Remove the daemon and its state, leaving the CLI installed |

Bare `openllmd` runs the foreground daemon process, as used by its service
manager. Do not launch a second foreground instance alongside the installed
service.

## Build from source

The public source mirror pins its shared packages to published GitHub refs;
the monorepo uses workspace dependencies instead. `main` tracks stable releases;
for a prerelease, check out its `v...` tag (or the rolling `prerelease` branch)
before installing dependencies. From the public mirror:

```sh
git clone https://github.com/openllmsh/daemon
cd daemon
bun install
bun run compile:host        # → dist/openllmd (this machine's target)
./dist/openllmd version
bun run compile             # darwin/linux × arm64/x64 (+ .gz sidecars)
```

Bun is required for these build commands. Compiling does not install the service
or register credentials. Run `--help` on the resulting binary before using it;
normal installs should use the verified shared installer above.

## Verify

Published binaries are pinned by SHA-256 in [`manifest.ts`](./manifest.ts).
From a source checkout, compare downloaded or installed bytes to those pins:

```sh
bun install
bun run verify                          # every published target
bun run verify -- --host                # this machine's target
bun run verify -- --file ./openllmd      # a local binary
bun run verify -- --installed           # the openllmd on PATH
```

Exit code is `0` only when every checked binary matches its pinned digest. Use
the source revision carrying the pins for the release you intend to verify.

The binary is **not byte-reproducible**: `bun build --compile --bytecode` embeds
non-deterministic bytecode. A source rebuild will not hash-match the release.
These checks establish consistency with the committed release digest; they do
not eliminate the need to trust the release source and publisher.

## License

**Source-available** under the [Business Source License 1.1](./LICENSE)
(© OpenLLM, INC) — converts to MIT on the Change Date. Not OSI open-source.

---

> **Read-only mirror.** Regenerated from the OpenLLM monorepo each release.
> PRs welcome — ingested upstream with your authorship preserved. BUSL
> contributions require the CLA (the bot will prompt you).
