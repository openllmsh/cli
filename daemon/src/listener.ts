/**
 * The daemon's local `/v1/*` inference surface. Mirrors the cloud's
 * OpenAI/Anthropic-compatible endpoints, served LOCALLY by the
 * `@openllm/core`-free `walker.ts` (subscription hops run on the official
 * CLI's credential; API-key hops are forwarded to the cloud).
 *
 * Single flow: a request arrives (a local client, or a relay tunnel opened
 * by a browser, a fleet peer, or the origin), the daemon fetches a signed
 * plan from `/api/daemon/plan`, and the walker executes it. The daemon holds
 * NO routing brain of its own — the cloud resolves the chain.
 *
 * The daemon binds to 127.0.0.1 and the caller owns the machine, so there
 * is no API-key auth gate here (unlike the cloud handler).
 */

import type { TContextOverflowStrategy } from "@openllmsh/protocol";
import {
  AnthropicCountTokensRequest,
  AnthropicRequest,
  ChatCompletionRequest,
  decodeVideoId,
  ImageGenerationInput,
  ImageGenerationRequest,
  isLocalKeyProviderSlug,
  parseImageEditInput,
  parseImageEditMultipart,
  parseVideoGenerationInput,
  ResponsesRequest,
} from "@openllmsh/protocol";
import {
  collectBoundedBytes,
  TUNNEL_MEDIA_MAX_BODY_BYTES,
} from "@openllmsh/tunnel";
import { estimateBodyTokens } from "@openllmsh/wire/lib/canonical/token-estimate";
import { Schema } from "effect";
import {
  runAudioSpeechWalker,
  runAudioTranscriptionWalker,
} from "./audio-walker";
import {
  fetchMediaDefaultPlan,
  fetchPlan,
  fetchVideoJobPlan,
  MediaDefaultPlanError,
} from "./cloud-client";
import { planCacheEnabled } from "./config";
import { notePresenceActivity } from "./control-channel";
import { corsHeaders, errorJson, isPreflight, preflightResponse } from "./cors";
import { isOAuthSlug } from "./delegation";
import { runEmbeddings } from "./embeddings-walker";
import { passthroughToOrigin } from "./forward";
import { runImageEditWalker, runImageWalker } from "./image-walker";
import { isLocalServerSlug } from "./local-servers";
import { logWarn, safeDiagnosticMessage } from "./logger";
import {
  buildMediaDefaultRequest,
  materializeSelectedModel,
  mediaDefaultSurfaceFor,
  modelFieldFromRequest,
  selectedModelFromPlan,
} from "./media-default-handoff";
import type { TParsedMultipart } from "./multipart";
import { parseMultipartBytes } from "./multipart";
import {
  originFailureDiagnostic,
  originFailureMessage,
  originFailureStatus,
  originFailureType,
  planFetchFailureAction,
} from "./net-error";
import type { TPlanTuple } from "./plan-cache";
import {
  loadPlanWithShared,
  lookupPlan,
  noteTeamPlanServed,
  planNeedsRefresh,
} from "./plan-cache";
import { tryDirectTeamLeg } from "./team-leg-client";
import {
  currentTeamGrantFieldsOf,
  currentTeamGrantToken,
} from "./team-request-context";

import { isBodylessVideoOp, videoOperationFor } from "./video-ops";
import {
  runVideoCancel,
  runVideoContent,
  runVideoCreate,
  runVideoPoll,
} from "./video-walker";
import {
  parsePlan,
  planSignatureOk,
  runCountTokens,
  runResponsesCompact,
  runWalker,
} from "./walker";

const parseAnthropicRequest = Schema.decodeUnknownSync(AnthropicRequest);
const parseOpenAIRequest = Schema.decodeUnknownSync(ChatCompletionRequest);
const parseImageRequest = Schema.decodeUnknownSync(ImageGenerationRequest);
const parseImageInput = Schema.decodeUnknownSync(ImageGenerationInput);

/**
 * Validate the normalized image fields while retaining provider-specific
 * extensions for the model-less forwarding path.
 */
const parseImageInputPreservingExtras = (input: unknown): unknown => {
  const parsed = parseImageInput(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return parsed;
  }
  return { ...input, ...parsed };
};

