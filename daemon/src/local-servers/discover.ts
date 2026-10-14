/**
 * Loopback local-model-server discovery.
 *
 * Probes `http://127.0.0.1:<port>/v1/models` for every well-known preset
 * port plus optional `OPENLLM_LOCAL_PORTS` extras. Security posture mirrors
 * the buzz-integration reference: literal 127.0.0.1 only (no DNS),
 * `redirect: "manual"`, 1 MB body cap, bounded concurrency, single-flight
 * scan, 2 s timeout. Keys never appear in the returned state — only
 * `has_key`.
 */
import type {
  TDaemonModelReportEntry,
  TLocalServerState,
  TProviderModelEntry,
  TProviderModelList,
} from "@openllmsh/protocol";
import {
  LOCAL_SERVER_PRESETS,
  localPortSlug,
  localServerPresetByPort,
} from "@openllmsh/protocol";
import { requestStatusPush } from "../auth-events";
import { reportModels } from "../cloud-client";
import { logWarn, safeDiagnosticMessage } from "../logger";
import { localKeyForPort } from "./keys";

/** Connect / probe deadline. A local port answers fast or is gone. */
const PROBE_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT_PROBES = 4;
/** Periodic rescan cadence. */
export const LOCAL_SCAN_INTERVAL_MS = 60_000;

type TProbeResult = {
  readonly status: number;
  /** `null` when the body exceeded the cap and was abandoned. */
  readonly text: string | null;
  readonly headers: Headers;
};

let activeProbes = 0;
const probeWaiters: Array<() => void> = [];

const acquireProbeSlot = async (): Promise<void> => {
  if (activeProbes < MAX_CONCURRENT_PROBES) {
    activeProbes += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    probeWaiters.push(resolve);
  });
  activeProbes += 1;
};

const releaseProbeSlot = (): void => {
  activeProbes -= 1;
  probeWaiters.shift()?.();
};

/** Read at most `MAX_BODY_BYTES`, abandoning the stream past the cap. */
const readCapped = async (res: Response): Promise<string | null> => {
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

/**
 * Probe `http://127.0.0.1:<port>/v1/models`. Auth header is OMITTED when
 * keyless (empty Bearer is rejected by several OpenAI-compatible servers).
 */
const probePort = async (
  port: number,
  apiKey: string | null,
): Promise<TProbeResult | null> => {
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> =
    apiKey !== null && apiKey.length > 0
      ? { Authorization: `Bearer ${apiKey}` }
      : {};
  await acquireProbeSlot();
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, text: "", headers: res.headers };
    }
    return {
      status: res.status,
      text: await readCapped(res),
      headers: res.headers,
    };
  } catch {
    return null;
  } finally {
    releaseProbeSlot();
  }
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * True when a 401/403 response looks like an OpenAI-compatible model server
 * asking for credentials — not an unrelated listener (e.g. macOS AirPlay on
 * :5000, which answers plain 403s). Plain status alone is not enough.
 */
export const looksLikeOpenAiCompatibleAuthChallenge = (
  status: number,
  text: string | null,
  headers: Headers,
): boolean => {
  if (status !== 401 && status !== 403) return false;
  const www = (headers.get("www-authenticate") ?? "").toLowerCase();
  if (
    www.includes("bearer") ||
    www.includes("basic") ||
    www.includes("api-key") ||
    www.includes("apikey")
  ) {
    return true;
  }
  if (text === null) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  try {
    const body: unknown = JSON.parse(trimmed);
    if (!isObject(body)) return false;
    if ("error" in body) return true;
    if (typeof body.message === "string") return true;
    if (typeof body.detail === "string" || Array.isArray(body.detail)) {
      return true;
    }
    if (typeof body.object === "string" && body.object === "error") return true;
    return false;
  } catch {
    return false;
  }
};

/** Keep only ports that are real model servers (reachable or auth-gated). */
const isReportableLocalServer = (state: TLocalServerState): boolean =>
  state.status === "ok" || state.status === "needs_key";

