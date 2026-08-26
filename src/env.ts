/**
 * CLI runtime configuration. The CLI shares the ONE OpenLLM config file —
 * `~/.openllm/.env` — with the daemon (and any future tool): the daemon's
 * installer/pairing writes `OPENLLM_CLOUD_ORIGIN` + `OPENLLM_API_KEY` there,
 * and the CLI respects them, so a re-pair or a custom origin (a preview
 * deployment, a self-host) applies product-wide without separate config.
 *
 * Resolution order per value:
 *
 *   1. process env — `OPENLLM_CLOUD_ORIGIN` / `OPENLLM_API_KEY`
 *   2. `~/.openllm/.env` (KEY=VALUE lines — the shared file; the same
 *      OPENLLM_* keys the daemon reads/writes)
 *   3. the compile-time cloud-origin default (`--define` bake) for the URL
 *
 * The version identity is baked at compile (`__OPENLLM_CLI_VERSION__`);
 * source runs carry the `0.0.0-dev` sentinel the dev guards key on.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Compile-time defines (see scripts/compile.ts). Source runs fall back.
declare const __OPENLLM_CLI_VERSION__: string | undefined;
declare const __OPENLLM_CLOUD_ORIGIN_DEFAULT__: string | undefined;

export const CLI_VERSION: string =
  typeof __OPENLLM_CLI_VERSION__ === "string"
    ? __OPENLLM_CLI_VERSION__
    : "0.0.0-dev";

const CLOUD_ORIGIN_DEFAULT: string =
  typeof __OPENLLM_CLOUD_ORIGIN_DEFAULT__ === "string"
    ? __OPENLLM_CLOUD_ORIGIN_DEFAULT__
    : "https://openllm.sh";

/**
 * The user's home directory, `$HOME` first.
 *
 * `os.homedir()` on macOS resolves via `getpwuid`, IGNORING `$HOME` — which
 * would make the CLI disagree with its own shell hooks (`openllm-env.sh` reads
 * `$HOME/.openllm/.env`) and with a child launched under an explicitly set HOME
 * (the daemon's isolated-CLI path does exactly that). Honour `$HOME` when
 * present so every OpenLLM component resolves the same tree.
 */
export const userHome = (): string => {
  const fromEnv = process.env.HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : homedir();
};

/**
 * `~/.openllm` — resolved LAZILY (a function, not a module const) for the same
 * reason `userHome()` exists: a const captures the home directory at import
 * time, so any caller that legitimately runs under a different HOME (a child
 * the daemon launches with an isolated HOME, a test harness) would silently
 * read the wrong tree.
 */
export const openllmDir = (): string => join(userHome(), ".openllm");

/**
 * The daemon-owned state root used by durable session hosts. Unlike ordinary
 * CLI state, this must honour the daemon override so both binaries scan the
 * same socket registry in development and tests.
 *
 * The override must be an absolute path. Session-host discovery reaps stale
 * entries with a recursive delete, so a relative root would resolve against
 * the invoking directory.
 */
export const daemonStateDir = (): string => {
  const override = process.env.OPENLLM_DAEMON_STATE_DIR;
  return override !== undefined && override.length > 0 && isAbsolute(override)
    ? override
    : openllmDir();
};
/**
 * The shared OpenLLM environment file. An installed daemon pins this path in
 * `OPENLLM_DAEMON_ENV_FILE`; honouring that override keeps CLI onboarding and
 * daemon persistence on the one configured file (including custom installs).
 */
export const sharedEnvFile = (): string => {
  const override = process.env.OPENLLM_DAEMON_ENV_FILE;
  return override !== undefined && override.length > 0 && isAbsolute(override)
    ? override
    : join(openllmDir(), ".env");
};
export const cliBinPath = (): string => join(openllmDir(), "bin", "openllm");

/** Parse a KEY=VALUE env file (comments + blank lines ignored). */
const parseEnvFile = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!fs.existsSync(path)) return out;
  try {
    for (const line of fs.readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (t.length === 0 || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch {
    // unreadable file → env-only resolution
  }
  return out;
};

/** The shared file's values (read-only). */
export const sharedFileConfig = (): Record<string, string> =>
  parseEnvFile(sharedEnvFile());

export type TCliConfig = {
  readonly gatewayUrl: string;
  /** Empty string when no key is configured — callers decide whether the
   *  operation needs one (`requireKey`). */
  readonly apiKey: string;
};

export const cliConfig = (): TCliConfig => {
  const file = sharedFileConfig();
  const gatewayUrl = (
    process.env.OPENLLM_CLOUD_ORIGIN ??
    file.OPENLLM_CLOUD_ORIGIN ??
    CLOUD_ORIGIN_DEFAULT
  ).replace(/\/+$/, "");
  const apiKey = process.env.OPENLLM_API_KEY ?? file.OPENLLM_API_KEY ?? "";
  return { gatewayUrl, apiKey };
};
