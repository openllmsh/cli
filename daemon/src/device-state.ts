/**
 * The daemon's view of the openllm CLI on this box.
 *
 * This used to be a manifest-driven WALK: for every registry item, fetch a
 * SHA-gated `install.sh` from the gateway and run it with `-s` to parse a
 * one-line JSON verdict, caching the result because the walk was expensive. All
 * of that is gone — clients are configured at RUN time by `openllm <client>`, so
 * there is nothing installed per client to probe, diverge, or stamp. See
 * `docs/proposals/remove-registry-runtime-config-merge.md`.
 *
 * What remains is the ONE piece of install state the dashboard needs: whether
 * the CLI binary is present and what version it reports. `--version` is owned
 * by the shared stamp-keyed cache (`cliVersion`); this module only parses
 * `openllm`/`openllmc` output and keeps a last-known snapshot so a status
 * push never blocks on a spawn.
 */

import type { TDaemonCliState } from "@openllmsh/protocol";
import { binarySignature } from "./bin-signature";
import { resolveOpenllmCli } from "./cli-self-update";
import { cliVersion } from "./delegation/util";
import { logDebug } from "./logger";

/** Last-known dashboard snapshot. Version subprocesses live in `cliVersion`. */
interface CliStateCache {
  path: string;
  signature: string | null;
  version: string | null;
}
let cache: CliStateCache = {
  path: "",
  signature: null,
  version: null,
};

const installedBinary = (): string | null => resolveOpenllmCli();

const parseOpenllmVersion = (out: string | null): string | null =>
  out?.match(/openllmc? v(\S+)/)?.[1] ?? null;

/**
 * Probe the CLI's presence + version. `cliVersion` coalesces and caches by
 * binary stamp; a missing binary is not installed and is not spawned.
 */
export const refreshCliState = async (): Promise<TDaemonCliState> => {
  const bin = installedBinary();
  if (bin === null) {
    cache = { path: "", signature: null, version: null };
    return { installed: false, version: null };
  }
  const signature = binarySignature(bin);
  const out = await cliVersion(bin);
  const version = parseOpenllmVersion(out);
  cache = { path: bin, signature, version };
  logDebug("device-state", "cli state", { installed: true, version });
  return { installed: true, version };
};

/**
 * The CLI state for a status push. A `statSync` is cheap enough to run on every
 * call: when the binary is unchanged it returns the last snapshot; when it
 * changed (or on first sight) it kicks a background refresh so the push is
 * never blocked on a spawn.
 */
export const getCliState = (): TDaemonCliState => {
  const bin = installedBinary();
  if (bin === null) {
    cache = { path: "", signature: null, version: null };
    return { installed: false, version: null };
  }
  if (cache.path === bin && cache.signature === binarySignature(bin)) {
    return { installed: true, version: cache.version };
  }
  void refreshCliState().catch(() => {
    // Best-effort: a failed probe keeps the previous value.
  });
  return {
    installed: true,
    version: cache.path === bin ? cache.version : null,
  };
};
