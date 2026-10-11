import type {
  TMediaPersistError,
  TModelCaps,
  TVideoDeleted,
  TVideoGenerationRequest,
  TVideoIdPayload,
  TVideoJob,
  TVideoJobStatus,
} from "@openllmsh/protocol";
import {
  aspectRatioFromDimensions,
  decodeVideoId,
  describeAllowed,
  encodeVideoId,
  isAllowedMediaOption,
  isSubscriptionProviderSlug,
  MEDIA_ERROR_RESPONSE_HEADER,
  MEDIA_URL_RESPONSE_HEADER,
  matchDeclaredAspectRatio,
  normalizeContentType,
  parseMediaDimensions,
  parseVideoGenerationInput,
  redactVideoErrorText,
  resolutionFromDimensions,
  VIDEO_INPUT_ERROR,
  VideoGenerationRequest,
  videoInputReceiptFromCounts,
} from "@openllmsh/protocol";
import { originatorHeadersFrom } from "@openllmsh/wire/lib/forwarded-headers";
import { Schema } from "effect";
import type { TUploadMediaDiagnostic } from "./cloud-client";
import { uploadMedia } from "./cloud-client";
import { errorJson } from "./cors";
import { getDelegate } from "./delegation";
import { passthroughToOrigin } from "./forward";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { withMediaAttribution } from "./media-attribution";
import { forwardMediaHopToCloud } from "./media-cloud-forward";
import {
  classifyMediaBuildFailure,
  MEDIA_BUILD_FAILURE_MESSAGE,
  MediaInputError,
  MediaProviderUnavailableError,
} from "./media-input-error";
import { mediaHopAdvances, mediaHttpErrorCode } from "./media-retry";
import type { TWalkArgs } from "./walker";
import {
  coolHopAfterStaleRefresh,
  parsePlan,
  passthroughHeaders,
  planSignatureOk,
  postUpstream,
  report,
  resolveHop,
  statusFor,
} from "./walker";

const parseVideoRequest = Schema.decodeUnknownSync(VideoGenerationRequest);

type TVideoUpstream = {
  readonly headers: Record<string, string>;
  readonly url: string;
  readonly accountHash: string | null;
};

type TXaiVideoStatus = {
  readonly status?: unknown;
  readonly progress?: unknown;
  readonly video?: { readonly url?: unknown };
  readonly error?: { readonly message?: unknown } | string;
};

export const acquireVideoUpstream = async (
  provider: string,
  args: TWalkArgs,
  hop: { readonly provider: string; readonly modelId: string },
  walkSessionKey?: string,
): Promise<TVideoUpstream | "retry"> => {
  const delegate = getDelegate(provider);
  if (delegate?.credentialForVideo === undefined) return "retry";
  try {
    const cred = await delegate.credentialForVideo(args.req.headers);
    if (cred.stale_refresh !== undefined) {
      coolHopAfterStaleRefresh(hop, cred.stale_refresh, walkSessionKey);
      return "retry";
    }
    return {
      headers: {
        ...originatorHeadersFrom(args.req.headers),
        ...cred.headers,
        authorization: `Bearer ${cred.access_token}`,
      },
      url: cred.url.replace(/\/+$/, ""),
      accountHash: cred.account_hash ?? null,
    };
  } catch {
    return "retry";
  }
};

const hopForVideoJob = (
  args: TWalkArgs,
  payload: TVideoIdPayload,
): ReturnType<typeof resolveHop> | undefined => {
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  return parsePlan(args.planParam)
    .map((modelId, index) => resolveHop(modelId, pmids[index]))
    .find(
      (candidate) =>
        candidate.modelId === payload.m && candidate.provider === payload.p,
    );
};

const EMPTY_BODY = new ArrayBuffer(0);

const followVideoJob = async (
  args: TWalkArgs,
  payload: TVideoIdPayload,
): Promise<Response | TVideoUpstream> => {
  if (!isSubscriptionProviderSlug(payload.p)) {
    return passthroughToOrigin(args.req, EMPTY_BODY, { pinModel: payload.m });
  }
  const hop = hopForVideoJob(args, payload);
  if (hop === undefined) {
    return errorJson(403, "Signed plan does not cover this video job");
  }
  const upstream = await acquireVideoUpstream(payload.p, args, hop);
  if (upstream === "retry") {
    return errorJson(404, `No video credential available for ${payload.p}`);
  }
  return upstream;
};

