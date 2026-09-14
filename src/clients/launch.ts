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

import { FREE_TIER_MCP_GROUPS } from "../commands";
import {
  deepMerge,
  parseJsonLoose,
  parseYaml,
  serializeToml,
  serializeYaml,
  substitute,
  type TJsonObject,
  tomlLeaves,
} from "./merge";
import { OVERLAYS } from "./overlays";
import type { TClient } from "./registry";

/**
 * Account tier. Only `"free"` changes launch behavior.
 *
 * Defined locally, NOT imported from `@openllm/schema`: the CLI ships as a
 * self-contained binary with no workspace deps (the generated SDK is
 * committed), so it cannot depend on `schema` even for types. Keep this union
 * in sync with `Tier` in `packages/schema/billing.ts`.
 */
export type TTier = "free" | "trial" | "pro";

/**
 * The `openllm mcp` argv for a tier. Paid tiers get the bare `["mcp"]` (all
 * groups); free tier narrows with `--only` per `FREE_TIER_MCP_GROUPS`,
 * excluding paid `claude-context` code-search. Overlay argv AND the MCP
 * server (`mcpGroupsForTier`) share that list so every MCP client is gated.
 */
export const mcpArgs = (tier: TTier | undefined): readonly string[] =>
  tier === "free"
    ? ["mcp", ...FREE_TIER_MCP_GROUPS.flatMap((g) => ["--only", g])]
    : ["mcp"];

/**
 * The MCP argv as a JSON array literal — the value substituted into each
 * overlay's `"{{MCP_ARGS}}"` (JSON, via `substituteJsonValue`) or `{{MCP_ARGS}}`
 * (TOML, via `substitute`). A JSON array literal is also a valid TOML array
 * literal, so one string serves both.
 */
export const mcpArgsJson = (tier: TTier | undefined): string =>
  JSON.stringify(mcpArgs(tier));

/**
 * opencode folds the binary into the same `command` array as the args, so it
 * gets its own `["<bin>", "mcp", …]` literal.
 */
export const mcpCommandJson = (
  binPath: string,
  tier: TTier | undefined,
): string => JSON.stringify([binPath, ...mcpArgs(tier)]);

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
  /**
   * The account tier this launch runs under. FREE tier excludes the paid
   * code-search MCP group (`claude-context`) from the one `openllm mcp` server;
   * `trial`/`pro` (and an unknown/undefined tier) get the full surface. Only
   * `"free"` narrows — anything else is treated as paid, so a failed tier fetch
   * fails OPEN to the full toolset rather than silently degrading a paying user.
   */
  readonly tier?: TTier;
  /** Opt-in sterile Claude launch: omit the OpenLLM MCP overlay. */
  readonly bare?: boolean;
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

/** Transform parsed string values once; inserted data is never template source. */
const mapStrings = (value: unknown, transform: (text: string) => unknown): unknown => {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]));
  }
  return value;
};

const fillCatalogTokens = (doc: unknown, inputs: TLaunchInputs): TJsonObject =>
  mapStrings(doc, (text) => text.replace(
    /__OPENLLM_BASE_URL__|__OPENLLM_API_KEY__/g,
    (token) => token === CATALOG_BASE_URL_TOKEN ? `${inputs.apiBase}/v1` : inputs.apiKey,
  )) as TJsonObject;

/** Parse before substituting scalar values, so paths cannot become escapes. */
const overlayDocument = (
  text: string,
  format: "json" | "toml" | "yaml",
  inputs: TLaunchInputs,
  values: Readonly<Record<string, unknown>> = {},
): TJsonObject => {
  // TOML/YAML array slots are unquoted in authored templates. Quote the slot,
  // not its eventual value, before parsing. JSON slots are already quoted.
  const source = format === "json" ? text : text.replace(/(?<=args = |args: )\{\{MCP_ARGS\}\}/g, '"{{MCP_ARGS}}"');
  const doc = format === "json" ? JSON.parse(source)
    : format === "toml" ? Bun.TOML.parse(source) : Bun.YAML.parse(source);
  const slots: Readonly<Record<string, unknown>> = {
    MCP_ARGS: mcpArgs(inputs.tier),
    MCP_COMMAND: [inputs.binPath, ...mcpArgs(inputs.tier)],
    ...values,
  };
  const vars = overlayVars(inputs);
  return mapStrings(doc, (text) => {
    const slot = /^\{\{([A-Z0-9_]+)\}\}$/.exec(text)?.[1];
    if (slot !== undefined && Object.hasOwn(slots, slot)) return slots[slot];
    return substitute(text, vars);
  }) as TJsonObject;
};

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
    return fillCatalogTokens(Bun.TOML.parse(catalog), inputs);
  } catch {
    return {};
  }
};

