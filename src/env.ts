/**
 * CLI runtime configuration. The CLI shares the ONE OpenLLM config file —
 * `<OpenLLM root>/.env` — with the daemon (and any future tool): the daemon's
 * installer/pairing writes `OPENLLM_CLOUD_ORIGIN` + `OPENLLM_API_KEY` there,
 * and the CLI respects them, so a re-pair or a custom origin (a preview
 * deployment, a self-host) applies product-wide without separate config.
 *
 * Resolution order per value:
 *
 *   1. process env — `OPENLLM_CLOUD_ORIGIN` / `OPENLLM_API_KEY`
 *   2. `<OpenLLM root>/.env` (KEY=VALUE lines — the shared file; the same
 *      OPENLLM_* keys the daemon reads/writes)
 *   3. the compile-time cloud-origin default (`--define` bake) for the URL
 *
 * The version identity is baked at compile (`__OPENLLM_CLI_VERSION__`);
 * source runs carry the `0.0.0-dev` sentinel the dev guards key on.
 * The constant itself lives in `cli-version.ts` so self-version dispatch
 * never imports this module.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TUpdateRouteConfig } from "@openllmsh/protocol/update-policy";
import { resolveUpdateSetting } from "@openllmsh/protocol/update-policy";

import { parseOpenllmDaemonPort } from "./runtime-contracts";

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

/** Resolve symlinks in the existing part of a path, including when the final
 *  file has not been created yet. Used at isolation boundaries so aliases
 *  through /tmp, PATH, or a symlinked home cannot reach production state. */
