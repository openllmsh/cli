/**
 * The coreless §3.3 walker — a thin executor of the cloud-resolved plan.
 *
 * The cloud is the only brain: it resolves the alias + cooldowns and hands
 * the daemon the concrete ordered chain as a signed plan (`/api/daemon/plan`). This
 * walker walks that list in order — making ZERO routing decisions:
 *
 *   for hop in plan (in order):
 *     - subscription hop  → inject the local CLI credential, call the
 *                           vendor upstream
 *     - API-key hop       → forward inbound to the cloud, pinned to the hop
 *                           (the cloud decrypts the BYOK credential + runs)
 *     - PRE-STREAM candidate failure → next hop (unless client aborted)
 *     - committed (response received, ok) → stream straight to the client
 *
 * Coreless: imports `@openllmsh/wire` + `@openllmsh/protocol` + local modules
 * only — NEVER `@openllm/core`. The pure provider wire transforms
 * (request/response/streaming for anthropic + chatgpt, the canonical
 * message adapters, and the SSE decode/encode primitives) all live in
 * `@openllmsh/wire`; the walker wires them into a tiny per-hop mini-runner.
 *
 * Serves all three subscription providers + cross-wire:
 *   - claude_code (Anthropic upstream): passthrough for an Anthropic-wire
 *     client; toAnthropicRequest + response re-encode for an OpenAI client.
 *   - chatgpt (Codex/Responses upstream): always transform via
 *     toChatGptRequest, decode Responses events → canonical → client wire.
 *   - kimi_code (OpenAI-compatible upstream): passthrough for an OpenAI
 *     client; canonical re-encode for an Anthropic client.
 * API-key hops are forwarded to the cloud. See
 * docs/proposals/coreless-daemon-passthrough.md §3.3 + §9(a).
 *
 * This is the daemon's ONLY data path (no `@openllm/core`, no flag, no
 * fallback). It reports TOKEN COUNTS only — accurate for both streaming
 * (accumulated off a tee'd canonical-chunk stream) and non-streaming — and
 * the cloud computes cost from them (single pricing source of truth, so no
 * pricing table is shipped to the box).
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  TAnthropicResponse,
  TChatCompletionChunk,
  TChatCompletionResponse,
  TCooldownReason,
  TDaemonRecordRequest,
  TErrorEnvelope,
  TModelCaps,
  TModelSettings,
  TProviderUsageSnapshot,
  TRequestStatus,
  TServerSearchCall,
} from "@openllmsh/protocol";
import {
  AnthropicResponse,
  ChatCompletionChunk,
  cooldownPolicyFor,
  daemonPlanSigningPayload,
  resolveDefaultModelCaps,
  resolveModelSettings,
  TOOL_SESSION_HEADER,
  TUNNELED_REQUEST_HEADER,
  TUNNELED_REQUEST_VALUE,
} from "@openllmsh/protocol";
import { declaresAnthropicServerSearchTool } from "@openllmsh/wire/adapters/messages/request";
import type { TCompactionSurface } from "@openllmsh/wire/features/compaction/compact-request";
import { compactRequestToFit } from "@openllmsh/wire/features/compaction/compact-request";
import {
  contextOverflowRequiredTokens,
  nextLargerContextModel,
} from "@openllmsh/wire/features/context-demote";
import type { TContextOverflowStrategy } from "@openllmsh/wire/features/context-overflow-strategy";
import {
  resolveContextOverflowStrategy,
  shouldDemoteOnContextOverflow,
  shouldSkipHopForSize,
} from "@openllmsh/wire/features/context-overflow-strategy";
import {
  compactionTargetFromOverflow,
  forcedCompactionTarget,
  MAX_LAST_RESORT_COMPACTION_ROUNDS,
  shouldSkipHopForContext,
} from "@openllmsh/wire/features/context-skip";
import { applyOutputTokenBackfill } from "@openllmsh/wire/features/max-tokens-backfill";
import { applyModelSettings } from "@openllmsh/wire/features/model-settings";
import {
  GATE_STALE_CAP_MS,
  quotaGateDecision,
} from "@openllmsh/wire/features/quota-gate";
import type { TCountTokensCapabilityMemory } from "@openllmsh/wire/lib/canonical/count-tokens-capability";
import {
  countTokensEndpointIdentity,
  countTokensUnsupportedFromUpstream,
  isCountTokensUnsupported,
  rememberCountTokensUnsupported,
} from "@openllmsh/wire/lib/canonical/count-tokens-capability";
import type { TTokenEncoding } from "@openllmsh/wire/lib/canonical/encoding-select";
import {
  DEFAULT_ENCODING,
  encodingForSurface,
  getTokenCounter,
} from "@openllmsh/wire/lib/canonical/encoding-select";
import {
  estimateAnthropicInputTokens,
  estimateBodyTokens,
  estimateBodyTokensExact,
} from "@openllmsh/wire/lib/canonical/token-estimate";
import {
  isEncryptedContentError,
  responsesBodyHasEncryptedContent,
  stripResponsesEncryptedContent,
} from "@openllmsh/wire/lib/encrypted-content";
import {
  CONTEXT_OVERFLOW_BODY,
  classifyHopError,
} from "@openllmsh/wire/lib/error-class";
import { originatorHeadersFrom } from "@openllmsh/wire/lib/forwarded-headers";
import {
  isCanonicalRefusal,
  isRefusalChunk,
} from "@openllmsh/wire/lib/refusal";
import { accumulateChunksToResponse } from "@openllmsh/wire/lib/streaming/accumulate";
import {
  isMeaningfulChunk,
  peekFirstChunk,
} from "@openllmsh/wire/lib/streaming/peek";
import { decodeProviderEventStream } from "@openllmsh/wire/lib/streaming/provider-decode";
import { responseToChunkStream } from "@openllmsh/wire/lib/streaming/response-stream";
import { withFrameAlignedHeartbeat } from "@openllmsh/wire/lib/streaming/sse";
import {
  partialUsageFrom,
  streamFailureCause,
  UpstreamStreamError,
  upstreamErrorFrom,
} from "@openllmsh/wire/lib/streaming/upstream-error";
import {
  isThinkingSignatureError,
  messagesBodyHasStrippableThinking,
  stripMessagesThinkingBlocks,
} from "@openllmsh/wire/lib/thinking-signature";
import {
  normalizeSchemaRefs,
  stripSchemaKeywords,
} from "@openllmsh/wire/lib/tool-schema";
import { buildAnthropicToolNameMap } from "@openllmsh/wire/providers/anthropic/request";
import { fromAnthropicResponse } from "@openllmsh/wire/providers/anthropic/response";
import { decodeAnthropicEventStream } from "@openllmsh/wire/providers/anthropic/streaming";
import { buildChatGptToolNameMap } from "@openllmsh/wire/providers/chatgpt/request";
import type { TChatGptStreamEvent } from "@openllmsh/wire/providers/chatgpt/streaming";
import {
  chatGptEventToChunk,
  isChatGptResponsesTerminalEvent,
  newChatGptStreamState,
} from "@openllmsh/wire/providers/chatgpt/streaming";
import { withChatGptNativeSearch } from "@openllmsh/wire/providers/chatgpt/web-search";
import { withGrokNativeSearch } from "@openllmsh/wire/providers/grok/web-search";
import {
  KIMI_SEARCH_MAX_ROUNDS,
  kimiBuiltinSearchCalls,
  kimiSearchEchoMessages,
  withKimiBuiltinSearch,
} from "@openllmsh/wire/providers/kimi/web-search";
// The SINGLE (clientWire × upstreamWire) request recipe — shared with the
// cloud runner so the two can't drift (this fork caused two regressions). See
// `docs/proposals/unified-upstream-request-builder.md`.
import {
  buildUpstreamRequest,
  canonicalFromInbound,
  clientWireOf,
  UnsupportedContentError,
} from "@openllmsh/wire/providers/upstream-request";
import { Schema } from "effect";
import { requestStatusPush } from "./auth-events";
import type { TCacheProbe } from "./cache-probe";
import {
  cacheProbeEnabled,
  cacheProbeOutcome,
  cacheProbePrefixHash,
  cacheProbeWrap,
} from "./cache-probe";
import {
  deliverChunkStream,
  deliverJsonResponse,
  heartbeatOptionsFor,
  isClientHangUp,
  sseResponseForClient,
} from "./client-encode";
import { recordRequest } from "./cloud-client";
import {
  activeExecutionSelection,
  activeExecutionSelectionOverrides,
  contextOverflowStrategy as bootstrapContextOverflowStrategy,
  catalogCapsDefaults,
  fleetSubscriptionServerFor,
  lookupCatalogEntry,
  modelSettingsOverrides,
  planSigningKey,
} from "./config";
import { errorJson } from "./cors";
import { getDelegate, isSubscriptionSlug } from "./delegation";
import { isLocalServerSlug, serveLocalHop } from "./local-servers";
import type { TRefreshErrorClass } from "./delegation/refresh";
import { authReasonCodeForRefreshError } from "./delegation/refresh";
import type { TProviderDelegate } from "./delegation/types";
import { stateDir } from "./env";
import { forwardToCloud } from "./forward";
import {
  clearHopCooldown,
  isHopCoolingDown,
  markHopCooldown,
  peekHopCooldown,
  TRANSIENT_COOLDOWN_REASONS,
} from "./hop-cooldown";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { maybeReportModels } from "./model-report";
import {
  isNativeRuntimeProvider,
  tryServeNativeRuntime,
} from "./native-runtime/serve";
import type { TNativeTokens } from "./native-runtime/types";
import { tokensFromResponse, ZERO_TOKENS } from "./native-runtime/types";
import { clearPlanCache } from "./plan-cache";
import { isClaudeCodeOriginator, resolveHopExecution } from "./sub-method";
import type { TTunnelToPeer } from "./tunnel-client";
import { tunnelToPeer } from "./tunnel-client";
import {
  peekUsageForQuotaGate,
  sampleUsageAfterRequest,
  sampleUsageOnExhaustion,
} from "./usage-cache";

export const noteWalkerStreamTerminal = (opts: {
  readonly aborted: boolean;
  readonly hang: boolean;
}): void => {
  if (opts.aborted) return;
  logWarn(
    "walker",
    opts.hang
      ? safeDiagnosticMessage`The stream stopped making progress.`
      : safeDiagnosticMessage`The stream ended in an unexpected failure.`,
  );
};

// Upstream WIRE per subscription provider — structural (which adapter to run),
// the one constant that stays in the walker. The upstream URL is no longer
// hardcoded here: it's resolved per hop from the delegate's auth config
// (`credentialForUpstream().url`), captured from the real CLI request. See
// `packages/cli/daemon/src/delegation/auth-config.ts`.
// The MANUAL upstream-HTTP transport. `claude_code` + `chatgpt` are served by
// the native-runtime path FIRST (`isNativeRuntimeProvider`); the manual entries
// here are the FALLBACK the walker uses when native declines (tools/images/
// structured-output/native gaps), so no workflow is blocked. Auth + refresh
// still flow through the CLIs — the manual path reads the credential via the
// delegate's `credentialForUpstream` (isolated CLI store + CLI-driven refresh),
// exactly like kimi_code + grok.
export type TUpstreamWire = "anthropic" | "chatgpt" | "openai";
const UPSTREAM_WIRE: Readonly<Record<string, TUpstreamWire>> = {
  // Claude Pro/Max via the isolated Claude Code OAuth bearer + the
  // `anthropic-beta: oauth-2025-04-20` header on the Anthropic Messages wire.
  claude_code: "anthropic",
  // ChatGPT/Codex subscription via the Codex Responses wire
  // (`/backend-api/codex/responses`) with the Codex identity preamble.
  chatgpt: "chatgpt",
  // Kimi's managed "Kimi For Coding" subscription speaks the OpenAI wire
  // (`/coding/v1/chat/completions`) — exactly what the official `kimi-code-cli`
  // sends. So we delegate over the openai wire with the CLI's genuine identity
  // (URL + headers from the delegate's `credentialForUpstream`, captured from
  // the real `kimi -p ping` request). See `kimi-code.ts`.
  kimi_code: "openai",
  // xAI Grok ("Grok Build") serves its models via the OpenAI Responses API
  // (both report `api_backend: "responses"`) at the CLI chat proxy
  // (`cli-chat-proxy.grok.com/v1/responses`, captured per-hop from the
  // delegate's auth config) — same wire as codex, so we delegate over the
  // chatgpt (Responses) adapter with the CLI's genuine bearer. It does NOT get
  // the Codex preamble (see `wantsCodexPreamble`).
  grok: "chatgpt",
};

// The Codex system preamble ("You are Codex…") is a Codex IDENTITY the ChatGPT
// backend requires — but WRONG for other providers that merely share the
// Responses wire (xAI Grok). Injected only for the real `chatgpt` provider on
// the manual FALLBACK path.
const wantsCodexPreamble = (provider: string): boolean =>
  provider === "chatgpt";

// The chatgpt Responses API emits freeform JSON events (no strict schema);
// discrimination happens inside `chatGptEventToChunk`. Mirrors the core
// spec's `Schema.Record(string, unknown)` validator.
const ChatGptStreamEventSchema: Schema.Schema<TChatGptStreamEvent> =
  Schema.Record({ key: Schema.String, value: Schema.Unknown });

export type TWalkArgs = {
  readonly req: Request;
  /** Fetch for local walker hops; omitted → the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly surface: "chat_completions" | "messages" | "responses";
  readonly endpoint: string;
  /** The parsed inbound JSON body (Anthropic- or OpenAI-shaped per surface). */
  readonly rawBody: unknown;
  /** The raw inbound bytes — forwarded verbatim to the cloud for API-key hops. */
  readonly rawBytes: ArrayBuffer;
  /** The signed plan (comma-separated model ids) from `/api/daemon/plan`, or null. */
  readonly planParam: string | null;
  /** Concrete upstream `provider_model_id`s parallel to the plan, so the
   *  daemon serves catalog-free. Null when the cloud sent none. */
  readonly pmidsParam: string | null;
  /** The deployment that signed the plan; the daemon forwards API-key hops
   *  + records usage back here. Null → pinned origin. */
  readonly originParam: string | null;
  /** Signed plan policy; null falls back to the bootstrap/default hop setting. */
  readonly contextOverflowStrategy?: TContextOverflowStrategy | null;
  /** The HMAC of the signed payload (plan+pmids+origin+strategy), or null. */
  readonly sigParam: string | null;
  readonly startedAt: number;
  /**
   * Wall-clock pause before a same-hop retry when the upstream gives no
   * usable `Retry-After`. Defaults to {@link DEFAULT_HOP_RETRY_DELAY_MS}.
   */
  readonly hopRetryDelayMs?: number;
  /**
   * Cap applied to a parsed `Retry-After` delay before a same-hop retry.
   * Defaults to {@link DEFAULT_HOP_RETRY_AFTER_CAP_MS}.
   */
  readonly hopRetryAfterCapMs?: number;
  /**
   * Optional native-runtime serve. Production omits this and uses
   * {@link tryServeNativeRuntime}; callers may inject an alternate
   * implementation (tests, specialised hosts).
   */
  readonly tryServeNativeRuntime?: typeof tryServeNativeRuntime;
  /**
   * Optional fleet-tunnel transport. Production omits this and uses the
   * live RTC→mux ladder inside {@link tunnelToPeer}.
   */
  readonly tunnelToPeer?: TTunnelToPeer;
  /**
   * Fired when a subscription hop's NEW/changed `auth` cooldown triggers an
   * immediate status push (so observers can count / react without a
   * module counter).
   */
  readonly onAuthCooldownStatusPush?: () => void;
  /** Upstreams known to lack count_tokens. Defaults to the process memory. */
  readonly countTokensCapability?: TCountTokensCapabilityMemory;
};

type THop = {
  readonly modelId: string;
  readonly provider: string;
  readonly providerModelId: string;
  /**
   * Catalog capabilities for this hop. Always present: `[]` when the
   * daemon catalog has no row (or an older cloud omitted the field) —
   * unknown, never treated as known-non-vision. Not part of the signed
   * plan payload; resolved locally from the bootstrap catalog.
   */
  readonly capabilities: ReadonlyArray<string>;
  /** Catalog-declared final outbound-body constraints, resolved locally. */
  readonly caps?: TModelCaps;
  readonly modelSettings?: TModelSettings;
  /** Catalog-gated client-output repair, resolved locally from bootstrap. */
  readonly stripSubagentIsolation: boolean;
};

/** Parse a `provider/model,provider/model` plan into ordered model ids.
 *  Also used for the parallel pmids list (same comma encoding). */
export const parsePlan = (planParam: string | null): ReadonlyArray<string> =>
  planParam === null
    ? []
    : planParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

/**
 * Resolve a plan model id to its `{ provider, providerModelId }`. Precedence:
 * (1) the concrete `providerModelId` the cloud pushed in the plan's pmids — the
 * catalog-free path; (2) the cloud-pulled catalog; (3) splitting the
 * `provider/model` pair (dev / older plans). Only the provider prefix is
 * ever derived locally; the upstream id is authoritative from the cloud.
 */
