/**
 * Authenticated HTTP client for the daemon's cloud control-plane calls.
 * Every request carries the user's `sk-llm-...` key as a bearer. The
 * cloud endpoints the daemon talks to:
 *
 *   GET  /api/daemon/bootstrap  — catalog + provider prefixes + routing
 *   POST /api/daemon/requests   — record one subscription-hop usage row
 *
 * No subscription token or user content ever appears in these payloads
 * (the no-off-box-exfiltration invariant — see the proposal §6).
 */
import { hostname } from "node:os";
import type {
  TDaemonBootstrap,
  TDaemonModelReport,
  TDaemonPlanResponse,
  TDaemonQuotaStatusReached,
  TDaemonRecordRequest,
  TDaemonSessionLost,
  TMediaDefaultRequest,
  TMediaPersistError,
  TPlanSurface,
  TRelayChannelResponse,
  TVideoJobPlanRequest,
} from "@openllmsh/protocol";
import {
  DAEMON_BOOTSTRAP_CAPS_HEADER,
  DAEMON_DEVICE_ID_HEADER,
  DAEMON_DEVICE_LABEL_HEADER,
  DaemonPlanResponse,
  EXECUTION_SELECTION2_CAP,
  encodeMediaDefaultPlanQuery,
  encodePlanSurfaceQueryValue,
  encodeVideoJobPlanQuery,
  MediaDefaultRequest,
  MODEL_CAPABILITIES_OPEN_CAP,
  PLAN_SURFACE_QUERY_KEY,
  RelayChannelResponse,
  SUB_METHOD_BRIDGE_CAPTURE_CAP,
  VideoJobPlanRequest,
} from "@openllmsh/protocol";
import { Schema } from "effect";
import { daemonEnv, deviceId } from "./env";
import { hasIdentityConflict, setIdentityConflict } from "./identity-state";
import { logWarn, safeDiagnosticMessage } from "./logger";

const decodeChannel = Schema.decodeUnknownSync(RelayChannelResponse);
const decodePlan = Schema.decodeUnknownSync(DaemonPlanResponse);
const decodeMediaDefault = Schema.decodeUnknownSync(MediaDefaultRequest);
const decodeVideoJobPlan = Schema.decodeUnknownSync(VideoJobPlanRequest);

/** Thrown when no API key is configured yet — the daemon is keyless. */
export class NoApiKeyError extends Error {
  constructor() {
    super("no API key configured");
    this.name = "NoApiKeyError";
  }
}

/** Thrown when the cloud rejects the key (401/403) — key invalid/stale. */
export class InvalidApiKeyError extends Error {
  constructor(status: number) {
    super(`cloud rejected the API key (${status})`);
    this.name = "InvalidApiKeyError";
  }
}

/**
 * Cloud HTTP 4xx for a media-default plan fetch. Distinct from
 * {@link InvalidApiKeyError} so the listener can echo the actionable
 * envelope (400 `no_media_default`, 402 budget, 401/403 auth) instead of
 * collapsing to a generic 502 or treating it as explicit-model passthrough.
 */
export class MediaDefaultPlanError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | undefined;
  constructor(status: number, message: string, type: string, code?: string) {
    super(message);
    this.name = "MediaDefaultPlanError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

const MAX_PLAN_ERROR_TEXT = 512;

const boundedText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > MAX_PLAN_ERROR_TEXT
    ? trimmed.slice(0, MAX_PLAN_ERROR_TEXT)
    : trimmed;
};

const fallbackMediaDefaultError = (
  status: number,
): { readonly message: string; readonly type: string } => {
  if (status === 401 || status === 403) {
    return {
      message: `cloud rejected the API key (${status})`,
      type: "auth_error",
    };
  }
  if (status === 402) {
    return {
      message: "OpenLLM: payment required — free tier exhausted",
      type: "free_tier_exhausted",
    };
  }
  if (status === 400) {
    return {
      message: "No media default is available for this request",
      type: "no_media_default",
    };
  }
  return {
    message: "Media default plan request failed",
    type: "request_error",
  };
};