const signedPlanError = (args: TWalkArgs): Response | null => {
  if (
    !planSignatureOk(
      args.planParam,
      args.pmidsParam,
      args.originParam,
      args.contextOverflowStrategy ?? null,
      args.sigParam,
    )
  ) {
    return errorJson(403, "invalid or missing __plan signature");
  }
  if (args.planParam === null)
    return errorJson(400, "videos require a daemon plan");
  return null;
};

const upstreamError = async (resp: Response): Promise<Response> => {
  const body = await resp.text().catch(() => "");
  return new Response(body.length > 0 ? body : null, {
    status: resp.status,
    headers: passthroughHeaders(resp),
  });
};

const responseJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const xaiStatus = (body: unknown): TXaiVideoStatus | null =>
  body !== null && typeof body === "object" ? (body as TXaiVideoStatus) : null;

const errorMessageFrom = (status: TXaiVideoStatus): string | undefined => {
  if (typeof status.error === "string") return status.error;
  return typeof status.error?.message === "string"
    ? status.error.message
    : undefined;
};

const upstreamHeaders = (headers: Record<string, string>): Headers =>
  new Headers({ ...headers, accept: "application/json" });

const videoRequestIdFrom = (body: unknown): string | null => {
  if (body === null || typeof body !== "object") return null;
  const requestId = (body as { readonly request_id?: unknown }).request_id;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : null;
};

/**
 * Raised when a canonical video request has no faithful expression in
 * xAI's declared request domain (`docs.x.ai/openapi.json`,
 * `GenerateVideoRequest`). Nothing is clamped or dropped — the caller
 * is told which values the surface accepts.
 */
export class XaiVideoInputError extends MediaInputError {
  constructor(field: string, message: string) {
    super(field, message);
    this.name = "XaiVideoInputError";
  }
}

/**
 * Derive Grok's `aspect_ratio` from a `WIDTHxHEIGHT` size by reducing the
 * ratio. Only an absent size defaults to `1:1`; a size that reduces to a
 * ratio outside the published enum is refused rather than sent (the
 * upstream would 400 after the request was already billed against the
 * user's account rate limits).
 */
export const videoAspectRatio = (size?: string, caps?: TModelCaps): string => {
  if (size === undefined) return "1:1";
  const parsed = parseMediaDimensions(size);
  if (parsed === null)
    throw new XaiVideoInputError(
      "size",
      `size must use positive WIDTHxHEIGHT dimensions, for example 1280x720; received ${size}.`,
    );
  // Matched by VALUE against the catalog's declared vocabulary, so a
  // size whose gcd spelling differs from the published one still goes
  // through with the caller's framing intact. No declared set means
  // UNKNOWN: the reduced ratio rides through unchallenged.
  const declaredRatios = caps?.mediaVideoAspectRatios;
  if (declaredRatios === undefined) return aspectRatioFromDimensions(parsed);
  const declared = matchDeclaredAspectRatio(declaredRatios, parsed);
  if (declared === null)
    throw new XaiVideoInputError(
      "size",
      `size ${size} implies aspect ratio ${aspectRatioFromDimensions(parsed)}, which this model does not generate. Accepted aspect ratios: ${describeAllowed(declaredRatios)}.`,
    );
  return declared;
};

/** Map xAI's asynchronous video statuses to OpenLLM's job lifecycle. */
export const mapVideoStatus = (status: unknown): TVideoJobStatus => {
  if (status === "done") return "completed";
  if (status === "failed" || status === "expired") return "failed";
  return status === "queued" ? "queued" : "in_progress";
};

/**
 * Select Grok's required output resolution from a WIDTHxHEIGHT size.
 *
 * Validated against the published REQUEST enum (480p / 720p / 1080p)
 * only, so a size whose short edge has no enum value (`1536p` was never
 * one) is reported instead of invented. Which of those a given model
 * actually prices is left to xAI's own rejection — see the note in
 * `media-limits.ts` on why no per-model table gates this.
 */
export const sizeToResolution = (size?: string, caps?: TModelCaps): string => {
  if (size === undefined) return "480p";
  const parsed = parseMediaDimensions(size);
  if (parsed === null)
    throw new XaiVideoInputError(
      "size",
      `size must use positive WIDTHxHEIGHT dimensions, for example 1280x720; received ${size}.`,
    );
  const resolution = resolutionFromDimensions(parsed);
  const allowed = caps?.videoResolutions;
  if (!isAllowedMediaOption(allowed, resolution))
    throw new XaiVideoInputError(
      "size",
      `size ${size} implies resolution ${resolution}, which this model does not generate. Accepted resolutions: ${describeAllowed(allowed ?? [])}.`,
    );
  return resolution;
};

