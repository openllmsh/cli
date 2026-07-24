<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="./assets/openllm-light.svg">
    <img alt="OpenLLM" src="./assets/openllm.svg" width="300">
  </picture>
</p>

<p align="center"><b>openllmc</b> — the OpenLLM CLI.</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue.svg"></a>
  <img alt="source-available" src="https://img.shields.io/badge/source-available-informational.svg">
  <img alt="targets" src="https://img.shields.io/badge/targets-darwin%20%C2%B7%20linux%20(arm64%2Fx64)-lightgrey.svg">
</p>

---

One compiled binary that carries **every OpenLLM extension**: a single MCP
server (`openllmc mcp`) exposing the **full native gateway API** (one tool
per OpenAPI operation, generated from the same schema the gateway serves at
`/api/swagger`), **semantic code + docs search** (claude-context), and
**persistent cross-session memory** (supermemory) — plus the hook
subcommands the `openllm` plugin's session hooks shell out to.

Self-contained by construction: the SDK is **generated and committed**
([`src/sdk/generated/`](./src/sdk/generated)) so this package links no
private workspace code — it builds standalone from this repo.

## Install

The canonical distribution is the **compiled binary** (verified against its
published SHA-256). Installing the **openllm plugin** from your gateway's
dashboard installs it for you; standalone:

```sh
curl -fsSL "https://openllm.sh/api/setup/cli/install.sh" | bash
# ↑ also runs `openllmc setup` (PATH symlink + shell completion)
openllmc version
openllmc mcp            # the unified MCP server (stdio)
```

> Installed from the dashboard (one-click)? That path runs sandboxed and
> skips PATH/completion — run `~/.openllm/bin/openllmc setup` once.

Or consume the source as a package:

```sh
bun install github:openllmsh/cli # latest
```

## Build from source

This repo is **self-compilable** — no private packages, no monorepo needed
(the SDK is committed under [`src/sdk/generated/`](./src/sdk/generated)):

```sh
git clone https://github.com/openllmsh/cli && cd cli
bun install
bun run compile:host        # → dist/openllmc (this machine's target)
./dist/openllmc version     # v0.0.0-dev — source builds carry the dev sentinel
bun run compile             # all 4 targets: darwin/linux × arm64/x64 (+ .gz sidecars)
```

A source build bakes the `0.0.0-dev` sentinel (release builds are stamped by
the release pipeline via `--version`), so it never self-updates — run it
directly or point `mcpServers.openllm` at your `dist/openllmc`.

## Commands

| Command | What |
| --- | --- |
| `openllmc mcp [--only <group>]` | the unified MCP server over stdio — groups: `openllm` (native API), `claude-context`, `supermemory` (default all) |
| `openllmc exec ctx <index\|search\|status\|index-docs> …` | code/docs-search hook verbs (what the plugin's hooks call) |
| `openllmc setup` | PATH symlink + shell completion (idempotent) |
| `openllmc completion <bash\|zsh\|fish\|install>` | print or install shell completion |
| `openllmc api --spec` | print the embedded OpenAPI spec |
| `openllmc self-update` | converge to the gateway's pinned release |
| `openllmc version` | print the version |

Config: `OPENLLM_CLOUD_ORIGIN` / `OPENLLM_API_KEY` (env, or
the shared `~/.openllm/.env` — the same file the
daemon pairing writes, so one pairing applies to
every OpenLLM tool on the box).

## Verify

Every published binary is pinned by SHA-256 in [`manifest.ts`](./manifest.ts),
committed to this repo. Confirm the artifacts the cloud serves are exactly what
this source vouches for — no trust required:

```sh
bun install
bun run verify                        # download every published target, hash it, check vs manifest.ts
bun run verify -- --host              # just this machine's target
bun run verify -- --file ./openllmc   # a binary you already installed/downloaded
bun run verify -- --installed         # the `openllmc` on your $PATH
```

Exit code is `0` only when every checked binary matches its pinned digest.

> Note: the binary is **not** byte-reproducible (`bun build --compile
> --bytecode` embeds non-deterministic bytecode), so rebuilding from source
> won't hash-match the release. The verifiable guarantee is that the
> **published** asset matches the SHA-256 committed here — the same digest
> the install script and `openllmc self-update` enforce on download.

## License

**Source-available** under the [Business Source License 1.1](./LICENSE)
(© Quantide LLC) — converts to MIT on the Change Date. Not OSI open-source.

---

> **Read-only mirror.** Regenerated from the OpenLLM monorepo each release.
> PRs welcome — ingested upstream with your authorship preserved. BUSL
> contributions require the CLA (the bot will prompt you).
