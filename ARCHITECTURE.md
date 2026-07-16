# `@openllmsh/cli` — the OpenLLM CLI

> The single distribution vehicle for every gateway extension: ONE compiled,
> source-free binary (`~/.openllm/bin/openllmc`) serving ONE MCP server that
> exposes the full native gateway API plus the claude-context and supermemory
> tool groups. Installed by the `openllm` plugin bundle
> (`packages/registry/plugin/openllm/install.sh`), self-updating against the
> gateway's pinned release — the extension-side twin of
> [`packages/daemon`](../daemon/ARCHITECTURE.md).

---

## 1. Shape

```
packages/cli/
├── package.json          # @openllmsh/cli · 0.0.0-dev placeholder · BUSL-1.1
├── manifest.ts           # COMMITTED release pin (repo/tag/per-target sha256)
├── release-types.ts      # CLI_TARGETS (SSOT of buildable targets) + TCliRelease
├── index.ts              # barrel: manifest + release-types only (gateway reads the pin)
├── scripts/
│   ├── compile.ts        # bun --compile --minify --bytecode ×4 targets + gzip sidecars
│   └── generate-sdk.ts   # MONOREPO-ONLY: HttpApi → committed SDK artifacts
└── src/
    ├── main.ts           # entry: mcp | exec | api | setup | completion | self-update | version
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
        ├── openllm/      # native-API tools — generated from ALL spec operations
        ├── claude-context/  # code+docs search tools + the ctx hook CLI
        └── supermemory/     # memory/recall/whoAmI tools
```

## 2. Commands

| Command | What |
| --- | --- |
| `openllmc mcp [--only <group>]` | the unified MCP server over stdio (groups: `openllm`, `claude-context`, `supermemory`; default all — `--only` is debug) |
| `openllmc exec ctx <index\|search\|status\|index-docs> …` | claude-context hook verbs — what the `openllm` bundle's hooks shell out to (`ctx` kept as a hidden alias for older bundles) |
| `openllmc setup` | PATH symlink + shell completion — run automatically by the curl installer; shown as a copyable follow-up on the dashboard card for sandboxed one-click installs |
| `openllmc completion <bash\|zsh\|fish\|install>` | shell completion (derived from `commands.ts`, the single command-surface source) |
| `openllmc api --spec` | print the embedded OpenAPI spec |
| `openllmc self-update` | converge to the gateway's pinned release |
| `openllmc version` | print the baked version |

Config: `LLM_GATEWAY_URL` / `LLM_GATEWAY_API_KEY` env (the same contract the
MCP mapping + hooks carry — plus the shared `OPENLLM_CLOUD_ORIGIN` /
`OPENLLM_API_KEY` names), falling back to the SHARED `~/.openllm/.env` (the
same file the daemon boots from — one pairing covers every tool), falling back
to the compile-time cloud-origin bake.

## 3. The generated SDK (why the mirror is self-contained)

`scripts/generate-sdk.ts` runs ONLY in the monorepo: it derives the OpenAPI
doc via the exact same path as the served `/api/swagger`
(`buildSanitizedSpec` in `packages/api/handlers/swagger.ts` — shared
sanitize, so the SDK can never drift from the published spec), then emits two
COMMITTED artifacts into `src/sdk/generated/`:

- `openapi.json` — the sanitized spec (also served by `openllmc api --spec`).
- `operations.ts` — a dependency-free typed table: one row per spec operation
  (method, path, params, body-presence). Deterministically sorted.

`src/mcp/openllm/tools.ts` derives one MCP tool per row — **every** spec
operation, no hand-picked subset; coverage tracks the spec. Mutating
operations carry explicit consent copy in their tool descriptions.

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
  `openllmc-<target>.gz` on `openllmsh/cli`; the manifest pins the
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
- `openllmc self-update` compares the baked version, downloads, gunzips,
  verifies the decompressed sha256, atomically swaps itself via
  same-directory rename. Converge policy (rollbacks supported);
  `0.0.0-dev` never self-updates.
