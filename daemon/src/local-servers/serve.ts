/**
 * Serve a `local_*` / `local_port_*` hop against a discovered loopback
 * OpenAI-compatible server. No delegate, no CLI, no OAuth — plain HTTP
 * passthrough with the shared wire transforms.
 *
 * Deliberately `@openllm/core`-free and walker-import-free (walker imports
 * this module): uses `@openllmsh/wire` + client-encode + cloud-client only.
 */
import type {
  TChatCompletionChunk,
  TChatCompletionResponse,
  TDaemonRecordRequest,
  TErrorEnvelope,
  TModelCaps,
  TModelSettings,
} from "@openllmsh/protocol";
import {
  ChatCompletionChunk,
  cooldownPolicyFor,
  isLocalServerSlug,
  LOCAL_REQUIRES_DAEMON_ERROR_CODE,
} from "@openllmsh/protocol";
import { classifyHopError } from "@openllmsh/wire/lib/error-class";
import { decodeProviderEventStream } from "@openllmsh/wire/lib/streaming/provider-decode";
import {
  buildUpstreamRequest,
  clientWireOf,
  UnsupportedContentError,
} from "@openllmsh/wire/providers/upstream-request";
import {
  deliverChunkStream,
  deliverJsonResponse,
  type TClientSurface,
} from "../client-encode";
import { recordRequest } from "../cloud-client";
import { errorJson } from "../cors";
import { tokensFromResponse, ZERO_TOKENS } from "../native-runtime/types";
import { localServerForModel, preflightLocalPort } from "./discover";
import { localKeyForPort } from "./keys";

/** Bound how long we wait for local-upstream *headers*. Cleared once headers
 *  arrive so a long local inference stream is not cut mid-body. */
const LOCAL_REQUEST_TIMEOUT_MS = 120_000;

/** Env override must be a strict positive safe integer (tests use a short
 *  budget). Mirrors {@link originHeaderTimeoutMs} in `forward.ts`. */
export const localHeaderTimeoutMs = (): number => {
  const raw = process.env.OPENLLM_LOCAL_HEADER_TIMEOUT_MS;
  if (raw === undefined) return LOCAL_REQUEST_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : LOCAL_REQUEST_TIMEOUT_MS;
};

const localHeaderTimeoutAbort = (): Error => {
  const err = new Error("local header timeout");
  err.name = "TimeoutError";
  return err;
};

export type TLocalServeHop = {
  readonly modelId: string;
  readonly provider: string;
  readonly providerModelId: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly caps?: TModelCaps;
  readonly modelSettings?: TModelSettings;
  readonly stripSubagentIsolation?: boolean;
};

export type TLocalServeArgs = {
  readonly surface: TClientSurface;
  readonly rawBody: unknown;
  readonly req: Request;
  readonly startedAt: number;
  readonly endpoint: string;
  readonly originParam: string | null;
};

const authHeadersFor = (port: number): Record<string, string> => {
  const key = localKeyForPort(port);
  return key !== null ? { Authorization: `Bearer ${key}` } : {};
};

/** Best-effort OpenAI/Anthropic error envelope parse for hop classification. */
const errorEnvelopeFrom = (raw: string): TErrorEnvelope | undefined => {
  try {
    const json = JSON.parse(raw) as { error?: unknown };
    if (typeof json.error === "string") {
      return { error: { message: json.error, type: "upstream_error" } };
    }
    return json.error !== null && typeof json.error === "object"
      ? { error: json.error as TErrorEnvelope["error"] }
      : undefined;
  } catch {
    const message = raw.trim().slice(0, 500);
    return message.length > 0
      ? { error: { message, type: "upstream_error" } }
      : undefined;
  }
};

/**
 * Terminal local-upstream error body. Local servers speak OpenAI; on the
 * Anthropic messages surface rewrite to `{ type: "error", error: { type, message } }`
 * so Claude Code sees a clean failure instead of an OpenAI-shaped envelope.
 */
