/**
 * The daemon-owned `agy` CLI settings under the isolated HOME
 * (`<home>/.gemini/antigravity-cli/settings.json`): pins a deny-all
 * permission list so `agy`'s built-in tools never run when the daemon serves
 * inference through it.
 *
 * Only documented settings are used (antigravity.google/docs/permissions,
 * CLI tab): rules are `action(target)`, `*` matches every target of an
 * action, and a deny rule beats ask and allow. `mcp(*)` is deliberately NOT
 * denied — client tools will ride the daemon's own loopback MCP server, and a
 * deny would beat any allow for it; the MCP servers `agy` loads come only from
 * config files under the isolated HOME and the request's empty workspace.
 * Browser tools have no permission action; the transport cancels the turn on
 * any non-response step anyway (`antigravity-headless.ts`).
 *
 * The file is shared with `agy` itself (it records e.g. `trustedWorkspaces`),
 * so this merges: every other key is kept, our rules are added to `deny`, and
 * the file is rewritten only when something changed.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Every documented action, all targets. */
export const ANTIGRAVITY_CLI_DENY_RULES: ReadonlyArray<string> = [
  "read_file(*)",
  "write_file(*)",
  "read_url(*)",
  "execute_url(*)",
  "download_url(*)",
  "command(*)",
  "unsandboxed(*)",
];

export const antigravityCliSettingsPath = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "settings.json");

type TSettings = Record<string, unknown>;

export type TMergeResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly next: TSettings }
  | { readonly kind: "invalid" };

/** Pure: merge the deny rules into parsed settings. */
export const mergeAntigravityCliSettings = (current: unknown): TMergeResult => {
  if (
    typeof current !== "object" ||
    current === null ||
    Array.isArray(current)
  ) {
    return { kind: "invalid" };
  }
  const settings = current as TSettings;
  const rawPermissions = settings.permissions;
  if (
    rawPermissions !== undefined &&
    (typeof rawPermissions !== "object" ||
      rawPermissions === null ||
      Array.isArray(rawPermissions))
  ) {
    return { kind: "invalid" };
  }
  const permissions = (rawPermissions ?? {}) as Record<string, unknown>;
  const rawDeny = permissions.deny;
  if (rawDeny !== undefined && !Array.isArray(rawDeny)) {
    return { kind: "invalid" };
  }
  const deny = (rawDeny ?? []) as unknown[];
  const missing = ANTIGRAVITY_CLI_DENY_RULES.filter(
    (rule) => !deny.includes(rule),
  );
  if (missing.length === 0) return { kind: "unchanged" };
  return {
    kind: "changed",
    next: {
      ...settings,
      permissions: { ...permissions, deny: [...deny, ...missing] },
    },
  };
};

/**
 * Ensure the deny rules are in the isolated settings file. Returns false when
 * the file exists but cannot be understood or written — the caller must then
 * not run `agy` (its tools might be live).
 */
export const ensureAntigravityCliSettings = (home: string): boolean => {
  const path = antigravityCliSettingsPath(home);
  let current: unknown = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  }
  const merged = mergeAntigravityCliSettings(current);
  if (merged.kind === "invalid") return false;
  if (merged.kind === "unchanged") return true;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged.next, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
};

// ─── Custom agent ──────────────────────────────────────────────────────────
//
// `agy`'s default agent declares ~60 built-in tools plus a long IDE-agent
// system prompt: ~9.6k input tokens on every new conversation. A documented
// custom agent (antigravity.google/docs/subagents: a Markdown file whose
// frontmatter `tools` is an allowlist and whose body IS the system prompt,
// run as the main agent with `agy --agent <name>`) with no tools cut a
// "reply ok" turn from 9,668 to 1,983 input tokens, measured 2026-11-20.
// It lives only under the isolated HOME (`<home>/.gemini/config/agents/`), so
// the user's own `agy` never sees it.

export const ANTIGRAVITY_CLI_AGENT_NAME = "openllm";

export const ANTIGRAVITY_CLI_AGENT_FILE = `---
name: ${ANTIGRAVITY_CLI_AGENT_NAME}
description: Plain chat completion for OpenLLM requests. No tools.
tools: []
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
---

You are a helpful assistant. Answer the user's message directly.
`;

export const antigravityCliAgentPath = (home: string): string =>
  join(home, ".gemini", "config", "agents", `${ANTIGRAVITY_CLI_AGENT_NAME}.md`);

/** Write the agent file when missing or different. False on a write error. */
export const ensureAntigravityCliAgent = (home: string): boolean => {
  const path = antigravityCliAgentPath(home);
  try {
    if (
      existsSync(path) &&
      readFileSync(path, "utf8") === ANTIGRAVITY_CLI_AGENT_FILE
    ) {
      return true;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, ANTIGRAVITY_CLI_AGENT_FILE, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
};

/** Everything the isolated `agy` profile needs before a spawn: the tool deny
 *  rules and the tool-less agent. False → do not run `agy`. */
export const prepareAntigravityCliProfile = (home: string): boolean =>
  ensureAntigravityCliSettings(home) && ensureAntigravityCliAgent(home);
