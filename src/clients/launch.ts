/**
 * The PURE half of session mode: given a client, the resolved gateway values,
 * and the user's existing config text, compute the launch plan — which
 * run-local files to write, which extra args to prepend, and which env vars the
 * child needs. No fs, no network, no exec, so every per-client rule is
 * unit-testable (`tests/cli/client-launch.test.ts`).
 *
 * The invariant this file exists to protect: the user's config is an INPUT
 * only. Nothing here ever produces a write outside the ephemeral run dir.
 */

import {
  deepMerge,
  parseJsonLoose,
  serializeToml,
  substitute,
  substituteJsonValue,
  type TJsonObject,
  tomlLeaves,
} from "./merge";
import { OVERLAYS } from "./overlays";
import type { TClient } from "./registry";

export type TLaunchInputs = {
  readonly client: TClient;
  /** Gateway base origin (local daemon or cloud), no trailing slash. */
  readonly apiBase: string;
  readonly apiKey: string;
  /** Absolute path to this binary — what MCP entries invoke. */
  readonly binPath: string;
  /** Absolute run dir for this launch. */
  readonly runDir: string;
  /** claude-context state dir. */
  readonly stateDir: string;
  /** The user's existing config text for this client, when it exists. */
  readonly userConfig?: string;
  /** Client-shaped model catalog body from the gateway, when available. */
  readonly catalog?: string;
};

export type TLaunchPlan = {
  /** run-dir-relative path → contents. Written 0o600 under a 0o700 dir. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Like `files`, but written 0o700 — for the few plan entries the client must
   * EXECUTE rather than read (Claude's `apiKeyHelper`). Kept separate from the
   * shared `HOOK_SCRIPTS` table because these bodies are per-launch (they
   * reference the run dir) and per-client.
   */
  readonly execFiles?: Readonly<Record<string, string>>;
  /** Args prepended BEFORE the user's own args. */
  readonly args: readonly string[];
  /** Env overrides for the child process. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Env vars to remove from inherited process env before spawning.
   *
   * This is required when OpenLLM writes its own auth for the child, but the user
   * also has ambient credentials (for example, from a separate Claude Code login)
   * that could be picked up accidentally and overshadow the OpenLLM flow.
   */
  readonly unsetEnv?: readonly string[];
  /** When set, the run dir must be a symlink farm over this real config dir
   *  (so credentials / history / sessions still resolve to the user's files). */
  readonly mirrorDir?: string;
  /** Whether the hook scripts must be materialized into `<runDir>/hooks`. */
  readonly hooks: boolean;
};

/**
 * The gateway never echoes a caller's key or resolved origin back inside a
 * generated catalog — it emits these placeholders instead, and the client
 * substitutes them locally (see `packages/api/catalog/grok-model-config.ts`).
 * Keep in sync with `GROK_BASE_URL_PLACEHOLDER` / `GROK_API_KEY_PLACEHOLDER`.
 */
const CATALOG_BASE_URL_TOKEN = "__OPENLLM_BASE_URL__";
const CATALOG_API_KEY_TOKEN = "__OPENLLM_API_KEY__";

/** Fill the gateway-emitted catalog placeholders with this launch's values. */
const fillCatalogTokens = (text: string, inputs: TLaunchInputs): string =>
  text
    .replaceAll(CATALOG_BASE_URL_TOKEN, `${inputs.apiBase}/v1`)
    .replaceAll(CATALOG_API_KEY_TOKEN, inputs.apiKey);

/**
 * Parse the Grok catalog block into a TOML document. Best-effort: an
 * unparseable payload degrades to the overlay's built-in fallback table rather
 * than failing the launch.
 */
const parseGrokCatalog = (
  catalog: string,
  inputs: TLaunchInputs,
): TJsonObject => {
  try {
    return Bun.TOML.parse(fillCatalogTokens(catalog, inputs)) as TJsonObject;
  } catch {
    return {};
  }
};

/** The placeholder values every overlay may reference. */
const overlayVars = (
  inputs: TLaunchInputs,
): Readonly<Record<string, string>> => ({
  OPENLLM_API_BASE: inputs.apiBase,
  OPENLLM_API_KEY: inputs.apiKey,
  OPENLLM_BIN: inputs.binPath,
  STATE_DIR: inputs.stateDir,
  HOOKS_DIR: `${inputs.runDir}/hooks`,
  MODEL_CATALOG_PATH: `${inputs.runDir}/models.json`,
});