export const resolveHop = (modelId: string, providerModelId?: string): THop => {
  const slash = modelId.indexOf("/");
  const provider = slash > 0 ? modelId.slice(0, slash) : modelId;
  const entry = lookupCatalogEntry(modelId);
  const capabilities = entry?.capabilities ?? [];
  const modelSettings = resolveModelSettings(
    entry?.settings,
    modelSettingsOverrides()[modelId],
  );
  // A card always wins. With no row, fall back to the catalog-owned
  // family defaults using the SAME shared matcher the cloud runs, so an
  // un-catalogued id resolves identically on both paths.
  const caps =
    entry?.caps ??
    resolveDefaultModelCaps(
      catalogCapsDefaults(),
      provider,
      providerModelId ?? modelId.slice(slash + 1),
    );
  const stripSubagentIsolation = entry?.strip_subagent_isolation === true;
  if (providerModelId !== undefined && providerModelId.length > 0) {
    return {
      modelId,
      provider,
      providerModelId,
      capabilities,
      ...(caps !== undefined ? { caps } : {}),
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      stripSubagentIsolation,
    };
  }
  if (entry !== null) {
    return {
      modelId,
      provider: entry.provider,
      providerModelId: entry.provider_model_id,
      capabilities,
      ...(caps !== undefined ? { caps } : {}),
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      stripSubagentIsolation,
    };
  }
  return slash > 0
    ? {
        modelId,
        provider,
        providerModelId: modelId.slice(slash + 1),
        capabilities,
        caps,
        stripSubagentIsolation,
      }
    : {
        modelId,
        provider: modelId,
        providerModelId: modelId,
        capabilities,
        caps,
        stripSubagentIsolation,
      };
};

/**
 * Verify a cloud-signed plan against the per-user key handed over at
 * bootstrap (coreless proposal §9). Timing-safe. A missing/short/mismatched
 * signature fails closed.
 */
export const verifyPlanSignature = (
  plan: string,
  sig: string | null,
  key: string,
): boolean => {
  if (sig === null || sig.length === 0) return false;
  const expected = createHmac("sha256", key).update(plan).digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
};

/**
 * Verify a signed `(plan, pmids, origin)` tuple against the bootstrap
 * signing key — the ONE check shared by the walker's 403 gate, the
 * listener's plan-cache admission, and the compact passthrough's
 * model-pin trust. True in unsigned dev mode (no key configured).
 */
export const planSignatureOk = (
  planParam: string | null,
  pmidsParam: string | null,
  originParam: string | null,
  contextOverflowStrategy: TContextOverflowStrategy | null,
  sigParam: string | null,
): boolean => {
  const sigKey = planSigningKey();
  return (
    sigKey === null ||
    verifyPlanSignature(
      daemonPlanSigningPayload(
        planParam ?? "",
        pmidsParam ?? "",
        originParam ?? "",
        contextOverflowStrategy,
      ),
      sigParam,
      sigKey,
    )
  );
};

/**
 * Can the walker serve this whole plan coreless? Every subscription hop
 * must be one of the three the walker knows an upstream for; API-key hops
 * are always walkable (forwarded to the cloud). DECLINE the whole plan up
 * front for an unknown subscription provider — so we never half-attempt a
 * chain and then bail. (All wire combinations of the three known providers
 * are supported now — passthrough where client-wire == upstream-wire,
 * transform-and-re-encode otherwise.)
 */
export const canWalkPlan = (hops: ReadonlyArray<THop>): boolean => {
  for (const hop of hops) {
    if (isLocalServerSlug(hop.provider)) continue; // local OpenAI-wire passthrough
    if (!isSubscriptionSlug(hop.provider)) continue; // API-key → forwardable
    if (isNativeRuntimeProvider(hop.provider)) continue; // native runtime path (incl. bridge-only cursor)
    if (UPSTREAM_WIRE[hop.provider] === undefined) return false;
  }
  return true;
};

/** Default pause before a same-hop retry when no usable `Retry-After` is present. */
export const DEFAULT_HOP_RETRY_DELAY_MS = 1_000;
/** Cap applied to a parsed `Retry-After` delay before a same-hop retry. */
export const DEFAULT_HOP_RETRY_AFTER_CAP_MS = 10_000;

/** Bounded delay from an upstream response's `Retry-After` (seconds or
 * HTTP-date), falling back to the hop-retry delay. */
const retryAfterDelayMs = (
  resp: Response,
  hopRetryDelayMs: number,
  hopRetryAfterCapMs: number,
): number => {
  const raw = resp.headers.get("retry-after");
  if (raw !== null) {
    const secs = Number(raw);
    if (!Number.isNaN(secs)) {
      return Math.max(0, Math.min(secs * 1000, hopRetryAfterCapMs));
    }
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
      return Math.max(0, Math.min(at - Date.now(), hopRetryAfterCapMs));
    }
  }
  return hopRetryDelayMs;
};

/**
 * Absolute recover time from an upstream response's `Retry-After` (seconds or
 * HTTP-date) — the authoritative "provably doomed until" floor threaded into
 * the hop cooldown. Unlike {@link retryAfterDelayMs} this is NOT capped: a
 * vendor that says "retry in 60s" must not be truncated to 10s, or the doom
 * oracle would let a recovery pass re-dial a hop the vendor already refused.
 * Returns `undefined` when the header is absent or unparseable.
 */
const retryAfterRecoverAtMs = (
  resp: Response,
  now: number = Date.now(),
): number | undefined => {
  const raw = resp.headers.get("retry-after");
  if (raw === null) return undefined;
  const secs = Number(raw);
  if (!Number.isNaN(secs)) return now + Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return at;
  return undefined;
};

/** Resolve after `ms` — or immediately once the client disconnects. */
const abortableDelay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** POST one built request upstream. Routing retries belong to the walker loop. */
type TTransportFailure = { readonly reason: string };

// Fetch's message frequently embeds the upstream URL (and potentially an API
// token). Keep only a conventional errno-like code, else its short error name.
const transportFailureFrom = (err: unknown): TTransportFailure => {
  const record =
    err !== null && typeof err === "object"
      ? (err as { readonly cause?: unknown; readonly name?: unknown })
      : null;
  const cause = record?.cause;
  const causeRecord =
    cause !== null && typeof cause === "object"
      ? (cause as { readonly code?: unknown })
      : null;
  const code = causeRecord?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
    return { reason: `network error: ${code}` };
  }
  const name = record?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name)
    ? { reason: `network error: ${name}` }
    : { reason: "network error" };
};

export const postUpstream = async (
  url: string,
  init: RequestInit,
  onTransportFailure?: (failure: TTransportFailure) => void,
): Promise<Response | null> => {
  try {
    return await fetch(url, init);
  } catch (err) {
    onTransportFailure?.(transportFailureFrom(err));
    return null;
  }
};

/**
 * POST an upstream body, plus ONE same-hop retry that STRIPS replayed
 * model-bound reasoning state when the upstream rejects it pre-stream.
 *
 * Two wire-gated recoveries (both pre-stream 400 only; one retry; no chain
 * advance — the caller still owns walk-on-failure):
 *
 * 1. **Responses (`chatgpt` wire, + grok):** strip `reasoning.encrypted_content`
 *    the hop can't decrypt (audit 2026-07-14-codex-upstream-wire §F2).
 * 2. **Anthropic (`anthropic` wire, claude_code):** strip historical
 *    `thinking`/`redacted_thinking` blocks whose `signature` the hop model
 *    rejects (issue #420). Active tool-use continuation thinking is preserved
 *    by {@link stripMessagesThinkingBlocks} — see that helper's header for the
 *    tool_use limitation. Origin model is not knowable from the wire, so there
 *    is no proactive strip (over-stripping would bust prompt cache on healthy
 *    same-model multi-turn); this reactive path is the correctness backstop.
 *
 * Non-matching wires / statuses / bodies fall straight through to
 * {@link postUpstream}. Exported for the daemon-level strip-retry unit test.
 */
export const postWithReplayStripRetry = async (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  wire: TUpstreamWire,
  signal: AbortSignal,
  onTransportFailure?: (failure: TTransportFailure) => void,
): Promise<Response | null> => {
  const send = (b: unknown): Promise<Response | null> =>
    postUpstream(
      url,
      { method: "POST", headers, body: JSON.stringify(b), signal },
      onTransportFailure,
    );
  const first = await send(body);
  // Anything other than a pre-stream 400 → nothing to recover from.
  if (first === null || first.ok || first.status !== 400) {
    return first;
  }

  // ── Responses: undecryptable reasoning.encrypted_content ────────────────
  // `chatgpt` is the only encrypted-content-bearing upstream wire (grok maps
  // to it in UPSTREAM_WIRE).
  if (wire === "chatgpt" && responsesBodyHasEncryptedContent(body)) {
    // Peek via `clone()` so the caller can still read `first` if this is not
    // a decrypt failure.
    const raw = await first
      .clone()
      .text()
      .catch(() => "");
    if (isEncryptedContentError(raw)) {
      const retried = await send(stripResponsesEncryptedContent(body));
      return retried ?? first;
    }
    return first;
  }

  // ── Anthropic: invalid thinking.signature on a model hop ────────────────
  // Only attempt when the body has thinking the strip would actually remove
  // (historical turns). Active tool-use-continuation thinking is preserved,
  // so a body whose only thinking is that turn is not strippable.
  if (wire === "anthropic" && messagesBodyHasStrippableThinking(body)) {
    const raw = await first
      .clone()
      .text()
      .catch(() => "");
    if (isThinkingSignatureError(raw)) {
      const retried = await send(stripMessagesThinkingBlocks(body));
      return retried ?? first;
    }
    return first;
  }

  return first;
};

/** Map the daemon's upstream wire to the classifier's provider format
 *  (chatgpt + kimi both speak the OpenAI error-envelope shape). */
const hopFormat = (wire: TUpstreamWire): "openai" | "anthropic" =>
  wire === "anthropic" ? "anthropic" : "openai";

/** Best-effort error-envelope extraction for reason tagging. Parsing is never
 * a routing gate: an unknown provider body still represents an uncommitted
 * candidate failure and therefore walks.
 *
 * A STRING-valued `error` is lifted into the canonical envelope: xAI's CLI
 * proxy answers an exhausted balance with `{"error":"Grok Build usage balance
 * exhausted"}`, and dropping that prose left the classifier with an empty
 * message — tagging the hop `payment` (60s) instead of `quota_exhausted`, so
 * the dead account was re-dialled all session. */
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
    const message = hopBodySnippet(raw);
    return message.length > 0
      ? { error: { message, type: "upstream_error" } }
      : undefined;
  }
};

/** Classify a raw upstream error response: best-effort envelope parse, then
 *  the shared cloud/daemon policy. The single call point for every
 *  daemon-served hop — subscription (wire-derived format) and cloud-forward
 *  ("openai": forwarded responses are normalized to the shared envelope). */
const classifyRawResponse = (
  status: number,
  raw: string,
  providerFormat: "openai" | "anthropic",
  aborted: boolean,
): ReturnType<typeof classifyHopError> =>
  classifyHopError({
    status,
    envelope: errorEnvelopeFrom(raw),
    providerFormat,
    aborted,
  });

/** Shared pre-commit candidate decision used for every daemon-served hop. */
export const classifyPrecommitResponse = (
  status: number,
  raw: string,
  wire: TUpstreamWire,
  aborted: boolean,
): ReturnType<typeof classifyHopError> =>
  classifyRawResponse(status, raw, hopFormat(wire), aborted);

export const statusFor = (httpStatus: number): TRequestStatus =>
  httpStatus < 400
    ? "success"
    : httpStatus === 429
      ? "rate_limited"
      : httpStatus === 408
        ? "timeout"
        : "error";

/** Strip hop-by-hop headers so the body re-streams cleanly to the client. */
export const passthroughHeaders = (resp: Response): Headers => {
  const headers = new Headers(resp.headers);
  for (const h of [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
  ]) {
    headers.delete(h);
  }
  return headers;
};

export const report = (
  row: TDaemonRecordRequest,
  origin: string | null,
  accountHash?: string,
): void => {
  const recordedRow: TDaemonRecordRequest = {
    ...row,
    idempotency_key: row.idempotency_key ?? randomUUID(),
  };
  void recordRequest(recordedRow, origin);
  if (
    recordedRow.status !== "success" ||
    !isSubscriptionSlug(recordedRow.provider) ||
    recordedRow.tokens_in + recordedRow.tokens_out <= 0
  ) {
    return;
  }
  const delegate = getDelegate(recordedRow.provider);
  if (delegate !== null) {
    sampleUsageAfterRequest(
      recordedRow.provider,
      () => delegate.usage(),
      recordedRow.account_hash ?? accountHash,
    );
  }
  // Fire-and-forget automatic catalog refresh for the hop that actually
  // used tokens. Never delays the response stream; skipped/failed stays
  // quiet; does not walk the fleet or failed hops.
  void maybeReportModels(Date.now(), recordedRow.provider, "auto").catch(
    () => {},
  );
};

const decodeAnthropicResponse = Schema.decodeUnknownSync(AnthropicResponse);

// The (clientWire × upstreamWire) request recipe — body + headers — lives in
// `@openllmsh/wire/providers/upstream-request` (buildUpstreamRequest /
// buildUpstreamHeaders / buildUpstreamBody / canonicalToUpstreamBody /
// canonicalFromInbound / clientWireOf). The walker is a thin caller; it never
// re-derives the recipe (that fork caused two regressions).

export type { TPeekedChunks } from "@openllmsh/wire/lib/streaming/peek";
// The pre-commit first-event peek is a SHARED wire primitive (one
// implementation for the daemon walker and the cloud dispatch chain, like
// the context ladder — see `@openllmsh/wire/lib/streaming/peek`).
// Re-exported here so the walker's callers/tests keep one import surface.
export {
  isMeaningfulChunk,
  peekFirstChunk,
} from "@openllmsh/wire/lib/streaming/peek";

type TDebugStreamReason = "end" | "error" | "aborted";

const formatCodexDebugFrame = (frame: string): string =>
  frame.replace(/\r/g, "").replace(/\n/g, "\\n");

type TSseFrameBoundary = {
  readonly index: number;
  readonly length: number;
};

const nextSseFrameBoundary = (buffer: string): TSseFrameBoundary | null => {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1 || (crlf !== -1 && crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
};

const codexSseDebugPath = (streamStartedMs: number): string => {
  const stamp = new Date(streamStartedMs).toISOString().replace(/[:.]/g, "-");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return join(stateDir(), "debug", `codex-sse-${stamp}-${suffix}.log`);
};

const writeDebugLine = (filePath: string, line: string): Promise<void> =>
  appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });

const debugCodexStream = async (
  source: ReadableStream<Uint8Array>,
  streamStartMs: number,
  filePath: string,
): Promise<void> => {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputReady = false;
  let writes = Promise.resolve();

  const enqueueLine = (line: string): void => {
    // Keep draining the tee branch while file I/O is pending. The queue is
    // debug-only, bounded by the response size, and cannot backpressure decode.
    writes = writes
      .then(() => writeDebugLine(filePath, line))
      .catch(() => undefined);
  };

  const enqueueFrame = (frame: string): void => {
    enqueueLine(
      `${Date.now() - streamStartMs} ${new Date().toISOString()} | ${formatCodexDebugFrame(frame)}\n`,
    );
  };

  const enqueueEnd = (
    reason: TDebugStreamReason,
    message: string | null,
  ): void => {
    const detail = message === null ? "" : `: ${message}`;
    enqueueLine(
      `--- STREAM ENDED (reason=${reason}${detail}) ms=${Date.now() - streamStartMs} ---\n`,
    );
  };

  try {
    await mkdir(join(stateDir(), "debug"), { recursive: true });
    outputReady = true;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.length > 0) enqueueFrame(buffer);
        enqueueEnd("end", null);
        await writes;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = nextSseFrameBoundary(buffer);
        if (boundary === null) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        enqueueFrame(frame);
      }
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    const isAbort =
      message.includes("Abort") ||
      message.includes("aborted") ||
      error instanceof DOMException;
    if (outputReady) {
      enqueueEnd(isAbort ? "aborted" : "error", message);
      await writes;
    }
    await reader.cancel("codex SSE debug capture ended").catch(() => undefined);
  }
};

const tapCodexSseStream = (
  body: ReadableStream<Uint8Array>,
  streamStartMs: number,
): ReadableStream<Uint8Array> => {
  const [toDecode, toDebug] = body.tee();
  const filePath = codexSseDebugPath(streamStartMs);
  // Drain the observer branch independently so it cannot stall the decoder.
  void debugCodexStream(toDebug, streamStartMs, filePath);
  return toDecode;
};

/** Decode an upstream SSE stream into canonical chunks, per upstream wire. */
export const decodeUpstreamStream = (
  wire: TUpstreamWire,
  body: ReadableStream<Uint8Array>,
  providerModelId: string,
  toolNameMap?: ReadonlyMap<string, string>,
): ReadableStream<TChatCompletionChunk> => {
  const options = {
    providerModelId,
    ...(toolNameMap !== undefined && toolNameMap.size > 0
      ? { toolNameMap }
      : {}),
  };
  if (wire === "anthropic") {
    return decodeAnthropicEventStream(body, options);
  }
  if (wire === "chatgpt") {
    return decodeProviderEventStream(
      body,
      {
        eventSchema: ChatGptStreamEventSchema,
        initialState: newChatGptStreamState,
        eventToChunk: chatGptEventToChunk,
        isTerminalEvent: isChatGptResponsesTerminalEvent,
      },
      options,
    );
  }
  // openai/kimi: the upstream chunk IS the canonical chunk.
  return decodeProviderEventStream(
    body,
    {
      eventSchema: ChatCompletionChunk,
      initialState: () => ({}),
      eventToChunk: (event: TChatCompletionChunk) => event,
    },
    options,
  );
};

/** Decode an upstream non-streaming JSON body into a canonical response. */
const decodeUpstreamJson = (
  wire: TUpstreamWire,
  json: unknown,
  providerModelId: string,
  toolNameMap?: ReadonlyMap<string, string>,
): TChatCompletionResponse => {
  if (wire === "anthropic") {
    const anthropic: TAnthropicResponse = decodeAnthropicResponse(json);
    return fromAnthropicResponse(anthropic, {
      providerModelId,
      ...(toolNameMap !== undefined && toolNameMap.size > 0
        ? { toolNameMap }
        : {}),
    });
  }
  // chatgpt Responses + openai/kimi: already ChatCompletion-shaped (mirror
  // the core chatgpt spec's inline `fromBody`, which only pins the model).
  return { ...(json as TChatCompletionResponse), model: providerModelId };
};

