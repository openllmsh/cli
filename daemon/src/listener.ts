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
 * Loopback callers supply a bearer for cloud authorization; tunneled requests
 * have already passed their transport's authorization.
 */

import { createHash } from "node:crypto";
import type { TContextOverflowStrategy } from "@openllmsh/sdk/protocol";
import {
  AnthropicCountTokensRequest,
  AnthropicRequest,
  ChatCompletionRequest,
  cooldownPolicyFor,
  decodeVideoId,
  HOP_GRANT_HEADER,
  ImageGenerationInput,
  ImageGenerationRequest,
  isLocalKeyProviderSlug,
  parseImageEditInput,
  parseImageEditMultipart,
  parseVideoGenerationInput,
  ResponsesRequest,
} from "@openllmsh/sdk/protocol";
import {
  collectBoundedBytes,
  TUNNEL_MEDIA_MAX_BODY_BYTES,
} from "@openllmsh/sdk/tunnel";
import {
  resolveContextOverflowStrategy,
  shouldDemoteOnContextOverflow,
} from "@openllmsh/sdk/wire/features/context-overflow-strategy";
import { estimateBodyTokens } from "@openllmsh/sdk/wire/lib/canonical/token-estimate";
import { Schema } from "effect";
import { waitForHoldRecords, withHoldNonce } from "./access-hold-context";
import {
  runAudioSpeechWalker,
  runAudioTranscriptionWalker,
} from "./audio-walker";
import { withRequestClient } from "./client-request-context";
import {
  fetchMediaDefaultPlan,
  fetchPlan,
  fetchVideoJobPlan,
  MediaDefaultPlanError,
} from "./cloud-client";
import {
  contextOverflowStrategy as bootstrapContextOverflowStrategy,
  planCacheEnabled,
} from "./config";
import { notePresenceActivity } from "./control-channel";
import { corsHeaders, errorJson, isPreflight, preflightResponse } from "./cors";
import { resolveLoopbackCallerKey } from "./credential-gate";
import { isOAuthSlug } from "./delegation";
import { runEmbeddings } from "./embeddings-walker";
import { forwardToCloud, passthroughToOrigin } from "./forward";
import {
  HoldSession,
  inferenceAdmission,
  withHoldSession,
} from "./hold-session";
import { runImageEditWalker, runImageWalker } from "./image-walker";
import { isLocalServerSlug } from "./local-servers";
import { logWarn, safeDiagnosticMessage } from "./logger";
import {
  buildMediaDefaultRequest,
  localChatAliasMediaRefusal,
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
  currentPolicyEpoch,
  currentPolicyRevision,
  loadPlanWithShared,
  lookupPlan,
  noteTeamPlanServed,
  observePolicyRevision,
  planNeedsRefresh,
} from "./plan-cache";
import { isTeamHop, tryDirectTeamLeg } from "./team-leg-client";
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
  classifyPrecommitResponse,
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

export const handleInference = async (
  req: Request,
  direct = false,
): Promise<Response> => {
  return inferenceAdmission.run(req, (admitted) => {
    const url = new URL(admitted.url);
    const session = new HoldSession(
      url.pathname.replace(/^\/api(?=\/v1\/)/, ""),
      Date.now(),
      inferenceAdmission.signal,
    );
    // A tunneled request (`direct === false`) carries the client origin
    // derived; the loopback surface derives its own from the headers.
    return withRequestClient(
      admitted,
      () =>
        withHoldSession(session, () =>
          handleInferenceIn(admitted, session, direct),
        ),
      !direct,
    );
  });
};

