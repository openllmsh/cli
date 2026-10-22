/**
 * Per-turn Muse execution overlay — fresh HOME + isolated XDG with ONLY a
 * symlink to the provider-owned auth.json and a gateway-written settings.json.
 *
 * Durable auth (delegation) lives at:
 *   `$providerHome/.config/muse/auth.json` (= cliConfigDir("muse")/auth.json)
 *
 * Official muse-bin has no `MUSE_SETTINGS_PATH` / `--settings` override (static
 * string scan of 1.3.0-R3401.1). Settings are only read from
 * `$XDG_CONFIG_HOME/muse/settings.json` (ACP mcp-overlay same contract). So
 * per-request MCP/model settings MUST be a real file under a private overlay
 * config home — never written into the durable provider settings.json
 * (concurrent turns would clobber each other and leave bearer tokens after
 * cleanup). Auth is the sole durable link (symlink), matching ACP's
 * mirror-except-settings pattern. Atomic replace of auth.json through a leaf
 * symlink can leave the durable file unchanged — accepted limitation without
 * an official split-config path; do not “fix” by sharing XDG_CONFIG_HOME.
 *
 * Callers MUST place `parentDir` OUTSIDE the MSP `workspaceRoot`. Absolute-path
 * reads of HOME are a residual host-policy risk.
 */

import { chmodSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { MUSE_CREDENTIAL_BACKEND } from "../cli-paths";
import { daemonTempDir } from "../sandbox/working-set";
import type { TMuseMcpServer } from "./muse-mcp-server";

/**
 * Serve-compatible Meta endpoint override written into overlay settings.json.
 *
 * Offline-proven against muse-bin 1.4.0-R4302.1 enterprise defaults:
 * `settings.endpoint_transport.base_url` + `auth:"bearer"` is active and
 * user-overridable. Flat `settings.base_url` is rejected (`unknown_member`).
 * Live subscription-OAuth + off-door bearer compatibility remains unproven —
 * callers must not claim that path from this type alone.
 */
export type TMuseEndpointTransportSettings = {
  readonly base_url: string;
  readonly auth: "bearer";
};

/**
 * `tools.web_search.mode` (native `WebSearchMode`, static string-table
 * evidence: `settings.rs`). `"hosted"` makes the vendor backend execute the
 * search and fold results into the turn (`web_search_call` stream items,
 * no caller round-trip); live-verified against muse-bin 1.4.0-R4302.1 via
 * `runMuseNativeCapture`'s own overlay seam — see
 * `tmp/bridge-capture-benchmark/muse-native-search-hosted-events.ndjson`.
 * `"client"` is only the currently-observed unset behavior on this muse-bin
 * build, not asserted as a documented/universal default; this overlay never
 * writes it.
 */
export type TMuseWebSearchMode = "hosted";

export type TMuseOverlay = {
  /**
   * Env overlay merged onto a cleaned Muse spawn env. Replaces HOME and all
   * XDG_* / CODEX_HOME so ambient skill roots cannot load. `MUSE_AUTH_PATH`
   * always points at the durable provider auth.json (symlink target) so the
   * official bash launcher (which reads `MUSE_AUTH_PATH`, then execs muse-bin)
   * cannot lose the store when overlay HOME differs; muse-bin itself resolves
   * credentials via XDG/`TBH_CREDENTIAL_BACKEND`, not `MUSE_AUTH_PATH`.
   *
   * Also re-pins `TBH_CREDENTIAL_BACKEND=file`, `MUSE_NO_AUTO_UPDATE=1`, and
   * `MUSE_LOGIN=0` so a sparse MuseClient.spawn `env` (Node replaces
   * `process.env` entirely) cannot omit the file backend and open Keychain.
   */
  readonly env: {
    readonly HOME: string;
    readonly XDG_CONFIG_HOME: string;
    readonly XDG_DATA_HOME: string;
    readonly XDG_STATE_HOME: string;
    readonly CODEX_HOME: string;
    readonly MUSE_AUTH_PATH: string;
    readonly TBH_CREDENTIAL_BACKEND: typeof MUSE_CREDENTIAL_BACKEND;
    readonly MUSE_NO_AUTO_UPDATE: "1";
    readonly MUSE_LOGIN: "0";
  };
  /** Absolute overlay muse/settings.json (tests / diagnostics). */
  readonly settingsPath: string;
  readonly cleanup: () => Promise<void>;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const PRIVATE_DIR_MODE = 0o700;

/**
 * Create each missing directory component from `base` down to `path` as
 * mode 0700, then `chmod` each newly created dir to 0700.
 *
 * Node/`fs.mkdir({ recursive: true, mode })` only applies `mode` to the LAST
 * component; intermediates get `0777 & ~umask`. Under a systemd user unit with
 * `UMask=0002` that yields group-writable `0775` ancestors, which muse-bin
 * rejects (`UnsafePath` on the session deletion registry). Creating one
 * component at a time with an explicit post-create chmod keeps every overlay
 * ancestor private regardless of umask. Does not change process umask.
 */
export const mkdirPrivate = async (
  path: string,
  base: string,
): Promise<void> => {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(path);
  if (
    resolvedPath !== resolvedBase &&
    !resolvedPath.startsWith(`${resolvedBase}${sep}`)
  ) {
    throw new Error(
      `mkdirPrivate: ${resolvedPath} is not under base ${resolvedBase}`,
    );
  }
  const rel = relative(resolvedBase, resolvedPath);
  if (rel.length === 0) return;
  let current = resolvedBase;
  for (const part of rel.split(sep)) {
    if (part.length === 0 || part === ".") continue;
    current = join(current, part);
    try {
      await mkdir(current, { mode: PRIVATE_DIR_MODE });
      chmodSync(current, PRIVATE_DIR_MODE);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
};

/**
 * Resolve the durable provider auth.json from the pre-overlay env.
 *
 * Requires a non-empty `HOME` (uses `XDG_CONFIG_HOME` when set). Refuses the
 * host `homedir()` fallback — an empty/missing HOME would otherwise pin
 * `MUSE_AUTH_PATH` at the interactive user store while overlay HOME is a
 * fresh temp tree (the scratch Keychain-incident mismatch).
 */
export const museAuthJsonPath = (
  env: NodeJS.ProcessEnv | Record<string, string>,
): string => {
  const home = env.HOME?.trim() ?? "";
  if (home.length === 0) {
    throw new Error(
      "museAuthJsonPath requires a non-empty HOME (refusing host homedir fallback)",
    );
  }
  const configHomeRaw = env.XDG_CONFIG_HOME?.trim() ?? "";
  const configHome =
    configHomeRaw.length > 0 ? configHomeRaw : join(home, ".config");
  return join(configHome, "muse", "auth.json");
};

const linkAuthIfPresent = (sourceAuth: string, destAuth: string): void => {
  try {
    const st = lstatSync(sourceAuth);
    if (!st.isFile() && !st.isSymbolicLink()) return;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  symlinkSync(sourceAuth, destAuth);
};

/**
 * Create a mode-0700 turn overlay. Fresh HOME + XDG config; auth.json
 * symlinked from the durable provider store; settings.json written ONLY in
 * the overlay (MCP + model). Never mutates durable settings.json. Cleans up
 * the root on any setup failure so partial overlays do not leak.
 */
export const createMuseExecutionOverlay = async (params: {
  readonly baseEnv: NodeJS.ProcessEnv | Record<string, string>;
  readonly mcp: TMuseMcpServer | null;
  readonly modelId?: string;
  readonly providerId?: string;
  /**
   * Optional Meta endpoint redirect for bridge-capture. Written as nested
   * `endpoint_transport` only — never as flat `base_url` / `api_base_url`.
   */
  readonly endpointTransport?: TMuseEndpointTransportSettings;
  /** Capture-only seam — see {@link TMuseWebSearchMode}. Omit for the bridge's default (unchanged) behavior. */
  readonly webSearchMode?: TMuseWebSearchMode;
  readonly parentDir?: string;
}): Promise<TMuseOverlay> => {
  // Validate durable auth resolution BEFORE allocating overlay dirs so a
  // missing/empty base HOME fails closed without leaving a temp tree.
  const durableAuth = museAuthJsonPath(params.baseEnv);

  const root = await mkdtemp(
    join(params.parentDir ?? daemonTempDir(), "muse-overlay-"),
  );
  chmodSync(root, 0o700);

  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };

  try {
    // Fresh HOME — not the provider home — so ~/.agents, ~/.claude, ~/.codex
    // from the durable tree cannot load. Auth is the only durable link.
    const home = join(root, "home");
    const configHome = join(home, ".config");
    const dataHome = join(home, ".local", "share");
    const stateHome = join(home, ".local", "state");
    const codexHome = join(home, ".codex");
    const museDir = join(configHome, "muse");
    // One component at a time + chmod: recursive mkdir only modes the leaf,
    // so umask 002 would otherwise leave `.local` (etc.) group-writable.
    await mkdirPrivate(home, root);
    await mkdirPrivate(configHome, root);
    await mkdirPrivate(museDir, root);
    await mkdirPrivate(dataHome, root);
    await mkdirPrivate(stateHome, root);
    await mkdirPrivate(codexHome, root);

    linkAuthIfPresent(durableAuth, join(museDir, "auth.json"));

    const mcpServers =
      params.mcp === null
        ? {}
        : {
            [params.mcp.name]: {
              type: "http",
              mode: "required",
              url: params.mcp.url,
              headers: Object.fromEntries(
                params.mcp.headers.map(({ name, value }) => [name, value]),
              ),
            },
          };

    const settings: Record<string, unknown> = {
      schema_version: 1,
      mcpServers,
      ...(params.modelId !== undefined ? { model: params.modelId } : {}),
      ...(params.providerId !== undefined
        ? { provider: params.providerId }
        : {}),
      ...(params.endpointTransport !== undefined
        ? {
            endpoint_transport: {
              base_url: params.endpointTransport.base_url,
              auth: params.endpointTransport.auth,
            },
          }
        : {}),
      ...(params.webSearchMode !== undefined
        ? { tools: { web_search: { mode: params.webSearchMode } } }
        : {}),
    };
    const settingsPath = join(museDir, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(settingsPath, 0o600);

    return {
      env: {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: codexHome,
        // Launcher-only override (muse-bin does not read this). Pin the durable
        // store so a launcher entrypoint never depends solely on the overlay symlink.
        MUSE_AUTH_PATH: durableAuth,
        // Keychain-safe pins — required when MuseClient.spawn replaces process.env.
        TBH_CREDENTIAL_BACKEND: MUSE_CREDENTIAL_BACKEND,
        MUSE_NO_AUTO_UPDATE: "1",
        MUSE_LOGIN: "0",
      },
      settingsPath,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
};