const mediaDefaultPlanErrorFromResponse = async (
  resp: Response,
): Promise<MediaDefaultPlanError> => {
  const fallback = fallbackMediaDefaultError(resp.status);
  let message = fallback.message;
  let type = fallback.type;
  let code: string | undefined;
  try {
    const raw: unknown = await resp.json();
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const err = (raw as { error?: unknown }).error;
      if (err !== null && typeof err === "object" && !Array.isArray(err)) {
        const rec = err as Record<string, unknown>;
        message = boundedText(rec.message, fallback.message);
        type = boundedText(rec.type, fallback.type);
        if (typeof rec.code === "string" && rec.code.trim().length > 0) {
          const clipped = rec.code.trim().slice(0, MAX_PLAN_ERROR_TEXT);
          code = clipped;
        }
      }
    }
  } catch {
    // Malformed body keeps the status-specific fallback.
  }
  return new MediaDefaultPlanError(resp.status, message, type, code);
};

/**
 * Thrown when `GET /api/daemon/channel` returns 403 `device_limit_exceeded`.
 * Distinct from {@link InvalidApiKeyError}: the key is fine, the plan's
 * concurrent-device cap is full. Carries the numbers so logs/UI can render
 * "N of M devices" without a second round-trip.
 */
export class DeviceLimitExceededError extends Error {
  readonly deviceCap: number;
  readonly deviceCount: number;
  constructor(deviceCap: number, deviceCount: number) {
    super(`device limit exceeded (${deviceCount}/${deviceCap} active devices)`);
    this.name = "DeviceLimitExceededError";
    this.deviceCap = deviceCap;
    this.deviceCount = deviceCount;
  }
}

/**
 * Parse a 403 channel body for the structured device-limit envelope. Returns
 * the typed error when the body matches; `null` for any other 403 shape
 * (auth rejection, etc.) so the caller can fall through to InvalidApiKeyError.
 */
const parseDeviceLimitError = async (
  resp: Response,
): Promise<DeviceLimitExceededError | null> => {
  try {
    const body = (await resp.json()) as {
      error?: {
        type?: unknown;
        device_cap?: unknown;
        device_count?: unknown;
      };
    };
    const err = body.error;
    if (
      err !== undefined &&
      err.type === "device_limit_exceeded" &&
      typeof err.device_cap === "number" &&
      typeof err.device_count === "number" &&
      Number.isFinite(err.device_cap) &&
      Number.isFinite(err.device_count)
    ) {
      return new DeviceLimitExceededError(err.device_cap, err.device_count);
    }
  } catch {
    // Malformed body → treat as a generic key rejection below.
  }
  return null;
};

// `os.hostname()` is almost always plain ASCII, but a header value must be —
// strip anything outside printable ASCII and cap the length so an exotic
// hostname can't make `fetch` throw on an invalid header.
const deviceLabel = (): string =>
  hostname()
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 120);

const authHeaders = (): Record<string, string> => {
  const { apiKey } = daemonEnv();
  if (apiKey === null) throw new NoApiKeyError();
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    // Device identity (metadata only): the cloud records the latest value per
    // key on `api_key_activity` so the dashboard tells two daemons behind one
    // NAT apart — device code + IP, not IP alone. Rides every control call
    // (incl. the channel handshake) so it stays fresh. See
    // `docs/proposals/daemon-device-aware-this-machine.md`.
    [DAEMON_DEVICE_ID_HEADER]: deviceId(),
    [DAEMON_DEVICE_LABEL_HEADER]: deviceLabel(),
    // Capability negotiation (never version-gated):
    // - open model capabilities list (post image_editing/realtime widening)
    // - bridge-capture SubMethod tokens in active_sub_method(s)
    // - EXECUTION_SELECTION2_CAP (`@openllmsh/protocol`'s named-execution-
    //   variant bootstrap fields, `execution_selection`/
    //   `execution_selections`): `native-runtime/serve.ts` now resolves an
    //   explicit selection through `execution-registry.ts`'s
    //   `resolveExecutionSelection` for claude_code/chatgpt/cursor/muse hops
    //   (09-implementation-plan.md phase 5, "existing-path migration"), so
    //   advertising this cap is now a true behavioral claim rather than
    //   plumbing-only decode support. See
    //   docs/plan/bridge-variants-and-capture-adapters/09-implementation-plan.md §8.
    [DAEMON_BOOTSTRAP_CAPS_HEADER]: [
      MODEL_CAPABILITIES_OPEN_CAP,
      SUB_METHOD_BRIDGE_CAPTURE_CAP,
      EXECUTION_SELECTION2_CAP,
    ].join(","),
  };
};

