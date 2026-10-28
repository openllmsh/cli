/**
 * Serve a `local_key` hop (OpenCode Go, Z.AI, MiniMax): the device holds the
 * API key, so the daemon calls the vendor's hosted OpenAI-compatible endpoint
 * directly. Same wire transforms and error classification as the loopback
 * local-server path (`local-servers/serve.ts`); the difference is the base URL
 * (a vendor preset) and the credential (one of several stored key slots).
 *
 * Slots are tried in index order. A slot whose upstream rejects for a
 * non-request reason (auth, quota, 5xx, network) advances to the next slot;
 * only when every slot fails does the hop fall through (non-final) or
 * surface the last error (final).
 */
import { createHash } from "node:crypto";
import type { TChatCompletionResponse } from "@openllmsh/protocol";
import {
  cooldownPolicyFor,
  isLocalKeyProviderSlug,
  localKeyProviderPreset,
} from "@openllmsh/protocol";
import { classifyHopError } from "@openllmsh/wire/lib/error-class";
import {
  buildUpstreamRequest,
  clientWireOf,
  UnsupportedContentError,
} from "@openllmsh/wire/providers/upstream-request";
import { deliverChunkStream, deliverJsonResponse } from "../client-encode";
import { errorJson } from "../cors";
import { accountHash } from "../delegation/account-id";
import type { TLocalServeArgs, TLocalServeHop } from "../local-servers/serve";
import {
  decodeOpenaiJson,
  decodeOpenaiStream,
  errorEnvelopeFrom,
  localErrorResponse,
  postLocal,
  recordLocal,
} from "../local-servers/serve";
import { tokensFromResponse, ZERO_TOKENS } from "../native-runtime/types";
import { readLocalKeySlots } from "./store";

/** OpenCode Go's relay refuses requests without this header (see
 *  `packages/core/providers/opencode-go/session.ts`). */
const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** Stable per-conversation session id: the client's own header when sent,
 *  else a hash of the model + first system + first other message. */