/**
 * Parse an OpenAI-compatible `/v1/models` body. Returns `null` when the body
 * is not valid JSON or lacks a `data` array — those must NOT be treated as a
 * reachable model server (plain HTTP 200 on a preset port is not enough).
 * An empty `data: []` is a valid empty listing.
 */
export const parseModels = (text: string): TProviderModelList | null => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const out: TProviderModelEntry[] = [];
  for (const entry of body.data) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (id.length === 0 || id.length > 128) continue;
    const display =
      typeof entry.name === "string"
        ? entry.name
        : typeof entry.display_name === "string"
          ? entry.display_name
          : undefined;
    out.push({
      provider_model_id: id,
      ...(display !== undefined && display.length > 0 && display.length <= 256
        ? { display_name: display }
        : {}),
    });
    if (out.length >= 1000) break;
  }
  return out;
};

/**
 * Fingerprint a responding port into a preset slug when possible. Port 8080
 * is shared by llama.cpp and LocalAI — use headers / model-id hints; else
 * fall back to `local_port_<port>`.
 */
export const fingerprintSlug = (
  port: number,
  headers: Headers,
  models: TProviderModelList,
): string => {
  const unique = localServerPresetByPort(port);
  if (unique !== null) return unique.slug;

  const server = (headers.get("server") ?? "").toLowerCase();
  const haystack = [
    server,
    ...models.map((m) => m.provider_model_id.toLowerCase()),
  ].join(" ");

  if (port === 8080) {
    if (
      haystack.includes("localai") ||
      haystack.includes("local-ai") ||
      server.includes("localai")
    ) {
      return "local_localai";
    }
    if (
      haystack.includes("llama.cpp") ||
      haystack.includes("llamacpp") ||
      haystack.includes("llama-cpp") ||
      server.includes("llama")
    ) {
      return "local_llamacpp";
    }
  }

  for (const preset of LOCAL_SERVER_PRESETS) {
    if (preset.defaultPort !== port) continue;
    const token = preset.slug.replace(/^local_/, "");
    if (
      haystack.includes(token) ||
      haystack.includes(preset.label.toLowerCase())
    ) {
      return preset.slug;
    }
  }

  return localPortSlug(port);
};

/** Ports to probe: presets (deduped) + `OPENLLM_LOCAL_PORTS` extras.
 *  Callers may pass an explicit `ports` list (e.g. a single port after a
 *  key change) instead of the env/preset set. */
export const portsToProbe = (
  env: NodeJS.ProcessEnv = process.env,
  opts?: { readonly ports?: ReadonlyArray<number> },
): ReadonlyArray<number> => {
  if (opts?.ports !== undefined) {
    return [...opts.ports].sort((a, b) => a - b);
  }
  const ports = new Set<number>();
  for (const preset of LOCAL_SERVER_PRESETS) {
    ports.add(preset.defaultPort);
  }
  const extra = env.OPENLLM_LOCAL_PORTS;
  if (typeof extra === "string" && extra.trim().length > 0) {
    for (const part of extra.split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
    }
  }
  return [...ports].sort((a, b) => a - b);
};