// Cloud control-plane calls must never hang forever. Bun's `fetch` has NO
// default timeout, so a half-open TCP connection to the cloud — routine on a
// long-lived remote daemon after a network blip — stalls the request
// indefinitely. For `fetchChannel` this is fatal: partysocket awaits the URL
// provider INSIDE its reconnect lock (`_connectLock`), released only when the
// fetch settles. A hung channel fetch wedges the lock forever, so BOTH
// partysocket's auto-reconnect AND the daemon's liveness-watchdog `reconnect()`
// early-return — the daemon is stuck "connecting" until the process restarts.
// Bounding every call with an AbortSignal lets a stalled connection reject
// promptly so the channel loop's backoff (or the caller) retries cleanly.
/** Control-plane header budget. Origin inference reuses this only for
 *  waiting on headers — never as a stream cutoff. */
export const CLOUD_FETCH_TIMEOUT_MS = 15_000;
const MEDIA_UPLOAD_TIMEOUT_MS = 120_000;

const cloudFetch = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, {
    ...init,
    signal:
      init.signal != null
        ? AbortSignal.any([
            init.signal,
            AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
  });

// Default to the pinned cloud origin, but let the same-machine-307 path
// override per-request with the deployment that issued the redirect
// (`?__origin=`), so one daemon serves any deployment.
const cloudUrl = (path: string, origin?: string | null): string => {
  const base =
    origin !== undefined && origin !== null && origin.length > 0
      ? origin.replace(/\/+$/, "")
      : daemonEnv().cloudOrigin;
  return `${base}${path}`;
};

/**
 * One snapshot with the catalog + provider prefixes + the user's and
 * global fallback config. Pulled at boot + on a TTL by config.ts.
 * Throws `NoApiKeyError` when keyless and `InvalidApiKeyError` on
 * 401/403 so callers can distinguish "needs a key" from "key is bad".
 */
export const fetchBootstrap = async (): Promise<TDaemonBootstrap> => {
  const resp = await cloudFetch(cloudUrl("/api/daemon/bootstrap"), {
    method: "GET",
    headers: authHeaders(),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`bootstrap fetch failed: ${resp.status}`);
  return (await resp.json()) as TDaemonBootstrap;
};

/**
 * Fetch a signed plan for a DIRECT client request (local-first gateway,
 * `docs/proposals/local-first-gateway.md` §4.1): the same tuple a
 * same-machine 307 carries, as JSON — the request body never transits the
 * cloud. The caller MUST verify `sig` (`planSignatureOk`) before caching
 * or executing. Throws on keyless/rejected/unreachable so the listener
 * can fall back to passthrough.
 */
export const fetchPlan = async (
  model: string,
  estTokens: number,
  signal?: AbortSignal,
  surface?: TPlanSurface,
): Promise<TDaemonPlanResponse> => {
  const params = new URLSearchParams({ model });
  if (estTokens > 0) params.set("est_tokens", String(Math.ceil(estTokens)));
  // The surface this request is FOR, when the listener knows it (every
  // media endpoint does — it is decided by the path). Without it the
  // cloud can only resolve the name under its chat default, which for an
  // ambiguous family name (`grok` on `/v1/images/generations`) plans the
  // chat model while the cloud's own image handler would select the image
  // one. Omitted on chat, where the default IS the answer, so an older
  // plan cache key and an unbumped daemon keep behaving identically.
  if (surface !== undefined)
    params.set(PLAN_SURFACE_QUERY_KEY, encodePlanSurfaceQueryValue(surface));
  const resp = await cloudFetch(
    cloudUrl(`/api/daemon/plan?${params.toString()}`),
    { method: "GET", headers: authHeaders(), signal },
  );
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`plan fetch failed: ${resp.status}`);
  return decodePlan(await resp.json());
};

/**
 * Metadata-only media-default plan fetch (no `model` query, never prompt
 * or media bytes). The cloud resolver picks a subscription-first then
 * API-key model; the caller verifies `sig` before using the tuple.
 */
export const fetchMediaDefaultPlan = async (
  request: TMediaDefaultRequest,
  signal?: AbortSignal,
): Promise<TDaemonPlanResponse> => {
  const validated = decodeMediaDefault(request);
  const query = encodeMediaDefaultPlanQuery(validated);
  if (query === null) {
    throw new Error("invalid media default plan request");
  }
  const resp = await cloudFetch(cloudUrl(`/api/daemon/plan?${query}`), {
    method: "GET",
    headers: authHeaders(),
    signal,
  });
  if (resp.status >= 400 && resp.status < 500) {
    throw await mediaDefaultPlanErrorFromResponse(resp);
  }
  if (!resp.ok) throw new Error(`plan fetch failed: ${resp.status}`);
  return decodePlan(await resp.json());
};

/**
 * Metadata-only plan for an existing video job (poll/content/cancel).
 * `video_job={model,provider}` — never aliases, never cooldowns, never prompt.
 */
export const fetchVideoJobPlan = async (
  request: TVideoJobPlanRequest,
  signal?: AbortSignal,
): Promise<TDaemonPlanResponse> => {
  const validated = decodeVideoJobPlan(request);
  const query = encodeVideoJobPlanQuery(validated);
  if (query === null) {
    throw new Error("invalid video job plan request");
  }
  const resp = await cloudFetch(cloudUrl(`/api/daemon/plan?${query}`), {
    method: "GET",
    headers: authHeaders(),
    signal,
  });
  if (resp.status >= 400 && resp.status < 500) {
    throw await mediaDefaultPlanErrorFromResponse(resp);
  }
  if (!resp.ok) throw new Error(`plan fetch failed: ${resp.status}`);
  return decodePlan(await resp.json());
};

/**
 * Why this channel fetch is happening.
 *
 * - `dial` (default): a real (re)connect — cloud fires `daemon_connected`.
 * - `probe`: the healthy-socket migration check (`migrateIfRelayMoved`) —
 *   cloud skips `daemon_connected` so the 45s probe does not pollute the
 *   onboarding funnel (~60 events/h/daemon). Older daemons that omit the
 *   flag keep firing (acceptable until they update).
 */
export type TFetchChannelPurpose = "dial" | "probe";

export type TFetchChannelOptions = {
  readonly purpose?: TFetchChannelPurpose;
};

/**
 * Ask the cloud for a relay channel: `GET /api/daemon/channel`. Returns the
 * stable per-env WSS URL + a short-lived connect ticket the daemon presents in
 * its `hello` frame. The daemon then holds ONE WebSocket to the relay — its
 * only control transport. Throws `NoApiKeyError`/`InvalidApiKeyError` so the
 * channel loop can back off, and {@link DeviceLimitExceededError} when the
 * plan's concurrent-device cap is full (403 with a structured body — must NOT
 * be collapsed into InvalidApiKeyError, or a soft cap looks like a bad key).
 * See `docs/proposals/daemon-relay-websocket-push.md`.
 */
export const fetchChannel = async (
  options?: TFetchChannelOptions,
): Promise<TRelayChannelResponse> => {
  const purpose: TFetchChannelPurpose =
    options?.purpose === "probe" ? "probe" : "dial";
  const path =
    purpose === "probe"
      ? "/api/daemon/channel?purpose=probe"
      : "/api/daemon/channel";
  const resp = await cloudFetch(cloudUrl(path), {
    method: "GET",
    headers: authHeaders(),
  });
  if (resp.status === 403) {
    const deviceLimit = await parseDeviceLimitError(resp);
    if (deviceLimit !== null) throw deviceLimit;
    throw new InvalidApiKeyError(resp.status);
  }
  if (resp.status === 401) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`channel fetch failed: ${resp.status}`);
  // Validate before we dial: a malformed `wss_url`/`ticket` would otherwise
  // surface as a cryptic WebSocket construction failure. Throwing here routes
  // through the channel loop's backoff like any other channel-fetch error.
  const raw = await resp.text();
  if (raw.trim() === "") {
    throw new Error(
      `invalid channel response: empty body (status ${resp.status}, content-length ${resp.headers.get("content-length") ?? "unknown"})`,
    );
  }
  try {
    return decodeChannel(JSON.parse(raw));
  } catch (err) {
    throw new Error(
      `invalid channel response: status ${resp.status}: ${err instanceof Error ? err.message : "decode failed"}`,
    );
  }
};

