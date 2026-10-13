/**
 * Gateway resolution + per-client model catalog for the runtime client
 * commands.
 *
 * The base URL is decided on EVERY launch rather than baked at install time
 * (which is what the old `--gateway local|cloud` install flag did): if a local
 * daemon answers on the loopback port, subscription models serve locally with
 * no cloud round trip; otherwise we fall back to the cloud origin. A daemon
 * that comes and goes therefore needs no reinstall.
 */

import type { TCliConfig } from "../env";
import { cliConfig, openllmDir, sharedFileConfig } from "../env";
import {
  DEFAULT_DAEMON_PORT,
  DEV_DEFAULT_DAEMON_PORT,
  isOpenllmDevMode,
  parseOpenllmDaemonPort,
} from "../runtime-contracts";

/**
 * How long to wait for the local daemon's /status before falling back. A
 * stopped daemon refuses the loopback connect instantly; this bounds only a
 * wedged one, so a launch never hangs on the check.
 */
const PROBE_TIMEOUT_MS = 250;
/** Catalog fetches are best-effort; a slow gateway must not stall a launch. */
export const CATALOG_TIMEOUT_MS = 8_000;

/** The daemon port: process env → this environment's file (`.dev.env` in
 *  dev, `.env` otherwise) → 8788 in dev / 8787 otherwise. */
export const daemonPort = (): number => {
  const fallback = isOpenllmDevMode()
    ? DEV_DEFAULT_DAEMON_PORT
    : DEFAULT_DAEMON_PORT;
  const raw =
    process.env.OPENLLM_DAEMON_PORT ??
    sharedFileConfig().OPENLLM_DAEMON_PORT ??
    String(fallback);
  return parseOpenllmDaemonPort(raw, fallback);
};

export type TGateway = {
  /** Base origin the client should talk to (no trailing slash, no `/v1`). */
  readonly base: string;
  /** The user's `sk-llm-…` key (empty when unpaired). */
  readonly apiKey: string;
  /** Cloud origin — always the real gateway, used for catalog fetches. */
  readonly cloudOrigin: string;
  /** True when `base` is this machine's daemon. */
  readonly local: boolean;
};

/** Probes in flight, per port: concurrent resolutions share ONE probe, but a
 *  settled result is never reused — a later call re-checks, so a daemon that
 *  starts or stops mid-process is seen. */
const probes = new Map<number, Promise<boolean>>();
let lastProbedPort: number | null = null;

/** Is a local daemon reachable right now? */
export const daemonReachable = (port: number): Promise<boolean> => {
  if (lastProbedPort !== null && lastProbedPort !== port) {
    clearDaemonProbeCache();
  }
  lastProbedPort = port;
  const inFlight = probes.get(port);
  if (inFlight !== undefined) return inFlight;
  const probe = probeDaemon(port).finally(() => {
    if (probes.get(port) === probe) probes.delete(port);
  });
  probes.set(port, probe);
  return probe;
};

/** Drop in-flight daemon reachability probes (e.g. after a port change). */
export const clearDaemonProbeCache = (): void => probes.clear();

const probeDaemon = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * Resolve the base URL this launch hands the client.
 *
 * AUTOMATIC: a fast probe of this machine's daemon on the environment's
 * `OPENLLM_DAEMON_PORT`. Answering → `http://127.0.0.1:<port>`, so
 * subscription models serve locally with no cloud round trip. Not answering →
 * the environment's `OPENLLM_CLOUD_ORIGIN`, where origin tunnels subscription
 * hops over the relay to an online device that serves them — so the cloud is
 * a complete answer, not a degraded one, and no flag is needed to choose it.
 *
 * `OPENLLM_GATEWAY=local|cloud` forces the choice for scripting and tests and
 * outranks the probe.
 */
export const resolveGateway = async (opts?: {
  /** Credential-gate result for this launch; keeps the validated snapshot and
   * avoids a second configuration-file read after interactive setup. */
  readonly config?: TCliConfig;
}): Promise<TGateway> => {
  const { gatewayUrl, apiKey } = opts?.config ?? cliConfig();
  const port = daemonPort();
  const localBase = `http://127.0.0.1:${port}`;
  const cloud = {
    base: gatewayUrl,
    apiKey,
    cloudOrigin: gatewayUrl,
    local: false,
  };
  const forced = process.env.OPENLLM_GATEWAY;
  if (forced === "cloud") return cloud;
  if (forced === "local") {
    return { base: localBase, apiKey, cloudOrigin: gatewayUrl, local: true };
  }
  const local = await daemonReachable(port);
  return {
    base: local ? localBase : gatewayUrl,
    apiKey,
    cloudOrigin: gatewayUrl,
    local,
  };
};

/**
 * Fetch a client's model catalog from the gateway. Best-effort: returns null on
 * any failure so a launch degrades to the overlay's built-in fallback models
 * rather than failing. Always fetched from the CLOUD origin — the catalog is
 * derived from the user's activated models server-side, which the local daemon
 * does not compute.
 */
export const fetchModelCatalog = async (
  gateway: TGateway,
  slug: string,
): Promise<string | null> => {
  if (gateway.apiKey.length === 0) return null;
  try {
    const res = await fetch(
      `${gateway.cloudOrigin}/api/setup/${slug}/model-catalog`,
      {
        headers: { authorization: `Bearer ${gateway.apiKey}` },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim().length === 0 ? null : text;
  } catch {
    return null;
  }
};

/**
 * The account tier for this launch, read from `/api/user`'s `tier` field. Only
 * `"free"` changes launch behavior (drops the paid code-search MCP group), so
 * every failure mode — no key, non-200, missing/unknown field, timeout — returns
 * `undefined`, which the launch planner treats as PAID. Failing open keeps a
 * paying user's full toolset on a flaky read; the backend gate is the real
 * authority either way. Best-effort and fast: a slow gateway must not stall a
 * launch (same `CATALOG_TIMEOUT_MS` budget as the catalog fetch).
 */
export const fetchTier = async (
  gateway: TGateway,
): Promise<"free" | "trial" | "pro" | undefined> => {
  if (gateway.apiKey.length === 0) return undefined;
  try {
    const res = await fetch(`${gateway.cloudOrigin}/api/user`, {
      headers: { authorization: `Bearer ${gateway.apiKey}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tier?: unknown };
    return body.tier === "free" || body.tier === "trial" || body.tier === "pro"
      ? body.tier
      : undefined;
  } catch {
    return undefined;
  }
};

/** claude-context's on-disk state dir (wire-stable name, every client). */
export const contextStateDir = (): string =>
  process.env.CLAUDE_CONTEXT_STATE_DIR ??
  `${openllmDir()}/plugin-state/claude-context`;