/** The placeholder values every overlay may reference. */
export const overlayVars = (
  inputs: TLaunchInputs,
): Readonly<Record<string, string>> => ({
  OPENLLM_API_BASE: inputs.apiBase,
  OPENLLM_API_KEY: inputs.apiKey,
  OPENLLM_BIN: inputs.binPath,
  STATE_DIR: inputs.stateDir,
  HOOKS_DIR: `${inputs.runDir}/hooks`,
  MODEL_CATALOG_PATH: `${inputs.runDir}/models.json`,
  // TOML overlays (grok, codex) carry `args = {{MCP_ARGS}}` at an array
  // position; `substitute` fills it with the JSON/TOML array literal. JSON
  // overlays instead use `substituteJsonValue` on the quoted `"{{MCP_ARGS}}"`
  // (see each plan) so the raw overlay stays valid JSON.
  MCP_ARGS: mcpArgsJson(inputs.tier),
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

// Windows has no executable /bin/sh contract. Inline trusted PowerShell code
// avoids script execution-policy changes and shell expansion of the key.
// Only the environment variable name is encoded; no credential enters argv.
const CLAUDE_WINDOWS_KEY_HELPER =
  "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " +
  Buffer.from(
    `[Console]::Out.Write([Environment]::GetEnvironmentVariable('${HELPER_KEY_VAR}'))`,
    "utf16le",
  ).toString("base64");

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
  const helperPath = `${inputs.runDir}/${CLAUDE_KEY_HELPER_REL}`;
  const windows = process.platform === "win32";
  const settings = overlayDocument(OVERLAYS.claude.settings, "json", inputs);
  return {
    files: {
      "settings.json": `${JSON.stringify(
        {
          ...settings,
          apiKeyHelper: windows
            ? CLAUDE_WINDOWS_KEY_HELPER
            : `'${helperPath.replaceAll("'", "'\\''")}'`,
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
      // The quoted `"{{MCP_ARGS}}"` (valid JSON in the raw overlay) becomes the
      // real args ARRAY via `substituteJsonValue`, then the remaining string
      // tokens (`{{OPENLLM_BIN}}`, `{{STATE_DIR}}`) fill normally.
      ...(inputs.bare
        ? {}
        : {
            "mcp.json": JSON.stringify(overlayDocument(OVERLAYS.claude.mcp, "json", inputs)),
          }),
    },
    execFiles: windows ? {} : { [CLAUDE_KEY_HELPER_REL]: CLAUDE_KEY_HELPER },
    args: [
      "--settings",
      `${inputs.runDir}/settings.json`,
      ...(inputs.bare ? [] : ["--mcp-config", `${inputs.runDir}/mcp.json`]),
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
  const overrides = overlayDocument(OVERLAYS.codex.overrides, "toml", inputs);
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
  const overlay = overlayDocument(OVERLAYS.grok.config, "toml", inputs);
  // The catalog is its own TOML document of one [model."<id>"] table per
  // activated model. Parse + deep-merge it (it must NOT be concatenated — both
  // documents define `[model."ultra"]`, which is a duplicate-key error) so the
  // live tables win over the built-in fallback.
  const catalogDoc =
    inputs.catalog === undefined
      ? {}
      : parseGrokCatalog(inputs.catalog, inputs);
  const mcp = overlayDocument(OVERLAYS.grok.mcp, "toml", inputs);
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
      "hooks/openllm.json": JSON.stringify(overlayDocument(OVERLAYS.grok.hooks, "json", inputs)),
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
 * Hermes session overlay — private `HERMES_HOME` over a symlink farm of
 * `~/.hermes`. Sticky profile writes live on `openllm hermes install`.
 */
const planHermes = (inputs: TLaunchInputs): TLaunchPlan => {
  const overlay = overlayDocument(OVERLAYS.hermes.config, "yaml", inputs);
  const user =
    inputs.userConfig === undefined ? {} : (parseYaml(inputs.userConfig) ?? {});
  const merged = deepMerge(user, overlay) as TJsonObject;
  return {
    files: {
      "config.yaml": serializeYaml(merged),
      // Own this file so a sticky `active_profile` cannot send Hermes into
      // ~/.hermes/profiles/<name> and skip this overlay. After install, launch
      // skips the overlay and sets HERMES_HOME to the profile instead.
      active_profile: "default\n",
    },
    args: [],
    env: {
      HERMES_HOME: inputs.runDir,
      OPENLLM_API_KEY: inputs.apiKey,
      OPENLLM_BIN: inputs.binPath,
      CLAUDE_CONTEXT_STATE_DIR: inputs.stateDir,
    },
    unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    mirrorDir: "~/.hermes",
    hooks: false,
  };
};

/**
 * OpenCode — `OPENCODE_CONFIG` points at a single config file, so we merge the
 * user's document with our provider block in memory and write the result into
 * the run dir. An unparseable user config degrades to our overlay alone.
 */
const planOpenCode = (inputs: TLaunchInputs): TLaunchPlan => {
  const models = inputs.catalog === undefined ? {}
    : fillCatalogTokens(JSON.parse(inputs.catalog), inputs);
  const overlay = overlayDocument(OVERLAYS.opencode.config, "json", inputs, { MODELS: models });
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
      return inputs.client.id === "hermes"
        ? planHermes(inputs)
        : planGrok(inputs);
    case "config-file":
      return planOpenCode(inputs);
    default:
      throw new Error(
        `client ${inputs.client.id} has no session launch strategy`,
      );
  }
};