/**
 * Lazy import: control-channel already imports this module. Push only on a
 * conflict *transition* so the dashboard sees the flag without an extra backoff.
 */
const pushIdentityConflictIfChanged = async (): Promise<void> => {
  const { pushStatusIfChanged } = await import("./control-channel");
  await pushStatusIfChanged("bootstrap");
};

/**
 * Publish this daemon's long-lived X25519 SPKI to the cloud so browser/fleet
 * peers pin against a cloud-attested identity (not solely relay status_push).
 * Best-effort: identity pin lag is non-fatal (RTC falls back to status_push).
 */
export const publishIdentity = async (pubkey: string): Promise<void> => {
  try {
    const response = await cloudFetch(cloudUrl("/api/daemon/identity"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ pubkey }),
    });
    if (response.status === 409) {
      let code: string | null = null;
      try {
        const body: unknown = await response.json();
        if (
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          body.error !== null &&
          typeof body.error === "object" &&
          "type" in body.error &&
          body.error.type === "identity_conflict"
        ) {
          code = "identity_conflict";
        }
      } catch {
        // A malformed conflict envelope remains non-fatal and unreported.
      }
      if (code === "identity_conflict") {
        const wasConflict = hasIdentityConflict();
        setIdentityConflict(true);
        logWarn(
          "identity",
          safeDiagnosticMessage`cloud pin conflicts with local X25519 key — RTC will fail until the pin is reset`,
          {},
        );
        // Push once per false→true; repeated 409s (bootstrap ~5min) stay silent.
        if (!wasConflict) await pushIdentityConflictIfChanged();
      }
      return;
    }
    if (response.ok) {
      const wasConflict = hasIdentityConflict();
      setIdentityConflict(false);
      // Push the true→false recovery so a reset is visible without an unrelated flip.
      if (wasConflict) await pushIdentityConflictIfChanged();
    }
  } catch {
    // swallow — identity pin is best-effort hardening
  }
};

