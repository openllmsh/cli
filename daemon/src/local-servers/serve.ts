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
  TModelCaps,
  TModelSettings,
} from "@openllmsh/protocol";
import {
  ChatCompletionChunk,
  LOCAL_REQUIRES_DAEMON_ERROR_CODE,
  isLocalServerSlug,
} from "@openllmsh/protocol";
import { decodeProviderEventStream } from "@openllmsh/wire/lib/streaming/provider-decode";
import {
  buildUpstreamRequest,
  clientWireOf,
  UnsupportedContentError,
} from "@openllmsh/wire/providers/upstream-request";
import { recordRequest } from "../cloud-client";
import {
  deliverChunkStream,
  deliverJsonResponse,
  type TClientSurface,
} from "../client-encode";
import { errorJson } from "../cors";
import { ZERO_TOKENS, tokensFromResponse } from "../native-runtime/types";
import {
  localServerBySlug,
  localServerHasModel,
  preflightLocalPort,
} from "./discover";
import { localKeyForPort } from "./keys";

const LOCAL_REQUEST_TIMEOUT_MS = 120_000;

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

const postLocal = async (
  url: string,
  init: RequestInit,
): Promise<Response | null> => {
  try {
    return await fetch(url, init);
  } catch {
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

  const server = localServerBySlug(hop.provider);
  if (
    server === null ||
    !localServerHasModel(hop.provider, hop.providerModelId)
  ) {
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
  const signal = AbortSignal.any([
    args.req.signal,
    AbortSignal.timeout(LOCAL_REQUEST_TIMEOUT_MS),
  ]);
  const resp = await postLocal(url, {
    method: "POST",
    headers: { ...built.headers, "content-type": "application/json" },
    body: JSON.stringify(built.body),
    signal,
    redirect: "manual",
  });

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
    if (!finalHop && resp.status >= 500) return null;
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
    return new Response(raw.length > 0 ? raw : null, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
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
    return new Response(text, {
      status: 502,
      headers: { "content-type": "application/json" },
    });
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
  const server = localServerBySlug(args.provider);
  if (
    server === null ||
    !localServerHasModel(args.provider, args.providerModelId)
  ) {
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

  const resp = await postLocal(`${server.base_url}/v1/embeddings`, {
    method: "POST",
    headers: {
      ...authHeadersFor(server.port),
      "content-type": "application/json",
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.any([
      args.signal,
      AbortSignal.timeout(LOCAL_REQUEST_TIMEOUT_MS),
    ]),
    redirect: "manual",
  });
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