const parseResponsesRequest = Schema.decodeUnknownSync(ResponsesRequest);
const parseCountTokensRequest = Schema.decodeUnknownSync(
  AnthropicCountTokensRequest,
);

/** Only ordinary text inference can use the direct team reservation leg. */
export const isDirectTeamInferencePath = (path: string): boolean =>
  path === "/v1/chat/completions" ||
  path === "/v1/messages" ||
  path === "/v1/responses";

/**
 * Add CORS headers to a response WITHOUT consuming its body, so streaming
 * (SSE) responses keep streaming. The dashboard browser calls this
 * localhost surface cross-origin, so every `/v1/*` response needs them.
 */
const withCors = (req: Request, res: Response): Response => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

export const handleInference = async (req: Request): Promise<Response> => {
  // CORS/PNA preflight — the dashboard fetches this surface cross-origin
  // (HTTPS page → http://127.0.0.1) for subscription models.
  if (isPreflight(req)) return preflightResponse(req);

  // A client pointed DIRECTLY at the daemon port is the strongest possible
  // liveness proof — republish presence (throttled, off the response path) so
  // the cloud can never hold this daemon offline while it is serving, which
  // would refuse the next subscription chain with `subscription_requires_daemon`.
  notePresenceActivity();

  const startedAt = Date.now();
  const url = new URL(req.url);
  // Codex's own compaction endpoint rides the responses surface but is a
  // verbatim vendor passthrough (`runResponsesCompact`) — no surface
  // schema, no walk.
  const isResponsesCompact = url.pathname.endsWith("/responses/compact");
  const isImages = url.pathname.endsWith("/images/generations");
  const isImageEdits = url.pathname.endsWith("/images/edits");
  const isTranscriptions = url.pathname.endsWith("/audio/transcriptions");
  const isSpeech = url.pathname.endsWith("/audio/speech");
  // Normalize the optional `/api` prefix once; reused for video routing + the
  // recorded `endpoint`.
  const normalizedPath = url.pathname.replace(/^\/api(?=\/v1\/)/, "");
  const isEmbeddings = normalizedPath === "/v1/embeddings";

  // Model listing is not an inference surface — the daemon holds no local
  // catalog, so a `GET /v1/models[...]` is passed straight through to the
  // cloud (same local-first passthrough as a pure-BYOK hop; the daemon's
  // paired key fills in when the caller sends none). Handled before the body
  // parse below, which assumes an inference request with a JSON body.
  if (req.method === "GET" && /^\/v1\/models(?:\/|$)/.test(normalizedPath)) {
    return withCors(req, await passthroughToOrigin(req, new ArrayBuffer(0)));
  }

  const { operation: videoOperation, videoId } = videoOperationFor(
    req.method,
    normalizedPath,
  );
  // Anthropic's PREFLIGHT, not inference. It must be matched BEFORE the
  // `/messages` test below (which it does not satisfy) or it falls through to
  // the `chat_completions` default and gets served as a real Opus generation —
  // see `runCountTokens` for what that cost us.
  const isCountTokens = url.pathname.endsWith("/messages/count_tokens");
  const surface: "chat_completions" | "messages" | "responses" =
    url.pathname.endsWith("/messages") || isCountTokens
      ? "messages"
      : url.pathname.endsWith("/responses") || isResponsesCompact
        ? "responses"
        : "chat_completions";
  const endpoint = normalizedPath;

  // Audio uploads (`/v1/audio/transcriptions`) and inline image edits
  // (`/v1/images/edits`) may arrive as `multipart/form-data` — every other
  // surface stays JSON-only. Bounded by the SAME cap the tunnel enforces on
  // a mux-forwarded media body (`TUNNEL_MEDIA_MAX_BODY_BYTES`), so a huge
  // upload can't stall or OOM the local listener either.
  const requestContentType = req.headers.get("content-type") ?? "";
  const isMultipart = requestContentType
    .toLowerCase()
    .includes("multipart/form-data");

  let rawBytes: ArrayBuffer;
  let rawBody: unknown = null;
  let multipart: TParsedMultipart | null = null;
  try {
    if (isBodylessVideoOp(videoOperation)) {
      rawBytes = await req.arrayBuffer();
    } else if (isMultipart) {
      const collected = await collectBoundedBytes(
        req.body,
        TUNNEL_MEDIA_MAX_BODY_BYTES,
        req.signal,
      );
      // Keep the ORIGINAL bytes (not a re-serialized FormData) so an
      // eventual cloud passthrough forwards the caller's exact multipart
      // body — `Response(collected, ...).formData()` only READS the bytes,
      // it never consumes/mutates the buffer we hand back to the caller.
      rawBytes = collected.buffer.slice(
        collected.byteOffset,
        collected.byteOffset + collected.byteLength,
      ) as ArrayBuffer;
      multipart = await parseMultipartBytes(collected, requestContentType);
    } else {
      rawBytes = await req.arrayBuffer();
      rawBody = JSON.parse(new TextDecoder().decode(rawBytes));
    }
  } catch (err) {
    const tooLarge = err instanceof Error && err.message.includes("too large");
    return withCors(
      req,
      errorJson(
        tooLarge ? 413 : 400,
        tooLarge
          ? "Request body too large"
          : "Body must be valid JSON or multipart/form-data",
      ),
    );
  }

  // The tunnel's leading-byte admission scanner can see an earlier duplicate
  // key than JSON.parse (which retains the last key). Re-bind the parsed root
  // model to the signed team grant at the dispatch boundary.
  const teamGrant = currentTeamGrantFieldsOf();
  if (
    teamGrant !== null &&
    !isBodylessVideoOp(videoOperation) &&
    !isMultipart &&
    (typeof rawBody !== "object" ||
      rawBody === null ||
      (rawBody as { readonly model?: unknown }).model !== teamGrant.model)
  ) {
    return withCors(
      req,
      errorJson(403, "Team grant model does not match request"),
    );
  }

  const mediaSurface = mediaDefaultSurfaceFor({
    isImages,
    isImageEdits,
    isTranscriptions,
    isSpeech,
    isVideoCreate: videoOperation === "create",
  });
  const modelField = modelFieldFromRequest(rawBody, multipart);
  // Invalid `model` types are only a media-default concern. Compact and
  // other non-media surfaces keep their existing parsers (compact is a
  // verbatim vendor passthrough).
  if (mediaSurface !== null && modelField.kind === "invalid") {
    return withCors(req, errorJson(400, "Invalid request body"));
  }

  // Inline image edits: explicit model normalizes immediately. Model-less
  // edits only run structural validation (mask/refs) here; required-model
  // decoding waits until a verified signed plan supplies the selection.
  let imageEditPending = false;
  if (isImageEdits) {
    const fieldsForParse =
      multipart !== null
        ? {
            ...multipart.fields,
            ...(modelField.kind === "absent" ? { model: "_" } : {}),
          }
        : null;
    const bodyForParse =
      multipart === null && modelField.kind === "absent"
        ? { ...(rawBody as Record<string, unknown>), model: "_" }
        : rawBody;
    const parsedEdit =
      multipart !== null
        ? parseImageEditMultipart({
            fields: fieldsForParse ?? multipart.fields,
            files: multipart.files,
          })
        : parseImageEditInput(bodyForParse);
    if (!parsedEdit.ok) {
      return withCors(
        req,
        errorJson(400, parsedEdit.error.message, parsedEdit.error.code),
      );
    }
    if (modelField.kind === "explicit") {
      rawBody = parsedEdit.request;
    } else {
      imageEditPending = true;
    }
  }

  // Validate against the surface schema for a clean 400 — the walker
  // passes the body through (passthrough) or adapts it, so a malformed
  // body would otherwise surface as an opaque upstream/transform failure.
  // Compact bodies skip this: the vendor owns that contract and the call
  // is forwarded verbatim (strictness here would 400 shapes the upstream
  // accepts). Model-less media uses optional-model INPUT schemas; concrete
  // required-model schemas run after a verified plan materializes `model`.
  // Set by the branches below that REWRITE `rawBody` (dropping a blank
  // `model`, dropping empty reference arrays). `rawBytes` — not `rawBody`
  // — is what a BYOK passthrough and a cloud hop actually put on the
  // wire, so a rewrite has to be mirrored onto the bytes or the two
  // disagree and the cloud sees the pre-normalization shape.
  let normalizedJsonBody = false;
  try {
    if (isResponsesCompact) {
      // no-op — verbatim vendor passthrough
    } else if (isCountTokens) parseCountTokensRequest(rawBody);
    else if (videoOperation === "create") {
      rawBody = parseVideoGenerationInput(rawBody);
      normalizedJsonBody = true;
    } else if (isBodylessVideoOp(videoOperation)) {
      // no-op — id-addressed video ops carry no body (rawBody is null); the
      // signed plan rides the query string, so there's nothing to validate.
    } else if (isImages) {
      if (modelField.kind === "explicit") parseImageRequest(rawBody);
      else {
        rawBody = parseImageInputPreservingExtras(rawBody);
        normalizedJsonBody = true;
      }
    } else if (isImageEdits) {
      // no-op — structural validation above; concrete decode after plan.
    } else if (isTranscriptions || isSpeech) {
      // no-op — the audio walker validates its own shape (either JSON or
      // multipart for transcriptions; JSON-only for speech).
    } else if (isEmbeddings) {
      // Embeddings keep a minimal body (`model` + `input`); the embeddings
      // walker validates what's needed and must not go through the chat
      // completion schema (which would 400 a valid embeddings request).
    } else if (surface === "messages") parseAnthropicRequest(rawBody);
    else if (surface === "responses") parseResponsesRequest(rawBody);
    else parseOpenAIRequest(rawBody);
  } catch (err) {
    return withCors(
      req,
      errorJson(
        400,
        err instanceof Error ? err.message : "Invalid request body",
      ),
    );
  }

  // Re-encode so the bytes agree with the normalized body. Both BYOK
  // passthroughs (`fetched === null`, and a verified plan with no
  // subscription hop) forward `rawBytes` verbatim, and `forwardCloudHop`
  // does the same for an API-key hop inside a mixed chain — a
  // media-default selection is the only path that rebuilds the bytes on
  // its own (`materializeSelectedModel`). JSON only: multipart keeps the
  // caller's exact original bytes, and a non-media surface is never
  // rewritten, so neither is touched here. Content-type is unchanged —
  // this stays `application/json`, so no header fixup is needed.
  //
  // Model-less media always rewrites bytes in `materializeSelectedModel`,
  // so skip the early full-body JSON.stringify there (large image data
  // URLs were paying ~1–5 ms twice). Explicit-alias / non-media-default
  // paths may passthrough before materialize and still need the sync.
  const syncNormalizedJsonBytes = (): void => {
    if (!normalizedJsonBody || multipart !== null) return;
    const encoded = new TextEncoder().encode(JSON.stringify(rawBody));
    rawBytes = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
    normalizedJsonBody = false;
  };
  if (
    normalizedJsonBody &&
    multipart === null &&
    !(modelField.kind !== "explicit" && mediaSurface !== null)
  ) {
    syncNormalizedJsonBytes();
  }

  // Signed-plan cache (flag-gated rider — `plan-cache.ts`). A plan fetched
  // from `/api/daemon/plan` is remembered per (surface, model alias); a later
  // request within the TTL replays it, skipping the cloud round trip. A tuple
  // enters the cache only after the same signature check the walker enforces,
  // so a forged tuple can never overwrite an entry. The alias is NOT inside the
  // signed payload; that residual scope is accepted because this surface is
  // 127.0.0.1 and the caller owns the machine (see the module doc).
  let planParam: string | null = null;
  let pmidsParam: string | null = null;
  let originParam: string | null = null;
  let contextOverflowStrategy: TContextOverflowStrategy | null = null;
  let sigParam: string | null = null;
  let passthroughContentType: string | null = null;
  const explicitAlias =
    modelField.kind === "explicit" ? modelField.value : null;
  // A cached plan is now SURFACE-scoped, because the plan itself is: the
  // same `grok` resolves to the chat model on `/v1/chat/completions` and
  // to the image model on `/v1/images/generations`, so one alias-keyed
  // entry would serve an image request the chat plan it cached a moment
  // earlier. Encode the pair structurally: concatenating with a colon
  // would collide with a chat alias literally named `image:grok`.
  const planCacheKey =
    explicitAlias === null
      ? null
      : JSON.stringify([mediaSurface ?? "chat", explicitAlias]);
  // Never cache model-less defaults under one empty alias — selection
  // depends on surface/options and current availability. Soft-stale hits
  // are served immediately; `loadPlan` below coalesces concurrent misses
  // and refreshes soft-stale entries in the background.
  if (planCacheEnabled() && planCacheKey !== null) {
    const cached = lookupPlan(planCacheKey);
    if (cached !== null) {
      ({
        planParam,
        pmidsParam,
        originParam,
        contextOverflowStrategy,
        sigParam,
      } = cached);
    }
  }

  const materializeFromVerifiedPlan = async (
    plan: string,
  ): Promise<Response | null> => {
    if (explicitAlias !== null) return null;
    const selected = selectedModelFromPlan(plan);
    if (selected === null) {
      return errorJson(400, "Signed plan did not include a model");
    }
    const next = await materializeSelectedModel({
      model: selected,
      rawBody,
      rawBytes,
      multipart,
      requestContentType,
    });
    rawBody = next.rawBody;
    rawBytes = next.rawBytes;
    multipart = next.multipart;
    passthroughContentType = next.contentType;
    if (imageEditPending) {
      const parsedEdit =
        multipart !== null
          ? parseImageEditMultipart({
              fields: multipart.fields,
              files: multipart.files,
            })
          : parseImageEditInput(rawBody);
      if (!parsedEdit.ok) {
        return errorJson(400, parsedEdit.error.message, parsedEdit.error.code);
      }
      rawBody = parsedEdit.request;
    }
    return null;
  };

  const handlePlanFetchError = (
    err: unknown,
    label: string,
    /**
     * Abort signal that owns this fetch. Omit (or pass `undefined`) for a
     * shared single-flight load so one client's abort is not classified as an
     * origin failure for every joined waiter.
     */
    signal?: AbortSignal,
  ): Response | "passthrough" | "throw" => {
    const decision = planFetchFailureAction(err, signal);
    if (decision.action === "origin-error") {
      logWarn("listener", originFailureDiagnostic(decision.kind), {
        stage: "plan_fetch",
        kind: decision.kind,
        label,
      });
      return withCors(
        req,
        errorJson(
          originFailureStatus(decision.kind),
          originFailureMessage(decision.kind),
          originFailureType(decision.kind),
        ),
      );
    }
    if (decision.action === "throw") return "throw";
    logWarn(
      "listener",
      safeDiagnosticMessage`Plan fetch failed; passing through to origin.`,
      { label, error: err instanceof Error ? err.message : String(err) },
    );
    return "passthrough";
  };

  // Local-first gateway (docs/proposals/local-first-gateway.md): a request
  // the plan cache didn't cover. Fetch a signed plan from the origin (body never transits the
  // cloud), verify it with the per-user key handed over at bootstrap,
  // and walk it locally when it contains at least one subscription hop; a
  // pure-BYOK plan (and a failed fetch) passes through to the origin
  // verbatim — the cloud keeps its own fallback/cooldown machinery,
  // byte-identical to a directly-pointed client.
  // Soft-stale cache hits still enter this block so `loadPlan` can refresh
  // them without blocking the request on WAN.
  if (
    (planParam === null ||
      (planCacheEnabled() &&
        planCacheKey !== null &&
        planNeedsRefresh(planCacheKey))) &&
    !isResponsesCompact &&
    explicitAlias !== null
  ) {
    // Embeddings against an explicit `local_*` model can be served on-device
    // without a cloud plan (local rows are device-live). Fall through to
    // `runEmbeddings` instead of origin-passthrough when the plan is missing
    // or not daemon-only.
    const embeddingsLocalFallback =
      isEmbeddings && isLocalServerSlug(explicitAlias.split("/")[0] ?? "");

    type TPlanFetchOutcome =
      | { readonly kind: "tuple"; readonly tuple: TPlanTuple }
      | { readonly kind: "passthrough" }
      | { readonly kind: "response"; readonly response: Response }
      | { readonly kind: "throw"; readonly error: unknown }
      | { readonly kind: "embeddings-local" };

    const resolveFetched = async (
      /**
       * Bound the shared single-flight to the cloud timeout only — never one
       * caller's `req.signal` — so one abort cannot fail every joined waiter.
       */
      signal: AbortSignal | undefined,
    ): Promise<TPlanFetchOutcome> => {
      let fetched: Awaited<ReturnType<typeof fetchPlan>> | null = null;
      try {
        fetched = await fetchPlan(
          explicitAlias,
          estimateBodyTokens(rawBody),
          signal,
          // The surface this request is FOR — already decided by the path
          // above. Sending it is what stops an ambiguous family name from
          // being planned on the wrong surface: `model=grok` posted to
          // `/v1/images/generations` must plan grok's IMAGE model, not the
          // chat one the cloud's chat default would pick. `null` (a chat or
          // compact request) omits it and keeps the historical default.
          mediaSurface ?? undefined,
        );
      } catch (err) {
        const outcome = handlePlanFetchError(err, explicitAlias, signal);
        if (outcome === "throw") return { kind: "throw", error: err };
        if (outcome !== "passthrough") {
          return { kind: "response", response: outcome };
        }
        return { kind: "passthrough" };
      }
      if (fetched === null) {
        if (embeddingsLocalFallback) return { kind: "embeddings-local" };
        return { kind: "passthrough" };
      }
      const fetchedContextOverflowStrategy =
        fetched.context_overflow_strategy ?? null;
      const verified = planSignatureOk(
        fetched.plan,
        fetched.pmids,
        fetched.origin,
        fetchedContextOverflowStrategy,
        fetched.sig,
      );
      const hasDaemonOnlyHop =
        verified &&
        parsePlan(fetched.plan).some((entry) => {
          const provider = entry.split("/")[0] ?? "";
          return (
            isOAuthSlug(provider) ||
            isLocalServerSlug(provider) ||
            isLocalKeyProviderSlug(provider)
          );
        });
      if (!verified || !hasDaemonOnlyHop) {
        // A verified plan with no daemon-only hop belongs to origin; the
        // body-model local fallback is only for an unverifiable plan.
        if (!embeddingsLocalFallback || verified) {
          return { kind: "passthrough" };
        }
        return { kind: "embeddings-local" };
      }
      return {
        kind: "tuple",
        tuple: {
          planParam: fetched.plan,
          pmidsParam: fetched.pmids,
          originParam: fetched.origin,
          contextOverflowStrategy: fetchedContextOverflowStrategy,
          sigParam: fetched.sig,
        },
      };
    };

    const forwardTeamOrOrigin = async (): Promise<Response> => {
      // Direct team reservations dispatch only ordinary inference. All media,
      // embeddings, and token-count surfaces retain their origin wire shape.
      if (!isDirectTeamInferencePath(normalizedPath)) {
        return passthroughToOrigin(req, rawBytes);
      }
      const model =
        rawBody !== null &&
        typeof rawBody === "object" &&
        !Array.isArray(rawBody)
          ? (rawBody as { readonly model?: unknown }).model
          : undefined;
      const direct = await tryDirectTeamLeg({
        request: req,
        body: new Uint8Array(rawBytes),
        model,
        surface,
      });
      return direct ?? passthroughToOrigin(req, rawBytes);
    };

    const applyPlanFetchOutcome = async (
      outcome: TPlanFetchOutcome,
    ): Promise<Response | null> => {
      if (outcome.kind === "throw") throw outcome.error;
      if (outcome.kind === "response") return outcome.response;
      if (outcome.kind === "tuple") {
        planParam = outcome.tuple.planParam;
        pmidsParam = outcome.tuple.pmidsParam;
        originParam = outcome.tuple.originParam;
        contextOverflowStrategy = outcome.tuple.contextOverflowStrategy;
        sigParam = outcome.tuple.sigParam;
        return null;
      }
      if (outcome.kind === "embeddings-local") {
        // leave planParam null — runEmbeddings serves from the body model
        return null;
      }
      syncNormalizedJsonBytes();
      return withCors(req, await forwardTeamOrOrigin());
    };

    if (planCacheEnabled() && planCacheKey !== null) {
      const { entry, shared } = await loadPlanWithShared<TPlanFetchOutcome>(
        planCacheKey,
        async () => {
          // Shared flight: cloud timeout only (no per-request abort).
          const outcome = await resolveFetched(undefined);
          if (outcome.kind === "tuple") {
            return { store: outcome.tuple, shared: outcome };
          }
          return { store: null, shared: outcome };
        },
      );
      if (shared !== null) {
        const applied = await applyPlanFetchOutcome(shared);
        if (applied !== null) return applied;
      } else if (entry !== null) {
        // Soft-stale immediate serve (background refresh still running).
        planParam = entry.planParam;
        pmidsParam = entry.pmidsParam;
        originParam = entry.originParam;
        contextOverflowStrategy = entry.contextOverflowStrategy;
        sigParam = entry.sigParam;
      } else if (planParam === null) {
        if (!embeddingsLocalFallback) {
          syncNormalizedJsonBytes();
          return withCors(req, await forwardTeamOrOrigin());
        }
      }
    } else if (planParam === null) {
      const outcome = await resolveFetched(req.signal);
      const applied = await applyPlanFetchOutcome(outcome);
      if (applied !== null) return applied;
    }
  } else if (
    planParam === null &&
    !isResponsesCompact &&
    explicitAlias === null &&
    mediaSurface !== null
  ) {
    const mediaRequest = buildMediaDefaultRequest(
      mediaSurface,
      rawBody,
      multipart,
    );
    if (mediaRequest === null) {
      return withCors(req, errorJson(400, "Invalid media default constraints"));
    }
    let fetched: Awaited<ReturnType<typeof fetchMediaDefaultPlan>> | null =
      null;
    try {
      fetched = await fetchMediaDefaultPlan(mediaRequest, req.signal);
    } catch (err) {
      if (err instanceof MediaDefaultPlanError) {
        logWarn(
          "listener",
          "Media default plan rejected; not forwarding media.",
          { status: err.status, type: err.type },
        );
        return withCors(
          req,
          errorJson(err.status, err.message, err.type, err.code),
        );
      }
      const outcome = handlePlanFetchError(err, mediaSurface);
      if (outcome === "throw") throw err;
      if (outcome !== "passthrough") return outcome;
      // Model-less media must not forward prompt/bytes to origin after a
      // failed selection — that would leak content and let the cloud pick
      // a paid model. Explicit-model failures still
      // passthrough above.
      return withCors(
        req,
        errorJson(502, "Media default plan is unavailable", "plan_error"),
      );
    }
    if (fetched === null) {
      return withCors(
        req,
        errorJson(502, "Media default plan is unavailable", "plan_error"),
      );
    }
    const fetchedContextOverflowStrategy =
      fetched.context_overflow_strategy ?? null;
    const verified = planSignatureOk(
      fetched.plan,
      fetched.pmids,
      fetched.origin,
      fetchedContextOverflowStrategy,
      fetched.sig,
    );
    if (!verified) {
      return withCors(req, errorJson(403, "invalid or missing plan signature"));
    }
    const materialized = await materializeFromVerifiedPlan(fetched.plan);
    if (materialized !== null) return withCors(req, materialized);
    if (selectedModelFromPlan(fetched.plan) === null) {
      return withCors(
        req,
        errorJson(400, "Signed plan did not include a model"),
      );
    }
    // Keep the FULL signed chain. Materialized body model is for decode
    // only; walkers iterate remaining hops (subscription then pinned API).
    planParam = fetched.plan;
    pmidsParam = fetched.pmids;
    originParam = fetched.origin;
    contextOverflowStrategy = fetchedContextOverflowStrategy;
    sigParam = fetched.sig;
  }

  // Mux GET video retrieve/content has no body and no model. Decode the
  // opaque job id (provider + model) and fetch a signed plan for that model.
  // HMAC is still required; a plan that does not cover the job is rejected.
  if (
    planParam === null &&
    isBodylessVideoOp(videoOperation) &&
    videoId !== undefined
  ) {
    let jobId = videoId;
    try {
      jobId = decodeURIComponent(videoId);
    } catch {
      return withCors(req, errorJson(400, "Invalid video job id"));
    }
    const payload = decodeVideoId(jobId);
    if (payload === null) {
      return withCors(req, errorJson(400, "Invalid video job id"));
    }
    let fetched: Awaited<ReturnType<typeof fetchVideoJobPlan>> | null = null;
    try {
      fetched = await fetchVideoJobPlan(
        { model: payload.m, provider: payload.p },
        req.signal,
      );
    } catch (err) {
      if (err instanceof MediaDefaultPlanError) {
        return withCors(
          req,
          errorJson(err.status, err.message, err.type, err.code),
        );
      }
      const outcome = handlePlanFetchError(err, payload.m);
      if (outcome === "throw") throw err;
      if (outcome !== "passthrough") return outcome;
      return withCors(
        req,
        errorJson(502, "Video job plan is unavailable", "plan_error"),
      );
    }
    if (fetched === null) {
      return withCors(
        req,
        errorJson(502, "Video job plan is unavailable", "plan_error"),
      );
    }
    const fetchedContextOverflowStrategy =
      fetched.context_overflow_strategy ?? null;
    const verified = planSignatureOk(
      fetched.plan,
      fetched.pmids,
      fetched.origin,
      fetchedContextOverflowStrategy,
      fetched.sig,
    );
    if (!verified) {
      return withCors(req, errorJson(403, "invalid or missing plan signature"));
    }
    planParam = fetched.plan;
    pmidsParam = fetched.pmids;
    originParam = fetched.origin;
    contextOverflowStrategy = fetchedContextOverflowStrategy;
    sigParam = fetched.sig;
    const hops = parsePlan(planParam);
    const coversJob = hops.some((id) => id === payload.m);
    if (!coversJob) {
      return withCors(
        req,
        errorJson(403, "Signed plan does not cover this video job"),
      );
    }
  }

  const walkHeaders = new Headers(req.headers);
  if (passthroughContentType !== null) {
    walkHeaders.set("content-type", passthroughContentType);
    walkHeaders.delete("content-length");
  }
  // Safety net: any deferred normalize that didn't go through
  // materializeSelectedModel still needs bytes to match rawBody.
  syncNormalizedJsonBytes();
  const walkReq =
    passthroughContentType !== null
      ? new Request(req.url, {
          method: req.method,
          headers: walkHeaders,
          signal: req.signal,
        })
      : req;

  const walkArgs = {
    req: walkReq,
    surface,
    endpoint,
    rawBody,
    rawBytes,
    planParam,
    pmidsParam,
    originParam,
    contextOverflowStrategy,
    sigParam,
    startedAt,
  };
  const response = await (videoOperation === "create"
    ? runVideoCreate(walkArgs)
    : videoOperation === "poll"
      ? runVideoPoll(walkArgs, videoId)
      : videoOperation === "content"
        ? runVideoContent(walkArgs, videoId)
        : videoOperation === "cancel"
          ? runVideoCancel(walkArgs, videoId)
          : isResponsesCompact
            ? runResponsesCompact(walkArgs)
            : isCountTokens
              ? runCountTokens(walkArgs)
              : isImages
                ? runImageWalker(walkArgs)
                : isImageEdits
                  ? runImageEditWalker(walkArgs)
                  : isTranscriptions
                    ? runAudioTranscriptionWalker(walkArgs, multipart)
                    : isSpeech
                      ? runAudioSpeechWalker(walkArgs)
                      : isEmbeddings
                        ? runEmbeddings(walkArgs)
                        : runWalker(walkArgs));

  // Only a successful team-tunnel response earns a warm slot. The refresher
  // retains just the model alias and surface; never the peer's prompt/body.
  if (
    response.ok &&
    currentTeamGrantToken() !== null &&
    planCacheEnabled() &&
    planCacheKey !== null &&
    explicitAlias !== null &&
    planParam !== null
  ) {
    noteTeamPlanServed(planCacheKey, async (): Promise<TPlanTuple | null> => {
      let refreshed: Awaited<ReturnType<typeof fetchPlan>>;
      try {
        refreshed = await fetchPlan(
          explicitAlias,
          0,
          undefined,
          mediaSurface ?? undefined,
        );
      } catch {
        return null;
      }
      const refreshedContextOverflowStrategy =
        refreshed.context_overflow_strategy ?? null;
      const verified = planSignatureOk(
        refreshed.plan,
        refreshed.pmids,
        refreshed.origin,
        refreshedContextOverflowStrategy,
        refreshed.sig,
      );
      const hasDaemonOnlyHop =
        verified &&
        parsePlan(refreshed.plan).some((entry) => {
          const provider = entry.split("/")[0] ?? "";
          return isOAuthSlug(provider) || isLocalServerSlug(provider);
        });
      if (!hasDaemonOnlyHop) return null;
      return {
        planParam: refreshed.plan,
        pmidsParam: refreshed.pmids,
        originParam: refreshed.origin,
        contextOverflowStrategy: refreshedContextOverflowStrategy,
        sigParam: refreshed.sig,
      };
    });
  }
  return withCors(req, response);
};