/**
 * Record one `public.requests` row for a subscription hop the daemon ran
 * locally. Best-effort: a recording failure must never fail the user's
 * request (the bytes already streamed back), so callers fire-and-forget.
 */
export const recordRequest = async (
  row: TDaemonRecordRequest,
  origin?: string | null,
): Promise<void> => {
  try {
    await cloudFetch(cloudUrl("/api/daemon/requests", origin), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(row),
    });
  } catch {
    // swallow — usage recording is non-critical telemetry
  }
};

/**
 * A transient cloud failure worth one retry within the two-attempt budget:
 * an overloaded server (500) or a rate limit (429). The cloud handler dedups
 * by (user, kind, scope, key), so a retry after a partially-processed request
 * cannot double-send. Every other status is a definitive reject — no retry.
 */
const isRetryableStatus = (status: number): boolean =>
  status === 500 || status === 429;

type TNotifyCloudEventLog = {
  readonly scope: string;
  readonly rejectedMessage: string;
  readonly failedMessage: string;
  readonly slug: string;
  readonly reason?: string;
  readonly diagnostic_code?: string;
};

/**
 * Two-attempt best-effort POST of a daemon cloud event. Retry only 500/429
 * (and thrown transport errors) on attempt 0; terminal otherwise. The cloud
 * handler dedups, so a retry after a partial process cannot double-send.
 */
const notifyCloudEvent = async (
  path: string,
  body: unknown,
  log: TNotifyCloudEventLog,
): Promise<void> => {
  const fields = {
    slug: log.slug,
    ...(log.reason === undefined ? {} : { reason: log.reason }),
    ...(log.diagnostic_code === undefined
      ? {}
      : { diagnostic_code: log.diagnostic_code }),
  };
  const request = (): Promise<Response> =>
    cloudFetch(cloudUrl(path), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request();
      if (response.ok) return;
      if (!isRetryableStatus(response.status) || attempt === 1) {
        logWarn(log.scope, log.rejectedMessage, {
          status: response.status,
          ...fields,
        });
        return;
      }
    } catch (error) {
      if (attempt === 1) {
        logWarn(log.scope, log.failedMessage, {
          error_class: error instanceof Error ? error.name : typeof error,
          ...fields,
        });
        return;
      }
    }
  }
};

/**
 * Report a confirmed local subscription-session loss to the cloud. This is
 * best-effort operational telemetry: the status path must never wait for it.
 */
export const notifySessionLost = async (
  loss: TDaemonSessionLost,
): Promise<void> => {
  await notifyCloudEvent("/api/daemon/session-lost", loss, {
    scope: "auth-loss-notify",
    rejectedMessage: "cloud rejected session-loss notification",
    failedMessage: "session-loss notification failed",
    slug: loss.slug,
    ...(loss.diagnostic_code === undefined
      ? {}
      : { diagnostic_code: loss.diagnostic_code }),
  });
};