const handleInferenceIn = async (
  inbound: Request,
  session: HoldSession,
  direct: boolean,
): Promise<Response> => {
  // CORS/PNA preflight — the dashboard fetches this surface cross-origin
  // (HTTPS page → http://127.0.0.1) for subscription models.
  if (isPreflight(inbound)) return preflightResponse(inbound);

  const hopGrant = direct ? null : inbound.headers.get(HOP_GRANT_HEADER);
  const teamGrantToken = currentTeamGrantToken();
  let callerKey: string | undefined;
  let req = inbound;
  if (direct) {
    // Loopback only: a keyless or placeholder bearer runs as the saved key.
    const resolved = resolveLoopbackCallerKey(
      inbound.headers.get("authorization"),
    );
    if (!resolved.ok) {
      return withCors(inbound, errorJson(401, resolved.message, "auth_error"));
    }
    callerKey = resolved.key;
    // Every passthrough forwards the inbound header, so replace it: a
    // placeholder bearer must never reach the cloud.
    const headers = new Headers(inbound.headers);
    headers.set("authorization", `Bearer ${callerKey}`);
    req = new Request(inbound, { headers });
  }

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
    if (hopGrant !== null) {
      return withCors(
        req,
        errorJson(502, "Granted plan is unavailable", "plan_error"),
      );
    }
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
    isEmbeddings,
  });
  const modelField = modelFieldFromRequest(rawBody, multipart);
  // Invalid `model` types are only a media-default concern. Compact and
  // other non-media surfaces keep their existing parsers (compact is a
  // verbatim vendor passthrough).
  if (mediaSurface !== null && modelField.kind === "invalid") {
    return withCors(req, errorJson(400, "Invalid request body"));
  }
  // Built-in chat tier aliases on a media surface are refused locally —
  // same code the plan endpoint returns — so a round trip is not required.
  if (mediaSurface !== null) {
    const refusal = localChatAliasMediaRefusal(mediaSurface, modelField);
    if (refusal !== null) {
      return withCors(
        req,
        errorJson(400, refusal.message, refusal.code, refusal.code),
      );
    }
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
  // A request origin tunneled with a hop grant is bound to one cap
  // reservation: its plan is never read from or written to the shared cache.
  const callerIdentity =
    callerKey === undefined
      ? "team-device"
      : createHash("sha256").update(callerKey).digest("hex");
  const planCacheKey =
    explicitAlias === null || hopGrant !== null || isResponsesCompact
      ? null
      : JSON.stringify([callerIdentity, mediaSurface ?? "chat", explicitAlias]);
  // Set when the cloud bound this request's plan to a cap hold; the walk then
  // runs inside `withHoldNonce` so signatures verify and records settle it.
  let holdNonce: string | null = null;
  let maxOutputTokens: number | null = null;
  // A single cloud hop can be a capped plan without a daemon hold: origin
  // reserves and settles its own hold when the pinned request arrives.
  let singleCloudHop = false;
  // Hops a capped direct request already failed on; the cloud skips them
  // when it reserves the next one.
  const excludedHops: string[] = [];
  // Set inside the explicit-model plan block: reserves the next hop for a
  // capped direct request after the held one failed.
  let reserveNextHop: (() => Promise<Response | null>) | null = null;
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

  const grantedPlanUnavailable = (): Response =>
    withCors(req, errorJson(502, "Granted plan is unavailable", "plan_error"));

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
    if (hopGrant !== null) {
      if (err instanceof Error && err.message === "plan fetch failed: 403") {
        return withCors(
          req,
          errorJson(403, "Hop grant rejected", "access_limit"),
        );
      }
      return grantedPlanUnavailable();
    }
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
    isResponsesCompact &&
    !direct &&
    hopGrant === null &&
    !explicitAlias?.startsWith("chatgpt/")
  ) {
    // Origin supplies the caller-authorized, provider-qualified hop.
    return withCors(
      req,
      errorJson(
        403,
        "Compact requires an authorized ChatGPT model",
        "plan_error",
      ),
    );
  }
  if (isResponsesCompact && explicitAlias === null) {
    return withCors(
      req,
      errorJson(400, "Compact requires a model", "plan_error"),
    );
  }
  if (
    (planParam === null ||
      (planCacheEnabled() &&
        planCacheKey !== null &&
        planNeedsRefresh(planCacheKey))) &&
    explicitAlias !== null
  ) {
    type TPlanFetchOutcome =
      | {
          readonly kind: "tuple";
          readonly tuple: TPlanTuple;
          readonly holdNonce: string | null;
          readonly maxOutputTokens: number | null;
          readonly singleCloudHop: boolean;
        }
      | { readonly kind: "passthrough" }
      | { readonly kind: "response"; readonly response: Response }
      | { readonly kind: "throw"; readonly error: unknown };

    const resolveFetched = async (
      /**
       * Shared flights use the shutdown signal rather than a caller's signal,
       * so one caller cannot abort other waiters.
       */
      signal: AbortSignal | undefined,
      background = false,
    ): Promise<TPlanFetchOutcome> => {
      const epoch = currentPolicyEpoch(callerIdentity);
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
          {
            ...(hopGrant === null ? { callerKey } : { hopGrant }),
            exclude: excludedHops,
            refresh: background,
          },
        );
      } catch (err) {
        if (
          excludedHops.length > 0 &&
          err instanceof Error &&
          err.message === "plan fetch failed: 410"
        ) {
          return {
            kind: "response",
            response: errorJson(410, "Plan chain exhausted", "plan_exhausted"),
          };
        }
        const outcome = handlePlanFetchError(err, explicitAlias, signal);
        if (outcome === "throw") return { kind: "throw", error: err };
        if (outcome !== "passthrough") {
          return { kind: "response", response: outcome };
        }
        return { kind: "passthrough" };
      }
      if (fetched === null) return { kind: "passthrough" };
      if (epoch !== currentPolicyEpoch(callerIdentity)) {
        // Held plans select exactly one model. Refund at the same configured
        // cloud that issued the plan, without trusting its unverified origin.
        // The session's terminal record settles it at 0 (nothing ran).
        if (fetched.hold_nonce !== undefined)
          session.adopt(
            fetched.hold_nonce,
            parsePlan(fetched.plan)[0] ?? fetched.plan,
            null,
          );
        return {
          kind: "response",
          response: withCors(
            req,
            errorJson(
              409,
              "Plan superseded by a policy change; retry",
              "plan_error",
            ),
          ),
        };
      }
      const fetchedContextOverflowStrategy =
        fetched.context_overflow_strategy ?? null;
      const fetchedHoldNonce = fetched.hold_nonce ?? null;
      const fetchedMaxOutputTokens = fetched.max_output_tokens ?? null;
      if (isResponsesCompact && fetchedHoldNonce !== null) {
        session.adopt(
          fetchedHoldNonce,
          parsePlan(fetched.plan)[0] ?? fetched.plan,
          null,
        );
        return {
          kind: "response",
          response: withCors(
            req,
            errorJson(
              403,
              "Compact is unavailable for capped keys",
              "plan_error",
            ),
          ),
        };
      }
      const verified = planSignatureOk(
        fetched.plan,
        fetched.pmids,
        fetched.origin,
        fetchedContextOverflowStrategy,
        fetched.sig,
        fetchedHoldNonce,
        fetchedMaxOutputTokens,
      );
      if (verified) observePolicyRevision(fetched.policy_rev, callerIdentity);
      const hasDaemonOnlyHop =
        verified &&
        parsePlan(fetched.plan).some((entry) => {
          const provider = entry.split("/")[0] ?? "";
          // A team hop is dialled from here (direct leg); origin would never
          // tunnel the forwarded request to the supplier.
          if (isTeamHop({ modelId: entry })) return true;
          return (
            isOAuthSlug(provider) ||
            isLocalServerSlug(provider) ||
            isLocalKeyProviderSlug(provider)
          );
        });
      const singleCloud =
        verified &&
        !hasDaemonOnlyHop &&
        direct &&
        hopGrant === null &&
        !isResponsesCompact &&
        parsePlan(fetched.plan).length === 1;
      if (!verified || (!hasDaemonOnlyHop && !singleCloud)) {
        return { kind: "passthrough" };
      }
      if (isResponsesCompact && !direct) {
        const models = parsePlan(fetched.plan);
        if (models.length !== 1 || models[0] !== explicitAlias) {
          return {
            kind: "response",
            response: withCors(
              req,
              errorJson(
                403,
                "Compact plan does not match the authorized model",
                "plan_error",
              ),
            ),
          };
        }
      }
      return {
        kind: "tuple",
        tuple: {
          planParam: fetched.plan,
          pmidsParam: fetched.pmids,
          originParam: fetched.origin,
          contextOverflowStrategy: fetchedContextOverflowStrategy,
          sigParam: fetched.sig,
          policyRev:
            fetched.policy_rev ?? currentPolicyRevision(callerIdentity),
        },
        holdNonce: fetchedHoldNonce,
        maxOutputTokens: fetchedMaxOutputTokens,
        singleCloudHop: singleCloud,
      };
    };

    const forwardTeamOrOrigin = async (): Promise<Response> => {
      // A grant binds this request to its claimed hold; never substitute the
      // device's credential if a plan cannot be used.
      if (hopGrant !== null) return grantedPlanUnavailable();
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
        callerKey,
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
        holdNonce = outcome.holdNonce;
        singleCloudHop = outcome.singleCloudHop;
        if (holdNonce !== null)
          session.adopt(
            holdNonce,
            parsePlan(outcome.tuple.planParam)[0] ?? outcome.tuple.planParam,
            outcome.tuple.originParam,
          );
        maxOutputTokens = outcome.maxOutputTokens;
        planParam = outcome.tuple.planParam;
        pmidsParam = outcome.tuple.pmidsParam;
        originParam = outcome.tuple.originParam;
        contextOverflowStrategy = outcome.tuple.contextOverflowStrategy;
        sigParam = outcome.tuple.sigParam;
        return null;
      }
      if (isResponsesCompact) {
        return withCors(
          req,
          errorJson(502, "Compact plan unavailable", "plan_error"),
        );
      }
      syncNormalizedJsonBytes();
      return withCors(req, await forwardTeamOrOrigin());
    };

    if (hopGrant === null) {
      reserveNextHop = async (): Promise<Response | null> =>
        applyPlanFetchOutcome(await resolveFetched(req.signal));
    }

    if (planCacheEnabled() && planCacheKey !== null) {
      let ledFlight = false;
      const { entry, shared } = await loadPlanWithShared<TPlanFetchOutcome>(
        planCacheKey,
        async (background) => {
          ledFlight = true;
          // Shared across callers, but cancelled when the daemon shuts down.
          const outcome = await resolveFetched(
            inferenceAdmission.signal,
            background,
          );
          // A held plan is bound to one reservation: never cache it.
          if (
            outcome.kind === "tuple" &&
            outcome.holdNonce === null &&
            !outcome.singleCloudHop
          ) {
            return { store: outcome.tuple, shared: outcome };
          }
          return { store: null, shared: outcome };
        },
      );
      if (shared !== null) {
        // A waiter that joined someone else's held flight reserves its own.
        const own =
          !ledFlight && shared.kind === "tuple" && shared.holdNonce !== null
            ? await resolveFetched(req.signal)
            : shared;
        const applied = await applyPlanFetchOutcome(own);
        if (applied !== null) return applied;
      } else if (entry !== null) {
        // Soft-stale immediate serve (background refresh still running).
        planParam = entry.planParam;
        pmidsParam = entry.pmidsParam;
        originParam = entry.originParam;
        contextOverflowStrategy = entry.contextOverflowStrategy;
        sigParam = entry.sigParam;
      } else if (planParam === null) {
        syncNormalizedJsonBytes();
        return withCors(req, await forwardTeamOrOrigin());
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
    const epoch = currentPolicyEpoch(callerIdentity);
    let fetched: Awaited<ReturnType<typeof fetchMediaDefaultPlan>> | null =
      null;
    try {
      fetched = await fetchMediaDefaultPlan(
        mediaRequest,
        req.signal,
        hopGrant ?? undefined,
        hopGrant === null ? callerKey : undefined,
      );
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
    holdNonce = fetched.hold_nonce ?? null;
    if (holdNonce !== null)
      session.adopt(
        holdNonce,
        parsePlan(fetched.plan)[0] ?? fetched.plan,
        null,
      );
    if (epoch !== currentPolicyEpoch(callerIdentity)) {
      return withCors(
        req,
        errorJson(
          409,
          "Plan superseded by a policy change; retry",
          "plan_error",
        ),
      );
    }
    const fetchedContextOverflowStrategy =
      fetched.context_overflow_strategy ?? null;
    maxOutputTokens = fetched.max_output_tokens ?? null;
    const verified = planSignatureOk(
      fetched.plan,
      fetched.pmids,
      fetched.origin,
      fetchedContextOverflowStrategy,
      fetched.sig,
      holdNonce,
      maxOutputTokens,
    );
    if (!verified) {
      return withCors(req, errorJson(403, "invalid or missing plan signature"));
    }
    observePolicyRevision(fetched.policy_rev, callerIdentity);
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
    const epoch = currentPolicyEpoch(callerIdentity);
    let fetched: Awaited<ReturnType<typeof fetchVideoJobPlan>> | null = null;
    try {
      fetched = await fetchVideoJobPlan(
        {
          model: payload.m,
          provider: payload.p,
          upstream_id: payload.u,
          created_at: payload.c,
          sig: payload.s,
        },
        req.signal,
        hopGrant ?? undefined,
        hopGrant === null ? callerKey : undefined,
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
    holdNonce = fetched.hold_nonce ?? null;
    if (holdNonce !== null)
      session.adopt(
        holdNonce,
        parsePlan(fetched.plan)[0] ?? fetched.plan,
        null,
      );
    if (epoch !== currentPolicyEpoch(callerIdentity)) {
      return withCors(
        req,
        errorJson(
          409,
          "Plan superseded by a policy change; retry",
          "plan_error",
        ),
      );
    }
    const fetchedContextOverflowStrategy =
      fetched.context_overflow_strategy ?? null;
    maxOutputTokens = fetched.max_output_tokens ?? null;
    const verified = planSignatureOk(
      fetched.plan,
      fetched.pmids,
      fetched.origin,
      fetchedContextOverflowStrategy,
      fetched.sig,
      holdNonce,
      maxOutputTokens,
    );
    if (!verified) {
      return withCors(req, errorJson(403, "invalid or missing plan signature"));
    }
    observePolicyRevision(fetched.policy_rev, callerIdentity);
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

  const walkOnce = (): Promise<Response> => {
    const walkArgs = {
      req: walkReq,
      callerKey: hopGrant === null ? callerKey : undefined,
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
    return videoOperation === "create"
      ? runVideoCreate(walkArgs)
      : videoOperation === "poll"
        ? runVideoPoll(walkArgs, videoId)
        : videoOperation === "content"
          ? runVideoContent(walkArgs, videoId)
          : videoOperation === "cancel"
            ? runVideoCancel(walkArgs, videoId)
            : isResponsesCompact
              ? runResponsesCompact(walkArgs, true)
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
                          : runWalker(walkArgs);
  };
  // Hop paths log failed attempts without the nonce; the session's terminal
  // record finalizes each hold exactly once (hold-session.ts).
  const walk = (): Promise<Response> => {
    if (!session.canDispatch(req.signal, inferenceAdmission))
      return Promise.resolve(
        withCors(req, errorJson(503, "daemon shutting down", "unavailable")),
      );
    if (singleCloudHop && planParam !== null) {
      // Origin authenticates the caller and owns this hop's reservation;
      // no daemon hold is used or charged for the forward.
      return forwardToCloud(
        walkReq,
        rawBytes,
        planParam,
        originParam,
        callerKey,
      );
    }
    const outcome = session.outcome;
    if (holdNonce === null || outcome === null) return walkOnce();
    return withHoldNonce(holdNonce, walkOnce, maxOutputTokens, outcome);
  };
  let response = await walk();
  let overflowResponse: Response | null = null;
  // A capped key's direct request holds one hop at a time. When that hop
  // fails, reserve the next one (the failed hop's record refunds its hold)
  // instead of giving up; origin-tunneled requests fall back on origin.
  while (
    (holdNonce !== null || singleCloudHop) &&
    reserveNextHop !== null &&
    planParam !== null &&
    !response.ok
  ) {
    const raw = await response
      .clone()
      .text()
      .catch(() => "");
    const cls = classifyPrecommitResponse(
      response.status,
      raw,
      "openai",
      req.signal.aborted,
      planParam?.split("/")[0],
    );
    if (
      cls.kind === "abort" ||
      cooldownPolicyFor(cls.reason).action === "surface"
    )
      break;
    const overflow = cls.reason === "context_overflow";
    if (
      overflow &&
      !shouldDemoteOnContextOverflow(
        resolveContextOverflowStrategy(
          contextOverflowStrategy ?? bootstrapContextOverflowStrategy(),
        ),
      )
    )
      break;
    if (excludedHops.includes(planParam)) break;
    if (overflow && overflowResponse === null)
      overflowResponse = new Response(raw, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    excludedHops.push(planParam);
    session.finish();
    if (holdNonce !== null) await waitForHoldRecords(holdNonce);
    const stopped = await reserveNextHop();
    if (stopped !== null) {
      if (stopped.status === 410)
        return withCors(req, overflowResponse ?? response);
      await response.body?.cancel().catch(() => undefined);
      return stopped;
    }
    if (planParam === null || excludedHops.includes(planParam)) {
      session.finish();
      return withCors(req, response);
    }
    await response.body?.cancel().catch(() => undefined);
    response = await walk();
  }

  // Only a successful team-tunnel response earns a warm slot. The refresher
  // retains just the model alias and surface; never the peer's prompt/body.
  if (
    response.ok &&
    holdNonce === null &&
    teamGrantToken !== null &&
    callerKey === undefined &&
    planCacheEnabled() &&
    planCacheKey !== null &&
    explicitAlias !== null &&
    planParam !== null
  ) {
    noteTeamPlanServed(planCacheKey, async (): Promise<TPlanTuple | null> => {
      const epoch = currentPolicyEpoch(callerIdentity);
      let refreshed: Awaited<ReturnType<typeof fetchPlan>>;
      try {
        refreshed = await fetchPlan(
          explicitAlias,
          0,
          undefined,
          mediaSurface ?? undefined,
          { refresh: true },
        );
      } catch {
        return null;
      }
      if (epoch !== currentPolicyEpoch(callerIdentity)) return null;
      // A held plan is bound to a reservation; it is never kept warm.
      if (refreshed.hold_nonce !== undefined) return null;
      const refreshedContextOverflowStrategy =
        refreshed.context_overflow_strategy ?? null;
      const verified = planSignatureOk(
        refreshed.plan,
        refreshed.pmids,
        refreshed.origin,
        refreshedContextOverflowStrategy,
        refreshed.sig,
      );
      if (verified) observePolicyRevision(refreshed.policy_rev, callerIdentity);
      const hasDaemonOnlyHop =
        verified &&
        parsePlan(refreshed.plan).some((entry) => {
          const provider = entry.split("/")[0] ?? "";
          return (
            isOAuthSlug(provider) ||
            isLocalServerSlug(provider) ||
            isLocalKeyProviderSlug(provider)
          );
        });
      if (!hasDaemonOnlyHop) return null;
      return {
        planParam: refreshed.plan,
        pmidsParam: refreshed.pmids,
        originParam: refreshed.origin,
        contextOverflowStrategy: refreshedContextOverflowStrategy,
        sigParam: refreshed.sig,
        policyRev:
          refreshed.policy_rev ?? currentPolicyRevision(callerIdentity),
      };
    });
  }
  return withCors(req, response);
};