const opencodeSession = (req: Request, body: unknown): string => {
  const inbound = req.headers.get(OPENCODE_SESSION_HEADER);
  if (inbound !== null && inbound.length > 0) return inbound;
  const messages =
    body !== null && typeof body === "object"
      ? (body as { messages?: unknown }).messages
      : undefined;
  if (Array.isArray(messages)) {
    const typed = messages as ReadonlyArray<{
      role?: unknown;
      content?: unknown;
    }>;
    const system = typed.find((m) => m.role === "system");
    const first = typed.find((m) => m.role !== "system");
    if (first !== undefined) {
      const seed = JSON.stringify([
        (body as { model?: unknown }).model ?? null,
        system?.content ?? null,
        first.role,
        first.content ?? null,
      ]);
      return `olm-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
    }
  }
  return `oneshot-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
};

/**
 * Vendor base URL, overridable per provider with
 * `OPENLLM_LOCAL_KEY_BASE_URL_<SLUG>` (tests point it at a loopback fake).
 * Only an absolute http(s) URL is accepted.
 */
export const localKeyBaseUrlFor = (slug: string, fallback: string): string => {
  const raw = process.env[`OPENLLM_LOCAL_KEY_BASE_URL_${slug.toUpperCase()}`];
  if (raw === undefined || raw.length === 0) return fallback;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? raw.replace(/\/+$/, "")
      : fallback;
  } catch {
    return fallback;
  }
};

const extraHeadersFor = (
  provider: string,
  req: Request,
  body: unknown,
): Record<string, string> =>
  provider === "opencode_go"
    ? { [OPENCODE_SESSION_HEADER]: opencodeSession(req, body) }
    : {};

/**
 * Serve one `local_key` hop. Returns a Response on commit / terminal
 * failure, or `null` when the walker should advance to the next hop (no key
 * on this device, or every slot failed with a fall-through-eligible error).
 */
export const serveLocalKeyHop = async (
  hop: TLocalServeHop,
  args: TLocalServeArgs,
  finalHop: boolean,
): Promise<Response | null> => {
  if (!isLocalKeyProviderSlug(hop.provider)) return null;
  const preset = localKeyProviderPreset(hop.provider);
  const slots = readLocalKeySlots(hop.provider);
  if (preset === null || slots.length === 0) {
    if (!finalHop) return null;
    return errorJson(
      503,
      `${preset?.label ?? hop.provider} has no API key on this device. Add one on /providers.`,
      "server_error",
      "subscription_requires_daemon",
    );
  }

  const clientWantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  const url = `${localKeyBaseUrlFor(preset.slug, preset.baseUrl)}/chat/completions`;
  const clientWire = clientWireOf(args.surface);
  const strip = hop.stripSubagentIsolation === true;
  let last: { status: number; raw: string } | null = null;

  for (const [i, slot] of slots.entries()) {
    const finalSlot = finalHop && i === slots.length - 1;
    const hash = accountHash(hop.provider, slot.key);
    let built: ReturnType<typeof buildUpstreamRequest>;
    try {
      built = buildUpstreamRequest({
        surface: args.surface,
        upstreamWire: "openai",
        rawBody: args.rawBody,
        provider: hop.provider,
        providerModelId: hop.providerModelId,
        stream: clientWantsStream,
        baseHeaders: { Authorization: `Bearer ${slot.key}` },
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

    const resp = await postLocal(
      url,
      {
        method: "POST",
        headers: {
          ...built.headers,
          ...extraHeadersFor(hop.provider, args.req, built.body),
          "content-type": "application/json",
        },
        body: JSON.stringify(built.body),
        redirect: "manual",
      },
      args.req.signal,
    );

    if (resp === null) {
      if (args.req.signal.aborted) {
        return errorJson(499, "client aborted request");
      }
      last = { status: 502, raw: "" };
      continue;
    }
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel().catch(() => {});
      last = { status: 502, raw: "" };
      continue;
    }
    if (!resp.ok) {
      const raw = await resp.text().catch(() => "");
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
      // A request-deterministic rejection fails on every key alike.
      if (policy.action === "surface" || finalSlot) {
        recordLocal(
          {
            model: hop.modelId,
            provider: hop.provider,
            status: "error",
            latency_ms: Date.now() - args.startedAt,
            endpoint: args.endpoint,
            error: `HTTP ${resp.status}`,
            account_hash: hash,
            ...ZERO_TOKENS,
          },
          args.originParam,
        );
        return localErrorResponse(resp.status, raw, args.surface);
      }
      last = { status: resp.status, raw };
      continue;
    }

    const success = (canonical: TChatCompletionResponse): void => {
      recordLocal(
        {
          model: hop.modelId,
          provider: hop.provider,
          status: "success",
          latency_ms: Date.now() - args.startedAt,
          endpoint: args.endpoint,
          account_hash: hash,
          ...tokensFromResponse(canonical),
        },
        args.originParam,
      );
    };
    const failure = (error: string): void => {
      recordLocal(
        {
          model: hop.modelId,
          provider: hop.provider,
          status: "error",
          latency_ms: Date.now() - args.startedAt,
          endpoint: args.endpoint,
          error,
          account_hash: hash,
          ...ZERO_TOKENS,
        },
        args.originParam,
      );
    };

    if (clientWantsStream && resp.body !== null) {
      return deliverChunkStream(
        decodeOpenaiStream(resp.body, hop.providerModelId),
        {
          surface: args.surface,
          clientWire,
          providerModelId: hop.providerModelId,
          status: resp.status,
          stripSubagentIsolation: strip,
          onResponse: success,
          onError: () => failure("local key stream meter failed"),
        },
      );
    }

    const text = await resp.text().catch(() => "");
    let canonical: TChatCompletionResponse;
    try {
      canonical = decodeOpenaiJson(JSON.parse(text), hop.providerModelId);
    } catch {
      failure("upstream response was not JSON");
      return args.surface === "messages"
        ? localErrorResponse(
            502,
            "upstream response was not JSON",
            args.surface,
          )
        : errorJson(502, "upstream response was not JSON");
    }
    success(canonical);
    return deliverJsonResponse(
      canonical,
      args.surface,
      clientWire,
      resp.status,
      strip,
    );
  }

  if (!finalHop) return null;
  // Every slot failed on a network error / redirect (the HTTP-error final
  // slot already returned above).
  return last !== null && last.raw.length > 0
    ? localErrorResponse(last.status, last.raw, args.surface)
    : errorJson(502, `${preset.label} upstream network error`);
};
