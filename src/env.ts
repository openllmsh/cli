/**
 * CLI runtime configuration. The CLI shares the ONE OpenLLM config file —
 * `~/.openllm/.env` — with the daemon (and any future tool): the daemon's
 * installer/pairing writes `OPENLLM_CLOUD_ORIGIN` + `OPENLLM_API_KEY` there,
 * and the CLI respects them, so a re-pair or a custom origin (a preview
 * deployment, a self-host) applies product-wide without separate config.
 *
 * Resolution order per value:
 *
 *   1. process env — `LLM_GATEWAY_URL` / `LLM_GATEWAY_API_KEY` (the contract
 *      the MCP mapping + hooks carry), or the legacy `GATEWAY_URL` /
 *      `GATEWAY_API_KEY` aliases, or the shared `OPENLLM_CLOUD_ORIGIN` /
 *      `OPENLLM_API_KEY` names
 *   2. `~/.openllm/.env` (KEY=VALUE lines — the shared file; the same
 *      OPENLLM_* keys the daemon reads/writes)
 *   3. the compile-time cloud-origin default (`--define` bake) for the URL
 *
 * The version identity is baked at compile (`__OPENLLM_CLI_VERSION__`);
 * source runs carry the `0.0.0-dev` sentinel the dev guards key on.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export const OPENLLM_DIR = join(homedir(), ".openllm");
/** The SHARED OpenLLM env file (same file the daemon boots from). The
 *  pre-rename `daemon.env` is read as a fallback for installs the daemon
 *  hasn't migrated yet — the CLI never writes either file. */
export const SHARED_ENV_FILE = join(OPENLLM_DIR, ".env");
const LEGACY_ENV_FILE = join(OPENLLM_DIR, "daemon.env");
export const CLI_BIN_PATH = join(OPENLLM_DIR, "bin", "openllmc");

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

/** The shared file's values — `.env` first, legacy `daemon.env` fallback
 *  (read-only: migrating the file is the daemon's job). */
const sharedFileConfig = (): Record<string, string> =>
  fs.existsSync(SHARED_ENV_FILE)
    ? parseEnvFile(SHARED_ENV_FILE)
    : parseEnvFile(LEGACY_ENV_FILE);

export type TCliConfig = {
  readonly gatewayUrl: string;
  /** Empty string when no key is configured — callers decide whether the
   *  operation needs one (`requireKey`). */
  readonly apiKey: string;
};

export const cliConfig = (): TCliConfig => {
  const file = sharedFileConfig();
  const gatewayUrl = (
    process.env.LLM_GATEWAY_URL ??
    process.env.GATEWAY_URL ??
    process.env.OPENLLM_CLOUD_ORIGIN ??
    file.LLM_GATEWAY_URL ??
    file.OPENLLM_CLOUD_ORIGIN ??
    CLOUD_ORIGIN_DEFAULT
  ).replace(/\/+$/, "");
  const apiKey =
    process.env.LLM_GATEWAY_API_KEY ??
    process.env.GATEWAY_API_KEY ??
    process.env.OPENLLM_API_KEY ??
    file.LLM_GATEWAY_API_KEY ??
    file.OPENLLM_API_KEY ??
    "";
  return { gatewayUrl, apiKey };
};

/** Resolve config and fail loud (stderr + exit 1) when no key is present. */
export const requireKeyedConfig = (): TCliConfig => {
  const cfg = cliConfig();
  if (cfg.apiKey.length === 0) {
    process.stderr.write(
      "[openllmc] No API key configured — set LLM_GATEWAY_API_KEY (env), or pair the daemon so ~/.openllm/.env carries OPENLLM_API_KEY\n",
    );
    process.exit(1);
  }
  return cfg;
};