// The daemon's per-hop token row (`TNativeTokens`) + its mapper + zero value
// are shared with the native path (`./native-runtime/types`) so the manual and
// native transports report identically. `tokens_in` is the canonical
// prompt-token total and INCLUDES the two cache fields; the cloud prices the
// split at the cache rates rather than the input rate.

/**
 * Build the BASE upstream headers for a hop: the ORIGINATOR's own headers
 * (denylist passthrough — `originatorHeadersFrom`), then the credential-intrinsic
 * headers + the subscription bearer layered on top. The wire-derived headers
 * (anthropic-version / anthropic-beta / content-type) are layered last by
 * `buildUpstreamRequest`/`buildUpstreamHeaders`. So a genuine vendor-CLI request
 * reaches the vendor with ITS real identity; the daemon swaps in the bearer
 * (+ the user's own account id where required) and never overrides an identity
 * the originator already presents. The delegate receives the inbound headers so
 * it can BACKFILL a vendor-CLI identity the originator lacks — chatgpt does this
 * for models the Codex backend gates on `originator: codex_cli_rs` (see its
 * `credentialForUpstream`). Returns "retry" when no usable local credential is
 * available, so the walker falls through.
 */
export const coolHopAfterStaleRefresh = (
  hop: { readonly provider: string; readonly modelId: string },
  errorClass: TRefreshErrorClass,
  walkSessionKey?: string,
): void => {
  const authReasonCode = authReasonCodeForRefreshError(errorClass);
  const changed = markHopCooldown(
    hop.provider,
    hop.modelId,
    "auth",
    walkSessionKey,
    undefined,
    Date.now(),
    authReasonCode,
  );
  if (changed && isSubscriptionSlug(hop.provider)) {
    getDelegate(hop.provider)?.invalidateStatusObservation?.();
    requestStatusPush();
  }
};

export const acquireUpstream = async (
  provider: string,
  args: TWalkArgs,
  hop?: { readonly provider: string; readonly modelId: string },
  walkSessionKey?: string,
): Promise<
  | { headers: Record<string, string>; url: string; accountHash: string | null }
  | "retry"
> => {
  const delegate = getDelegate(provider);
  if (delegate === null) return "retry";
  try {
    const cred = await delegate.credentialForUpstream(args.req.headers);
    if (cred.stale_refresh !== undefined) {
      if (hop !== undefined) {
        coolHopAfterStaleRefresh(hop, cred.stale_refresh, walkSessionKey);
      }
      return "retry";
    }
    return {
      headers: {
        ...originatorHeadersFrom(args.req.headers),
        ...cred.headers,
        authorization: `Bearer ${cred.access_token}`,
      },
      url: cred.url,
      // Rides onto the recorded row so the cloud attributes this hop's
      // cost to the right vendor-account meter series.
      accountHash: cred.account_hash ?? null,
    };
  } catch {
    return "retry";
  }
};

/** The client's inbound `anthropic-beta` (messages surface only) — merged into
 *  the upstream beta by `buildUpstreamHeaders`. */
const inboundBetaOf = (args: TWalkArgs): string | null =>
  args.surface === "messages" ? args.req.headers.get("anthropic-beta") : null;

/**
 * Apply a transform to every tool's `parameters` schema in a built upstream
 * body, leaving tools without a `parameters` (and non-array `tools`) untouched.
 * Shared by the keyword-strip + ref-normalization compat branches so the two
 * can't drift.
 *
 * BOTH tool shapes are handled, because the daemon's upstream wires disagree:
 *   - Responses wire (grok, chatgpt) — FLAT `{type,name,parameters}`;
 *   - chat-completions wire (kimi_code) — NESTED
 *     `{type:"function", function:{name,parameters}}`.
 * Only matching the flat shape forwarded Kimi's tools verbatim, which Moonshot
 * 400s ("tools.function.parameters is not a valid moonshot flavored json
 * schema … references must start with #/$defs/").
 */
const mapOneToolParameters = (
  tool: unknown,
  transform: (params: unknown) => unknown,
): unknown => {
  if (tool === null || typeof tool !== "object") return tool;
  const rec = tool as Record<string, unknown>;
  if ("parameters" in rec) {
    return { ...rec, parameters: transform(rec.parameters) };
  }
  const fn = rec.function;
  if (fn !== null && typeof fn === "object" && "parameters" in fn) {
    const fnRec = fn as Record<string, unknown>;
    return {
      ...rec,
      function: { ...fnRec, parameters: transform(fnRec.parameters) },
    };
  }
  return tool;
};

const mapToolParameters = (
  out: Record<string, unknown>,
  transform: (params: unknown) => unknown,
): Record<string, unknown> => {
  if (!Array.isArray(out.tools)) return out;
  return {
    ...out,
    tools: out.tools.map((tool) => mapOneToolParameters(tool, transform)),
  };
};

/**
 * Whether reading this delegate's LIVE row could change this body at all.
 *
 * Reading it is not free: `getObservedModelCaps` resolves against the
 * vendor's `/v1/models`, which on a cold or expired cache is a network round
 * trip with a 10s timeout — and a failed fetch is not negatively cached, so a
 * vendor outage makes every request pay it again. The boolean hook this
 * replaced was consulted only when the body carried the one param it could
 * remove; calling its successor unconditionally put that cost on requests no
 * denial could possibly affect.
 *
 * The predicate is GENERIC — it asks the delegate which params its rows can
 * deny (`observedDeniedParamCandidates`) and never names one itself, so the
 * fact stays owned by the delegate and a wider candidate set simply widens
 * the demand. It is a skip condition only: when the lookup DOES run, every
 * `deniedParams` entry the observation returns is still applied, candidate or
 * not. A delegate that declares no candidates is always consulted (unknown =
 * ask), which preserves today's behaviour for anything but grok.
 */
const observationCouldApply = (
  delegate: TProviderDelegate,
  body: Record<string, unknown>,
): boolean => {
  const candidates = delegate.observedDeniedParamCandidates;
  if (candidates === undefined) return true;
  return candidates.some((param) => body[param] !== undefined);
};

/**
 * Delegate-owned per-model request compat, applied to the BUILT upstream body
 * (grok today; a no-op for delegates that declare neither knob — audit
 * 2026-07-14 §F2/§F7):
 *   - parameters the delegate OBSERVES as denied on the vendor's live model
 *     list are dropped (`getObservedModelCaps` → `deniedParams`; grok's rows
 *     deny `reasoning` when they advertise no configurable effort, and
 *     `null` = nothing observed leaves the request untouched) — the shared
 *     wire builder can't know this, only the delegate sees `/v1/models`.
 *     The observation is in the catalog's own `ModelCaps` vocabulary, so a
 *     live fact and an authored one are the same kind of thing (see
 *     `mergeObservedModelCaps`), and it may only ever NARROW;
 *   - tool-schema keywords the endpoint rejects stripped recursively from
 *     every tool's `parameters`.
 * The delegate rides in as a parameter (callers pass `getDelegate(...)`) so
 * the offline suite can exercise the policy with a stub.
 */
export const applyDelegateModelCompat = async (
  delegate: TProviderDelegate | null,
  providerModelId: string,
  body: unknown,
): Promise<unknown> => {
  if (delegate === null || body === null || typeof body !== "object") {
    return body;
  }
  let out = body as Record<string, unknown>;
  if (
    delegate.getObservedModelCaps !== undefined &&
    observationCouldApply(delegate, out)
  ) {
    // Read per request, exactly where the boolean hook used to be read:
    // same phase, same (cached) fetch, no bootstrap round-trip — a live
    // vendor fact must not wait on the next catalog refresh. `null` =
    // nothing observed, which leaves the body untouched.
    const observed = await delegate
      .getObservedModelCaps(providerModelId)
      .catch((): null => null);
    for (const param of observed?.deniedParams ?? []) {
      if (out[param] === undefined) continue;
      const { [param]: _dropped, ...rest } = out;
      out = rest;
    }
  }
  const keywords = delegate.unsupportedToolSchemaKeywords;
  if (keywords !== undefined && keywords.length > 0) {
    out = mapToolParameters(out, (params) =>
      stripSchemaKeywords(params, keywords),
    );
  }
  // Ref normalization runs AFTER keyword stripping so both transforms compose on
  // one hop that opts into both (Kimi: refs only, today). See §3.2.
  if (delegate.normalizesToolSchemaRefs === true) {
    out = mapToolParameters(out, (params) => normalizeSchemaRefs(params));
  }
  return out;
};