const probeOne = async (port: number): Promise<TLocalServerState> => {
  const baseUrl = `http://127.0.0.1:${port}`;
  const key = localKeyForPort(port);
  const hasKey = key !== null;
  const probe = await probePort(port, key);
  if (probe === null) {
    return {
      slug: localServerPresetByPort(port)?.slug ?? localPortSlug(port),
      port,
      base_url: baseUrl,
      status: "unreachable",
      has_key: hasKey,
      models: [],
    };
  }
  if (probe.status >= 300 && probe.status < 400) {
    // Redirect refused — treat as unreachable (SSRF hardening).
    return {
      slug: localServerPresetByPort(port)?.slug ?? localPortSlug(port),
      port,
      base_url: baseUrl,
      status: "unreachable",
      has_key: hasKey,
      models: [],
    };
  }
  if (probe.status === 401 || probe.status === 403) {
    if (
      !looksLikeOpenAiCompatibleAuthChallenge(
        probe.status,
        probe.text,
        probe.headers,
      )
    ) {
      // Unrelated listener (AirPlay, printers, …) — not a model server.
      return {
        slug: localServerPresetByPort(port)?.slug ?? localPortSlug(port),
        port,
        base_url: baseUrl,
        status: "unreachable",
        has_key: hasKey,
        models: [],
      };
    }
    return {
      slug: localServerPresetByPort(port)?.slug ?? localPortSlug(port),
      port,
      base_url: baseUrl,
      status: "needs_key",
      has_key: hasKey,
      models: [],
    };
  }
  if (probe.status < 200 || probe.status > 299 || probe.text === null) {
    return {
      slug: localServerPresetByPort(port)?.slug ?? localPortSlug(port),
      port,
      base_url: baseUrl,
      status: "unreachable",
      has_key: hasKey,
      models: [],
    };
  }
  const models = parseModels(probe.text);
  if (models === null) {
    // HTTP 200 that is not an OpenAI-compatible models listing.
    return {
      slug: localServerPresetByPort(port)?.slug ?? localPortSlug(port),
      port,
      base_url: baseUrl,
      status: "unreachable",
      has_key: hasKey,
      models: [],
    };
  }
  const slug = fingerprintSlug(port, probe.headers, models);
  return {
    slug,
    port,
    base_url: baseUrl,
    status: "ok",
    has_key: hasKey,
    models,
  };
};

/**
 * Cheap preflight: is anything listening on the port? Any HTTP answer
 * (including 401/404) counts as alive.
 */
export const preflightLocalPort = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
};

// ─── Scan state ──────────────────────────────────────────────────────────

let lastStates: ReadonlyArray<TLocalServerState> = [];
let inFlight: Promise<ReadonlyArray<TLocalServerState>> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

/**
 * Merge two discovery rows that share a provider slug (same server TYPE on
 * different ports, or a fingerprinted winner vs `local_port_*`). Unions
 * models; prefers `ok` over `needs_key`, then the preset's default port,
 * then the lower port. Used so status / UI show ONE row per type per device
 * even when two LM Studio ports answer.
 */
export const mergeLocalServerStates = (
  a: TLocalServerState,
  b: TLocalServerState,
): TLocalServerState => {
  const statusRank = (s: TLocalServerState["status"]): number => {
    if (s === "ok") return 0;
    if (s === "needs_key") return 1;
    return 2;
  };
  const defaultPort =
    LOCAL_SERVER_PRESETS.find((p) => p.slug === a.slug)?.defaultPort ?? null;
  const portScore = (port: number): number => {
    if (defaultPort !== null && port === defaultPort) return 0;
    return 1;
  };
  let winner = a;
  let loser = b;
  const byStatus = statusRank(a.status) - statusRank(b.status);
  if (
    byStatus > 0 ||
    (byStatus === 0 &&
      (portScore(a.port) > portScore(b.port) ||
        (portScore(a.port) === portScore(b.port) && a.port > b.port)))
  ) {
    winner = b;
    loser = a;
  }
  const seen = new Set(winner.models.map((m) => m.provider_model_id));
  const models = [...winner.models];
  let added = false;
  for (const model of loser.models) {
    if (seen.has(model.provider_model_id)) continue;
    seen.add(model.provider_model_id);
    models.push(model);
    added = true;
  }
  return added ? { ...winner, models } : winner;
};

/**
 * One logical server per provider slug. Port collisions are handled earlier;
 * this collapses e.g. two `local_lmstudio` ports into a single status row.
 */
export const collapseLocalServersBySlug = (
  states: ReadonlyArray<TLocalServerState>,
): ReadonlyArray<TLocalServerState> => {
  const bySlug = new Map<string, TLocalServerState>();
  for (const state of states) {
    const prev = bySlug.get(state.slug);
    if (prev === undefined) {
      bySlug.set(state.slug, state);
      continue;
    }
    bySlug.set(state.slug, mergeLocalServerStates(prev, state));
  }
  return [...bySlug.values()].sort((a, b) => a.port - b.port);
};