/** Build the provider-native video generation request without performing I/O. */
export const buildVideoUpstreamBody = (
  provider: string,
  req: TVideoGenerationRequest,
  providerModelId: string,
  caps?: TModelCaps,
): Record<string, unknown> => {
  parseVideoGenerationInput(req);
  if (provider !== "grok") {
    throw new MediaProviderUnavailableError(
      `Unsupported subscription video provider: ${provider}`,
    );
  }
  // `duration` is an int32 in [1, 15] (openapi.json
  // `GenerateVideoRequest.duration`). A non-numeric or out-of-range
  // value is reported, never coerced to a string the upstream rejects
  // and never clamped into range on the caller's behalf.
  let duration: number | undefined;
  if (req.seconds !== undefined) {
    const parsedSeconds = Number(req.seconds);
    if (req.seconds.trim() === "" || !Number.isFinite(parsedSeconds))
      throw new XaiVideoInputError(
        "seconds",
        `seconds must be a numeric duration string; received ${req.seconds}.`,
      );
    if (!Number.isInteger(parsedSeconds))
      throw new XaiVideoInputError(
        "seconds",
        `Grok Imagine video durations are whole seconds; received ${req.seconds}.`,
      );
    const range = caps?.mediaVideoDurationRange;
    if (
      range !== undefined &&
      (parsedSeconds < range.min || parsedSeconds > range.max)
    )
      throw new XaiVideoInputError(
        "seconds",
        `This model generates clips from ${range.min} to ${range.max} seconds; received ${req.seconds}. The request is not shortened for you.`,
      );
    const durations = caps?.mediaVideoDurationsSeconds;
    if (
      durations !== undefined &&
      !durations.some((allowed) => allowed === parsedSeconds)
    )
      throw new XaiVideoInputError(
        "seconds",
        `This model generates clips of ${describeAllowed(durations)} seconds; received ${req.seconds}.`,
      );
    duration = parsedSeconds;
  }
  const voiceCount = req.reference_voices?.length ?? 0;
  const maxVoices = caps?.mediaVideoMaxReferenceVoices;
  if (maxVoices !== undefined && voiceCount > maxVoices)
    throw new XaiVideoInputError(
      "reference_voices",
      `This model accepts up to ${maxVoices} reference voices; received ${voiceCount}.`,
    );
  // Voice references are FORWARDED for every Grok video model. The
  // published per-model input modalities say only `-1.5` declares
  // AUDIO, but refusing here would label a vendor model incapable from
  // a table of ours; the transport carries `reference_audios` fine, so
  // the provider's own error is the authority.
  return {
    model: providerModelId,
    prompt: req.prompt,
    ...(req.input_image !== undefined
      ? { image: { url: req.input_image } }
      : {}),
    ...(req.reference_images !== undefined && req.reference_images.length > 0
      ? { reference_images: req.reference_images.map((url) => ({ url })) }
      : {}),
    ...(req.reference_voices !== undefined && req.reference_voices.length > 0
      ? {
          reference_audios: req.reference_voices.map((voice_id) => ({
            voice_id,
          })),
        }
      : {}),
    ...(duration !== undefined ? { duration } : {}),
    aspect_ratio: videoAspectRatio(req.size, caps),
    resolution: sizeToResolution(req.size, caps),
  };
};

const reportVideo = (
  args: TWalkArgs,
  provider: string,
  model: string,
  httpStatus: number,
  accountHash: string | null,
): void => {
  report(
    {
      model,
      provider,
      status: statusFor(httpStatus),
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: Date.now() - args.startedAt,
      endpoint: args.endpoint,
      ...(accountHash !== null ? { account_hash: accountHash } : {}),
    },
    args.originParam,
  );
};

const decodeJob = (videoId: string | undefined): TVideoIdPayload | Response => {
  if (videoId === undefined) return errorJson(404, "No such video");
  const payload = decodeVideoId(videoId);
  return payload ?? errorJson(404, `No such video: ${videoId}`);
};

// Bound a single xAI status GET so a hung upstream can't stall the poll —
// combined with the client's own abort signal (same pattern as cloud-client).
const VIDEO_STATUS_TIMEOUT_MS = 30_000;