/**
 * The env var the run-local `apiKeyHelper` echoes. Deliberately NOT one of
 * Claude's own `ANTHROPIC_*` names: Claude must see the key ONLY through the
 * helper, so this name is invisible to its credential resolution.
 */
const HELPER_KEY_VAR = "OPENLLM_GATEWAY_KEY";

/**
 * The run-local `apiKeyHelper`. Echoes the key from the child ENVIRONMENT
 * rather than embedding it, so the launch plan still writes NO secret to disk.
 */
const CLAUDE_KEY_HELPER = `#!/bin/sh\nprintf '%s' "$${HELPER_KEY_VAR}"\n`;

/**
 * The helper's path RELATIVE to the run dir. Single source for both the
 * `execFiles` key (which is run-dir-relative) and the absolute `apiKeyHelper`
 * setting, so the two can never drift apart.
 */
const CLAUDE_KEY_HELPER_REL = "hooks/api-key.sh";

/**
 * Claude Code — `--settings` layers additional settings over the user's own and
 * `--mcp-config` adds MCP servers, so NOTHING needs merging and nothing needs a
 * config-dir redirect: the user's `~/.claude` stays fully authoritative
 * (credentials, history, projects, and their claude.ai login).
 *
 * The gateway key is supplied via `apiKeyHelper` rather than `ANTHROPIC_API_KEY`,
 * and every ambient Anthropic credential is stripped from the child env. That is
 * what keeps the session to exactly ONE key source. Claude warns
 * "Both <x> and <y> set · auth may not work as expected" whenever it finds two
 * live credentials at once, and setting `ANTHROPIC_API_KEY` while the user is
 * signed in to claude.ai is precisely that collision — the login lives in the
 * macOS keychain, which no env var or config-dir override can scope, so removing
 * OUR side is the only fix that leaves theirs intact.
 */
const planClaude = (inputs: TLaunchInputs): TLaunchPlan => {
  const vars = overlayVars(inputs);
  const helperPath = `${inputs.runDir}/${CLAUDE_KEY_HELPER_REL}`;
  const settings = parseJsonLoose(
    substitute(OVERLAYS.claude.settings, vars),
  ) as TJsonObject;
  return {
    files: {
      "settings.json": `${JSON.stringify(
        {
          ...settings,
          apiKeyHelper: helperPath,
          // Claude auto-fetches the user's claude.ai cloud MCP connectors, then
          // reports that it disabled them because another auth source takes
          // precedence. Under the gateway they could never have connected — the
          // session authenticates with the gateway key, not the claude.ai
          // login — so opting out up front removes a warning about something we
          // were never going to use. Scoped to this launch: "any-source-true
          // wins", but we only ever set it in the run-local settings, so the
          // user's own connectors are untouched outside `openllm claude`.
          disableClaudeAiConnectors: true,
        },
        null,
        2,
      )}\n`,
      "mcp.json": substitute(OVERLAYS.claude.mcp, vars),
    },
    execFiles: { [CLAUDE_KEY_HELPER_REL]: CLAUDE_KEY_HELPER },
    args: [
      "--settings",
      `${inputs.runDir}/settings.json`,
      "--mcp-config",
      `${inputs.runDir}/mcp.json`,
    ],
    env: {
      ANTHROPIC_BASE_URL: inputs.apiBase,
      [HELPER_KEY_VAR]: inputs.apiKey,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "ultra",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "plus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "lite",
      OPENLLM_BIN: inputs.binPath,
      CLAUDE_CONTEXT_STATE_DIR: inputs.stateDir,
    },
    // A second live credential is exactly what triggers the warning, so every
    // ambient Anthropic key is dropped — including any the user exported
    // themselves, which would otherwise silently outrank the gateway.
    unsetEnv: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ],
    hooks: true,
  };
};

/**
 * Codex — every overlay leaf becomes a `-c key=value` override layered on the
 * user's own `config.toml` (Codex's documented mechanism). The provider's key is
 * named via `env_key`, not inlined, so it never reaches argv.
 */