/**
 * Status / UI snapshot: at most one row per server TYPE. Serve lookups use
 * {@link localServerForModel} against the uncollapsed probe list so a model
 * that only exists on a secondary port is still dialed on that port.
 */
export const currentLocalServerStates = (): ReadonlyArray<TLocalServerState> =>
  collapseLocalServersBySlug(lastStates);

/** Look up a currently-ok server by provider slug (first match). */
export const localServerBySlug = (slug: string): TLocalServerState | null =>
  lastStates.find((s) => s.slug === slug && s.status === "ok") ?? null;

/**
 * Ok server for `slug` that currently lists `providerModelId`. Prefers the
 * port that actually advertised the model when the same type answers on
 * several ports.
 */
export const localServerForModel = (
  slug: string,
  providerModelId: string,
): TLocalServerState | null =>
  lastStates.find(
    (s) =>
      s.slug === slug &&
      s.status === "ok" &&
      s.models.some((m) => m.provider_model_id === providerModelId),
  ) ?? null;

/** True when `slug` currently lists `providerModelId` on any ok port. */
export const localServerHasModel = (
  slug: string,
  providerModelId: string,
): boolean => localServerForModel(slug, providerModelId) !== null;

/** Build `local_entries` for `POST /api/daemon/models` (replace semantics). */
export const localModelReportEntries =
  (): ReadonlyArray<TDaemonModelReportEntry> => {
    const byProvider = new Map<string, TProviderModelEntry[]>();
    for (const state of lastStates) {
      if (state.status !== "ok" || state.models.length === 0) continue;
      const existing = byProvider.get(state.slug) ?? [];
      const seen = new Set(existing.map((m) => m.provider_model_id));
      for (const model of state.models) {
        if (seen.has(model.provider_model_id)) continue;
        seen.add(model.provider_model_id);
        existing.push(model);
      }
      byProvider.set(state.slug, existing);
    }
    return [...byProvider.entries()].map(([provider, models]) => ({
      provider,
      models,
    }));
  };

/**
 * Cloud local-model report dirty flag. Starts true so the first scan always
 * reports (even when the snapshot is empty). Cleared only on a successful
 * `reportModels`; a failed/returned-error report leaves it set so the next
 * scan retries even if the snapshot itself did not change.
 */
let localReportDirty = true;

/** One cloud report in flight; a concurrent request coalesces into a trailing re-push. */
let reportInFlight: Promise<void> | null = null;
let reportQueued = false;

/**
 * Push the current local model snapshot to the cloud. Serializes reports: at
 * most one `reportModels` in flight; overlapping callers set a coalesce flag
 * so a trailing re-push runs with the latest `lastStates` after the current
 * one settles (avoids racing two replaces against the same device row).
 */