const localErrorResponse = (
  status: number,
  raw: string,
  surface: TClientSurface,
): Response => {
  if (surface !== "messages") {
    return new Response(raw.length > 0 ? raw : null, {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  let message = `local upstream returned ${status}`;
  let type = "api_error";
  const envelope = errorEnvelopeFrom(raw);
  if (
    envelope?.error.message !== undefined &&
    envelope.error.message.length > 0
  ) {
    message = envelope.error.message;
  }
  if (envelope?.error.type !== undefined && envelope.error.type.length > 0) {
    type = envelope.error.type;
  }
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
};

/**
 * Fetch a local upstream, aborting only while waiting for response headers.
 * {@link inboundSignal} stays on the fetch via `AbortSignal.any` so a client
 * abort still cancels an in-flight body after headers arrive.
 */
const postLocal = async (
  url: string,
  init: RequestInit,
  inboundSignal: AbortSignal,
): Promise<Response | null> => {
  const headerTimeout = new AbortController();
  const timer = setTimeout(() => {
    if (!headerTimeout.signal.aborted) {
      headerTimeout.abort(localHeaderTimeoutAbort());
    }
  }, localHeaderTimeoutMs());
  const signal = AbortSignal.any([inboundSignal, headerTimeout.signal]);
  try {
    const resp = await fetch(url, { ...init, signal });
    clearTimeout(timer);
    return resp;
  } catch {
    clearTimeout(timer);
    return null;
  }
};

const decodeOpenaiJson = (
  json: unknown,
  providerModelId: string,
): TChatCompletionResponse => ({
  ...(json as TChatCompletionResponse),
  model: providerModelId,
});

const decodeOpenaiStream = (
  body: ReadableStream<Uint8Array>,
  providerModelId: string,
): ReadableStream<TChatCompletionChunk> =>
  decodeProviderEventStream(
    body,
    {
      eventSchema: ChatCompletionChunk,
      initialState: () => ({}),
      eventToChunk: (event: TChatCompletionChunk) => event,
    },
    { providerModelId },
  );

const recordLocal = (
  row: Omit<TDaemonRecordRequest, "idempotency_key"> & {
    readonly idempotency_key?: string;
  },
  origin: string | null,
): void => {
  void recordRequest(
    {
      ...row,
      idempotency_key: row.idempotency_key ?? crypto.randomUUID(),
    },
    origin,
  );
};

/**
 * Serve one local-server hop. Returns a Response on commit / terminal
 * failure, or `null` when the walker should advance to the next hop
 * (model gone, port dead, preflight miss).
 */
export const serveLocalHop = async (
  hop: TLocalServeHop,
  args: TLocalServeArgs,
  finalHop: boolean,
): Promise<Response | null> => {
  if (!isLocalServerSlug(hop.provider)) return null;

  const server = localServerForModel(hop.provider, hop.providerModelId);
  if (server === null) {
    if (finalHop) {
      return errorJson(
        503,
        `local server "${hop.provider}" does not currently list model "${hop.providerModelId}"`,
        "server_error",
        LOCAL_REQUIRES_DAEMON_ERROR_CODE,
      );
    }
    return null;
  }

  const alive = await preflightLocalPort(server.port);
  if (!alive) {
    if (finalHop) {
      return errorJson(
        503,
        `local server on port ${server.port} is not reachable`,
        "server_error",
        LOCAL_REQUIRES_DAEMON_ERROR_CODE,
      );
    }
    return null;
  }

  const clientWantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  let built: ReturnType<typeof buildUpstreamRequest>;
  try {
    built = buildUpstreamRequest({
      surface: args.surface,
      upstreamWire: "openai",
      rawBody: args.rawBody,
      provider: hop.provider,
      providerModelId: hop.providerModelId,
      stream: clientWantsStream,
      baseHeaders: authHeadersFor(server.port),
      isOAuth: false,
      caps: hop.caps,
      modelSettings: hop.modelSettings,
      capabilities: hop.capabilities ?? [],
    });
  } catch (err) {
    if (err instanceof UnsupportedContentError) {
      if (!finalHop) return null;
      return errorJson(400, err.message, "unsupported_content");
    }
    throw err;
  }

  const url = `${server.base_url}/v1/chat/completions`;
  const resp = await postLocal(
    url,
    {
      method: "POST",
      headers: { ...built.headers, "content-type": "application/json" },
      body: JSON.stringify(built.body),
      redirect: "manual",
    },
    args.req.signal,
  );

  if (resp === null) {
    if (args.req.signal.aborted) {
      return errorJson(499, "client aborted request");
    }
    if (finalHop) {
      recordLocal(
        {
          model: hop.modelId,
          provider: hop.provider,
          status: "error",
          latency_ms: Date.now() - args.startedAt,
          endpoint: args.endpoint,
          error: "local upstream network error",
          ...ZERO_TOKENS,
        },
        args.originParam,
      );
      return errorJson(502, "local upstream network error");
    }
    return null;
  }

  if (resp.status >= 300 && resp.status < 400) {
    await resp.body?.cancel().catch(() => {});
    if (finalHop) {
      return errorJson(502, "local upstream redirected; refusing to follow");
    }
    return null;
  }

  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    // Same pre-commit classification the OAuth path uses: every non-abort
    // failure is transient, and `cooldownPolicyFor` decides whether a non-final
    // hop advances (`walk_no_cool` / `cool_and_advance` / `retry_in_place`) or
    // surfaces immediately (`surface` — request-deterministic 4xx).
    const cls = classifyHopError({
      status: resp.status,
      envelope: errorEnvelopeFrom(raw),
      providerFormat: "openai",
      aborted: args.req.signal.aborted,
    });
    if (cls.kind === "abort") {
      return errorJson(499, "client aborted request");
    }
    const policy = cooldownPolicyFor(cls.reason);
    if (!finalHop && policy.action !== "surface") {
      return null;
    }
    recordLocal(
      {
        model: hop.modelId,
        provider: hop.provider,
        status: "error",
        latency_ms: Date.now() - args.startedAt,
        endpoint: args.endpoint,
        error: `HTTP ${resp.status}`,
        ...ZERO_TOKENS,
      },
      args.originParam,
    );
    return localErrorResponse(resp.status, raw, args.surface);
  }

  const clientWire = clientWireOf(args.surface);
  const strip = hop.stripSubagentIsolation === true;

  if (clientWantsStream && resp.body !== null) {
    const chunks = decodeOpenaiStream(resp.body, hop.providerModelId);
    return deliverChunkStream(chunks, {
      surface: args.surface,
      clientWire,
      providerModelId: hop.providerModelId,
      status: resp.status,
      stripSubagentIsolation: strip,
      onResponse: (canonical) => {
        recordLocal(
          {
            model: hop.modelId,
            provider: hop.provider,
            status: "success",
            latency_ms: Date.now() - args.startedAt,
            endpoint: args.endpoint,
            ...tokensFromResponse(canonical),
          },
          args.originParam,
        );
      },
      onError: () => {
        recordLocal(
          {
            model: hop.modelId,
            provider: hop.provider,
            status: "error",
            latency_ms: Date.now() - args.startedAt,
            endpoint: args.endpoint,
            error: "local stream meter failed",
            ...ZERO_TOKENS,
          },
          args.originParam,
        );
      },
    });
  }

  const text = await resp.text().catch(() => "");
  let canonical: TChatCompletionResponse;
  try {
    canonical = decodeOpenaiJson(JSON.parse(text), hop.providerModelId);
  } catch {
    recordLocal(
      {
        model: hop.modelId,
        provider: hop.provider,
        status: "error",
        latency_ms: Date.now() - args.startedAt,
        endpoint: args.endpoint,
        error: "local upstream response was not JSON",
        ...ZERO_TOKENS,
      },
      args.originParam,
    );
    // Never echo the raw non-JSON body: clients expect a surface-shaped
    // envelope, and the upstream text is not a useful contract.
    return args.surface === "messages"
      ? localErrorResponse(
          502,
          "local upstream response was not JSON",
          args.surface,
        )
      : errorJson(502, "local upstream response was not JSON");
  }
  recordLocal(
    {
      model: hop.modelId,
      provider: hop.provider,
      status: "success",
      latency_ms: Date.now() - args.startedAt,
      endpoint: args.endpoint,
      ...tokensFromResponse(canonical),
    },
    args.originParam,
  );
  return deliverJsonResponse(
    canonical,
    args.surface,
    clientWire,
    resp.status,
    strip,
  );
};

/**
 * Single-shot embeddings against a discovered local server. Returns null
 * when the model is not currently listed (caller forwards / errors).
 */
export const serveLocalEmbeddings = async (args: {
  readonly provider: string;
  readonly providerModelId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}): Promise<Response | null> => {
  if (!isLocalServerSlug(args.provider)) return null;
  const server = localServerForModel(args.provider, args.providerModelId);
  if (server === null) {
    return null;
  }
  const alive = await preflightLocalPort(server.port);
  if (!alive) return null;

  const upstreamBody =
    args.body !== null && typeof args.body === "object"
      ? {
          ...(args.body as Record<string, unknown>),
          model: args.providerModelId,
        }
      : { model: args.providerModelId };

  const resp = await postLocal(
    `${server.base_url}/v1/embeddings`,
    {
      method: "POST",
      headers: {
        ...authHeadersFor(server.port),
        "content-type": "application/json",
      },
      body: JSON.stringify(upstreamBody),
      redirect: "manual",
    },
    args.signal,
  );
  if (resp === null) return errorJson(502, "local embeddings upstream failed");
  if (resp.status >= 300 && resp.status < 400) {
    await resp.body?.cancel().catch(() => {});
    return errorJson(502, "local embeddings upstream redirected");
  }
  return new Response(resp.body, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
};