export const canonicalPath = (path: string): string => {
  const absolute = resolve(path);
  let cursor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(cursor);
      return resolve(real, ...suffix.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      suffix.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
};

export const isIsolatedStateRoot = (): boolean =>
  process.env.OPENLLM_DAEMON_STATE_DIR !== undefined;

export const isProductionOpenllmPath = (path: string): boolean => {
  const productionRoot = canonicalPath(join(userHome(), ".openllm"));
  const candidate = canonicalPath(path);
  const rel = relative(productionRoot, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/**
 * The shared OpenLLM root — `~/.openllm` by default, or the configured daemon
 * state root for an isolated run. Resolved lazily so a child launched under a
 * different HOME or state override never captures the caller's path.
 */
export const openllmDir = (): string => {
  const override = process.env.OPENLLM_DAEMON_STATE_DIR;
  if (override === undefined) return join(userHome(), ".openllm");
  if (override.length === 0 || !isAbsolute(override)) {
    throw new Error(
      "OPENLLM_DAEMON_STATE_DIR must be a non-empty absolute path",
    );
  }
  const productionRoot = canonicalPath(join(userHome(), ".openllm"));
  const isolatedRoot = canonicalPath(override);
  const relativeToProduction = relative(productionRoot, isolatedRoot);
  if (
    relativeToProduction === "" ||
    (relativeToProduction !== ".." &&
      !relativeToProduction.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToProduction))
  ) {
    throw new Error(
      "OPENLLM_DAEMON_STATE_DIR must not point inside ~/.openllm",
    );
  }
  return override;
};

/**
 * The daemon-owned state root used by durable session hosts. The CLI and
 * daemon share this root so both binaries scan the same socket registry.
 *
 * The override must be an absolute path. Session-host discovery reaps stale
 * entries with a recursive delete, so a relative root would resolve against
 * the invoking directory.
 */
export const daemonStateDir = (): string => {
  return openllmDir();
};
/**
 * The shared OpenLLM environment file. An installed daemon pins this path in
 * `OPENLLM_DAEMON_ENV_FILE`; honouring that override keeps CLI onboarding and
 * daemon persistence on the one configured file (including custom installs).
 */
export const sharedEnvFile = (): string => {
  const override = process.env.OPENLLM_DAEMON_ENV_FILE;
  const path =
    override !== undefined && override.length > 0 && isAbsolute(override)
      ? override
      : join(openllmDir(), ".env");
  if (isIsolatedStateRoot() && isProductionOpenllmPath(path)) {
    throw new Error(
      "OPENLLM_DAEMON_ENV_FILE must not point inside ~/.openllm during isolated operation",
    );
  }
  return path;
};
export const cliBinPath = (): string => join(openllmDir(), "bin", "openllm");

/**
 * Header carrying the per-boot local caller token on the daemon's `/v1/*`
 * surface — mirrors `LOCAL_CALLER_TOKEN_HEADER` in
 * `packages/daemon/src/cors.ts` (the CLI is self-contained: no workspace
 * imports, so the wire string is duplicated deliberately).
 */
export const LOCAL_CALLER_TOKEN_HEADER = "x-openllm-local-token";

/**
 * Env override for the local caller token. First-party children the CLI or
 * daemon launches (vendor CLIs, hook scripts, the MCP server) inherit it so
 * they authenticate to `/v1/*` even where the token file is unreadable; a
 * bare local process reads the `0600` file instead.
 */
export const LOCAL_CALLER_TOKEN_ENV = "OPENLLM_LOCAL_TOKEN";

/** The daemon's default loopback port — wire-stable, mirrors
 *  `DEFAULT_DAEMON_PORT` / `DEV_DEFAULT_DAEMON_PORT` in
 *  `packages/daemon/src/env.ts`. */
const DEFAULT_DAEMON_PORT = 8787;
const DEV_DEFAULT_DAEMON_PORT = 8788;

/** The loopback port this CLI expects the daemon on (env or shared config). */
export const daemonPort = (): number => {
  const raw =
    process.env.OPENLLM_DAEMON_PORT ??
    sharedFileConfig().OPENLLM_DAEMON_PORT ??
    String(DEFAULT_DAEMON_PORT);
  return parseOpenllmDaemonPort(raw, DEFAULT_DAEMON_PORT);
};

/**
 * The loopback ports the per-boot local caller token may be sent to: the
 * configured daemon port, plus the dev default while `OPENLLM_DAEMON_DEV=1`
 * (a dev daemon isolates itself on 8788). Token stamping is port-bound —
 * without it, any redirect to an arbitrary local port could harvest the
 * loopback credential and ride the real daemon's `/v1/*` surface with it.
 */
export const daemonTokenPorts = (): ReadonlySet<number> =>
  new Set(
    process.env.OPENLLM_DAEMON_DEV === "1"
      ? [daemonPort(), DEV_DEFAULT_DAEMON_PORT]
      : [daemonPort()],
  );

/** Wire-stable basename of the token file under the daemon state root —
 *  mirrors `LOCAL_CALLER_TOKEN_FILE` in `packages/daemon/src/env.ts`. Dev
 *  daemons isolate theirs as `<name>.dev`. */
const LOCAL_CALLER_TOKEN_FILE = "local-caller-token";

/**
 * The daemon's per-boot local caller token — the loopback-only credential a
 * first-party local client presents to `/v1/*` (via
 * {@link LOCAL_CALLER_TOKEN_HEADER} or `Authorization: Bearer`) instead of
 * the user's `sk-llm`. The daemon swaps it for the paired key before any
 * upstream call, so a captured token is useless off this machine.
 *
 * Resolution order: {@link LOCAL_CALLER_TOKEN_ENV} (inherited by launched
 * children), then the `0600` file under the daemon state root. A caller
 * carrying `OPENLLM_DAEMON_DEV=1` prefers the dev-isolated file. Null when no
 * daemon has minted one — callers keep the `sk-llm` bearer, which the daemon
 * also accepts.
 */
export const localCallerToken = (): string | null => {
  const fromEnv = process.env[LOCAL_CALLER_TOKEN_ENV]?.trim();
  if (fromEnv !== undefined && /^[0-9a-f]{64}$/.test(fromEnv)) return fromEnv;
  const dir = daemonStateDir();
  const names =
    process.env.OPENLLM_DAEMON_DEV === "1"
      ? [`${LOCAL_CALLER_TOKEN_FILE}.dev`, LOCAL_CALLER_TOKEN_FILE]
      : [LOCAL_CALLER_TOKEN_FILE, `${LOCAL_CALLER_TOKEN_FILE}.dev`];
  for (const name of names) {
    try {
      const token = fs.readFileSync(join(dir, name), "utf-8").trim();
      if (/^[0-9a-f]{64}$/.test(token)) return token;
    } catch {
      // absent/unreadable — try the next candidate
    }
  }
  return null;
};

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

/** Update-only channel settings, with process environment taking precedence. */
export const cliUpdateRoute = (): TUpdateRouteConfig => {
  const file = sharedFileConfig();
  const configuredOrigin =
    process.env.OPENLLM_CLOUD_ORIGIN ?? file.OPENLLM_CLOUD_ORIGIN;
  return {
    channel: resolveUpdateSetting(
      process.env.OPENLLM_UPDATE_CHANNEL,
      file.OPENLLM_UPDATE_CHANNEL,
    ),
    gatewayOrigin: cliConfig().gatewayUrl,
    gatewayOriginExplicit:
      configuredOrigin !== undefined && configuredOrigin.trim().length > 0,
  };
};
