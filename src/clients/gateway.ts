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

import { cliConfig, openllmDir, sharedFileConfig } from "../env";

/** How long to wait for the local daemon's /status before falling back. */
const PROBE_TIMEOUT_MS = 400;
/** Catalog fetches are best-effort; a slow gateway must not stall a launch. */
const CATALOG_TIMEOUT_MS = 8_000;

const DEFAULT_DAEMON_PORT = 8787;

/** Load daemon configuration from env + shared file, defaulting to 8787. */
export const daemonPort = (): number => {
  const raw =
    process.env.OPENLLM_DAEMON_PORT ??
    sharedFileConfig().OPENLLM_DAEMON_PORT ??
    String(DEFAULT_DAEMON_PORT);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : DEFAULT_DAEMON_PORT;
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

/** Is a local daemon reachable right now? */
const daemonReachable = async (port: number): Promise<boolean> => {
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
 * LOCAL BY DEFAULT: the client points at this machine's daemon
 * (`http://127.0.0.1:<port>`), so subscription models serve locally with no
 * cloud round trip. `-r` (`remote: true`) points it at the cloud origin
 * instead, where subscription hops take the cloud's 307-redirect path back to
 * whichever daemon is live for that key.
 *
 * The local default is still PROBED: if no daemon answers, a local base URL
 * would hand the client an address nothing is listening on, so we fall back to
 * the cloud rather than launching something guaranteed to fail. `-r` skips the
 * probe entirely (it isn't asking about local).
 *
 * `OPENLLM_GATEWAY=local|cloud` forces the choice for scripting and tests and
 * outranks the probe; an explicit `-r` outranks both.
 */
export const resolveGateway = async (opts?: {
  readonly remote?: boolean;
}): Promise<TGateway> => {
  const { gatewayUrl, apiKey } = cliConfig();
  const port = daemonPort();
  const localBase = `http://127.0.0.1:${port}`;
  const cloud = {
    base: gatewayUrl,
    apiKey,
    cloudOrigin: gatewayUrl,
    local: false,
  };
  if (opts?.remote === true) return cloud;
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

/** claude-context's on-disk state dir (wire-stable name, every client). */
export const contextStateDir = (): string =>
  process.env.CLAUDE_CONTEXT_STATE_DIR ??
  `${openllmDir()}/plugin-state/claude-context`;
