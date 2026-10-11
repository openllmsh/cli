/**
 * The daemon's local `/v1/*` inference surface. Mirrors the cloud's
 * OpenAI/Anthropic-compatible endpoints, served LOCALLY by the
 * `@openllm/core`-free `walker.ts` (subscription hops run on the official
 * CLI's credential; API-key hops are forwarded to the cloud).
 *
 * Single flow: a client points at the gateway, the gateway 307s a
 * subscription-involving chain here with the resolved `?__plan=`, and the
 * walker executes that plan. The daemon holds NO routing brain of its own
 * — without a `?__plan=` there is nothing to walk, so it answers 400
 * (there is no legacy "daemon resolves its own chain" path).
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
import { isSubscriptionSlug } from "./delegation";
import { passthroughToOrigin } from "./forward";
import { runImageEditWalker, runImageWalker } from "./image-walker";
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
import { lookupPlan, storePlan } from "./plan-cache";
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
const parseResponsesRequest = Schema.decodeUnknownSync(ResponsesRequest);
const parseCountTokensRequest = Schema.decodeUnknownSync(
  AnthropicCountTokensRequest,
);

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

const contextOverflowStrategyParam = (
  raw: string | null,
): TContextOverflowStrategy | null =>
  raw === "compact_in_place" ? "compact_in_place" : null;

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
        rawBody = parseImageInput(rawBody, { onExcessProperty: "preserve" });
        normalizedJsonBody = true;
      }
    } else if (isImageEdits) {
      // no-op — structural validation above; concrete decode after plan.
    } else if (isTranscriptions || isSpeech) {
      // no-op — the audio walker validates its own shape (either JSON or
      // multipart for transcriptions; JSON-only for speech).
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
  if (normalizedJsonBody && multipart === null) {
    const encoded = new TextEncoder().encode(JSON.stringify(rawBody));
    rawBytes = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
  }

  // Signed-plan cache (flag-gated rider — `plan-cache.ts`). A 307-borne
  // request remembers its signed tuple per model alias; a DIRECT request
  // (no `?__plan=`) within the TTL replays it, skipping the cloud round
  // trip. The walker verifies the signature either way, so the flag being
  // off (or a cache miss) is exactly the pre-rider flow: no plan → the
  // walker's clean 400.
  //
  // A tuple enters the cache ONLY after the same signature check the walker
  // enforces (unsigned accepted only in no-key dev mode), so a forged or
  // tampered tuple can never overwrite an entry. Residual scope, accepted:
  // the alias is NOT inside the signed payload (adding it would change the
  // canonical payload and fail-close every already-deployed daemon), so a
  // LOOPBACK caller could pair a genuinely-signed tuple with a different
  // `model` in the body — but this surface is 127.0.0.1 with the caller
  // owning the machine (see the module doc: no auth gate), and such a
  // caller can already address the daemon/cloud arbitrarily as themselves.
  let planParam = url.searchParams.get("__plan");
  let pmidsParam = url.searchParams.get("__pmids");
  let originParam = url.searchParams.get("__origin");
  let contextOverflowStrategy = contextOverflowStrategyParam(
    url.searchParams.get("__context_overflow_strategy"),
  );
  let sigParam = url.searchParams.get("__sig");
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
  // depends on surface/options and current availability.
  if (planCacheEnabled() && planCacheKey !== null) {
    if (planParam !== null) {
      if (
        planSignatureOk(
          planParam,
          pmidsParam,
          originParam,
          contextOverflowStrategy,
          sigParam,
        )
      ) {
        storePlan(planCacheKey, {
          planParam,
          pmidsParam,
          originParam,
          contextOverflowStrategy,
          sigParam,
        });
      }
    } else {
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

  const rejectUnverifiedRedirect = (): Response =>
    withCors(req, errorJson(403, "invalid or missing __plan signature"));

  // 307-borne: verify the signed tuple BEFORE deriving a missing model or
  // running required-model decode. Unsigned/tampered plans never authorize
  // inference; an explicit caller model is never rewritten.
  if (planParam !== null && explicitAlias === null && mediaSurface !== null) {
    if (
      !planSignatureOk(
        planParam,
        pmidsParam,
        originParam,
        contextOverflowStrategy,
        sigParam,
      )
    ) {
      return rejectUnverifiedRedirect();
    }
    const materialized = await materializeFromVerifiedPlan(planParam);
    if (materialized !== null) return withCors(req, materialized);
  }

  const handlePlanFetchError = (
    err: unknown,
    label: string,
  ): Response | "passthrough" | "throw" => {
    const decision = planFetchFailureAction(err, req.signal);
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

  // Local-first gateway (docs/proposals/local-first-gateway.md): a DIRECT
  // request (no `?__plan=` — the client's base URL is the daemon, baked at
  // install time by a `--gateway local` setup) that the plan cache didn't
  // cover. Fetch a signed plan from the origin (body never transits the
  // cloud), verify it with the SAME per-user key a 307 is verified with,
  // and walk it locally when it contains at least one subscription hop; a
  // pure-BYOK plan (and a failed fetch) passes through to the origin
  // verbatim — the cloud keeps its own fallback/cooldown machinery,
  // byte-identical to a directly-pointed client. 307-borne requests are
  // untouched by this branch.
  if (planParam === null && !isResponsesCompact && explicitAlias !== null) {
    let fetched: Awaited<ReturnType<typeof fetchPlan>> | null = null;
    try {
      fetched = await fetchPlan(
        explicitAlias,
        estimateBodyTokens(rawBody),
        req.signal,
        // The surface this request is FOR — already decided by the path
        // above. Sending it is what stops an ambiguous family name from
        // being planned on the wrong surface: `model=grok` posted to
        // `/v1/images/generations` must plan grok's IMAGE model, not the
        // chat one the cloud's chat default would pick. `null` (a chat or
        // compact request) omits it and keeps the historical default.
        mediaSurface ?? undefined,
      );
    } catch (err) {
      const outcome = handlePlanFetchError(err, explicitAlias);
      if (outcome === "throw") throw err;
      if (outcome !== "passthrough") return outcome;
    }
    if (fetched === null) {
      return withCors(req, await passthroughToOrigin(req, rawBytes));
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
    const hasSubscriptionHop =
      verified &&
      parsePlan(fetched.plan).some((entry) =>
        isSubscriptionSlug(entry.split("/")[0] ?? ""),
      );
    if (!verified || !hasSubscriptionHop) {
      return withCors(req, await passthroughToOrigin(req, rawBytes));
    }
    planParam = fetched.plan;
    pmidsParam = fetched.pmids;
    originParam = fetched.origin;
    contextOverflowStrategy = fetchedContextOverflowStrategy;
    sigParam = fetched.sig;
    if (planCacheEnabled() && planCacheKey !== null) {
      storePlan(planCacheKey, {
        planParam,
        pmidsParam,
        originParam,
        contextOverflowStrategy,
        sigParam,
      });
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
          `media default plan ${err.status} ${err.type} — not forwarding media`,
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
      // a paid model under NO_DAEMON. Explicit-model failures still
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
      return withCors(
        req,
        errorJson(403, "invalid or missing __plan signature"),
      );
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

  // Mux GET video retrieve/content has no body and no ?__plan=. Decode the
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
      return withCors(
        req,
        errorJson(403, "invalid or missing __plan signature"),
      );
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
  return withCors(
    req,
    await (videoOperation === "create"
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
                        : runWalker(walkArgs)),
  );
};