const pushLocalModels = (): Promise<void> => {
  if (reportInFlight !== null) {
    reportQueued = true;
    return reportInFlight;
  }
  reportInFlight = (async () => {
    // `entries: []` must not wipe oauth rows — cloud treats absent/empty
    // oauth entries as a no-op when `local_entries` is present (cloud side).
    // Until that lands, still send the local set so a supporting cloud can
    // replace this device's local rows.
    for (;;) {
      reportQueued = false;
      const local_entries = localModelReportEntries();
      try {
        const result = await reportModels({
          entries: [],
          local_entries: [...local_entries],
        });
        if (result.ok) {
          localReportDirty = false;
        } else {
          logWarn(
            "local-servers",
            safeDiagnosticMessage`local model report failed`,
            { err: result.error },
          );
        }
      } catch (err) {
        logWarn(
          "local-servers",
          safeDiagnosticMessage`local model report failed`,
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
      if (!reportQueued) break;
    }
  })().finally(() => {
    reportInFlight = null;
  });
  return reportInFlight;
};

/**
 * Run one full scan (single-flight). Updates status + pushes models when
 * the snapshot changes. Optional `ports` narrows the probe set (used after
 * a key change / manual rescan of a single port's peers).
 */
export const rescanLocalServers = async (opts?: {
  readonly ports?: ReadonlyArray<number>;
}): Promise<ReadonlyArray<TLocalServerState>> => {
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    const ports = portsToProbe(process.env, opts);
    const states = await Promise.all(ports.map((port) => probeOne(port)));
    // Deduplicate colliding 8080 presets: keep the fingerprinted winner;
    // drop a second row that shares the same port under another slug.
    const byPort = new Map<number, TLocalServerState>();
    for (const state of states) {
      const prev = byPort.get(state.port);
      if (prev === undefined) {
        byPort.set(state.port, state);
        continue;
      }
      // Prefer an `ok` result; then prefer a fingerprinted preset over
      // `local_port_*`.
      const prefer =
        (state.status === "ok" && prev.status !== "ok") ||
        (state.status === prev.status &&
          !state.slug.startsWith("local_port_") &&
          prev.slug.startsWith("local_port_"));
      if (prefer) byPort.set(state.port, state);
    }
    // Drop unreachable / non-API listeners from status + UI. Presets are
    // probed privately; only real model servers (ok / needs_key) surface.
    const next = [...byPort.values()]
      .filter(isReportableLocalServer)
      .sort((a, b) => a.port - b.port);
    const changed = JSON.stringify(next) !== JSON.stringify(lastStates);
    lastStates = next;
    if (changed) {
      requestStatusPush();
    }
    // Report when the snapshot changed OR a prior report is still dirty
    // (failed / never succeeded) so a transient cloud outage recovers on the
    // next tick without waiting for another discovery delta.
    if (changed || localReportDirty) {
      void pushLocalModels();
    }
    return lastStates;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
};

/** Re-probe a single port after a key change, then refresh the snapshot. */
export const rescanLocalPort = async (
  port: number,
): Promise<TLocalServerState> => {
  // Let an in-flight full scan settle first, or it would land afterwards and
  // overwrite this port's refreshed state with the pre-change probe.
  if (inFlight !== null) await inFlight.catch(() => undefined);
  const state = await probeOne(port);
  const without = lastStates.filter((s) => s.port !== port);
  lastStates = (
    isReportableLocalServer(state) ? [...without, state] : without
  ).sort((a, b) => a.port - b.port);
  requestStatusPush();
  void pushLocalModels();
  return state;
};

/** Start the boot + 60s discovery loop (idempotent). */
export const startLocalServerDiscovery = (): void => {
  if (started) return;
  started = true;
  void rescanLocalServers().catch((err) =>
    logWarn("local-servers", safeDiagnosticMessage`initial local scan failed`, {
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  scanTimer = setInterval(() => {
    void rescanLocalServers().catch(() => {});
  }, LOCAL_SCAN_INTERVAL_MS);
  // Don't keep the process alive solely for the scan timer.
  if (
    typeof scanTimer === "object" &&
    scanTimer !== null &&
    "unref" in scanTimer
  ) {
    scanTimer.unref();
  }
};

/** Stop the periodic scan and clear the in-memory snapshot (shutdown). */
export const stopLocalServerDiscovery = (): void => {
  if (scanTimer !== null) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  started = false;
  inFlight = null;
  lastStates = [];
  activeProbes = 0;
  probeWaiters.splice(0);
  localReportDirty = true;
  reportQueued = false;
  reportInFlight = null;
};

/**
 * Replace the in-memory discovery snapshot. Production uses this after a
 * successful scan; callers that already know the live set (e.g. a single
 * port refresh that merges into the prior snapshot) can also write it.
 */
export const replaceLocalServerSnapshot = (
  states: ReadonlyArray<TLocalServerState>,
): void => {
  lastStates = [...states].sort((a, b) => a.port - b.port);
};
