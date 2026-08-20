/**
 * The static client overlays from `packages/cli/setup/**`, embedded into the
 * compiled binary as text (Bun text imports survive `bun build --compile`, so
 * a source-free binary carries its own configuration data — no install step
 * writes these anywhere).
 *
 * Authored as real `.json` / `.toml` / `.yaml` / `.md` files so they stay
 * parseable + reviewable; `tests/cli/setup-overlays.test.ts` parses every one.
 * See `packages/cli/setup/README.md` for the authoring rules.
 */

import claudeGuidance from "../../setup/claude/guidance.md" with {
  type: "text",
};
import claudeMcp from "../../setup/claude/mcp.json" with { type: "text" };
import claudePromptPrefix from "../../setup/claude/prompt-prefix.md" with {
  type: "text",
};
import claudeSettings from "../../setup/claude/settings.json" with {
  type: "text",
};
import codexOverrides from "../../setup/codex/overrides.toml" with {
  type: "text",
};
import grokConfig from "../../setup/grok/config.toml" with { type: "text" };
import grokGuidance from "../../setup/grok/guidance.md" with { type: "text" };
import grokHooks from "../../setup/grok/hooks.json" with { type: "text" };
import grokMcp from "../../setup/grok/mcp.toml" with { type: "text" };
import hermesGuidance from "../../setup/hermes/guidance.md" with {
  type: "text",
};
import hermesConfig from "../../setup/hermes/openllm.yaml" with {
  type: "text",
};
import opencodeConfig from "../../setup/opencode/opencode.json" with {
  type: "text",
};
import raycastProviders from "../../setup/raycast/providers.yaml" with {
  type: "text",
};

/**
 * `with { type: "text" }` makes Bun hand back the raw bytes as a STRING, but
 * TypeScript resolves a `.json` specifier through `resolveJsonModule` and types
 * it as the PARSED object regardless of the attribute (import attributes don't
 * influence TS's module typing). The `.toml`/`.yaml`/`.md` specifiers resolve
 * through `text-imports.d.ts` and are already `string`.
 *
 * So narrow the JSON ones here, once, instead of letting an object-typed value
 * masquerade as text through the rest of the codebase.
 * `tests/cli/setup-overlays.test.ts` asserts the runtime type really is a
 * string (and that the bytes match the authored file), so this cast is checked
 * rather than assumed.
 */
const asText = (value: unknown): string => value as string;

export const OVERLAYS = {
  claude: {
    settings: asText(claudeSettings),
    mcp: asText(claudeMcp),
    guidance: claudeGuidance,
    promptPrefix: claudePromptPrefix,
  },
  codex: { overrides: codexOverrides },
  grok: {
    config: grokConfig,
    mcp: grokMcp,
    hooks: asText(grokHooks),
    guidance: grokGuidance,
  },
  hermes: {
    config: hermesConfig,
    guidance: hermesGuidance,
  },
  opencode: { config: asText(opencodeConfig) },
  raycast: { providers: raycastProviders },
} as const;
