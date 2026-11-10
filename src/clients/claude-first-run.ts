/**
 * Pre-answer Claude Code's first-run dialogs for OpenLLM-launched sessions.
 *
 * Device sessions and `openllm claude` already inject `--settings` / MCP / the
 * gateway key helper, but Claude still gates a fresh machine on
 * `~/.claude.json` fields (onboarding, folder trust, bypass-permissions, and
 * custom API-key approval). Screen-scraping those dialogs remains a fallback;
 * seeding the missing keys up front is what keeps a TTY-less agent host from
 * stalling before `SessionStart`.
 *
 * Never clobber the user's values: only keys that are absent are written. A
 * huge `~/.claude.json` (project history) is left alone — that user is past
 * first-run, and parsing tens of MB would stall the launch.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonLoose, type TJsonObject } from "./merge";

/** Refuse to JSON.parse a Claude config bigger than this (bytes). */
export const CLAUDE_JSON_PARSE_MAX_BYTES = 1_048_576;

/** Default theme recorded with a seeded first-run completion. */
export const CLAUDE_FIRST_RUN_THEME = "dark";

export type TClaudeFirstRunSeed = {
  /** Absolute cwd Claude will start in (folder-trust key). */
  readonly cwd: string;
  /** Gateway / helper key — last 20 chars go into `customApiKeyResponses`. */
  readonly apiKey?: string;
  /** When the launch passes `--dangerously-skip-permissions`. */
  readonly skipPermissions?: boolean;
  /** Theme to record if onboarding was never completed. */
  readonly theme?: string;
};

export type TClaudeFirstRunEnv = Readonly<Record<string, string | undefined>>;

const isPlainObject = (value: unknown): value is TJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where Claude reads `.claude.json`: `$CLAUDE_CONFIG_DIR` when set, else the
 * caller's home. Matches the vendor CLI and the daemon's host-sign-in probe.
 */
export const claudeJsonPath = (
  home: string,
  env: TClaudeFirstRunEnv,
): string => {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return join(fromEnv, ".claude.json");
  }
  return join(home, ".claude.json");
};

/** Last 20 characters Claude stores in `customApiKeyResponses.approved`. */
export const claudeApiKeySuffix = (apiKey: string): string =>
  apiKey.length <= 20 ? apiKey : apiKey.slice(-20);

/**
 * Pure merge: fill only missing first-run keys on `base`. Existing booleans,
 * themes, project entries and API-key responses are left untouched.
 */
export const mergeClaudeFirstRun = (
  base: TJsonObject,
  seed: TClaudeFirstRunSeed,
): TJsonObject => {
  const out: TJsonObject = { ...base };

  if (!Object.hasOwn(out, "hasCompletedOnboarding")) {
    out.hasCompletedOnboarding = true;
  }
  if (!Object.hasOwn(out, "theme")) {
    out.theme = seed.theme ?? CLAUDE_FIRST_RUN_THEME;
  }

  if (seed.skipPermissions === true) {
    if (!Object.hasOwn(out, "bypassPermissionsModeAccepted")) {
      out.bypassPermissionsModeAccepted = true;
    }
    if (!Object.hasOwn(out, "skipDangerousModePermissionPrompt")) {
      out.skipDangerousModePermissionPrompt = true;
    }
  }

  if (seed.apiKey !== undefined && seed.apiKey.length > 0) {
    const suffix = claudeApiKeySuffix(seed.apiKey);
    const existing = isPlainObject(out.customApiKeyResponses)
      ? { ...out.customApiKeyResponses }
      : {};
    const approved = Array.isArray(existing.approved)
      ? [...existing.approved]
      : [];
    const rejected = Array.isArray(existing.rejected)
      ? [...existing.rejected]
      : [];
    if (!approved.includes(suffix) && !rejected.includes(suffix)) {
      approved.push(suffix);
    }
    out.customApiKeyResponses = {
      ...existing,
      approved,
      rejected,
    };
  }

  if (seed.cwd.length > 0) {
    const projects = isPlainObject(out.projects) ? { ...out.projects } : {};
    const existingProject = projects[seed.cwd];
    const prior: TJsonObject = isPlainObject(existingProject)
      ? { ...existingProject }
      : {};
    if (!Object.hasOwn(prior, "hasTrustDialogAccepted")) {
      prior.hasTrustDialogAccepted = true;
      projects[seed.cwd] = prior;
      out.projects = projects;
    }
  }

  return out;
};

export type TSeedClaudeFirstRunResult =
  | { readonly ok: true; readonly path: string; readonly wrote: boolean }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * Only a device session (started from the browser, `OPENLLM_DEVICE_SESSION_ID`
 * set) has no terminal to answer Claude's first-run dialogs, and there the
 * user already chose the folder and permission mode. An interactive
 * `openllm claude` keeps Claude's own trust and bypass-permissions prompts.
 */
export const shouldSeedClaudeFirstRun = (
  clientId: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  clientId === "claude" && (env.OPENLLM_DEVICE_SESSION_ID ?? "").trim() !== "";

/**
 * Merge missing first-run keys into Claude's global config. Best-effort: a
 * missing file is created; an unreadable / oversized / invalid file is skipped
 * so a launch never fails because of this helper.
 */
export const seedClaudeFirstRun = (
  home: string,
  env: TClaudeFirstRunEnv,
  seed: TClaudeFirstRunSeed,
): TSeedClaudeFirstRunResult => {
  const path = claudeJsonPath(home, env);
  let base: TJsonObject = {};

  if (existsSync(path)) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return { ok: false, path, reason: "stat-failed" };
    }
    if (size > CLAUDE_JSON_PARSE_MAX_BYTES) {
      return { ok: false, path, reason: "too-large" };
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { ok: false, path, reason: "read-failed" };
    }
    if (text.trim().length === 0) {
      base = {};
    } else {
      const parsed = parseJsonLoose(text);
      if (parsed === null) {
        return { ok: false, path, reason: "invalid-json" };
      }
      base = parsed;
    }
  }

  const merged = mergeClaudeFirstRun(base, seed);
  if (JSON.stringify(merged) === JSON.stringify(base)) {
    return { ok: true, path, wrote: false };
  }

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.openllm-tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    return { ok: false, path, reason: "write-failed" };
  }
  return { ok: true, path, wrote: true };
};