const sanitizeErrorLine = (err: unknown, max: number): string => {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = raw.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const upstreamErrorLine = (err: UpstreamStreamError): string => {
  const { type, message } = upstreamErrorFrom(err);
  return message.startsWith(type) ? message : `${type}: ${message}`;
};

/**
 * The one-line, credential-safe reason a stream failed — the vendor's terminal
 * error (with its own `upstreamType` code) when there is one, else the thrown
 * transport failure. This is what BOTH the client envelope and the recorded
 * `public.requests` row must carry: an upstream failure is unguessable, so a
 * row without it is not debuggable.
 */
const streamFailureDetail = (err: unknown): string => {
  const cause = streamFailureCause(err);
  return cause instanceof UpstreamStreamError
    ? sanitizeErrorLine(upstreamErrorLine(cause), 300)
    : sanitizeErrorLine(cause, 300);
};

const streamFailureTokens = (err: unknown): TNativeTokens => {
  const usage = partialUsageFrom(err);
  return usage === null ? ZERO_TOKENS : tokensFromResponse({ usage });
};

export type THopRetry = {
  readonly kind: "retry";
  readonly reason: string;
  readonly status?: number;
  readonly bodySnippet?: string;
  readonly cooldownReason?: TCooldownReason;
  /** Original upstream error retained when a later forced retry must fail back. */
  readonly upstreamResponse?: Response;
  /** Absolute vendor `Retry-After` recover time — the authoritative doom floor. */
  readonly recoverAtMs?: number;
};

export type THopServeOutcome = Response | THopRetry;

export type THopTrailEntry = {
  readonly modelId: string;
  readonly provider: string;
  readonly reason: string;
  readonly status?: number;
};

export const hopRetry = (
  reason: string,
  detail?: {
    readonly status?: number;
    readonly bodySnippet?: string;
    readonly cooldownReason?: TCooldownReason;
    readonly upstreamResponse?: Response;
    readonly recoverAtMs?: number;
  },
): THopRetry => ({
  kind: "retry",
  reason,
  ...(detail?.status !== undefined ? { status: detail.status } : {}),
  ...(detail?.bodySnippet !== undefined && detail.bodySnippet.length > 0
    ? { bodySnippet: detail.bodySnippet }
    : {}),
  ...(detail?.cooldownReason !== undefined
    ? { cooldownReason: detail.cooldownReason }
    : {}),
  ...(detail?.upstreamResponse !== undefined
    ? { upstreamResponse: detail.upstreamResponse }
    : {}),
  ...(detail?.recoverAtMs !== undefined
    ? { recoverAtMs: detail.recoverAtMs }
    : {}),
});

export const isHopRetry = (v: THopServeOutcome): v is THopRetry =>
  typeof v === "object" &&
  v !== null &&
  "kind" in v &&
  (v as { kind: unknown }).kind === "retry";

/** Short single-line snippet from upstream body for trail/UI (max chars). */
export const hopBodySnippet = (raw: string, max = 200): string => {
  const line = raw.replace(/\s+/g, " ").trim();
  if (line.length === 0) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

export const formatHopFailuresHeader = (
  trail: ReadonlyArray<THopTrailEntry>,
): string =>
  trail
    .map((e) => {
      // Keep the sanitized reason detail even when a status is present — a
      // bare `model:403` loses the "usage limit" / "context window" context
      // that makes the trail diagnosable.
      const tag = e.reason
        .replace(/[\r\n;,]+/g, " ")
        .trim()
        .slice(0, 48);
      const label = tag.length > 0 ? tag : "failed";
      return e.status !== undefined
        ? `${e.modelId}:${e.status}:${label}`
        : `${e.modelId}:${label}`;
    })
    .join(";");

/** The handrolled transport's upstream wire for `provider`, or `undefined`
 *  when the provider has no manual (handrolled) transport at all (cursor,
 *  muse). A read-only lookup over the same `UPSTREAM_WIRE` table
 *  `serveSubscriptionHop` uses — never a second, duplicated map — so a
 *  benchmark or diagnostic caller can determine handrolled-eligibility
 *  without re-deriving the provider→wire mapping. */
export const upstreamWireFor = (provider: string): TUpstreamWire | undefined =>
  UPSTREAM_WIRE[provider];

/**
 * The walker's manual (handrolled) upstream-HTTP transport for one
 * subscription hop — exported ONLY as a benchmark/diagnostic seam (see
 * `scripts/bridge-capture-benchmark/`). Production call sites remain
 * `serveSubscriptionHop`'s own internal calls above; this export changes no
 * behavior, it just lets an external, read-only caller reuse the exact same
 * `acquireUpstream` → `buildUpstreamRequest` → streaming/cleanup pipeline
 * production handrolled dispatch already runs, rather than reimplementing
 * headers/credential-acquisition/body-adaptation in a parallel script.
 */
export const serveSubscription = async (
  hop: THop,
  wire: TUpstreamWire,
  args: TWalkArgs,
  finalHop: boolean,
  onQuotaExhausted?: (provider: string, accountHash: string | null) => void,
  walkSessionKey?: string,
): Promise<THopServeOutcome> => {
  const acquired = await acquireUpstream(
    hop.provider,
    args,
    hop,
    walkSessionKey,
  );
  if (acquired === "retry") return hopRetry("no usable credential");
  const { headers: baseHeaders, url, accountHash } = acquired;

  const clientWantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  // ONE shared recipe — body + headers — for the (clientWire × upstreamWire)
  // pairing (the cloud runner calls the same builder). Capabilities come
  // from the bootstrap catalog via `resolveHop` — never injected by hand.
  let built: ReturnType<typeof buildUpstreamRequest>;
  try {
    built = buildUpstreamRequest({
      surface: args.surface,
      upstreamWire: wire,
      rawBody: args.rawBody,
      provider: hop.provider,
      providerModelId: hop.providerModelId,
      stream: clientWantsStream,
      baseHeaders,
      inboundBeta: inboundBetaOf(args),
      isOAuth: wire === "anthropic",
      codexInstructions: wantsCodexPreamble(hop.provider),
      caps: hop.caps,
      modelSettings: hop.modelSettings,
      capabilities: hop.capabilities,
    });
  } catch (err) {
    if (err instanceof UnsupportedContentError) {
      if (!finalHop) return hopRetry("unsupported_content");
      return errorJson(400, err.message, "unsupported_content");
    }
    throw err;
  }
  const headers = built.headers;
  // Build from the same canonical request that `buildUpstreamRequest` encoded.
  // Empty maps stay absent from decoder state, preserving the normal path.
  const canonicalForToolNames = canonicalFromInbound(
    args.surface,
    args.rawBody,
  );
  const toolNameMap =
    wire === "chatgpt"
      ? buildChatGptToolNameMap(canonicalForToolNames)
      : wire === "anthropic"
        ? buildAnthropicToolNameMap(canonicalForToolNames)
        : undefined;
  let body = await applyDelegateModelCompat(
    getDelegate(hop.provider),
    hop.providerModelId,
    applyOutputTokenBackfill(built.body, {
      hopModelId: hop.modelId,
      rawBody: args.rawBody,
      getOutputTokenLimit: (modelId) =>
        lookupCatalogEntry(modelId)?.output_token_limit ?? null,
      wire,
      codexInstructions: wantsCodexPreamble(hop.provider),
    }),
  );
  // Provider-native search: the client DECLARED the Anthropic
  // `web_search_*` server tool — an explicit platform-executes-search
  // contract (Claude Code's WebSearch). A bare `web_search`-NAMED function
  // tool never triggers a provider-native branch.
  //
  //   - chatgpt: Codex's OpenAI Responses `web_search` tool executes hosted
  //     search within ONE request. The bridge enables this capability through
  //     `thread/start.config`; handrolled hops must inject the native tool
  //     themselves or leak an unexecutable client `web_search` function.
  //   - grok: xAI's Responses proxy runs web + X search fully server-side
  //     within ONE request. Swap the canonicalised `web_search` function
  //     tool for the native `web_search`/`x_search` tools (one search owner
  //     per turn); the chatgpt stream decoder re-emits the executed
  //     searches as canonical `server_search_calls` → blocks + usage.
  //   - kimi_code: Moonshot's builtin `$web_search` also executes
  //     server-side, but its protocol pauses for a verbatim ARGUMENT ECHO
  //     per search — served by `serveKimiBuiltinSearch` below (a protocol
  //     echo, not gateway agency: nothing is extracted, executed, or
  //     synthesized on this box).
  const declaredSearch =
    args.surface === "messages" &&
    declaresAnthropicServerSearchTool(args.rawBody);
  if (declaredSearch && hop.provider === "chatgpt") {
    body = withChatGptNativeSearch(body);
  }
  if (declaredSearch && hop.provider === "grok") {
    body = withGrokNativeSearch(body);
  }
  if (declaredSearch && hop.provider === "kimi_code") {
    return serveKimiBuiltinSearch(
      hop,
      args,
      finalHop,
      { url, headers, accountHash },
      withKimiBuiltinSearch(body),
    );
  }
  const transport = { failure: null as TTransportFailure | null };
  // §4.1 cache-race probe (opt-in): only the Anthropic wire races a prompt
  // cache prefix; other wires have no cache-write concept to correlate.
  const cacheProbe: TCacheProbe | null =
    cacheProbeEnabled() && wire === "anthropic"
      ? (() => {
          const prefixHash = cacheProbePrefixHash(body);
          return prefixHash === null
            ? null
            : {
                prefixHash,
                model: hop.modelId,
                providerModelId: hop.providerModelId,
                accountHash,
                lastInFlight: 0,
              };
        })()
      : null;
  const dispatch = (): Promise<Response | null> =>
    postWithReplayStripRetry(
      url,
      headers,
      body,
      wire,
      args.req.signal,
      (failure) => {
        transport.failure = failure;
      },
    );
  const resp =
    cacheProbe !== null
      ? await cacheProbeWrap(cacheProbe, dispatch)
      : await dispatch();
  if (resp === null) {
    // An inbound cancellation aborts the fetch by design. It is terminal but
    // not an upstream failure, so it must neither walk nor write a cooldown row.
    if (args.req.signal.aborted)
      return errorJson(499, "client aborted request");
    return hopRetry(transport.failure?.reason ?? "network error", {
      cooldownReason: "network",
    });
  }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    const bodySnippet = hopBodySnippet(raw);
    // No output has been committed yet. A different configured candidate may
    // accept the same canonical request regardless of this provider's status
    // code or envelope shape, so use the shared cloud/daemon policy.
    const cls = classifyPrecommitResponse(
      resp.status,
      raw,
      wire,
      args.req.signal.aborted,
    );
    if (cls.kind === "transient" && !args.req.signal.aborted) {
      // Capture the vendor's Retry-After as an ABSOLUTE recover floor (the
      // generic doom oracle). Never shortens the 180s policy TTL — it's an
      // ADDITIONAL fact a recovery pass consults before bypassing a transient
      // cooldown.
      const recoverAtMs = retryAfterRecoverAtMs(resp);
      return hopRetry(
        `HTTP ${resp.status}: ${bodySnippet || "upstream rejected"}`,
        {
          status: resp.status,
          bodySnippet,
          cooldownReason: cls.reason,
          upstreamResponse: new Response(raw.length > 0 ? raw : null, {
            status: resp.status,
            headers: passthroughHeaders(resp),
          }),
          ...(recoverAtMs !== undefined ? { recoverAtMs } : {}),
        },
      );
    }
    // The final hop has nowhere to walk (or the caller aborted): surface the
    // upstream response verbatim, including status and Retry-After. Still
    // record a zero-token error row so Overview's debug table shows it.
    if (cls.kind === "transient" && cls.reason === "quota_exhausted") {
      onQuotaExhausted?.(hop.provider, accountHash);
    }
    report(
      {
        model: hop.modelId,
        provider: hop.provider,
        status: statusFor(resp.status),
        ...ZERO_TOKENS,
        latency_ms: Date.now() - args.startedAt,
        endpoint: args.endpoint,
        error: `HTTP ${resp.status}: ${bodySnippet || "upstream rejected"}`,
        cooldown_reason:
          cls.kind === "transient" ? cls.reason : "upstream_rejection",
        ...(accountHash !== null ? { account_hash: accountHash } : {}),
      },
      args.originParam,
    );
    // Final-hop failure still cools the model — bust the plan cache so the
    // next request re-resolves instead of replaying this leader.
    clearPlanCache();
    return new Response(raw.length > 0 ? raw : null, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }

  if (!resp.body) return hopRetry("empty response body");

  // Committed. Re-encode the response to the client's wire + record a
  // metadata row. Cost is NOT computed here — the cloud recomputes it from
  // these token counts (single pricing source of truth, no local table).
  const clientWire = clientWireOf(args.surface);
  // `responses` clients always need a Responses re-encode (never raw upstream
  // bytes), so they never take the verbatim passthrough.
  const passthrough =
    wire === clientWire &&
    args.surface !== "responses" &&
    !hop.stripSubagentIsolation;
  // What the UPSTREAM produced, decided deterministically (not sniffed):
  // chatgpt's Codex/Responses endpoint ALWAYS streams (`toChatGptRequest`
  // forces `stream: true`); anthropic + kimi propagate the request's stream
  // flag, which buildUpstreamBody set from the client's. So upstream is SSE
  // iff chatgpt, or the client asked to stream.
  const upstreamStreams = wire === "chatgpt" || clientWantsStream;
  // NOTE: `latency_ms` is deliberately NOT part of `baseRow`. A streaming hop
  // commits within milliseconds and then runs for minutes, so a latency
  // stamped here would describe time-to-first-byte and mislabel every stream
  // (a real 342s stream recorded 2066ms). Each report stamps it when the row
  // is actually written — i.e. when the stream ends.
  const baseRow = {
    model: hop.modelId,
    provider: hop.provider,
    status: statusFor(resp.status),
    endpoint: args.endpoint,
    ...(accountHash !== null ? { account_hash: accountHash } : {}),
  } satisfies Partial<TDaemonRecordRequest>;
  const elapsed = (): number => Date.now() - args.startedAt;
  const upstreamBody =
    wire === "chatgpt" && process.env.OPENLLM_DEBUG_CODEX_SSE === "1"
      ? tapCodexSseStream(resp.body, Date.now())
      : resp.body;
  const recordTokens = (u: TNativeTokens): void => {
    if (cacheProbe !== null) cacheProbeOutcome(cacheProbe, u);
    report({ ...baseRow, latency_ms: elapsed(), ...u }, args.originParam);
  };
  /**
   * A committed stream that died mid-flight. The hop returned 200, so
   * `baseRow.status` is "success" — it MUST be overridden here, else a severed
   * stream is recorded as a healthy turn (indistinguishable from success, with
   * only the zero token count as a hint). The client has already received a
   * 200 and partial bytes; this row is the only record that it broke.
   *
   * A CLIENT abort is excluded: `args.req.signal.aborted` or
   * {@link isClientHangUp} (the marker `cancelTee` stamps on body cancel).
   * A plain upstream AbortError is still a provider failure and IS recorded.
   */
  const recordStreamFailure = (err: unknown): void => {
    if (args.req.signal.aborted) return;
    if (isClientHangUp(err)) return;
    noteWalkerStreamTerminal({ aborted: false, hang: false });
    report(
      {
        ...baseRow,
        status: "error",
        ...streamFailureTokens(err),
        latency_ms: elapsed(),
        error: `upstream stream failed after output began: ${streamFailureDetail(err)}`,
      },
      args.originParam,
    );
  };

  // Shared terminal handling for a FIRST-event in-stream rejection caught
  // by the pre-commit peek (streaming passthrough, streaming cross-wire,
  // and the JSON drain): a non-final hop WALKS — nothing was generated,
  // so the walk cannot double-spend; the final hop surfaces a 502
  // recorded as an ERROR row.
  const peekedError = (error: unknown): THopServeOutcome => {
    const detail = streamFailureDetail(error);
    const cls = classifyRawResponse(
      502,
      detail,
      hopFormat(wire),
      args.req.signal.aborted,
    );
    const upstreamResponse = errorJson(
      502,
      `upstream stream ended before producing output: ${detail}`,
    );
    if (!finalHop && !args.req.signal.aborted) {
      // Preserve the terminal response this pre-output error would have
      // produced on the final hop, so a forced-context epilogue that also
      // fails surfaces IT (the authentic upstream failure) instead of the
      // generic all-hops-failed 502 — mirroring the non-final HTTP
      // pre-commit branch above. Critically, classify the body before
      // returning: HTTP 200 stream failures can still be context overflow.
      return hopRetry(detail, {
        status: 502,
        bodySnippet: detail,
        ...(cls.kind === "transient" ? { cooldownReason: cls.reason } : {}),
        upstreamResponse,
      });
    }
    if (args.req.signal.aborted) {
      // Client hung up before the first output byte (deliberate Ctrl-C).
      // Terminal but NOT an upstream fault: writing an error row here would
      // cool the provider on the cloud (daemon-record maps a bare `error`
      // status to `upstream_rejection`). Skip the row and return 499 — the
      // same rule the pre-commit 499, `recordStreamFailure`, and
      // `refusalWalks` already apply for an aborted request.
      return errorJson(499, "client aborted request");
    }
    if (cls.kind === "transient" && cls.reason === "context_overflow") {
      report(
        {
          ...baseRow,
          status: "error",
          ...ZERO_TOKENS,
          latency_ms: elapsed(),
          error: `upstream stream ended before producing output: ${detail}`,
        },
        args.originParam,
      );
      return hopRetry(detail, {
        status: 502,
        bodySnippet: detail,
        cooldownReason: cls.reason,
        upstreamResponse,
      });
    }
    report(
      {
        ...baseRow,
        status: "error",
        ...ZERO_TOKENS,
        latency_ms: elapsed(),
        error: `upstream stream ended before producing output: ${detail}`,
      },
      args.originParam,
    );
    return errorJson(
      502,
      `upstream stream ended before producing output: ${detail}`,
    );
  };

  // A STRUCTURED refusal (Anthropic policy/safety block, content filter)
  // that preceded ANY output is not proof another candidate will refuse
  // the same canonical request — so a non-final, non-aborted hop WALKS
  // (nothing was generated; no double-spend), exactly like the pre-output
  // stream-error path. It is request-semantic, NOT a provider-health
  // fault, so it never marks a cooldown. The FINAL hop has nowhere to
  // walk: it surfaces the authentic provider refusal (returns false, so
  // the caller commits the buffered stream / decoded response as-is).
  const refusalWalks = (): boolean => !finalHop && !args.req.signal.aborted;

  // ── Client wants a live stream ──────────────────────────────────────
  // First-class path: stream chunk-by-chunk, re-encoding to the client's
  // wire as bytes arrive. (upstreamStreams is always true here — chatgpt
  // always streams; anthropic/kimi stream because the client asked.)
  if (clientWantsStream) {
    // Keep the (localhost) client connection warm while the upstream is
    // quiet during a long reasoning / tool run — the same "chat stopped
    // while it was actually doing something" symptom the cloud guards. The
    // daemon does NOT add `withStreamDeadline`: that exists only to beat
    // Vercel's `maxDuration` guillotine (a cloud-only concept), and a daemon
    // crash can't emit a terminator regardless. Frame-aligned so a beat is
    // never spliced inside a half-sent SSE event.
    const heartbeat = (
      bytes: ReadableStream<Uint8Array>,
    ): ReadableStream<Uint8Array> =>
      withFrameAlignedHeartbeat(bytes, heartbeatOptionsFor(args.surface));
    // Meter token usage off a tee'd canonical branch (never blocks the
    // client; accurate counts come from the final chunk's usage).
    const meter = (chunks: ReadableStream<TChatCompletionChunk>): void => {
      void accumulateChunksToResponse(chunks, hop.providerModelId)
        .then((r) => recordTokens(tokensFromResponse(r)))
        .catch(recordStreamFailure);
    };
    if (passthrough) {
      // Same wire in and out — the client gets the upstream bytes verbatim
      // (no transform round-trip that could alter them); a tee'd copy is
      // decoded purely to meter. The meter branch doubles as the
      // pre-commit peek: an in-stream rejection that precedes any output
      // (Anthropic emits `event: error` on a 200 for overloaded_error
      // etc.) surfaces BEFORE the byte-verbatim response is committed, so
      // a non-final hop can walk instead of dying inside a committed
      // stream. The client branch stays byte-verbatim either way.
      const [toClient, toMeter] = upstreamBody.tee();
      const peeked = await peekFirstChunk(
        decodeUpstreamStream(wire, toMeter, hop.providerModelId, toolNameMap),
        isMeaningfulChunk,
        // The meter's decoded view is LOSSY (schema-unknown frames are
        // dropped): an empty decode of a byte-verbatim passthrough must
        // commit, not walk — the client's bytes ride `toClient` untouched.
        { emptyStreamIsError: false, isRefusal: isRefusalChunk },
      );
      if (peeked.kind === "error") {
        void toClient.cancel().catch(() => undefined);
        return peekedError(peeked.error);
      }
      if (peeked.kind === "refusal" && refusalWalks()) {
        void toClient.cancel().catch(() => undefined);
        void peeked.chunks.cancel().catch(() => undefined);
        return hopRetry("content filter refusal");
      }
      meter(peeked.chunks);
      return new Response(heartbeat(toClient), {
        status: resp.status,
        headers: passthroughHeaders(resp),
      });
    }
    // Cross-wire (or chatgpt): decode → peek → the shared delivery tail
    // (tee → meter + re-encode + heartbeat — `deliverChunkStream`, the same
    // tail the native bridge uses). The signal-bounded first-event peek
    // keeps the response uncommitted until the first meaningful chunk, so a
    // pre-output in-stream rejection (context overflow) WALKS a non-final
    // hop instead of dying inside a committed stream — however long the
    // vendor's prefill takes to produce it.
    const peeked = await peekFirstChunk(
      decodeUpstreamStream(
        wire,
        upstreamBody,
        hop.providerModelId,
        toolNameMap,
      ),
      isMeaningfulChunk,
      { isRefusal: isRefusalChunk },
    );
    if (peeked.kind === "error") return peekedError(peeked.error);
    if (peeked.kind === "refusal" && refusalWalks()) {
      void peeked.chunks.cancel().catch(() => undefined);
      return hopRetry("content filter refusal");
    }
    return deliverChunkStream(peeked.chunks, {
      surface: args.surface,
      clientWire,
      providerModelId: hop.providerModelId,
      status: resp.status,
      onResponse: (r) => recordTokens(tokensFromResponse(r)),
      onError: recordStreamFailure,
      stripSubagentIsolation: hop.stripSubagentIsolation,
    });
  }

  // ── Client wants a single JSON response ─────────────────────────────
  const jsonHeaders = { "content-type": "application/json" } as const;

  if (upstreamStreams) {
    // The upstream streamed but the client wants JSON (chatgpt, whose Codex
    // endpoint always streams): peek the first event, then DRAIN → one
    // response. The peek splits the two failure classes: a FIRST-event
    // rejection (the gpt-5.6 overflow incident shape: HTTP 200, then
    // `error: Your input exceeds the context window`) arrives before the
    // vendor generated anything, so a non-final hop WALKS without
    // double-generation; a failure AFTER output began is terminal — the
    // vendor already spent tokens on this turn, so it is never
    // re-dispatched.
    const peeked = await peekFirstChunk(
      decodeUpstreamStream(
        wire,
        upstreamBody,
        hop.providerModelId,
        toolNameMap,
      ),
      isMeaningfulChunk,
      { isRefusal: isRefusalChunk },
    );
    if (peeked.kind === "error") return peekedError(peeked.error);
    if (peeked.kind === "refusal" && refusalWalks()) {
      void peeked.chunks.cancel().catch(() => undefined);
      return hopRetry("content filter refusal");
    }
    let canonical: TChatCompletionResponse;
    try {
      canonical = await accumulateChunksToResponse(
        peeked.chunks,
        hop.providerModelId,
      );
    } catch (err) {
      // Mid-drain failure (output had begun): terminal, never retried.
      // Keep the vendor's terminal error (with its upstreamType code, not
      // the UpstreamStreamError class name) / the drain failure's first
      // line instead of a bare generic message. Recorded as an ERROR row —
      // the client receives a 502, so `statusFor(resp.status)`'s "success"
      // (from the upstream 200) would misreport the outcome.
      recordStreamFailure(err);
      return errorJson(
        502,
        `upstream stream failed after output began: ${streamFailureDetail(err)}`,
      );
    }
    recordTokens(tokensFromResponse(canonical));
    return deliverJsonResponse(
      canonical,
      args.surface,
      clientWire,
      resp.status,
      hop.stripSubagentIsolation,
    );
  }

  // Upstream returned JSON + client wants JSON (anthropic/kimi non-stream).
  // Decode for tokens + client re-encode; on parse/decode failure surface
  // the upstream payload verbatim rather than mangling it.
  //
  // The read itself can fail: the upstream committed a 200 and then dropped
  // the connection mid-body. Unguarded, that rejection escapes `runWalker`
  // entirely — no row is written and the daemon's outer handler synthesizes a
  // bare 500, the most invisible failure this walker can produce. Treat it as
  // the post-commit stream failure it is.
  let text: string;
  try {
    text = await resp.text();
  } catch (err) {
    recordStreamFailure(err);
    return errorJson(
      502,
      `upstream stream failed after output began: ${streamFailureDetail(err)}`,
    );
  }
  // An undecodable body is NOT a failed request: the client receives the
  // upstream's 200 bytes verbatim, so the row's status stays "success". What
  // is lost is METERING — we can't read the token counts — and a zero-token
  // success row is exactly the undebuggable shape this file is trying to
  // eliminate. So the row keeps its honest status and carries a note saying
  // why the counts are zero, rather than silently looking like a free request.
  const recordUnmetered = (reason: string): void =>
    report(
      {
        ...baseRow,
        ...ZERO_TOKENS,
        latency_ms: elapsed(),
        error: `delivered verbatim but not metered: ${reason}`,
      },
      args.originParam,
    );
  let upstreamJson: unknown;
  try {
    upstreamJson = JSON.parse(text);
  } catch (err) {
    recordUnmetered(`response body is not JSON (${streamFailureDetail(err)})`);
    return new Response(text, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }
  let canonical: TChatCompletionResponse;
  try {
    canonical = decodeUpstreamJson(
      wire,
      upstreamJson,
      hop.providerModelId,
      toolNameMap,
    );
  } catch (err) {
    recordUnmetered(
      `response did not decode on the ${wire} wire (${streamFailureDetail(err)})`,
    );
    return new Response(text, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }
  // A 200 whose decoded body IS a structured refusal walks a non-final hop
  // (nothing to double-spend), mirroring the streaming pre-commit peek and
  // the cloud non-stream promotion. The final hop surfaces it verbatim.
  if (isCanonicalRefusal(canonical) && refusalWalks()) {
    return hopRetry("content filter refusal");
  }
  recordTokens(tokensFromResponse(canonical));
  // Passthrough returns the upstream bytes verbatim; cross-wire re-encodes
  // through the shared delivery tail.
  return passthrough
    ? new Response(text, { status: resp.status, headers: jsonHeaders })
    : deliverJsonResponse(
        canonical,
        args.surface,
        clientWire,
        resp.status,
        hop.stripSubagentIsolation,
      );
};

/**
 * Serve a kimi_code hop whose client declared the Anthropic server search
 * tool, over Moonshot's builtin `$web_search` PROTOCOL ECHO (see
 * `@openllmsh/wire/providers/kimi/web-search`): each round's builtin
 * tool calls are answered by echoing their opaque arguments back verbatim —
 * the search already ran server-side; Moonshot injects the stored results
 * into context on the next round. The walker extracts nothing, executes
 * nothing, and synthesizes nothing. Rounds are read in full (a `stream:
 * true` client gets the final answer as a one-shot SSE re-encode); each
 * echoed search is reported as a canonical `ServerSearchCall` (opaque —
 * Moonshot never exposes the query) so the client's search counter works.
 * ONE usage row is recorded, summed across rounds.
 */
const serveKimiBuiltinSearch = async (
  hop: THop,
  args: TWalkArgs,
  _finalHop: boolean,
  acquired: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly accountHash: string | null;
  },
  initialBody: unknown,
): Promise<THopServeOutcome> => {
  const wire: TUpstreamWire = "openai";
  const clientWantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  const clientWire = clientWireOf(args.surface);
  let body = initialBody as Record<string, unknown>;
  // Rounds must be read in full to see the builtin calls.
  body = { ...body, stream: false };
  const executed: TServerSearchCall[] = [];
  const totals = { ...ZERO_TOKENS };
  const addTokens = (raw: unknown): void => {
    const usage =
      raw !== null && typeof raw === "object"
        ? (raw as { readonly usage?: Record<string, unknown> }).usage
        : undefined;
    if (usage === undefined) return;
    totals.tokens_in += Number(usage.prompt_tokens ?? 0) || 0;
    totals.tokens_out += Number(usage.completion_tokens ?? 0) || 0;
  };
  const recordOnce = (
    status: TRequestStatus,
    cooldownReason?: TCooldownReason,
  ): void =>
    report(
      {
        model: hop.modelId,
        provider: hop.provider,
        status,
        latency_ms: Date.now() - args.startedAt,
        endpoint: args.endpoint,
        ...(cooldownReason !== undefined
          ? { cooldown_reason: cooldownReason }
          : {}),
        ...(acquired.accountHash !== null
          ? { account_hash: acquired.accountHash }
          : {}),
        ...totals,
      },
      args.originParam,
    );

  for (let round = 0; ; round++) {
    const resp = await postWithReplayStripRetry(
      acquired.url,
      acquired.headers,
      body,
      wire,
      args.req.signal,
    );
    // Round 0 keeps `serveSubscription`'s walk semantics (nothing consumed
    // yet). A LATER round already burned echo rounds + tokens on this hop —
    // walking to another provider would silently discard that usage and
    // re-run the whole conversation, so surface the continuation failure
    // instead and record what was consumed.
    if (resp === null) {
      if (round === 0) {
        return hopRetry("network error", { cooldownReason: "network" });
      }
      recordOnce("error");
      return errorJson(
        502,
        "kimi built-in web search: continuation round failed (network)",
      );
    }
    if (!resp.ok) {
      const raw = await resp.text().catch(() => "");
      const bodySnippet = hopBodySnippet(raw);
      const cls = classifyPrecommitResponse(
        resp.status,
        raw,
        wire,
        args.req.signal.aborted,
      );
      if (round === 0 && cls.kind === "transient") {
        // Round 0 has consumed nothing yet, so hand the decision to the
        // walker-level handler regardless of hop position: it applies a bounded
        // in-place retry for retry_in_place reasons (honouring Retry-After), or
        // surfaces this authentic upstream response for cool/walk policies —
        // the same unified path every other hop uses. `resp` is already drained
        // by `.text()`, so pass a reconstructed Response with the real status +
        // body + recover floor.
        const upstreamResponse = new Response(raw.length > 0 ? raw : null, {
          status: resp.status,
          headers: passthroughHeaders(resp),
        });
        return hopRetry(
          `HTTP ${resp.status}: ${bodySnippet || "upstream rejected"}`,
          {
            status: resp.status,
            bodySnippet,
            cooldownReason: cls.reason,
            upstreamResponse,
            recoverAtMs: retryAfterRecoverAtMs(resp),
          },
        );
      }
      recordOnce(
        statusFor(resp.status),
        cls.kind === "transient" ? cls.reason : undefined,
      );
      return new Response(raw.length > 0 ? raw : null, {
        status: resp.status,
        headers: passthroughHeaders(resp),
      });
    }
    const text = await resp.text();
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(text);
    } catch {
      recordOnce("error");
      return new Response(text, {
        status: resp.status,
        headers: passthroughHeaders(resp),
      });
    }
    addTokens(rawJson);

    const builtinCalls = kimiBuiltinSearchCalls(rawJson);
    // Round ceiling: a model STILL searching at the cap cannot be decoded as
    // a final answer (its builtin tool_calls would fail the canonical decode
    // and leak raw kimi JSON to the client) — fail explicitly instead.
    if (builtinCalls !== null && round >= KIMI_SEARCH_MAX_ROUNDS) {
      recordOnce("error");
      return errorJson(
        502,
        `kimi built-in web search exceeded the round limit (${KIMI_SEARCH_MAX_ROUNDS})`,
      );
    }
    if (builtinCalls === null) {
      // FINAL round — decode canonically, attach the executed searches, and
      // re-encode for the client.
      let canonical: TChatCompletionResponse;
      try {
        canonical = decodeUpstreamJson(wire, rawJson, hop.providerModelId);
      } catch {
        recordOnce("error");
        return new Response(text, {
          status: resp.status,
          headers: passthroughHeaders(resp),
        });
      }
      const choice = canonical.choices[0];
      const final: TChatCompletionResponse =
        executed.length > 0 && choice !== undefined
          ? {
              ...canonical,
              usage: {
                ...canonical.usage,
                prompt_tokens: totals.tokens_in,
                completion_tokens: totals.tokens_out,
                total_tokens: totals.tokens_in + totals.tokens_out,
              },
              choices: [
                {
                  ...choice,
                  message: {
                    ...choice.message,
                    server_search_calls: executed,
                  },
                },
                ...canonical.choices.slice(1),
              ],
            }
          : canonical;
      recordOnce(statusFor(resp.status));
      // Tokens already recorded — encode-only via the shared delivery tail.
      return clientWantsStream
        ? sseResponseForClient(
            responseToChunkStream(final),
            args.surface,
            clientWire,
            undefined,
            hop.stripSubagentIsolation,
          )
        : deliverJsonResponse(
            final,
            args.surface,
            clientWire,
            undefined,
            hop.stripSubagentIsolation,
          );
    }

    // Echo round: report each server-executed search (query is opaque to
    // this box) and feed the arguments back verbatim.
    for (const call of builtinCalls) {
      executed.push({ id: call.id, query: "" });
    }
    body = {
      ...body,
      messages: [
        ...((body.messages as unknown[] | undefined) ?? []),
        ...kimiSearchEchoMessages(rawJson, builtinCalls),
      ],
    };
  }
};

/**
 * Walk the plan and return the committed `Response`. The walker is the
 * daemon's ONLY data path — there is no core-backed fallback — so it
 * always answers with a Response (never throws; a bare throw would 500 the
 * user instead of surfacing a clean error). A request the listener could
 * not resolve a plan for → 400.
 */
/**
 * Local subscription readiness for one provider — shared by the auth gate
 * and the quota-account lookup so a hop pays `status()` at most once.
 * `connected: false` means install-only / not signed in / status failed;
 * the walker must not spawn a bridge or attempt handrolled on that box.
 */
export type TLocalSubscriptionAuth = {
  readonly connected: boolean;
  readonly detail: string | null;
};

export const ensureLocalSubscription = async (
  provider: string,
  connectedByProvider: Map<string, TLocalSubscriptionAuth>,
  accountHashByProvider: Map<string, string | null>,
): Promise<TLocalSubscriptionAuth> => {
  const cached = connectedByProvider.get(provider);
  if (cached !== undefined) return cached;

  const { readProviderStatus } = await import("./status");
  const { normalizeProviderConnection } = await import("@openllmsh/protocol");
  const status = await readProviderStatus(provider);
  if (status === null) {
    const miss: TLocalSubscriptionAuth = {
      connected: false,
      detail: `${provider} is not a local subscription provider`,
    };
    connectedByProvider.set(provider, miss);
    accountHashByProvider.set(provider, null);
    return miss;
  }
  const normalized = normalizeProviderConnection(status);
  const result: TLocalSubscriptionAuth = {
    connected: normalized.serviceable,
    detail: normalized.serviceable
      ? null
      : (status.detail ?? `${provider} not signed in on this device`),
  };
  connectedByProvider.set(provider, result);
  accountHashByProvider.set(
    provider,
    normalized.serviceable ? (status.account_hash ?? null) : null,
  );
  return result;
};

export const usageForActiveAccount = async (
  provider: string,
  accountHashByProvider: Map<string, string | null>,
  connectedByProvider: Map<string, TLocalSubscriptionAuth> = new Map(),
): Promise<TProviderUsageSnapshot | null> => {
  // Single resolution path:
  //   1. If the auth cache already says not-connected → null (walker auth gate
  //      already paid for status()).
  //   2. If the account hash is not yet known → ensureLocalSubscription fills
  //      both maps (same probe the hop auth gate uses).
  //   3. Peek the usage cache for that account. A pre-seeded account hash
  //      (unit tests) is honored without a live status() re-probe.
  const known = connectedByProvider.get(provider);
  if (known !== undefined && !known.connected) return null;

  if (!accountHashByProvider.has(provider)) {
    const auth = await ensureLocalSubscription(
      provider,
      connectedByProvider,
      accountHashByProvider,
    );
    if (!auth.connected) return null;
  }

  const accountHash = accountHashByProvider.get(provider) ?? null;
  if (accountHash === null) return null;
  const delegate = getDelegate(provider);
  if (delegate === null) return null;
  // `usage()` is a stored-credential read — it must not native-refresh.
  return peekUsageForQuotaGate(provider, accountHash, () => delegate.usage());
};

/**
 * The plan hop with the LARGEST known input window, and that window — the
 * last-resort compaction target. Unknown-limit hops are ignored (no window to
 * size a budget from). Returns `null` when no hop declares a limit.
 */
const largestContextHop = (
  hops: ReadonlyArray<THop>,
): { hop: THop; window: number } | null => {
  let best: { hop: THop; window: number } | null = null;
  for (const hop of hops) {
    const window = lookupCatalogEntry(hop.modelId)?.input_token_limit ?? null;
    if (window !== null && (best === null || window > best.window)) {
      best = { hop, window };
    }
  }
  return best;
};

/**
 * Fleet subscription tunnel — the consuming-daemon fallback for a
 * subscription hop this box could not serve locally.
 *
 * Single call site after local serve is exhausted for ANY subscription
 * provider (auth gate miss, bridge decline, handrolled hopRetry, empty
 * local method list). The trigger is "this box can't serve" — never a
 * per-slug branch. Without this, browser→B→A never exercises when B has
 * the CLI installed but no login, or when a bridge-only hop declines.
 *
 * When the bootstrap snapshot names an online fleet peer serving the
 * provider, the ORIGINAL inbound request tunnels to the peer over the
 * relay; the peer walks it with its own credential (its local plan fetch
 * pins the same alias, so the same chain policy applies). Returns null —
 * meaning "fall through like any failed hop" — when: the request is
 * itself tunnel-borne from a fleet daemon (loop guard — stamped by
 * tunnel-server only for `consumer:"daemon"`; browser→device omits it so
 * this selected device can still fleet once), no peer serves the
 * provider, or the tunnel fails before the response head.
 */
const tryFleetTunnel = async (
  hop: THop,
  args: TWalkArgs,
): Promise<Response | null> => {
  if (args.req.headers.get(TUNNELED_REQUEST_HEADER) === TUNNELED_REQUEST_VALUE)
    return null;
  const peerKeyId = fleetSubscriptionServerFor(hop.provider);
  if (peerKeyId === null) return null;
  const clientWantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  try {
    const res = await tunnelToPeer({
      keyId: peerKeyId,
      surface:
        args.surface === "messages"
          ? "messages"
          : args.surface === "responses"
            ? "responses"
            : "chat_completions",
      body: new Uint8Array(args.rawBytes),
      accept: clientWantsStream ? "text/event-stream" : "application/json",
      ...(args.tunnelToPeer !== undefined
        ? { transport: args.tunnelToPeer }
        : {}),
      anthropicVersion:
        args.surface === "messages"
          ? args.req.headers.get("anthropic-version")
          : null,
      anthropicBeta:
        args.surface === "messages"
          ? args.req.headers.get("anthropic-beta")
          : null,
      userAgent: args.req.headers.get("user-agent"),
      signal: args.req.signal,
    });
    // Any peer response head (success or terminal failure) ends this
    // consumer walk: the peer already ran its full plan. Pre-head
    // failures throw below and fall through to the next local hop.
    return res;
  } catch {
    if (args.req.signal.aborted)
      return errorJson(499, "client aborted request");
    return null;
  }
};

export const runWalker = async (args: TWalkArgs): Promise<Response> => {
  const strategy = resolveContextOverflowStrategy(
    args.contextOverflowStrategy ??
      (args.sigParam === null ? bootstrapContextOverflowStrategy() : null),
  );
  const planModelIds = parsePlan(args.planParam);
  if (planModelIds.length === 0) {
    return errorJson(
      400,
      "the daemon could not resolve a plan for this request — send an explicit `model` so it can fetch a signed plan from the gateway",
    );
  }

  // Reject a forged plan: when the cloud configured a signing secret (so it
  // handed us a per-user key at bootstrap), the plan MUST carry a valid sig
  // over the full canonical payload (plan + pmids + origin). No key → unsigned
  // mode (dev), accept. (§9 + daemon-presence-without-heartbeat)
  if (
    !planSignatureOk(
      args.planParam,
      args.pmidsParam,
      args.originParam,
      args.contextOverflowStrategy ?? null,
      args.sigParam,
    )
  ) {
    return errorJson(403, "invalid or missing plan signature");
  }

  // The concrete upstream ids ride parallel to the plan — split WITHOUT
  // trimming empties so positions stay aligned (an empty entry = uncatalogued
  // hop, falls back inside resolveHop).
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  const hops = planModelIds.map((m, i) => resolveHop(m, pmids[i]));
  if (!canWalkPlan(hops)) {
    return errorJson(
      400,
      "the plan contains a subscription provider the daemon has no upstream for",
    );
  }

  // First: walk the plan as-is. LAST-RESORT compaction (below) only runs if that
  // whole walk fails on SIZE — every hop oversized — so a healthy request never
  // pays for a rewrite (same last-resort-only rule as the cloud chain; see
  // wire/features/context-skip.ts).
  const firstPass = await walkPlan(args, hops, strategy);
  if (!(await isContextOverflowResponse(firstPass))) {
    return withoutContextOverflowHopTag(firstPass);
  }

  const compactHop = shouldDemoteOnContextOverflow(strategy)
    ? largestContextHop(hops)
    : (() => {
        const modelId = firstPass.headers.get(CONTEXT_OVERFLOW_HOP_HEADER);
        if (modelId === null) return null;
        const hop = hops.find((candidate) => candidate.modelId === modelId);
        const window =
          hop === undefined
            ? null
            : (lookupCatalogEntry(hop.modelId)?.input_token_limit ?? null);
        return hop === undefined || window === null ? null : { hop, window };
      })();

  const largest = compactHop;
  // Measure with the ruler family that matches the wire (Claude for `messages`,
  // o200k otherwise) — the same choice the compactor's fit check uses.
  const encoding = encodingForSurface(args.surface);
  // A CONFIRMED vendor overflow forces a real shrink. We do NOT bail merely
  // because the local ruler thinks the body already "fits" a static target
  // (RC1) — the vendor's own tokenizer already rejected it, so a false local fit
  // must not veto compaction. Bail only when there is no sized hop to aim the
  // cut at, or the client went away.
  if (largest === null || args.req.signal.aborted) {
    return withoutContextOverflowHopTag(firstPass);
  }
  // Warm the BPE ruler before the compactor's internal fit checks — this is the
  // one place an exact count decides HOW MUCH to cut. The ~160 ms one-time load
  // per isolate is trivial next to the re-walk it gates (the alternative here is
  // a hard 502), and every later oversized request on this warm daemon process
  // reuses the counter for free; the healthy path never warms it and stays on
  // the cheap `chars/4` fallback.
  await getTokenCounter(encoding);
  // The daemon forwards the RAW inbound body per surface, so the compactor must
  // match: `responses` (Codex) is `{ input: item[] }`, `messages` (Claude) is
  // Anthropic-shaped, `chat_completions` is canonical OpenAI.
  const surface: TCompactionSurface = args.surface;
  // BOUNDED vendor-grounded retry. Each round sizes the cut from the FRESH
  // vendor numbers in the latest overflow envelope (the ruler→vendor ratio
  // self-calibrates and converges), compacts, and re-walks. Hard-capped so a
  // persistently-rejecting upstream can never spin an infinite compaction loop.
  let currentBody = args.rawBody;
  let overflowResponse = firstPass;
  for (let round = 0; round < MAX_LAST_RESORT_COMPACTION_ROUNDS; round++) {
    if (args.req.signal.aborted) {
      return withoutContextOverflowHopTag(overflowResponse);
    }
    // Size the cut from the vendor's own count for the body we just sent — the
    // observed ratio is exact calibration for THIS conversation. Clamped no
    // looser than the static target; falls back to it when the vendor gave no
    // count.
    const localEstimate = estimateBodyTokensExact(currentBody, encoding);
    const target = compactionTargetFromOverflow({
      requiredTokens: await overflowRequiredTokensOf(overflowResponse),
      window: largest.window,
      localEstimate,
      provider: largest.hop.provider,
    });
    // A confirmed overflow always forces a real shrink (see
    // forcedCompactionTarget) so a false local fit never re-sends the same
    // body.
    const forcedTarget = forcedCompactionTarget(target, localEstimate);
    const compacted = compactRequestToFit(
      currentBody,
      surface,
      forcedTarget,
      encoding,
    );
    // Nothing left to reduce (or the cut didn't actually shrink the body) —
    // surface the last overflow rather than re-sending an identical body.
    if (!compacted.compacted || compacted.estimatedTokens >= localEstimate) {
      return withoutContextOverflowHopTag(overflowResponse);
    }
    const compactedArgs: TWalkArgs = {
      ...args,
      rawBody: compacted.body,
      rawBytes: new TextEncoder().encode(JSON.stringify(compacted.body))
        .buffer as ArrayBuffer,
    };
    const retry = await walkPlan(
      compactedArgs,
      shouldDemoteOnContextOverflow(strategy) ? hops : [largest.hop],
      strategy,
    );
    if (!(await isContextOverflowResponse(retry))) {
      return withoutContextOverflowHopTag(retry);
    }
    // Still overflowing — recompute the target from the retry's FRESH vendor
    // numbers and compact tighter on the next bounded round.
    overflowResponse = retry;
    currentBody = compacted.body;
  }
  return withoutContextOverflowHopTag(overflowResponse);
};

/**
 * The upstream tokenizer's authoritative request size carried in a walk's
 * overflow Response body, or null when the envelope carried no parseable count
 * (then the caller falls back to the static target). Clones so the Response body
 * is left intact for the caller.
 */
const overflowRequiredTokensOf = async (
  response: Response,
): Promise<number | null> => {
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  return contextOverflowRequiredTokens(text);
};

/**
 * True when a walk's terminal Response is a context-overflow failure — either
 * the synthesized 502 fall-through or an upstream 4xx whose body carries the
 * "maximum context length" diagnostic. This is the signal that last-resort
 * compaction should retry; any other outcome (success, a non-size error) returns
 * to the caller untouched.
 */
const isContextOverflowResponse = async (
  response: Response,
): Promise<boolean> => {
  if (response.ok) return false;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  // Do NOT treat the generic "all hops in the plan failed" 502 as overflow —
  // that fall-through covers auth / rate-limit / 5xx exhaustion too, and
  // compacting then re-walking a doomed plan only wastes another hop round.
  // Require a real size-rejection signal from the hop trail / upstream body.
  // An upstream overflow envelope — either the exact "contains N tokens" form
  // (which also yields the required-token count) or the broader vendor phrasing
  // the shared error classifier recognises (`maximum context length`, `exceeds
  // the context window`, …). Reuse wire's CONTEXT_OVERFLOW_BODY so the retry
  // triggers on exactly the envelopes the walk classifies as `context_overflow`.
  if (contextOverflowRequiredTokens(text) !== null) return true;
  return CONTEXT_OVERFLOW_BODY.test(text);
};

/**
 * Walk a resolved plan once and return its terminal Response. Extracted from
 * `runWalker` so the last-resort compaction path can re-invoke the identical
 * walk with a shrunk body. All plan/signature validation stays in `runWalker`
 * (it must not re-run on the compacted retry).
 */
// Monotonic, per-process walk counter → a hermetic walk-local session key (no
// crypto / Date-based entropy, so tests are deterministic). Identifies which
// walk set a hop cooldown, so a recovery pass can distinguish "a sibling cooled
// this" (bypassable) from "I cooled this" (already tried — never re-dial).
let walkCounter = 0;

// Sentinel returned by `serveSubscriptionHop` meaning "this hop produced no
// terminal response — keep walking" (the extracted stand-in for a `continue`).
const HOP_CONTINUE: unique symbol = Symbol("hop-continue");
type THopContinue = typeof HOP_CONTINUE;

// Internal only: lets `runWalker` retain the actual overflowing hop while
// `walkPlan` continues to return a Response for its normal path. It is removed
// before any terminal response reaches the localhost client.
const CONTEXT_OVERFLOW_HOP_HEADER = "x-openllm-internal-context-overflow-hop";

const tagContextOverflowHop = (response: Response, hop: THop): Response => {
  const headers = passthroughHeaders(response);
  headers.set(CONTEXT_OVERFLOW_HOP_HEADER, hop.modelId);
  return new Response(response.body, { status: response.status, headers });
};

const withoutContextOverflowHopTag = (response: Response): Response => {
  if (!response.headers.has(CONTEXT_OVERFLOW_HOP_HEADER)) return response;
  const headers = passthroughHeaders(response);
  headers.delete(CONTEXT_OVERFLOW_HOP_HEADER);
  return new Response(response.body, { status: response.status, headers });
};

// A committed terminal Response from a subscription hop, tagged with its ORIGIN.
// `servedLocally` is true when THIS box's native-runtime or handrolled transport
// produced the Response (so a 2xx proves THIS box's account recovered); false
// when a fleet peer served it over the tunnel (a DIFFERENT account — no proof
// about this box, so it must not clear this box's cooldown sign).
type THopServed = {
  readonly response: Response;
  readonly servedLocally: boolean;
};

const walkPlan = async (
  args: TWalkArgs,
  hops: ReadonlyArray<THop>,
  contextOverflowStrategy: TContextOverflowStrategy,
): Promise<Response> => {
  walkCounter += 1;
  const walkSessionKey = `walk-${walkCounter}`;
  const hopRetryDelayMs = args.hopRetryDelayMs ?? DEFAULT_HOP_RETRY_DELAY_MS;
  const hopRetryAfterCapMs =
    args.hopRetryAfterCapMs ?? DEFAULT_HOP_RETRY_AFTER_CAP_MS;
  const accountHashByProvider = new Map<string, string | null>();
  // Shared per-request cache of `delegate.status()` — the local auth gate and
  // the quota-account lookup both read through it so a hop pays status once.
  const connectedByProvider = new Map<string, TLocalSubscriptionAuth>();
  // Canonical view of the inbound for native-runtime eligibility and encoding.
  const canonical = canonicalFromInbound(args.surface, args.rawBody);
  const baseEstimate = estimateBodyTokens(args.rawBody);

  // The cloud's execution preference — a global value plus per-provider
  // overrides — sampled ONCE per request from the cached bootstrap
  // snapshot so it can never switch mid-hop (a bootstrap refresh landing
  // mid-walk applies to the NEXT request). Resolved per hop against the
  // provider's registry defaults in `resolveHopExecution` (+ caller policy:
  // first-party Claude → handrolled-only; other Claude callers and
  // Cursor/Muse/Antigravity → vendor runtime only).
  const claudeCodeOriginator = isClaudeCodeOriginator(args.req.headers);
  const requestedExecutionSelection = activeExecutionSelection();
  const executionSelectionOverrides = activeExecutionSelectionOverrides();

  let lastError: string | null = null;
  let firstTerminalResponse: Response | null = null;
  const hopTrail: THopTrailEntry[] = [];
  const attempted: string[] = [];
  let contextDemotionTarget: string | null = null;
  const sampleQuotaUsage = (
    provider: string,
    accountHash: string | null | undefined,
  ): void => {
    const delegate = getDelegate(provider);
    if (delegate === null) return;
    sampleUsageAfterRequest(
      provider,
      () => delegate.usage(),
      accountHash ?? undefined,
    );
  };
  const sampleQuotaUsageImmediate = (
    provider: string,
    accountHash: string | null | undefined,
  ): void => {
    const delegate = getDelegate(provider);
    if (delegate === null) return;
    // The vendor just told us this account is exhausted. Sample NOW (no
    // debounce / min-interval floor) so the quota gate has a rejected snapshot
    // to route on — an exhausted account emits no successful request, so
    // nothing else would re-sample it. Single-flight in `cachedUsage` collapses
    // a concurrent herd to one vendor read.
    sampleUsageOnExhaustion(
      provider,
      () => delegate.usage(),
      accountHash ?? undefined,
    );
  };
  const reportHopFailure = (
    hop: THop,
    reason: string,
    status?: number,
    cooldownReason?: TCooldownReason,
  ): void => {
    report(
      {
        model: hop.modelId,
        provider: hop.provider,
        status: status === undefined ? "error" : statusFor(status),
        ...ZERO_TOKENS,
        latency_ms: Date.now() - args.startedAt,
        endpoint: args.endpoint,
        error: reason,
        ...(cooldownReason !== undefined
          ? { cooldown_reason: cooldownReason }
          : {}),
      },
      args.originParam,
    );
    // A hop that failed is about to cool on the cloud (daemon-record →
    // publishCooldownMark). Drop the signed-plan cache so the next request
    // re-resolves a plan that skips the cooled model instead of replaying
    // the same rate-limited leader for the rest of the 45s TTL.
    clearPlanCache();
  };
  const addHopFailure = (
    hop: THop,
    reason: string,
    status?: number,
    cooldownReason?: TCooldownReason,
    recoverAtMs?: number,
  ): void => {
    hopTrail.push({
      modelId: hop.modelId,
      provider: hop.provider,
      reason,
      ...(status !== undefined ? { status } : {}),
    });
    // Cool the hop on THIS box too — the cloud mark is best-effort and
    // cross-process, so without a local table an exhausted account is
    // re-dialled on every subsequent request (see hop-cooldown.ts). Stamp the
    // walk's session key + the vendor recover floor as provenance so a recovery
    // pass can tell whose mark this is and whether it's provably doomed.
    if (
      cooldownReason !== undefined &&
      cooldownPolicyFor(cooldownReason).action === "cool_and_advance"
    ) {
      const changed = markHopCooldown(
        hop.provider,
        hop.modelId,
        cooldownReason,
        walkSessionKey,
        recoverAtMs,
      );
      // A NEW/changed `auth` mark on a subscription hop: push status now so
      // the dashboard overlay does not wait for the 15s watcher. Repeated
      // identical marks (in-place retry) do not re-arm. Never refresh.
      if (
        changed &&
        cooldownReason === "auth" &&
        isSubscriptionSlug(hop.provider)
      ) {
        getDelegate(hop.provider)?.invalidateStatusObservation?.();
        args.onAuthCooldownStatusPush?.();
        requestStatusPush();
      }
    }
    // The vendor just TOLD us this account is out of quota. Sample its usage
    // IMMEDIATELY (no debounce) so the quota gate gets a rejected snapshot to
    // route on for the rest of the window — an exhausted account produces no
    // successful request, so nothing else would ever re-sample it.
    if (cooldownReason === "quota_exhausted") {
      sampleQuotaUsageImmediate(
        hop.provider,
        accountHashByProvider.get(hop.provider),
      );
    }
    reportHopFailure(hop, reason, status, cooldownReason);
  };
  // `winner` is the hop that produced a SUCCESS response: it is reported as
  // `x-openllm-resolved-model: <provider>/<model>` + the fallback count, the
  // same observability headers the cloud sets. A forwarded cloud hop already
  // carries the cloud's own (more precise) value, which is kept.
  const withHopTrailHeaders = (resp: Response, winner?: THop): Response => {
    const won = winner !== undefined && resp.status < 400;
    if (attempted.length === 0 && hopTrail.length === 0 && !won) return resp;
    const headers = passthroughHeaders(resp);
    if (attempted.length > 0) {
      headers.set("x-openllm-chain", attempted.join(","));
    }
    if (hopTrail.length > 0) {
      headers.set("x-openllm-hop-failures", formatHopFailuresHeader(hopTrail));
    }
    if (won) {
      if (!headers.has("x-openllm-resolved-model")) {
        headers.set(
          "x-openllm-resolved-model",
          `${winner.provider}/${winner.providerModelId}`,
        );
      }
      if (attempted.length > 1) {
        headers.set(
          "x-openllm-attempted-fallbacks",
          String(attempted.length - 1),
        );
      }
    }
    return new Response(resp.body, { status: resp.status, headers });
  };
  // Commit a subscription hop's terminal Response. A SUCCESS (HTTP < 400) proves
  // the hop is healthy right now, so drop any stale cooldown sign IMMEDIATELY:
  // sibling walks and the next request then skip the whole exhaust-then-recover
  // detour instead of re-earning quota for the full TTL. A committed ERROR
  // Response (4xx/5xx) is not proof of health and never clears; nor does
  // HOP_CONTINUE (no committed response). The final-hop success path flows
  // through here too, so a final hop dialled while cooled also clears.
  //
  // The clear fires ONLY on a LOCALLY-served 2xx. A fleet-tunnel 2xx is served
  // by a REMOTE peer using a DIFFERENT subscription account, so it proves
  // nothing about THIS box's account — clearing on it could erase a live
  // `quota_exhausted` backstop and let concurrent siblings re-storm the still-
  // exhausted local account during the usage-sample lag. The clear stays GLOBAL
  // (it benefits all local consumers); only the trigger narrows to local serves.
  const commitSubscriptionServe = (hop: THop, served: THopServed): Response => {
    if (served.servedLocally && served.response.status < 400) {
      clearHopCooldown(hop.provider, hop.modelId);
    }
    return withHopTrailHeaders(served.response, hop);
  };
  // Context skips preserve priority without permanently excluding a model:
  // once ordinary candidates are exhausted, retry the skipped candidates once
  // in original order with the heuristic bypassed. The final forced candidate
  // returns its authentic provider result, so failed retries cannot loop.
  const queue: Array<{
    readonly hop: THop;
    readonly forceContextAttempt: boolean;
  }> = hops.map((hop) => ({ hop, forceContextAttempt: false }));
  const contextSkipped: THop[] = [];
  // Subscription hops the pass-1 cooldown gate skipped — candidates for the
  // post-loop recovery pass (a transient cooldown may be advisory).
  const cooldownSkipped: THop[] = [];
  // Hop identities (`provider|modelId`) THIS walk actually DIALLED in pass 1.
  // The authoritative at-most-once guard for the recovery pass: a concurrent
  // sibling can overwrite a cooldown entry's `setterSessionKey` (last-writer-
  // wins), so when the same model appears at two chain positions the setter
  // check alone can let recovery re-dial a hop pass 1 already tried. This set
  // is walk-local and immune to sibling writes.
  const dialedHops = new Set<string>();
  let requeuedSkipped = false;
  const preserveTerminalResponse = (
    response: Response | undefined,
    forceContextAttempt: boolean,
  ): void => {
    if (
      firstTerminalResponse === null &&
      response !== undefined &&
      !forceContextAttempt &&
      !requeuedSkipped &&
      contextSkipped.length > 0
    ) {
      firstTerminalResponse = response;
    }
  };
  // The per-subscription-hop serve body, extracted verbatim so the post-loop
  // recovery pass can re-dial a cooling hop directly, after the caller loop's
  // cooldown gate has already decided eligibility. Cooldown gating is owned by
  // the caller loop (pass 1's gate + the recovery pass's advisory bypass), NOT
  // this helper. Returns a committed raw Response (the caller wraps it with
  // `withHopTrailHeaders`) or {@link HOP_CONTINUE} meaning "keep walking" (the
  // extracted stand-in for a `continue`).
  const serveSubscriptionHop = async (
    hop: THop,
    finalHop: boolean,
    opts: {
      readonly forceContextAttempt: boolean;
      readonly retryAttempt: number;
    },
  ): Promise<THopServed | THopContinue> => {
    const { forceContextAttempt, retryAttempt } = opts;
    // ── Local auth gate (every subscription provider) ─────────────────
    // Install ≠ signed-in. status().status === "connected" is the same signal the cloud
    // uses for fleet_subscriptions. Without a local login, skip every local
    // transport (bridge spawn / handrolled credential) and go straight to
    // fleet — a doomed ACP handshake ("Invalid params") or credential throw
    // is not a hop resolution strategy.
    const localAuth = await ensureLocalSubscription(
      hop.provider,
      connectedByProvider,
      accountHashByProvider,
    );
    if (!localAuth.connected) {
      lastError =
        localAuth.detail ?? `${hop.provider} not signed in on this device`;
      const tunneled = await tryFleetTunnel(hop, args);
      if (tunneled !== null) {
        return { response: tunneled, servedLocally: false };
      }
      addHopFailure(hop, lastError);
      return HOP_CONTINUE;
    }

    const decision = quotaGateDecision({
      snapshot: await usageForActiveAccount(
        hop.provider,
        accountHashByProvider,
        connectedByProvider,
      ),
      meter: lookupCatalogEntry(hop.modelId)?.subscription_meter,
      finalHop,
      staleCapMs: GATE_STALE_CAP_MS,
      now: Date.now(),
    });
    if (decision.kind === "skip") {
      lastError = decision.reason;
      hopTrail.push({
        modelId: hop.modelId,
        provider: hop.provider,
        reason: decision.reason,
      });
      clearPlanCache();
      return HOP_CONTINUE;
    }

    // Resolve the outer transport and concrete variant together: a global
    // handrolled preference must not leak into a bridge-only provider's native
    // dispatch after its outer selector has fallen back to the provider default.
    const { methods, executionSelection } = resolveHopExecution({
      provider: hop.provider,
      executionPreference: requestedExecutionSelection,
      executionOverrides: executionSelectionOverrides,
      originator: { isClaudeCode: claudeCodeOriginator },
    });
    const wire = UPSTREAM_WIRE[hop.provider];
    const hasHandrolledFallback =
      methods.includes("handrolled") && wire !== undefined;
    let nativeDecline: string | null = null;
    let nativeCooldownReason: TCooldownReason | undefined;
    let handrolledRetry: THopRetry | null = null;

    if (methods.includes("native") && isNativeRuntimeProvider(hop.provider)) {
      // Official vendor runtime for the hop's concrete selection (variant +
      // capture). Pre-commit declines fall through to handrolled when
      // `methods` still allows it; otherwise fleet.
      const serveNative = args.tryServeNativeRuntime ?? tryServeNativeRuntime;
      const native = await serveNative({
        provider: hop.provider,
        providerModelId: hop.providerModelId,
        surface: args.surface,
        rawBody: args.rawBody,
        canonical: applyModelSettings(canonical, hop.modelSettings),
        wantsStream:
          (args.rawBody as { stream?: unknown } | null)?.stream === true,
        // TODO(docs/audit/2026-08-30-claude-code-bridge-failures.md §4 B1):
        // route a valid token to its owner daemon before this per-request fleet
        // fallback. Until a durable owner registry exists, validation below gives
        // a precise wrong-owner/epoch decline rather than a misleading map miss.
        continuationToken: args.req.headers.get(TOOL_SESSION_HEADER),
        executionSelection,
        stripSubagentIsolation: hop.stripSubagentIsolation,
        signal: args.req.signal,
        record: (tokens, status) =>
          report(
            {
              model: hop.modelId,
              provider: hop.provider,
              status,
              latency_ms: Date.now() - args.startedAt,
              endpoint: args.endpoint,
              ...tokens,
            },
            args.originParam,
            accountHashByProvider.get(hop.provider) ?? undefined,
          ),
      });
      if (native instanceof Response) {
        if (!native.ok) {
          const raw = await native
            .clone()
            .text()
            .catch(() => "");
          const cls = classifyRawResponse(
            native.status,
            raw,
            "openai",
            args.req.signal.aborted,
          );
          if (cls.kind === "transient" && cls.reason === "context_overflow") {
            if (!shouldDemoteOnContextOverflow(contextOverflowStrategy)) {
              return {
                response: tagContextOverflowHop(native, hop),
                servedLocally: true,
              };
            }
            const requiredTokens =
              contextOverflowRequiredTokens(raw) ?? baseEstimate;
            const nextModel = nextLargerContextModel(
              hops.map((candidate) => candidate.modelId),
              hop.modelId,
              requiredTokens,
              (modelId) =>
                lookupCatalogEntry(modelId)?.input_token_limit ?? null,
            );
            if (nextModel !== null && !args.req.signal.aborted) {
              contextDemotionTarget = nextModel;
              return HOP_CONTINUE;
            }
          }
          if (args.req.signal.aborted) {
            return {
              response: errorJson(499, "client aborted request"),
              servedLocally: true,
            };
          }
          if (cls.kind === "abort") {
            return {
              response: errorJson(499, "client aborted request"),
              servedLocally: true,
            };
          }
          const policy = cooldownPolicyFor(cls.reason);
          const shouldRetryInPlace =
            policy.action === "retry_in_place" ||
            (finalHop && cls.reason === "rate_limit");
          if (shouldRetryInPlace && retryAttempt === 0) {
            await abortableDelay(
              retryAfterDelayMs(native, hopRetryDelayMs, hopRetryAfterCapMs),
              args.req.signal,
            );
            if (args.req.signal.aborted) {
              return {
                response: errorJson(499, "client aborted request"),
                servedLocally: true,
              };
            }
            return serveSubscriptionHop(hop, finalHop, {
              forceContextAttempt,
              retryAttempt: 1,
            });
          }
          const reason = `native hop ${hop.modelId} returned ${native.status}`;
          addHopFailure(hop, reason, native.status, cls.reason);
          if (policy.action === "surface") {
            return { response: native, servedLocally: true };
          }
          if (!finalHop) return HOP_CONTINUE;
        }
        if (
          native.status === 408 ||
          native.status === 429 ||
          native.status >= 500
        ) {
          clearPlanCache();
        }
        return { response: native, servedLocally: true };
      }
      nativeDecline = `native hop ${hop.modelId} declined: ${native.declined}`;
      nativeCooldownReason = native.cooldownReason;
      // Capture already owned (or may have owned) the upstream send — never
      // handroll, fleet, or advance to another provider for the same turn.
      const captureOwnership = native.captureOwnership;
      if (captureOwnership === "accepted" || captureOwnership === "uncertain") {
        if (args.req.signal.aborted) {
          return {
            response: errorJson(499, "client aborted request"),
            servedLocally: true,
          };
        }
        addHopFailure(hop, nativeDecline, undefined, nativeCooldownReason);
        lastError = nativeDecline;
        return {
          response: errorJson(
            502,
            captureOwnership === "uncertain"
              ? `${nativeDecline} (capture send may have reached upstream; not retried)`
              : nativeDecline,
          ),
          servedLocally: true,
        };
      }
      if (hasHandrolledFallback) {
        nativeDecline += " — served by the manual transport";
      }
      lastError = nativeDecline;
    }

    if (hasHandrolledFallback && wire !== undefined) {
      // Manual subscription transport — sole path for kimi/grok; fallback
      // for bridge declines on claude_code + chatgpt when policy allows.
      const served = await serveSubscription(
        hop,
        wire,
        args,
        finalHop,
        sampleQuotaUsage,
        walkSessionKey,
      );
      if (!isHopRetry(served)) {
        if (
          forceContextAttempt &&
          !served.ok &&
          firstTerminalResponse !== null
        ) {
          return { response: firstTerminalResponse, servedLocally: true };
        }
        // Final-hop handrolled overflow returns a Response, not hopRetry, so
        // tag it here or compact-in-place cannot find the overflowing hop.
        return {
          response:
            !served.ok &&
            !shouldDemoteOnContextOverflow(contextOverflowStrategy)
              ? tagContextOverflowHop(served, hop)
              : served,
          servedLocally: true,
        };
      }
      handrolledRetry = served;
      lastError = `subscription hop ${hop.modelId} failed pre-stream: ${served.reason}`;
      preserveTerminalResponse(served.upstreamResponse, forceContextAttempt);
    }

    // Once local authentication is confirmed, this daemon owns the outcome.
    // A bridge decline or handrolled failure follows the local retry/cooldown/
    // plan policy below; another account on a fleet peer must not mask it.
    // Generic fleet fallback is reserved for the auth-unavailable gate above.
    if (handrolledRetry !== null) {
      if (handrolledRetry.cooldownReason === "context_overflow") {
        if (!shouldDemoteOnContextOverflow(contextOverflowStrategy)) {
          if (handrolledRetry.upstreamResponse !== undefined) {
            return {
              response: tagContextOverflowHop(
                handrolledRetry.upstreamResponse,
                hop,
              ),
              servedLocally: true,
            };
          }
          addHopFailure(
            hop,
            handrolledRetry.reason,
            handrolledRetry.status,
            handrolledRetry.cooldownReason,
            handrolledRetry.recoverAtMs,
          );
          return HOP_CONTINUE;
        }
        const requiredTokens =
          contextOverflowRequiredTokens(
            handrolledRetry.bodySnippet ?? handrolledRetry.reason,
          ) ?? baseEstimate;
        const nextModel = nextLargerContextModel(
          hops.map((candidate) => candidate.modelId),
          hop.modelId,
          requiredTokens,
          (modelId) => lookupCatalogEntry(modelId)?.input_token_limit ?? null,
        );
        if (nextModel !== null && !args.req.signal.aborted) {
          hopTrail.push({
            modelId: hop.modelId,
            provider: hop.provider,
            reason: handrolledRetry.reason,
            ...(handrolledRetry.status !== undefined
              ? { status: handrolledRetry.status }
              : {}),
          });
          contextDemotionTarget = nextModel;
          return HOP_CONTINUE;
        }
        if (handrolledRetry.upstreamResponse !== undefined) {
          return {
            response: handrolledRetry.upstreamResponse,
            servedLocally: true,
          };
        }
      }
      if (args.req.signal.aborted) {
        return {
          response: errorJson(499, "client aborted request"),
          servedLocally: true,
        };
      }
      const cooldownReason = handrolledRetry.cooldownReason;
      const policy =
        cooldownReason === undefined
          ? undefined
          : cooldownPolicyFor(cooldownReason);
      // `rate_limit` remains cooling, but a final vendor hop keeps its historical
      // bounded Retry-After retry before its authentic response is surfaced.
      const shouldRetryInPlace =
        policy?.action === "retry_in_place" ||
        (finalHop && cooldownReason === "rate_limit");
      if (shouldRetryInPlace && retryAttempt === 0) {
        const response = handrolledRetry.upstreamResponse;
        await abortableDelay(
          response === undefined
            ? hopRetryDelayMs
            : retryAfterDelayMs(response, hopRetryDelayMs, hopRetryAfterCapMs),
          args.req.signal,
        );
        if (args.req.signal.aborted) {
          return {
            response: errorJson(499, "client aborted request"),
            servedLocally: true,
          };
        }
        return serveSubscriptionHop(hop, finalHop, {
          forceContextAttempt,
          retryAttempt: 1,
        });
      }
      addHopFailure(
        hop,
        handrolledRetry.reason,
        handrolledRetry.status,
        cooldownReason,
        handrolledRetry.recoverAtMs,
      );
      if (
        (finalHop || policy?.action === "surface") &&
        handrolledRetry.upstreamResponse !== undefined
      ) {
        return {
          response: handrolledRetry.upstreamResponse,
          servedLocally: true,
        };
      }
      if (policy?.action === "surface") {
        return {
          response: errorJson(
            handrolledRetry.status ?? 502,
            handrolledRetry.reason,
            cooldownReason,
          ),
          servedLocally: true,
        };
      }
      return HOP_CONTINUE;
    }

    if (args.req.signal.aborted) {
      return {
        response: errorJson(499, "client aborted request"),
        servedLocally: true,
      };
    }
    lastError =
      nativeDecline ??
      (methods.length === 0
        ? `${hop.provider} hop ${hop.modelId} has no local transport on this box`
        : (lastError ??
          `${hop.provider} hop ${hop.modelId} could not be served locally`));
    addHopFailure(hop, lastError, undefined, nativeCooldownReason);
    return HOP_CONTINUE;
  };
  const forwardCloudHop = async (
    hop: THop,
    finalHop: boolean,
  ): Promise<Response | null> => {
    for (let retryAttempt = 0; retryAttempt <= 1; retryAttempt++) {
      let response: Response;
      try {
        response = await forwardToCloud(
          args.req,
          args.rawBytes,
          hop.modelId,
          args.originParam,
        );
      } catch {
        if (args.req.signal.aborted || retryAttempt === 1) return null;
        await abortableDelay(hopRetryDelayMs, args.req.signal);
        continue;
      }
      if (response.ok || args.req.signal.aborted) return response;
      const raw = await response
        .clone()
        .text()
        .catch(() => "");
      const cls = classifyRawResponse(response.status, raw, "openai", false);
      if (cls.kind === "abort") return response;
      const action = cooldownPolicyFor(cls.reason).action;
      const shouldRetryInPlace =
        action === "retry_in_place" ||
        (finalHop && cls.reason === "rate_limit");
      if (!shouldRetryInPlace || retryAttempt === 1) return response;
      await abortableDelay(
        retryAfterDelayMs(response, hopRetryDelayMs, hopRetryAfterCapMs),
        args.req.signal,
      );
      if (args.req.signal.aborted) {
        return errorJson(499, "client aborted request");
      }
    }
    return null;
  };
  let queueIndex = 0;
  while (true) {
    if (queueIndex >= queue.length) {
      if (
        !requeuedSkipped &&
        contextSkipped.length > 0 &&
        !args.req.signal.aborted
      ) {
        requeuedSkipped = true;
        queue.push(
          ...contextSkipped.map((hop) => ({
            hop,
            forceContextAttempt: true,
          })),
        );
        continue;
      }
      break;
    }
    const candidate = queue[queueIndex];
    if (candidate === undefined) break;
    queueIndex += 1;
    const { hop, forceContextAttempt } = candidate;
    attempted.push(hop.modelId);
    // A skipped ordinary candidate means the physical queue still has a
    // forced-context epilogue. Its successor must remain walkable until that
    // retry receives the tokenizer's final verdict.
    const finalHop =
      queueIndex === queue.length &&
      (requeuedSkipped || contextSkipped.length === 0);
    if (
      contextDemotionTarget !== null &&
      hop.modelId !== contextDemotionTarget
    ) {
      const reason = `hop ${hop.modelId} skipped: context overflow requires a larger input window`;
      lastError = reason;
      hopTrail.push({
        modelId: hop.modelId,
        provider: hop.provider,
        reason,
      });
      continue;
    }
    contextDemotionTarget = null;
    // ── Local cooldown gate, per hop ──────────────────────────────────
    // A hop that just failed with a cooling reason (quota exhausted, rate
    // limited, auth) is not dialled again from this box until its policy TTL
    // expires. Never applied to the FINAL hop (never-drop-all: the caller gets
    // the real upstream error, not a synthetic one).
    if (!finalHop && isHopCoolingDown(hop.provider, hop.modelId)) {
      lastError = `hop ${hop.modelId} skipped: cooling down after a recent failure`;
      hopTrail.push({
        modelId: hop.modelId,
        provider: hop.provider,
        reason: lastError,
      });
      // Record subscription hops skipped by the cooldown gate for the post-loop
      // recovery pass (API-key hops cool via the cloud — excluded). A transient
      // sibling-set cooldown may be bypassable once the authoritative usage
      // floor confirms the shared account still has quota.
      if (isSubscriptionSlug(hop.provider)) cooldownSkipped.push(hop);
      continue;
    }
    // ── Context gate, per hop (shared with the cloud chain —
    // `shouldSkipHopForContext`) ──────────────────────────────────────
    // Plan A already happened (the catalog served correct budgets +
    // `/responses/compact` passes through, so the client compacts
    // itself). Skip a non-final hop when the conservative routing estimate
    // exceeds its known input budget; the final hop still lets the real
    // upstream tokenizer decide, the forced-context epilogue above retries
    // skipped hops once everything else exhausts, and the pre-output peek
    // walk below is the backstop for estimate misses.
    if (
      shouldSkipHopForSize(contextOverflowStrategy) &&
      !forceContextAttempt &&
      shouldSkipHopForContext({
        estimatedTokens: baseEstimate,
        inputTokenLimit:
          lookupCatalogEntry(hop.modelId)?.input_token_limit ?? null,
        finalHop,
      })
    ) {
      lastError = `hop ${hop.modelId} skipped: ~${baseEstimate}-token request clearly exceeds its input window`;
      contextSkipped.push(hop);
      hopTrail.push({
        modelId: hop.modelId,
        provider: hop.provider,
        reason: lastError,
      });
      continue;
    }
    if (isLocalServerSlug(hop.provider)) {
      dialedHops.add(`${hop.provider}|${hop.modelId}`);
      const localResp = await serveLocalHop(
        hop,
        {
          surface: args.surface,
          rawBody: args.rawBody,
          req: args.req,
          startedAt: args.startedAt,
          endpoint: args.endpoint,
          originParam: args.originParam,
        },
        finalHop,
      );
      if (localResp === null) {
        lastError = `local hop ${hop.modelId} unavailable on this device`;
        addHopFailure(hop, lastError);
        continue;
      }
      return withHopTrailHeaders(localResp, hop);
    }
    if (isSubscriptionSlug(hop.provider)) {
      // Record the DIALLED identity before serving so the recovery pass can
      // never re-dial it, independent of the (sibling-overwritable) setter key.
      dialedHops.add(`${hop.provider}|${hop.modelId}`);
      const served = await serveSubscriptionHop(hop, finalHop, {
        forceContextAttempt,
        retryAttempt: 0,
      });
      if (served === HOP_CONTINUE) continue;
      return commitSubscriptionServe(hop, served);
    }
    // API-key hop: forward to the cloud pinned to this concrete model.
    const forwarded = await forwardCloudHop(hop, finalHop);
    if (forwarded === null) {
      lastError = `forward of ${hop.modelId} to cloud failed`;
      // Client hung up while the cloud fetch was in flight. Terminal but NOT
      // an upstream fault: `addHopFailure` would report status "error" and the
      // cloud record handler would cool the model as `upstream_rejection`.
      if (args.req.signal.aborted) {
        return withHopTrailHeaders(errorJson(499, "client aborted request"));
      }
      addHopFailure(hop, lastError);
      continue;
    }
    const resp = forwarded;
    if (!resp.ok) {
      const raw = await resp
        .clone()
        .text()
        .catch(() => "");
      // Forwarded cloud responses are normalized to the shared envelope;
      // provider format only affects reason tagging, never walk eligibility.
      const cls = classifyRawResponse(
        resp.status,
        raw,
        "openai",
        args.req.signal.aborted,
      );
      if (
        cls.kind === "transient" &&
        cls.reason === "context_overflow" &&
        !shouldDemoteOnContextOverflow(contextOverflowStrategy)
      ) {
        return tagContextOverflowHop(
          new Response(resp.body, {
            status: resp.status,
            headers: passthroughHeaders(resp),
          }),
          hop,
        );
      }
      if (
        cls.kind === "transient" &&
        cooldownPolicyFor(cls.reason).action !== "surface" &&
        !finalHop
      ) {
        lastError = `cloud hop ${hop.modelId} returned ${resp.status}`;
        const reason =
          hopBodySnippet(raw).length > 0
            ? `HTTP ${resp.status}: ${hopBodySnippet(raw)}`
            : lastError;
        if (cls.reason === "context_overflow") {
          const requiredTokens =
            contextOverflowRequiredTokens(raw) ?? baseEstimate;
          const nextModel = nextLargerContextModel(
            hops.map((candidate) => candidate.modelId),
            hop.modelId,
            requiredTokens,
            (modelId) => lookupCatalogEntry(modelId)?.input_token_limit ?? null,
          );
          if (nextModel !== null && !args.req.signal.aborted) {
            hopTrail.push({
              modelId: hop.modelId,
              provider: hop.provider,
              reason,
              status: resp.status,
            });
            contextDemotionTarget = nextModel;
            continue;
          }
          return withHopTrailHeaders(
            new Response(resp.body, {
              status: resp.status,
              headers: passthroughHeaders(resp),
            }),
          );
        }
        addHopFailure(hop, reason, resp.status, cls.reason);
        preserveTerminalResponse(resp.clone(), forceContextAttempt);
        continue;
      }
      if (forceContextAttempt && firstTerminalResponse !== null) {
        return withHopTrailHeaders(firstTerminalResponse);
      }
    }
    return withHopTrailHeaders(
      new Response(resp.body, {
        status: resp.status,
        headers: passthroughHeaders(resp),
      }),
      hop,
    );
  }
  // ── Recovery pass ─────────────────────────────────────────────────────
  // The whole chain walked to a terminal failure, but some subscription hops
  // were skipped by the ADVISORY cooldown gate. Under N concurrent agents on
  // ONE shared subscription account, the first agent's transient 429 cools the
  // hop process-globally and every sibling then skips the entire all-one-account
  // chain — where N direct vendor connections would each just retry and succeed.
  // Re-dial such a hop ONCE, but only when it is provably NOT doomed: a transient
  // cooldown set by a DIFFERENT walk, past any vendor Retry-After floor, AND with
  // the authoritative usage cache confirming the account still has quota (the
  // stricter gate — never the bare pass-1 "allow").
  //
  // Restart from the TOP of the chain, not from the leftover skip list: iterate
  // the plan's hops in CHAIN ORDER from index 0 so the request lands on the
  // HIGHEST-PRIORITY usable hop (e.g. opus-5), not whatever degraded lower hop
  // happened to be skipped. Only a hop pass 1 SKIPPED by the advisory cooldown
  // gate is a candidate (`cooldownSkippedSet`) — a hop pass 1 already DIALLED
  // (and failed) is never re-dialled; `recoveryDialed` keeps it at-most-once
  // across the recovery loop too. The FIRST successful dial wins and returns.
  const cooldownSkippedSet = new Set(
    cooldownSkipped.map((h) => `${h.provider}|${h.modelId}`),
  );
  const recoveryDialed = new Set<string>();
  for (const hop of hops) {
    if (args.req.signal.aborted) break;
    // Skipped by the advisory cooldown gate in pass 1 — never a dialled-and-
    // failed hop, and never an API-key hop (those cool via the cloud).
    if (!cooldownSkippedSet.has(`${hop.provider}|${hop.modelId}`)) continue;
    // Authoritative at-most-once: never re-dial a hop identity pass 1 already
    // dialled, even when a concurrent sibling overwrote its cooldown setter key
    // (last-writer-wins) so the `setterSessionKey` check below no longer sees
    // this walk. Covers a chain that lists the same model at two positions.
    if (dialedHops.has(`${hop.provider}|${hop.modelId}`)) continue;
    if (recoveryDialed.has(`${hop.provider}|${hop.modelId}`)) continue; // at-most-once per hop
    const cd = peekHopCooldown(hop.provider, hop.modelId);
    if (cd === undefined) continue; // expired — leave to the next request
    if (!TRANSIENT_COOLDOWN_REASONS.has(cd.reason)) continue; // hard reason
    if (cd.setterSessionKey === walkSessionKey) continue; // I set it — already tried
    // Past the vendor's authoritative recover floor (or none given).
    if (cd.recoverAtMs !== undefined && Date.now() < cd.recoverAtMs) continue;
    // Provably doomed by size: pass 1's cooldown gate runs BEFORE its context
    // gate, so a cooldown-skipped hop was never size-checked. Mirror pass 1's
    // `shouldSkipHopForContext` (finalHop:false — the recovery dial is never
    // final) so a context-ineligible hop is not re-dialled into a guaranteed
    // context_overflow (which doesn't even cool — pure waste). Checked BEFORE
    // the usage read so an ineligible hop never pays for a vendor usage probe.
    if (
      shouldSkipHopForSize(contextOverflowStrategy) &&
      shouldSkipHopForContext({
        estimatedTokens: baseEstimate,
        inputTokenLimit:
          lookupCatalogEntry(hop.modelId)?.input_token_limit ?? null,
        finalHop: false,
      })
    ) {
      continue;
    }
    // HARD usage floor — the STRICTER predicate: a confirmed quota snapshot that
    // the gate says still has room. Absent / null / rejected → never bypass.
    const snap = await usageForActiveAccount(
      hop.provider,
      accountHashByProvider,
      connectedByProvider,
    );
    if (snap === null || snap.kind !== "quota") continue;
    const gate = quotaGateDecision({
      snapshot: snap,
      meter: lookupCatalogEntry(hop.modelId)?.subscription_meter,
      finalHop: false,
      staleCapMs: GATE_STALE_CAP_MS,
      now: Date.now(),
    });
    if (gate.kind !== "allow") continue;
    recoveryDialed.add(`${hop.provider}|${hop.modelId}`);
    const served = await serveSubscriptionHop(hop, false, {
      forceContextAttempt: false,
      retryAttempt: 0,
    });
    // A bypass failure re-marks the hop with THIS walk's session key (setter ==
    // mine), so it can never be reconsidered here — at-most-once, no loop. A
    // success clears the stale cooldown sign (`commitSubscriptionServe`).
    if (served !== HOP_CONTINUE) return commitSubscriptionServe(hop, served);
  }
  // Every hop in the plan failed pre-stream. Surface the trail so the client
  // (and Overview once rows land in Neon) can see WHY earlier hops walked.
  const trailSummary =
    hopTrail.length > 0
      ? ` (trail: ${formatHopFailuresHeader(hopTrail)}; last: ${lastError ?? "unknown"})`
      : lastError !== null
        ? ` (last: ${lastError})`
        : "";
  return withHopTrailHeaders(
    errorJson(502, `all hops in the plan failed${trailSummary}`),
  );
};

/** Upstream compact endpoint for a Codex `/responses` URL — codex-rs calls
 *  `<base>/responses/compact`, so the delegate's captured inference URL
 *  (`…/backend-api/codex/responses`) just gains the `/compact` suffix. */
export const compactUpstreamUrl = (responsesUrl: string): string =>
  `${responsesUrl.replace(/\/+$/, "")}/compact`;

/**
 * The provider model id a `/responses/compact` call should pin: the
 * plan's first chatgpt hop when a (cloud-resolved) plan was fetched or
 * replayed from the signed-plan cache — the same alias→pmid authority every
 * inference call uses — else the body's own model id forwarded verbatim
 * (a client naming a concrete Codex model needs no translation).
 */
export const resolveCompactModelId = (
  planParam: string | null,
  pmidsParam: string | null,
  rawBody: unknown,
): string => {
  const planModelIds = parsePlan(planParam);
  const pmids = pmidsParam === null ? [] : pmidsParam.split(",");
  for (const [i, m] of planModelIds.entries()) {
    const hop = resolveHop(m, pmids[i]);
    if (hop.provider === "chatgpt") return hop.providerModelId;
  }
  const model = (rawBody as { model?: unknown } | null)?.model;
  return typeof model === "string" ? model : "";
};

/**
 * Upstream count-tokens endpoint for an Anthropic `/v1/messages` URL — the
 * delegate's captured inference URL just gains the `/count_tokens` leaf, with
 * the query string preserved. Returns `null` when the captured URL is NOT a
 * `/messages` endpoint: we never GUESS a vendor path, and the caller falls back
 * to the local estimate instead.
 */
export const countTokensUpstreamUrl = (messagesUrl: string): string | null => {
  let u: URL;
  try {
    u = new URL(messagesUrl);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/messages")) return null;
  u.pathname = `${path}/count_tokens`;
  return u.toString();
};

/**
 * Serve `POST /v1/messages/count_tokens` — Claude Code's PREFLIGHT (model
 * availability + the context-window indicator). It is NOT inference and must
 * never be walked as such.
 *
 * It used to be: the listener's surface test (`endsWith("/messages")`) missed
 * this path, so it fell through to the `chat_completions` default, the body was
 * pushed through the OpenAI→Anthropic adapter (which deliberately DROPS
 * `cache_control` — no non-Anthropic upstream honours it) and POSTed to the
 * captured INFERENCE url. Every context-indicator tick therefore ran a real,
 * fully-uncached, max-context Opus generation, walked the whole fallback chain
 * when it failed, and drew opaque `rate_limit_error` 429s from Anthropic — a
 * request shape no genuine Claude Code ever sends.
 *
 * Now: ONE hop, no walk. When the plan's head speaks the Anthropic wire we
 * forward the client's body verbatim to the vendor's own `/count_tokens` leaf
 * (free, consumes no quota) through the shared `buildUpstreamRequest` recipe —
 * so it carries the same identity + `anthropic-version`/`anthropic-beta` as
 * inference, with only `model` pinned and adaptive-thinking normalised.
 * ANYTHING else — untrusted plan, non-Anthropic head, no credential, an
 * unrecognised captured url, or a non-2xx upstream — answers
 * `estimateAnthropicInputTokens`, the SAME estimator the cloud handler serves,
 * so the number a client sees doesn't shift with which surface answered. A
 * preflight always returns a `{ input_tokens }` body, never a bare 4xx. No usage
 * row is recorded; the vendor bills nothing for a token count.
 */
export const runCountTokens = async (args: TWalkArgs): Promise<Response> => {
  const estimate = async (
    encoding: TTokenEncoding,
    reason: string | null,
  ): Promise<Response> => {
    if (reason !== null) {
      logWarn(
        "count-tokens",
        `serving local estimate for ${args.endpoint}: ${reason}`,
      );
    }
    return new Response(
      JSON.stringify({
        input_tokens: await estimateAnthropicInputTokens(
          args.rawBody,
          encoding,
        ),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  // A forged plan must not steer which vendor sees the body (same rule as
  // `runWalker`); an untrusted plan degrades to the estimate rather than 403ing
  // — the preflight contract is a number, not an error.
  if (
    !planSignatureOk(
      args.planParam,
      args.pmidsParam,
      args.originParam,
      args.contextOverflowStrategy ?? null,
      args.sigParam,
    )
  ) {
    return estimate(DEFAULT_ENCODING, "plan signature missing or invalid");
  }
  const planModelIds = parsePlan(args.planParam);
  const head = planModelIds[0];
  if (head === undefined) return estimate(DEFAULT_ENCODING, null);
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  // The HEAD of the chain only: it's the hop that would serve the matching
  // `/v1/messages` call, so it's the one whose tokenizer the client is asking
  // about. A preflight never walks — a fallback hop's count would describe a
  // model the request isn't going to.
  const hop = resolveHop(head, pmids[0]);
  const hopEncoding: TTokenEncoding =
    UPSTREAM_WIRE[hop.provider] === "anthropic" ? "claude" : DEFAULT_ENCODING;
  if (UPSTREAM_WIRE[hop.provider] !== "anthropic") {
    // Known non-Anthropic wire: no count_tokens leaf exists. Local BPE only —
    // never a fetch, never a warning (this is the expected ChatGPT/Kimi/Grok
    // preflight path).
    return estimate(hopEncoding, null);
  }
  // The count URL is the captured delegate inference URL + `/count_tokens`.
  // That host is not in the unsigned request; guessing it would mix custom
  // endpoints. `acquireUpstream` is therefore required to *name* the
  // identity (it may refresh CLI auth as a side effect). Once named, a
  // remembered-unsupported hop skips the count HTTP below — not the
  // acquire.
  const acquired = await acquireUpstream(hop.provider, args, hop);
  if (acquired === "retry") {
    return estimate(hopEncoding, `no usable ${hop.provider} credential`);
  }
  const url = countTokensUpstreamUrl(acquired.url);
  if (url === null) {
    return estimate(
      hopEncoding,
      "captured upstream url is not a /messages endpoint",
    );
  }
  const scope = {
    provider: hop.provider,
    endpointIdentity: countTokensEndpointIdentity(url),
  };
  const capability = args.countTokensCapability ?? {
    isUnsupported: isCountTokensUnsupported,
    remember: rememberCountTokensUnsupported,
  };
  if (capability.isUnsupported(scope)) {
    return estimate(hopEncoding, null);
  }
  let built: ReturnType<typeof buildUpstreamRequest>;
  try {
    built = buildUpstreamRequest({
      surface: "messages",
      upstreamWire: "anthropic",
      rawBody: args.rawBody,
      provider: hop.provider,
      providerModelId: hop.providerModelId,
      // `undefined` preserves the body's own stream flag — a count_tokens body
      // carries none, and injecting one would diverge from the real CLI.
      stream: undefined,
      baseHeaders: acquired.headers,
      inboundBeta: inboundBetaOf(args),
      isOAuth: true,
      caps: hop.caps,
      modelSettings: hop.modelSettings,
      capabilities: hop.capabilities,
    });
  } catch (err) {
    if (err instanceof UnsupportedContentError) {
      return estimate(hopEncoding, "unsupported_content");
    }
    throw err;
  }
  let resp: Response;
  let text: string;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: args.req.signal,
    });
    // The body read is INSIDE the try: a mid-body stream error (or the client
    // aborting) rejects here, and a preflight that throws would surface as a
    // 500 — the one thing this handler promises never to do.
    text = await resp.text();
  } catch (err) {
    return estimate(
      hopEncoding,
      `upstream unreachable: ${sanitizeErrorLine(err, 200)}`,
    );
  }
  if (!resp.ok) {
    if (countTokensUnsupportedFromUpstream(resp.status, text)) {
      capability.remember(scope);
      return estimate(hopEncoding, null);
    }
    return estimate(
      hopEncoding,
      `upstream ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/**
 * Serve `POST /v1/responses/compact` — the Codex CLI's OWN compaction
 * call (Plan A of the context ladder: the client compacts itself).
 * Without this passthrough a Codex client pointed at openllm gets a 404
 * from its `/responses/compact` call, its self-compaction silently
 * breaks, and sessions balloon until the gateway-side overflow ladder
 * has to intervene every turn. Mirrors ref/CLIProxyAPI's
 * `executeCompact`: build the normal Codex upstream request (identity
 * headers + preamble via `buildUpstreamRequest`), pin the resolved
 * model, POST non-streaming to `<responses-url>/compact`, and return
 * the upstream JSON verbatim. chatgpt-only — no other provider exposes
 * the endpoint.
 */
export const runResponsesCompact = async (
  args: TWalkArgs,
): Promise<Response> => {
  // A forged plan must not steer the model id: honour the plan only when
  // it verifies (same rule as `runWalker`); an invalid plan falls back to
  // the body's own model rather than 403ing — compact works planless.
  const planTrusted = planSignatureOk(
    args.planParam,
    args.pmidsParam,
    args.originParam,
    args.contextOverflowStrategy ?? null,
    args.sigParam,
  );
  const providerModelId = resolveCompactModelId(
    planTrusted ? args.planParam : null,
    planTrusted ? args.pmidsParam : null,
    args.rawBody,
  );
  const compactPlan = parsePlan(planTrusted ? args.planParam : null);
  const compactPmids =
    planTrusted && args.pmidsParam !== null ? args.pmidsParam.split(",") : [];
  const compactHop = compactPlan
    .map((modelId, i) => resolveHop(modelId, compactPmids[i]))
    .find((h) => h.provider === "chatgpt");
  const acquired = await acquireUpstream(
    "chatgpt",
    args,
    compactHop ?? { provider: "chatgpt", modelId: providerModelId },
  );
  if (acquired === "retry") {
    return errorJson(
      502,
      "no usable chatgpt credential on this daemon — connect the Codex CLI on /providers first",
    );
  }
  let built: ReturnType<typeof buildUpstreamRequest>;
  try {
    built = buildUpstreamRequest({
      surface: "responses",
      upstreamWire: "chatgpt",
      rawBody: args.rawBody,
      provider: "chatgpt",
      providerModelId,
      stream: false,
      baseHeaders: acquired.headers,
      inboundBeta: null,
      isOAuth: false,
      codexInstructions: wantsCodexPreamble("chatgpt"),
      caps: compactHop?.caps,
      capabilities: compactHop?.capabilities ?? [],
    });
  } catch (err) {
    if (err instanceof UnsupportedContentError) {
      return errorJson(400, err.message, "unsupported_content");
    }
    throw err;
  }
  // Compact is strictly non-streaming — codex-rs DELETES the stream flag
  // rather than sending `stream: false`.
  const body =
    built.body !== null && typeof built.body === "object"
      ? (({ stream: _stream, ...rest }): Record<string, unknown> => rest)(
          built.body as Record<string, unknown>,
        )
      : built.body;
  let resp: Response;
  try {
    resp = await fetch(compactUpstreamUrl(acquired.url), {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(body),
      signal: args.req.signal,
    });
  } catch (err) {
    return errorJson(
      502,
      `compact upstream unreachable: ${sanitizeErrorLine(err, 300)}`,
    );
  }
  // Verbatim passthrough — the Codex client owns the compact protocol; no
  // usage row (the vendor bills compaction as part of the session). Headers
  // forward via the same transport-safe filter every other passthrough
  // uses, so upstream retry metadata (429 `retry-after`, rate-limit
  // headers) reaches the client intact.
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: passthroughHeaders(resp),
  });
};