// Bound the presigned MP4 download so a hung transfer can't stall indefinitely
// even if the client stays connected. Generous — a Grok clip is ≤15s of video,
// so a real download finishes well inside this.
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

const getStatus = async (
  args: TWalkArgs,
  upstream: TVideoUpstream,
  payload: TVideoIdPayload,
): Promise<Response | TXaiVideoStatus> => {
  let resp: Response;
  try {
    resp = await (args.fetchImpl ?? fetch)(
      `${upstream.url}/videos/${encodeURIComponent(payload.u)}`,
      {
        method: "GET",
        headers: upstreamHeaders(upstream.headers),
        signal: AbortSignal.any([
          args.req.signal,
          AbortSignal.timeout(VIDEO_STATUS_TIMEOUT_MS),
        ]),
      },
    );
  } catch {
    return args.req.signal.aborted
      ? errorJson(499, "client aborted request")
      : errorJson(502, "upstream video provider is unreachable");
  }
  if (!resp.ok) return upstreamError(resp);
  try {
    const body = xaiStatus(await resp.json());
    return (
      body ?? errorJson(502, "upstream video provider returned invalid JSON")
    );
  } catch {
    return errorJson(502, "upstream video provider returned invalid JSON");
  }
};

export const runVideoCreate = async (args: TWalkArgs): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;

  let request: TVideoGenerationRequest;
  try {
    request = parseVideoRequest(parseVideoGenerationInput(args.rawBody));
  } catch {
    return errorJson(400, VIDEO_INPUT_ERROR);
  }
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  const hops = parsePlan(args.planParam).map((modelId, index) =>
    resolveHop(modelId, pmids[index]),
  );
  const attempted: string[] = [];
  const stamp = (resp: Response, resolved?: string): Response =>
    withMediaAttribution(resp, {
      attempted,
      ...(resolved !== undefined ? { resolvedModel: resolved } : {}),
    });
  let lastError: Response | null = null;

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    if (hop === undefined) continue;
    const last = i === hops.length - 1;
    if (!isSubscriptionProviderSlug(hop.provider)) {
      attempted.push(hop.modelId);
      const forwarded = await forwardMediaHopToCloud(args, hop.modelId);
      if (forwarded.ok) return stamp(forwarded, hop.modelId);
      lastError = forwarded;
      if (
        !last &&
        mediaHopAdvances({
          dispatched: true,
          httpStatus: forwarded.status,
          errorCode: mediaHttpErrorCode(forwarded.status),
          accepted: false,
        })
      ) {
        continue;
      }
      return stamp(forwarded);
    }
    const upstream = await acquireVideoUpstream(hop.provider, args, hop);
    if (upstream === "retry") {
      lastError = errorJson(
        404,
        `No video credential available for ${hop.provider}`,
      );
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    attempted.push(hop.modelId);
    let body: Record<string, unknown>;
    try {
      body = buildVideoUpstreamBody(
        hop.provider,
        request,
        hop.providerModelId,
        // Catalog-resolved facts for THIS hop.
        hop.caps,
      );
    } catch (err) {
      const failure = classifyMediaBuildFailure(err);
      if (failure.kind === "unexpected") {
        // Our bug, not the caller's: log the detail, return one
        // sanitized sentence, and do NOT advance — another hop would
        // hit the same code path.
        logWarn(
          "video-walker",
          safeDiagnosticMessage`Failed to build video request`,
          {
            provider: hop.provider,
            model: hop.providerModelId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return stamp(errorJson(500, MEDIA_BUILD_FAILURE_MESSAGE));
      }
      // Both remaining kinds are known BEFORE dispatch, so their own
      // text is safe to return with the field that caused it.
      const errorCode =
        failure.kind === "input" ? "video_input_invalid" : "model_unavailable";
      lastError = errorJson(400, failure.message, errorCode);
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "model_unavailable",
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    const resp = await postUpstream(`${upstream.url}/videos/generations`, {
      method: "POST",
      headers: {
        ...upstream.headers,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: args.req.signal,
    });
    if (resp === null) {
      return stamp(
        args.req.signal.aborted
          ? errorJson(499, "client aborted request")
          : errorJson(502, "upstream video provider is unreachable"),
      );
    }
    if (!resp.ok) {
      reportVideo(
        args,
        hop.provider,
        hop.modelId,
        resp.status,
        upstream.accountHash,
      );
      const rawError = await upstreamError(resp);
      const errorText = redactVideoErrorText(await rawError.text(), [
        request.input_image ?? "",
        ...(request.reference_images ?? []),
        ...(request.reference_voices ?? []),
        ...Object.entries(upstream.headers).flatMap(([key, value]) =>
          /authorization|cookie|token|key/i.test(key)
            ? [value, value.replace(/^(?:Bearer|Basic)\s+/i, "")]
            : [],
        ),
      ]);
      lastError = new Response(errorText, {
        status: rawError.status,
        headers: rawError.headers,
      });
      if (
        !last &&
        mediaHopAdvances({
          dispatched: true,
          httpStatus: resp.status,
          errorCode: mediaHttpErrorCode(resp.status),
          accepted: false,
        })
      ) {
        continue;
      }
      return stamp(lastError);
    }
    let requestId: string | null;
    try {
      requestId = videoRequestIdFrom(await resp.json());
    } catch {
      requestId = null;
    }
    if (requestId === null) {
      return stamp(
        errorJson(502, "upstream video provider returned no request_id"),
      );
    }
    const createdAt = Math.floor(Date.now() / 1000);
    const job: TVideoJob = {
      id: encodeVideoId({
        p: hop.provider,
        u: requestId,
        m: hop.modelId,
        c: createdAt,
      }),
      object: "video",
      created_at: createdAt,
      status: "queued",
      model: hop.modelId,
      progress: 0,
      // Read forwarding evidence from the accepted outbound body, not user intent.
      input_receipt: videoInputReceiptFromCounts({
        starting_images: body.image === undefined ? 0 : 1,
        subject_images: Array.isArray(body.reference_images)
          ? body.reference_images.length
          : 0,
        voices: Array.isArray(body.reference_audios)
          ? body.reference_audios.length
          : 0,
      }),
      ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
      ...(request.size !== undefined ? { size: request.size } : {}),
    };
    reportVideo(
      args,
      hop.provider,
      hop.modelId,
      resp.status,
      upstream.accountHash,
    );
    return stamp(responseJson(job), hop.modelId);
  }
  return stamp(
    lastError ??
      errorJson(
        404,
        "No video provider in the daemon plan can serve this request",
      ),
  );
};

export const runVideoPoll = async (
  args: TWalkArgs,
  videoId?: string,
): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;
  const payload = decodeJob(videoId);
  if (payload instanceof Response) return payload;
  const followed = await followVideoJob(args, payload);
  if (followed instanceof Response) return followed;
  const status = await getStatus(args, followed, payload);
  if (status instanceof Response) return status;
  const errorMessage = errorMessageFrom(status);
  const job: TVideoJob = {
    id: videoId ?? "",
    object: "video",
    created_at: payload.c,
    status: mapVideoStatus(status.status),
    model: payload.m,
    ...(typeof status.progress === "number"
      ? { progress: status.progress }
      : {}),
    ...(errorMessage !== undefined ? { error: { message: errorMessage } } : {}),
  };
  return responseJson(job);
};

export const runVideoContent = async (
  args: TWalkArgs,
  videoId?: string,
): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;
  const payload = decodeJob(videoId);
  if (payload instanceof Response) return payload;
  const followed = await followVideoJob(args, payload);
  if (followed instanceof Response) return followed;
  const status = await getStatus(args, followed, payload);
  if (status instanceof Response) return status;
  if (status.status !== "done") {
    return errorJson(
      409,
      `Video is not ready yet (status: ${typeof status.status === "string" ? status.status : "unknown"}). Poll GET /v1/videos/${videoId} until it completes.`,
    );
  }
  const contentUrl = status.video?.url;
  if (typeof contentUrl !== "string" || contentUrl.length === 0) {
    return errorJson(502, "Completed video has no downloadable content URL");
  }
  let content: Response;
  try {
    // NOT tied to `args.req.signal`: the client (e.g. the browser tool) cancels
    // the response body as soon as it has read the durable-url header, which
    // aborts the inbound request. If this download were bound to that signal the
    // teed persist branch would die mid-flight and nothing would ever land in the
    // library. A timeout alone bounds it so persistence completes regardless.
    content = await (args.fetchImpl ?? fetch)(contentUrl, {
      method: "GET",
      signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    return args.req.signal.aborted
      ? errorJson(499, "client aborted request")
      : errorJson(502, "video download is unreachable");
  }
  if (!content.ok) return upstreamError(content);

  const body = content.body;
  if (body === null) {
    return errorJson(502, "upstream video has no content body");
  }

  const id = videoId;
  if (id === undefined) {
    return errorJson(404, "No such video");
  }
  // This is a video content endpoint, so the payload IS a video. Pin a video
  // content-type when the upstream CDN serves a generic one (e.g.
  // application/octet-stream): the library allowlist keys on the exact type,
  // and the ingest rejects an x-media-kind that disagrees with the content-type
  // — a non-video type would fail-close a legitimate video.
  const rawContentType = normalizeContentType(
    content.headers.get("content-type"),
    "video/mp4",
  );
  const contentType = rawContentType.startsWith("video/")
    ? rawContentType
    : "video/mp4";
  // Persistence is CONFIRMED before the response head, because the media URL
  // header is the only durability evidence the consumer ever gets: the browser
  // tool reads it, cancels the body and settles the job `ready`. Advertising it
  // from a detached upload made a 200 + header mean "a row will probably
  // exist", so an ingest failure became a permanently dead URL on a job nobody
  // polls again (audit M1).
  //
  // Buffering first is not a new cost — the old persist branch already read the
  // whole body into an ArrayBuffer for the upload; the tee only let the client
  // branch drain in parallel. What it does cost is time to first byte for a
  // plain content consumer (curl), which now waits out the cloud upload. That
  // is the price of a truthful header, and the bytes are still served in full.
  //
  // Neither the download nor the upload is tied to `args.req.signal`: a client
  // that walks away mid-flight must not abort persistence — the generation is
  // already paid for. Each hop carries its own timeout instead.
  let bytes: ArrayBuffer;
  try {
    bytes = await new Response(body).arrayBuffer();
  } catch {
    return errorJson(502, "video download failed mid-stream");
  }

  // A collected list rather than a reassigned `let`: TS narrows a variable
  // only ever written inside a callback to its initializer type.
  const failures: Array<TUploadMediaDiagnostic> = [];
  const saved = await uploadMedia(
    bytes,
    {
      contentType,
      kind: "video",
      sourceRef: videoId,
      id,
    },
    args.originParam,
    (diagnostic) => {
      failures.push(diagnostic);
    },
  ).catch((err: unknown) => {
    // `uploadMedia` resolves `null` for every failure it owns, but a caller
    // must not depend on that: an unexpected rejection degrades to the same
    // not-persisted decision rather than escaping as an unhandled error
    // (same posture as `image-walker`).
    logWarn(
      "video-walker",
      safeDiagnosticMessage`Failed to persist generated video`,
      { error: err instanceof Error ? err.message : String(err), videoId },
    );
    return null;
  });

  const responseHeaders: Record<string, string> = {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-openllm-media-id": id,
  };
  if (saved !== null && args.originParam) {
    responseHeaders[MEDIA_URL_RESPONSE_HEADER] =
      `${args.originParam}/api/media/${id}`;
  } else if (saved === null) {
    // Reason only — no URL, no status, no bytes. This is what lets the
    // consumer separate "persistence failed" from "this responder does not
    // advertise durability" (an older daemon sends neither header).
    const diagnostic = failures[0];
    const reason: TMediaPersistError = diagnostic?.reason ?? "ingest_failed";
    responseHeaders[MEDIA_ERROR_RESPONSE_HEADER] = reason;
    logWarn(
      "video-walker",
      safeDiagnosticMessage`Generated video was not persisted to the library`,
      {
        reason,
        ...(diagnostic?.status === undefined
          ? {}
          : { status: diagnostic.status }),
        videoId,
      },
    );
  }

  return new Response(bytes, {
    status: 200,
    headers: responseHeaders,
  });
};

export const runVideoCancel = async (
  args: TWalkArgs,
  videoId?: string,
): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;
  const payload = decodeJob(videoId);
  if (payload instanceof Response) return payload;
  const followed = await followVideoJob(args, payload);
  if (!(followed instanceof Response)) {
    await fetch(`${followed.url}/videos/${encodeURIComponent(payload.u)}`, {
      method: "DELETE",
      headers: upstreamHeaders(followed.headers),
      signal: AbortSignal.any([
        args.req.signal,
        AbortSignal.timeout(VIDEO_STATUS_TIMEOUT_MS),
      ]),
    }).catch(() => {});
  }
  const deleted: TVideoDeleted = {
    id: videoId ?? "",
    object: "video.deleted",
    deleted: true,
  };
  return responseJson(deleted);
};