const planCodex = (inputs: TLaunchInputs): TLaunchPlan => {
  const vars = overlayVars(inputs);
  const overrides = Bun.TOML.parse(
    substitute(OVERLAYS.codex.overrides, vars),
  ) as TJsonObject;
  const files: Record<string, string> = {};
  if (inputs.catalog !== undefined) files["models.json"] = inputs.catalog;
  else delete overrides.model_catalog_json; // no catalog → don't point at a missing file
  const args = tomlLeaves(overrides).flatMap((pair) => ["-c", pair]);
  return {
    files,
    args,
    env: { OPENLLM_API_KEY: inputs.apiKey },
    hooks: false,
  };
};

/**
 * Grok Build — no override flag exists, so the run dir becomes a private
 * `GROK_HOME` containing a MERGED `config.toml`. The run dir is a symlink farm
 * over the real `~/.grok`, so `auth.json`, sessions, and history still resolve
 * to the user's own files; only `config.toml` (and our own hook/rules files) are
 * real files in the run dir.
 */
const planGrok = (inputs: TLaunchInputs): TLaunchPlan => {
  const vars = overlayVars(inputs);
  const overlay = Bun.TOML.parse(
    substitute(OVERLAYS.grok.config, vars),
  ) as TJsonObject;
  // The catalog is its own TOML document of one [model."<id>"] table per
  // activated model. Parse + deep-merge it (it must NOT be concatenated — both
  // documents define `[model."ultra"]`, which is a duplicate-key error) so the
  // live tables win over the built-in fallback.
  const catalogDoc =
    inputs.catalog === undefined
      ? {}
      : parseGrokCatalog(inputs.catalog, inputs);
  const mcp = Bun.TOML.parse(
    substitute(OVERLAYS.grok.mcp, vars),
  ) as TJsonObject;
  const user =
    inputs.userConfig === undefined
      ? {}
      : ((): TJsonObject => {
          try {
            return Bun.TOML.parse(inputs.userConfig) as TJsonObject;
          } catch {
            // Unparseable user config: proceed with ours alone rather than
            // failing the launch — we are not writing their file back.
            return {};
          }
        })();
  const merged = deepMerge(
    deepMerge(deepMerge(user, overlay), catalogDoc),
    mcp,
  ) as TJsonObject;
  return {
    files: {
      "config.toml": serializeToml(merged),
      "hooks/openllm.json": substitute(OVERLAYS.grok.hooks, vars),
      "rules/openllm.md": OVERLAYS.grok.guidance,
    },
    args: [],
    env: {
      GROK_HOME: inputs.runDir,
      OPENLLM_BIN: inputs.binPath,
      CLAUDE_CONTEXT_STATE_DIR: inputs.stateDir,
    },
    mirrorDir: "~/.grok",
    hooks: true,
  };
};

/**
 * OpenCode — `OPENCODE_CONFIG` points at a single config file, so we merge the
 * user's document with our provider block in memory and write the result into
 * the run dir. An unparseable user config degrades to our overlay alone.
 */
const planOpenCode = (inputs: TLaunchInputs): TLaunchPlan => {
  const vars = overlayVars(inputs);
  const overlayText = substituteJsonValue(
    OVERLAYS.opencode.config,
    "MODELS",
    inputs.catalog === undefined
      ? "{}"
      : fillCatalogTokens(inputs.catalog, inputs),
  );
  const overlay = JSON.parse(substitute(overlayText, vars)) as TJsonObject;
  const user =
    inputs.userConfig === undefined
      ? {}
      : (parseJsonLoose(inputs.userConfig) ?? {});
  const merged = deepMerge(user, overlay) as TJsonObject;
  return {
    files: { "opencode.json": `${JSON.stringify(merged, null, 2)}\n` },
    args: [],
    env: {
      OPENCODE_CONFIG: `${inputs.runDir}/opencode.json`,
      OPENLLM_BIN: inputs.binPath,
      CLAUDE_CONTEXT_STATE_DIR: inputs.stateDir,
    },
    hooks: false,
  };
};

/** Build the launch plan for a session client. */
export const buildLaunchPlan = (inputs: TLaunchInputs): TLaunchPlan => {
  switch (inputs.client.strategy) {
    case "flags":
      return planClaude(inputs);
    case "config-overrides":
      return planCodex(inputs);
    case "config-dir":
      return planGrok(inputs);
    case "config-file":
      return planOpenCode(inputs);
    default:
      throw new Error(
        `client ${inputs.client.id} has no session launch strategy`,
      );
  }
};
