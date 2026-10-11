/**
 * Forward an API-key hop to the cloud `/v1/*` surface.
 *
 * In a MIXED chain (some subscription hops, some API-key BYOK hops), the
 * whole session runs on the daemon — but the daemon holds no DEK and must
 * not decrypt a vault credential. So an API-key hop is proxied to the
 * cloud, which decrypts via the zero-knowledge vault, runs it, and logs
 * it exactly as today. The daemon just streams the cloud's response back
 * to the local client.
 *
 * Authenticated with the user's `sk-llm-...` key — the same key the cloud
 * already validates for `/v1/*`.
 */
import {
  MEDIA_PERSISTENCE_REQUEST_HEADER,
  TUNNELED_REQUEST_HEADER,
} from "@openllmsh/protocol";
import { CLOUD_FETCH_TIMEOUT_MS } from "./cloud-client";
import { errorJson } from "./cors";
import { daemonEnv } from "./env";
import { logWarn } from "./logger";
import {
  classifyOriginThrow,
  originFailureDiagnostic,
  originFailureMessage,
  originFailureStatus,
  originFailureType,
} from "./net-error";

/** Bound how long we wait for origin *headers*. The timer is cleared once
 *  headers arrive so a long inference stream is not cut by this budget.
 *  {@link inbound.signal} stays on the fetch via `AbortSignal.any`.
 *  Env override must be a strict positive safe integer. */
export const originHeaderTimeoutMs = (): number => {
  const raw = process.env.OPENLLM_ORIGIN_HEADER_TIMEOUT_MS;
  if (raw === undefined) return CLOUD_FETCH_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : CLOUD_FETCH_TIMEOUT_MS;
};

const headerTimeoutAbort = (): Error => {
  const err = new Error("origin header timeout");
  err.name = "TimeoutError";
  return err;
};

const fetchOrigin = async (
  target: string,
  init: RequestInit,
  inbound: Request,
): Promise<Response> => {
  const headerTimeout = new AbortController();
  const timer = setTimeout(() => {
    if (!headerTimeout.signal.aborted) {
      headerTimeout.abort(headerTimeoutAbort());
    }
  }, originHeaderTimeoutMs());
  const signal = AbortSignal.any([inbound.signal, headerTimeout.signal]);
  try {
    const resp = await fetch(target, { ...init, signal });
    clearTimeout(timer);
    return stripHopByHopResponseHeaders(resp);
  } catch (err) {
    clearTimeout(timer);
    const kind = classifyOriginThrow(err, inbound.signal);
    if (kind === null) throw err;
    logWarn("forward", originFailureDiagnostic(kind), { kind });
    return errorJson(
      originFailureStatus(kind),
      originFailureMessage(kind),
      originFailureType(kind),
    );
  }
};

/**
 * Bun's `fetch` auto-decompresses upstream bodies but may leave the
 * original `content-encoding` / length / hop-by-hop headers in place.
 * Forwarding those as-is makes the next client try to decompress plain
 * bytes (`ZlibError` / `BrotliDecompressionError`). Same denylist the
 * walker applies in `passthroughHeaders`.
 */
const stripHopByHopResponseHeaders = (resp: Response): Response => {
  const headers = new Headers(resp.headers);
  for (const h of [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
  ]) {
    headers.delete(h);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
};

/**
 * Proxy one inbound request to the cloud `/v1/*` surface verbatim,
 * pinning the model to the API-key hop the local chain selected. Streams
 * the upstream response through (status + body; hop-by-hop encoding
 * headers stripped so Bun's auto-decompression cannot poison clients).
 */
export const forwardToCloud = async (
  inbound: Request,
  bodyBytes: ArrayBuffer,
  pinnedModel: string,
  origin?: string | null,
): Promise<Response> => {
  const url = new URL(inbound.url);
  // Forward to the deployment that SIGNED the plan so a single daemon serves
  // any deployment; fall back to the pinned cloud origin. The cloud `/v1`
  // surface selects via `x-openllm-pin-model`, so no query is forwarded.
  const base =
    origin !== undefined && origin !== null && origin.length > 0
      ? origin.replace(/\/+$/, "")
      : daemonEnv().cloudOrigin;
  const target = `${base}${url.pathname}`;
  const headers = new Headers(inbound.headers);
  headers.delete(MEDIA_PERSISTENCE_REQUEST_HEADER);
  headers.set("authorization", `Bearer ${daemonEnv().apiKey}`);
  // Lock the cloud to the exact concrete model the local chain picked, so
  // the cloud doesn't re-run its own alias/fallback resolution.
  headers.set("x-openllm-pin-model", pinnedModel);
  // Daemon-originated: the origin must never tunnel it back to a daemon.
  headers.set(TUNNELED_REQUEST_HEADER, "1");
  headers.delete("host");
  headers.delete("content-length");

  return fetchOrigin(
    target,
    {
      method: inbound.method,
      headers,
      body: bodyBytes,
    },
    inbound,
  );
};

/**
 * Transparent passthrough to the origin for a DIRECT client request the
 * daemon does not walk itself (local-first gateway,
 * `docs/proposals/local-first-gateway.md` §4.2): the plan resolved
 * pure-BYOK (the cloud keeps its own fallback + cooldown machinery, which
 * must stay byte-identical to today), or the plan fetch failed. No
 * `x-openllm-pin-model` — an inbound one is STRIPPED so the cloud runs
 * its full resolve (pinning is the daemon's own forward primitive, never
 * a caller's).
 *
 * Auth: the caller's own `Authorization` bearer is forwarded when present
 * (clients configured at the daemon carry their `sk-llm` key, and it may
 * differ from the daemon's paired key — usage must account to the caller's
 * key); absent one, the daemon's paired key fills in. `x-openllm-tunneled`
 * is set so the origin never tunnels the request back to a daemon (we
 * already chose not to walk it; a re-tunnel could loop).
 */
export type TPassthroughOptions = {
  /** Pin the cloud to this concrete model (media-default BYOK). */
  readonly pinModel?: string;
  /** Replacement Content-Type after a multipart rewrite (new boundary). */
  readonly contentType?: string;
};

export const passthroughToOrigin = async (
  inbound: Request,
  bodyBytes: ArrayBuffer,
  options?: TPassthroughOptions,
): Promise<Response> => {
  const url = new URL(inbound.url);
  const target = `${daemonEnv().cloudOrigin}${url.pathname}${url.search}`;
  const headers = new Headers(inbound.headers);
  headers.delete(MEDIA_PERSISTENCE_REQUEST_HEADER);
  if (options?.pinModel !== undefined && options.pinModel.length > 0) {
    headers.set("x-openllm-pin-model", options.pinModel);
  } else {
    headers.delete("x-openllm-pin-model");
  }
  if (options?.contentType !== undefined) {
    headers.set("content-type", options.contentType);
  }
  const callerAuth = inbound.headers.get("authorization");
  if (callerAuth === null || callerAuth.length === 0) {
    const { apiKey } = daemonEnv();
    if (apiKey !== null) headers.set("authorization", `Bearer ${apiKey}`);
  }
  headers.set(TUNNELED_REQUEST_HEADER, "1");
  headers.delete("host");
  headers.delete("content-length");

  return fetchOrigin(
    target,
    {
      method: inbound.method,
      headers,
      // GET/HEAD cannot carry a body (a model-listing passthrough has none) —
      // undici throws if one is supplied, so omit it for those methods.
      body:
        inbound.method === "GET" || inbound.method === "HEAD"
          ? undefined
          : bodyBytes,
    },
    inbound,
  );
};
