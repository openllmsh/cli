# `packages/cli/setup` — static client overlays

The OpenLLM configuration for each supported client, as **data**. These files
are embedded into the `openllm` binary at compile time (Bun text imports) and
applied at RUN time by `openllm <client>` — they are never installed into the
user's home directory by a setup script.

## Authoring rules

1. **No secrets.** Use placeholders only; the runtime substitutes them from
   `~/.openllm/.env` + the live model catalog:

   | Placeholder | Substituted with |
   | --- | --- |
   | `{{OPENLLM_API_BASE}}` | gateway base URL (local daemon when reachable, else cloud origin) |
   | `{{OPENLLM_API_KEY}}` | the user's `sk-llm-…` key |
   | `{{OPENLLM_BIN}}` | absolute path to the `openllm` binary |
   | `{{STATE_DIR}}` | claude-context state dir |
   | `{{HOOKS_DIR}}` | run-local hooks dir (materialized per launch) |
   | `{{MODEL_CATALOG_PATH}}` | run-local model catalog file |
   | `{{MODELS}}` | client-shaped model block from `/api/setup/<client>/model-catalog` |

   Prefer routing a secret through the child **environment** (see the client
   table in `src/clients/registry.ts`) over writing it into a run-local file:
   session clients that can take their key from env put nothing secret on disk.

2. **No scripts.** Pure JSON / TOML / YAML / Markdown. `tests/cli/setup-overlays.test.ts`
   parses every file, so a syntax error fails CI.

3. **No per-user state.** The same bytes ship to every user.

4. **Changes ride CLI releases.** `setup/**` is part of `CLI_BINARY_SOURCES`, so
   editing an overlay forces a CLI rebuild + re-pin. The daemon's auto-update
   converges the binary, and the next `openllm <client>` uses the new overlay —
   there is no reinstall step.

5. **`claude/prompt-prefix.md` is hand-maintained here.** It is the ONLY home
   of the agent steering prefix — the gateway does NOT inject any prompt
   prefix into upstream calls (a gateway-injected prefix breaks prompt-cache
   prefix stability and self-identifies the subscription hop as a gateway).
   Edit the text directly in this file; there is no generator.

## Layout

```
setup/
├── claude/     settings.json · mcp.json · guidance.md · prompt-prefix.md
├── codex/      overrides.toml
├── grok/       config.toml · mcp.toml · hooks.json · guidance.md
├── hermes/     openllm.yaml · guidance.md   (always-on sticky profile)
├── opencode/   opencode.json
└── raycast/    providers.yaml      (always-on client — applied in place)
```