/**
 * Report a fresh subscription quota warning or rejection to the cloud. This is
 * best-effort operational telemetry: repeated status computation must not wait
 * for it, and one transport retry is the complete delivery budget.
 */
export const notifyQuotaStatus = async (
  body: TDaemonQuotaStatusReached,
): Promise<void> => {
  await notifyCloudEvent("/api/daemon/quota-status", body, {
    scope: "quota-status-notify",
    rejectedMessage: "cloud rejected quota notification",
    failedMessage: "quota notification failed",
    slug: body.slug,
  });
};

export type TUploadMediaOptions = {
  readonly contentType: string;
  readonly kind: string;
  readonly sourceRef?: string;
  readonly filename?: string;
  /** Pre-minted media row id — sent as `x-media-id` so the cloud row's PK is
   *  known to the daemon up front (keeps `/api/media/<id>` stable). */
  readonly id?: string;
};

export type TUploadMediaResponse = {
  readonly id: string;
  readonly url: string;
};

/**
 * Observe WHY an ingest failed, without changing `uploadMedia`'s resolved
 * shape. A `null` result is the single "not persisted" answer every caller
 * already branches on; this optional sink adds the coarse reason for the one
 * caller that must tell its consumer something more useful than "no URL".
 *
 * Optional + additive on purpose: every existing call site (and every test
 * double that implements `uploadMedia` with three parameters) keeps working
 * unchanged, and a caller that passes no sink pays nothing.
 */
export type TUploadMediaDiagnostic = {
  readonly reason: TMediaPersistError;
  /** Ingest HTTP status, when one was actually received. Never a URL, body,
   *  credential or byte count — this is logged locally AND (as `reason`
   *  alone) crosses the relay. */
  readonly status?: number;
};

const uploadFailureReason = (err: unknown): TMediaPersistError => {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "ingest_timeout";
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return "ingest_timeout";
  }
  return "ingest_unreachable";
};

/**
 * Best-effort ingest of locally generated media into the cloud library. Media
 * bytes can be large, so this deliberately uses a longer timeout than the
 * daemon control plane. Failures are swallowed so callers can choose a local
 * fallback without failing the generation itself.
 */
export const uploadMedia = async (
  bytes: ArrayBuffer | Uint8Array,
  opts: TUploadMediaOptions,
  origin?: string | null,
  onFailure?: (diagnostic: TUploadMediaDiagnostic) => void,
): Promise<TUploadMediaResponse | null> => {
  const fail = (diagnostic: TUploadMediaDiagnostic): null => {
    onFailure?.(diagnostic);
    return null;
  };
  try {
    const headers = {
      ...authHeaders(),
      "content-type": opts.contentType,
      "x-media-kind": opts.kind,
      ...(opts.sourceRef === undefined
        ? {}
        : { "x-media-source-ref": opts.sourceRef }),
      ...(opts.filename === undefined
        ? {}
        : { "x-media-filename": opts.filename }),
      ...(opts.id === undefined ? {} : { "x-media-id": opts.id }),
    };
    const resp = await fetch(cloudUrl("/api/daemon/media", origin), {
      method: "POST",
      headers,
      body: new Blob([
        bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes,
      ]),
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return fail({ reason: "ingest_rejected", status: resp.status });
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return fail({ reason: "ingest_invalid_response", status: resp.status });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("id" in body) ||
      !("url" in body) ||
      typeof body.id !== "string" ||
      typeof body.url !== "string"
    ) {
      return fail({ reason: "ingest_invalid_response", status: resp.status });
    }
    return { id: body.id, url: body.url };
  } catch (err) {
    return fail({ reason: uploadFailureReason(err) });
  }
};

/** The terminal outcome of one cloud model-cache report attempt. */
export type TModelReportResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Report the live model lists this daemon's connected delegates observed
 * (`POST /api/daemon/models` — live-provider-model-catalog proposal §4).
 * Metadata only (model ids + optional display/context data, never a
 * credential). The caller chooses whether a failure is background-best-effort
 * or should be surfaced to an explicit user action.
 */
export const reportModels = async (
  report: TDaemonModelReport,
): Promise<TModelReportResult> => {
  try {
    const resp = await cloudFetch(cloudUrl("/api/daemon/models"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(report),
    });
    if (!resp.ok) {
      return { ok: false, error: `model report failed: HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "model report failed",
    };
  }
};
