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
 *   2. the environment's file — `~/.openllm/.env`, or `~/.openllm/.dev.env`
 *      in dev mode (`OPENLLM_DAEMON_DEV=1`, the daemon's own signal); a dev
 *      launch falls back to `.env` for the API key only, like the dev daemon
 *   3. the default origin: the local Next server in dev, else the
 *      compile-time cloud-origin default (`--define` bake)
 *
 * The version identity is baked at compile (`__OPENLLM_CLI_VERSION__`);
 * source runs carry the `0.0.0-dev` sentinel the dev guards key on.
 * The constant itself lives in `cli-version.ts` so self-version dispatch
 * never imports this module.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  bearerApiKeyOf,
  DEV_CLOUD_ORIGIN,
  isOpenllmDevMode,
} from "./runtime-contracts";

export { CLI_VERSION } from "./cli-version";

// Compile-time defines (see scripts/compile.ts). Source runs fall back.
declare const __OPENLLM_CLOUD_ORIGIN_DEFAULT__: string | undefined;

const CLOUD_ORIGIN_DEFAULT: string =
  typeof __OPENLLM_CLOUD_ORIGIN_DEFAULT__ === "string"
    ? __OPENLLM_CLOUD_ORIGIN_DEFAULT__
    : "https://www.openllm.sh";

/**
 * The user's home directory, `$HOME` first.
 *
 * `os.homedir()` on macOS resolves via `getpwuid`, IGNORING `$HOME` — which
 * would make the CLI disagree with its shell launchers and with a child
 * launched under an explicitly set HOME
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

/**
 * The file THIS launch's environment reads: `.dev.env` in dev mode, else the
 * shared `.env` (an absolute `OPENLLM_DAEMON_ENV_FILE` overrides both). Same
 * split the daemon makes (`envFilePath`), so a dev CLI and a dev daemon agree
 * on the port and origin.
 */
export const cliEnvFile = (): string => {
  const override = process.env.OPENLLM_DAEMON_ENV_FILE;
  if (override !== undefined && override.length > 0 && isAbsolute(override))
    return override;
  return join(openllmDir(), isOpenllmDevMode() ? ".dev.env" : ".env");
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

/** This environment's file values (read-only): `.dev.env` in dev, `.env`
 *  otherwise. */
export const sharedFileConfig = (): Record<string, string> =>
  parseEnvFile(cliEnvFile());

export type TCliConfig = {
  readonly gatewayUrl: string;
  /** Empty string when no key is configured — callers decide whether the
   *  operation needs one (`requireKey`). */
  readonly apiKey: string;
};

export const cliConfig = (): TCliConfig => {
  const file = sharedFileConfig();
  const dev = isOpenllmDevMode();
  const gatewayUrl = (
    process.env.OPENLLM_CLOUD_ORIGIN ??
    file.OPENLLM_CLOUD_ORIGIN ??
    (dev ? DEV_CLOUD_ORIGIN : CLOUD_ORIGIN_DEFAULT)
  ).replace(/\/+$/, "");
  // A blank `OPENLLM_API_KEY=` line is "no key", so it must not block the
  // dev fallback to the prod `.env` (read directly — never the overridden
  // file again).
  const fileKey =
    file.OPENLLM_API_KEY !== undefined && file.OPENLLM_API_KEY.length > 0
      ? file.OPENLLM_API_KEY
      : undefined;
  const rawKey =
    process.env.OPENLLM_API_KEY ??
    fileKey ??
    (dev
      ? parseEnvFile(join(openllmDir(), ".env")).OPENLLM_API_KEY
      : undefined) ??
    "";
  // Defense in depth: a device trust anchor pasted into the env
  // (`sk-llm-<key>.<anchor>`) never becomes part of the bearer, and a key
  // whose suffix is malformed is treated as no key at all — never sent.
  const apiKey = bearerApiKeyOf(rawKey) ?? "";
  return { gatewayUrl, apiKey };
};
