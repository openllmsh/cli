import type {
  TImageEditRequest,
  TImageGenerationRequest,
  TImageGenerationResponse,
  TMediaOptionIssue,
  TModelCaps,
} from "@openllmsh/protocol";
import {
  aspectRatioFromDimensions,
  base64ToBytes,
  describeAllowed,
  ImageGenerationRequest,
  ImageGenerationResponse,
  isAllowedMediaOption,
  matchDeclaredAspectRatio,
  mediaOptionRejection,
  normalizeContentType,
  parseImageEditInput,
  parseMediaDimensions,
  resolutionTierForLongEdge,
  unsupportedParamIssue,
} from "@openllmsh/protocol";
import { inspectImageBytes } from "@openllmsh/wire/lib/canonical/image-signature";
import {
  completedEventFromFinalImage,
  encodeImageSseEvent,
} from "@openllmsh/wire/lib/canonical/image-sse";
import { originatorHeadersFrom } from "@openllmsh/wire/lib/forwarded-headers";
import { Schema } from "effect";
import { uploadMedia } from "./cloud-client";
import { errorJson } from "./cors";
import { getDelegate, isSubscriptionSlug } from "./delegation";
import type { TImageCredential } from "./delegation/types";
import {
  buildImageEditUpstreamBody,
  ImageProviderUnavailableError,
  isSupportedImageEditReference,
} from "./image-edit-wire";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { withMediaAttribution } from "./media-attribution";
import { forwardMediaHopToCloud } from "./media-cloud-forward";
import {
  classifyMediaBuildFailure,
  MEDIA_BUILD_FAILURE_MESSAGE,
  MediaInputError,
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

const parseImageRequest = Schema.decodeUnknownSync(ImageGenerationRequest);
const parseImageResponse = Schema.decodeUnknownSync(ImageGenerationResponse);

type TImageUpstream = {
  readonly headers: Record<string, string>;
  readonly url: string;
  readonly accountHash: string | null;
};

// `url` is optional: the b64-only fallback below (storage unavailable, caller
// explicitly asked for inline bytes) returns a data item with no hosted URL
// at all — never the vendor's own (possibly private/signed) URL, which this
// walker never forwards to the client in any code path.
type TImageDataItem = {
  readonly url?: string;
  readonly revised_prompt?: string;
  readonly b64_json?: string;
};

/** Runtime-agnostic bytes → base64 encoder (the inverse of `base64ToBytes`).
 *  The daemon already depends on `node:buffer`'s `Buffer` throughout
 *  (`keypair.ts`, `credential-gate.ts`, …), so this stays a plain local
 *  helper rather than a new protocol export. */
const bytesToBase64 = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString("base64");

const toUint8Array = (bytes: ArrayBuffer | Uint8Array): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

export const persistImageDataItem = async (
  item: TImageGenerationResponse["data"][number],
  includeBase64: boolean,
  args: TWalkArgs,
): Promise<TImageDataItem> => {
  let bytes: ArrayBuffer | Uint8Array;
  let contentType = "image/png";

  if (item.b64_json !== undefined) {
    bytes = base64ToBytes(item.b64_json);
    // Sniff the real bytes rather than trusting the vendor's declared
    // format: a subscription bridge has been observed returning JPEG bytes
    // where the wire contract implied PNG (see
    // `wire/lib/canonical/image-signature.ts`). Unrecognized bytes keep the
    // historical "image/png" default — generation output that fails to
    // sniff is not necessarily malformed (a format `inspectImageBytes`
    // doesn't parse), so it is still persisted, just under the fallback
    // label it always used.
    const inspected = inspectImageBytes(bytes);
    if (inspected !== null) contentType = inspected.mime;
  } else if (item.url !== undefined && item.url.length > 0) {
    const image = await (args.fetchImpl ?? fetch)(item.url, {
      method: "GET",
      signal: AbortSignal.timeout(30_000),
    });
    if (!image.ok) {
      throw new Error("upstream image download failed");
    }
    contentType = normalizeContentType(
      image.headers.get("content-type"),
      "image/png",
    );
    bytes = await image.arrayBuffer();
  } else {
    throw new Error("image item has no content");
  }

  // `uploadMedia`'s own real implementation always resolves (never rejects —
  // it wraps every failure mode in its own try/catch and resolves `null`),
  // but the fallback below must reach the SAME decision no matter how a
  // caller's `uploadMedia` fails, including a bare rejection (a test double,
  // or any future implementation that stops honoring that contract) — so an
  // unexpected throw here degrades exactly like a `null` result instead of
  // surfacing as an unhandled rejection with a different, inconsistent shape.
  const saved = await uploadMedia(
    bytes,
    {
      contentType,
      kind: "image",
      sourceRef: undefined,
    },
    args.originParam,
  ).catch(() => null);

  if (saved === null) {
    // The media library is unreachable, but the vendor call already
    // succeeded and the generated bytes are sitting right here in memory.
    // When the caller explicitly asked for inline bytes
    // (`response_format: "b64_json"`), hand them back rather than
    // discarding a successful generation over a persistence concern the
    // caller never asked to depend on. A `url`-only caller has no
    // substitute for a hosted URL — that path still fails hard below
    // (strict URL-only failure, unchanged).
    if (includeBase64) {
      // Never fabricate media the sniffer can't positively identify as a
      // real image — a storage outage is not a license to hand back
      // malformed bytes just because the caller asked for base64.
      const inspected = inspectImageBytes(toUint8Array(bytes));
      if (inspected !== null) {
        return {
          // Reuse the vendor's own base64 when it already sent one;
          // otherwise (the item arrived as a `url`) encode the bytes this
          // walker itself downloaded — the vendor's URL (which may be
          // private/signed/time-limited) is never included here.
          b64_json: item.b64_json ?? bytesToBase64(bytes),
          ...(item.revised_prompt !== undefined
            ? { revised_prompt: item.revised_prompt }
            : {}),
        };
      }
    }
    throw new Error("failed to upload image");
  }
  return {
    url: saved.url,
    // When base64 was asked for, the vendor's own encoding is reused when it
    // sent one; a `url`-delivered item is encoded from the bytes this walker
    // already downloaded. Dropping them (the previous behaviour) left a
    // URL-returning vendor's item with no bytes at all — which a `b64_json`
    // caller explicitly asked for, and which starved the SSE lane, whose
    // `completed` event REQUIRES `b64_json`. Matches the storage-failure
    // branch above, which already encodes the downloaded bytes.
    ...(includeBase64
      ? { b64_json: item.b64_json ?? bytesToBase64(bytes) }
      : {}),
    ...(item.revised_prompt !== undefined
      ? { revised_prompt: item.revised_prompt }
      : {}),
  };
};

export const acquireImageUpstream = async (
  provider: string,
  args: TWalkArgs,
  hop: { readonly provider: string; readonly modelId: string },
  walkSessionKey?: string,
): Promise<TImageUpstream | "retry"> => {
  const delegate = getDelegate(provider);
  if (delegate?.credentialForImage === undefined) return "retry";
  try {
    const cred = await delegate.credentialForImage(args.req.headers);
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
      url: cred.url,
      accountHash: cred.account_hash ?? null,
    };
  } catch {
    return "retry";
  }
};

export const sizeToAspect = (size?: string, caps?: TModelCaps): string => {
  switch (size) {
    case "1792x1024":
      return "16:9";
    case "1024x1792":
      return "9:16";
    case undefined:
    case "1024x1024":
      return "1:1";
    case "auto":
      return "auto";
    default: {
      const parsed = parseMediaDimensions(size);
      if (parsed === null)
        throw new MediaInputError(
          "size",
          "Grok image size is not supported by this transport",
        );
      // Matched by VALUE against the catalog's declared vocabulary: a
      // vendor may publish non-integer spellings (`9:19.5`) that a gcd
      // reduction can never produce, so 1080x2340 is served as the
      // declared `9:19.5` instead of being refused as `6:13`. With no
      // declared set the reduced ratio rides through.
      return (
        matchDeclaredAspectRatio(caps?.mediaImageAspectRatios ?? [], parsed) ??
        aspectRatioFromDimensions(parsed)
      );
    }
  }
};

/**
 * Translate the caller's size into a published resolution tier.
 *
 * Only the DOCUMENTED tier sizes map: `1k` is "~1024x1024" and `2k` is
 * "~2048x2048" (docs.x.ai pricing enum), so a long edge of exactly 1024
 * or 2048 is expressible and anything else is not. No nearest-tier
 * guessing — that promoted 1536 to the pricier `2k` and demoted 512 to
 * an upscaled `1k`, both of them requests nobody made. `1.5k` is in the
 * request enum with no published pixel size, so no size reaches it; a
 * caller who wants it needs an explicit resolution control, which this
 * canonical surface does not model yet.
 */
export const sizeToImageResolution = (
  size: string | undefined,
  caps?: TModelCaps,
): string | undefined => {
  // Tier names, their documented pixel meanings and the default all come
  // from the catalog. With no tier data the size is UNKNOWN to us: no
  // resolution is sent at all rather than guessing one, and the provider
  // applies its own default.
  const tiers = caps?.mediaImageResolutionTiers;
  const allowed = caps?.mediaImageResolutions;
  const fallback = caps?.mediaImageDefaultResolution;
  if (size === undefined || size === "auto") return fallback;
  const parsed = parseMediaDimensions(size);
  if (parsed === null)
    throw new MediaInputError(
      "size",
      "Grok image size is not supported by this transport",
    );
  if (tiers === undefined) return fallback;
  const longEdge = Math.max(parsed.width, parsed.height);
  const resolution = resolutionTierForLongEdge(tiers, longEdge, allowed);
  if (resolution === null)
    throw new MediaInputError(
      "size",
      `size ${size} has no documented resolution tier for this model: published tiers are ${describeAllowed(tiers.map((tier) => `${tier.resolution} (~${tier.longEdge} long edge)`))}. Omit size for the provider default, or send a size matching a published tier — it is not rounded to a neighbouring tier for you.`,
    );
  return resolution;
};

export const buildImageUpstreamBody = (
  provider: string,
  req: TImageGenerationRequest,
  providerModelId: string,
  caps?: TModelCaps,
): Record<string, unknown> => {
  if (provider === "chatgpt") {
    // `response_format` is GATEWAY-OWNED and stays omitted: the walker
    // persists the bytes and builds `data[]` itself, so the caller's choice
    // is honoured whatever reaches the upstream. That is a translation, not
    // a drop.
    //
    // Every other option the caller sent is FORWARDED. This branch is
    // OpenAI-shaped and `style` / `output_format` / `output_compression` /
    // `moderation` are canonical fields of that very wire, spelled here
    // exactly as they are spelled when a card declares support — so the
    // absence of a card is absence of EVIDENCE, not evidence of absence.
    // Two behaviours were wrong in opposite directions and both are fixed
    // here: dropping `style` in silence returned a picture nobody asked for
    // (the original bug), and refusing it on an un-carded model invented an
    // incapability from missing metadata (the over-correction). Unknown
    // forwards and lets the provider — the only authority on its own wire —
    // answer; a card that says `false` refuses before anything is spent.
    const issues: TMediaOptionIssue[] = [];
    const refuse = (param: string): void => {
      issues.push(
        unsupportedParamIssue({
          param,
          reason:
            "is declared unsupported by this ChatGPT image model's card, so it was refused rather than discarded. Remove it, or choose a model whose card serves it.",
        }),
      );
    };
    // `style` is checked on its OWN fact — it is not a member of the output
    // group, so a card that serves the group says nothing about it.
    if (req.style !== undefined && caps?.supportsStyle === false)
      refuse("style");
    if (caps?.supportsGptImageOutputOptions === false) {
      // Named one by one, so a caller who sent three learns about three.
      if (req.output_format !== undefined) refuse("output_format");
      if (req.output_compression !== undefined) refuse("output_compression");
      if (req.moderation !== undefined) refuse("moderation");
      if (req.background !== undefined) refuse("background");
    }
    // ONE refusal carrying every locally-known issue: a first-failure
    // validator turns a four-field request into a four-round-trip staircase.
    const rejection = mediaOptionRejection(issues);
    if (rejection !== null)
      throw new MediaInputError(rejection.param, rejection.message);
    return {
      model: providerModelId,
      prompt: req.prompt,
      ...(req.n !== undefined ? { n: req.n } : {}),
      ...(req.size !== undefined ? { size: req.size } : {}),
      ...(req.quality !== undefined ? { quality: req.quality } : {}),
      ...(req.style !== undefined ? { style: req.style } : {}),
      ...(req.output_format !== undefined
        ? { output_format: req.output_format }
        : {}),
      ...(req.output_compression !== undefined
        ? { output_compression: req.output_compression }
        : {}),
      ...(req.moderation !== undefined ? { moderation: req.moderation } : {}),
      ...(req.background !== undefined ? { background: req.background } : {}),
      ...(req.user !== undefined ? { user: req.user } : {}),
    };
  }
  if (provider === "grok") {
    // `user` IS part of xAI's published GenerateImageRequest
    // (docs.x.ai/openapi.json), so it is forwarded rather than refused;
    // `style` and the gpt-image output group have no field there and are
    // still reported instead of being dropped.
    //
    // A card may say a specific model DOES serve one of these
    // (`supportsStyle` / `supportsGptImageOutputOptions`), and then it is
    // forwarded: the refusal exists because the published request schema
    // has no field for it, not because we decided the model cannot.
    const styleUnmapped =
      req.style !== undefined && caps?.supportsStyle !== true;
    const outputGroupUnmapped =
      caps?.supportsGptImageOutputOptions !== true &&
      (req.background !== undefined ||
        req.output_format !== undefined ||
        req.output_compression !== undefined ||
        req.moderation !== undefined);
    const unmapped = styleUnmapped
      ? "style"
      : outputGroupUnmapped
        ? req.background !== undefined
          ? "background"
          : req.output_format !== undefined
            ? "output_format"
            : req.output_compression !== undefined
              ? "output_compression"
              : "moderation"
        : undefined;
    if (unmapped !== undefined)
      throw new MediaInputError(
        unmapped,
        `Grok image adapter cannot map ${unmapped}; it was not discarded. Use an image adapter that serializes this option, or remove it only if it is not intended.`,
      );
    const aspectRatio = sizeToAspect(req.size, caps);
    if (!isAllowedMediaOption(caps?.mediaImageAspectRatios, aspectRatio))
      throw new MediaInputError(
        "size",
        `size ${req.size ?? ""} implies aspect ratio ${aspectRatio}, which this model does not accept. Accepted aspect ratios: ${describeAllowed(caps?.mediaImageAspectRatios ?? [])}.`,
      );
    const n = req.n ?? 1;
    const countRange = caps?.mediaImageCountRange;
    if (
      countRange !== undefined &&
      (!Number.isInteger(n) || n < countRange.min || n > countRange.max)
    )
      throw new MediaInputError(
        "n",
        `n must be a whole number from ${countRange.min} to ${countRange.max}; received ${n}.`,
      );
    const resolution = sizeToImageResolution(req.size, caps);
    return {
      model: providerModelId,
      // `quality` is forwarded unchanged: the published request schema
      // did not resolve this field, so neither dropping nor validating
      // it would be evidence-backed.
      ...(req.quality !== undefined ? { quality: req.quality } : {}),
      prompt: req.prompt,
      n,
      aspect_ratio: aspectRatio,
      ...(resolution === undefined ? {} : { resolution }),
      // Omitted only when a card says this model's upstream has no such
      // knob. That is NOT a refusal: the walker persists the bytes and
      // builds `data[]` itself, so the caller's `response_format` is
      // honoured either way.
      ...(caps?.upstreamAcceptsResponseFormat === false
        ? {}
        : { response_format: "b64_json" }),
      ...(req.user !== undefined ? { user: req.user } : {}),
    };
  }
  throw new ImageProviderUnavailableError(
    `Unsupported subscription image provider: ${provider}`,
  );
};

export const normalizeImageResponse = (
  upstream: unknown,
): TImageGenerationResponse => {
  const data =
    upstream !== null && typeof upstream === "object"
      ? (upstream as { readonly data?: unknown }).data
      : undefined;
  // A "success" upstream body with no `data` array is malformed — surface it
  // as a 502 (the caller converts this throw) rather than fabricating an empty
  // but 200-OK image response the client would read as a successful no-op.
  if (!Array.isArray(data)) {
    throw new Error("upstream image response missing a data array");
  }
  return parseImageResponse({
    created: Math.floor(Date.now() / 1000),
    data,
  });
};

/**
 * Final-only image SSE for the local lane.
 *
 * NEITHER subscription provider this walker serves emits progressive
 * image bytes — xAI's docs state streaming "is not supported by models
 * with image output capability", and the Gemini image wire documents no
 * partial-image events — so there is nothing real to forward as a
 * partial frame. Rather than refuse `stream: true` (the caller asked
 * for a transport, not a capability) or fabricate progress, this emits
 * exactly ONE genuine `image_generation.completed` event carrying the
 * real bytes, the real usage when the upstream sent one, and the
 * durable library URL.
 *
 * Ordering is the promise: persistence runs BEFORE the stream opens, so
 * a `completed` event is only ever written once the bytes are stored
 * and the `url` it advertises exists. A persistence failure therefore
 * answers a normal JSON error, never a `completed` event describing
 * media that was not saved.
 *
 * This DELIBERATELY differs from the cloud image lane, which opens the
 * stream first so genuine progressive frames can reach the client while
 * generation is still running, and persists when its completed event
 * arrives. That lane cannot persist first — it does not hold the final
 * image until the end, and buffering to get it would destroy the
 * progressive property it exists to provide; it therefore needs a
 * terminal SSE `error` frame for a post-open persistence failure, which
 * this lane never reaches for. Do not "harmonise" the two: each order
 * is correct for its inputs, and the invariant they share is the one
 * that matters — `url` is emitted only after the bytes are stored, so
 * on both lanes its presence is a fact rather than a promise.
 */
export const imageStreamResponse = (
  normalized: TImageGenerationResponse,
  persisted: ReadonlyArray<TImageDataItem>,
  request: TImageGenerationRequest,
): Response => {
  const createdAt = normalized.created;
  const frames: Uint8Array[] = [];
  for (const [index, item] of persisted.entries()) {
    const b64 = item.b64_json ?? normalized.data[index]?.b64_json;
    if (b64 === undefined) continue;
    const event = completedEventFromFinalImage({
      b64_json: b64,
      createdAt,
      ...(request.size !== undefined ? { size: request.size } : {}),
      ...(normalized.quality !== undefined
        ? { quality: normalized.quality }
        : {}),
      ...(normalized.background !== undefined
        ? { background: normalized.background }
        : {}),
      ...(normalized.output_format !== undefined
        ? { outputFormat: normalized.output_format }
        : {}),
      // Real counts only: an upstream that sends none gets none, and
      // the `output_tokens_details` that only the non-streaming shape
      // carries is dropped rather than invented.
      ...(normalized.usage !== undefined
        ? {
            usage: {
              input_tokens: normalized.usage.input_tokens,
              output_tokens: normalized.usage.output_tokens,
              total_tokens: normalized.usage.total_tokens,
              ...(normalized.usage.input_tokens_details !== undefined
                ? {
                    input_tokens_details: normalized.usage.input_tokens_details,
                  }
                : {}),
            },
          }
        : {}),
    });
    frames.push(
      encodeImageSseEvent(
        item.url === undefined ? event : { ...event, url: item.url },
      ),
    );
  }
  if (frames.length === 0)
    return errorJson(502, "upstream image provider returned no image bytes");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    },
  );
};

export const runImageWalker = async (args: TWalkArgs): Promise<Response> => {
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
  if (args.planParam === null) {
    return errorJson(400, "images require a daemon plan");
  }

  let imageRequest: TImageGenerationRequest;
  try {
    imageRequest = parseImageRequest(args.rawBody);
  } catch (err) {
    return errorJson(
      400,
      err instanceof Error ? err.message : "Invalid image generation request",
    );
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
    if (isSubscriptionSlug(hop.provider)) {
      // Recorded the moment this hop is UNDERTAKEN, not once it has been
      // dispatched. Everything below can refuse before a byte leaves the
      // box — an option this wire cannot map, a provider with no local
      // credential — and a refusal that names nobody is the one thing a
      // caller cannot act on: the MCP tool renders "Served by <model>"
      // from these headers, so without them an agent re-sends the same
      // rejected field hoping a different model was at fault. The cloud
      // lane (`runMediaApiChain`) pushes before attempting for exactly
      // this reason; this is not a claim that anything was submitted —
      // the dispatch facts handed to `mediaHopAdvances` are untouched.
      attempted.push(hop.modelId);
      // Validate before credential fallback can advance to an unchecked transport.
      let upstreamBody: Record<string, unknown>;
      try {
        upstreamBody = buildImageUpstreamBody(
          hop.provider,
          imageRequest,
          hop.providerModelId,
          // Catalog-resolved, model-specific facts for THIS hop; the
          // provider branch is only the family default beneath them.
          hop.caps,
        );
      } catch (err) {
        const failure = classifyMediaBuildFailure(err);
        // `ImageProviderUnavailableError` predates the shared brands and
        // is still thrown by the image-edit wire, so it keeps its own
        // check rather than being reclassified as a gateway fault.
        const unavailable =
          failure.kind === "provider_unavailable" ||
          err instanceof ImageProviderUnavailableError;
        if (failure.kind === "unexpected" && !unavailable) {
          logWarn(
            "image-walker",
            safeDiagnosticMessage`Failed to build image request`,
            {
              provider: hop.provider,
              model: hop.providerModelId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          return stamp(
            errorJson(500, MEDIA_BUILD_FAILURE_MESSAGE),
            hop.modelId,
          );
        }
        const errorCode = unavailable ? "model_unavailable" : "caller_error";
        lastError = errorJson(
          400,
          unavailable && err instanceof Error
            ? err.message
            : (failure as { readonly message: string }).message,
          errorCode,
        );
        if (!last && mediaHopAdvances({ dispatched: false, errorCode }))
          continue;
        return stamp(lastError, hop.modelId);
      }
      const delegate = getDelegate(hop.provider);
      if (delegate?.credentialForImage === undefined) {
        if (
          !last &&
          mediaHopAdvances({
            dispatched: false,
            errorCode: "missing_credential",
          })
        ) {
          continue;
        }
        return stamp(
          errorJson(404, `No image credential available for ${hop.provider}`),
          hop.modelId,
        );
      }
      const acquired = await acquireImageUpstream(hop.provider, args, hop);
      if (acquired === "retry") {
        if (
          !last &&
          mediaHopAdvances({
            dispatched: false,
            errorCode: "missing_credential",
          })
        )
          continue;
        return stamp(
          errorJson(404, `No image credential available for ${hop.provider}`),
          hop.modelId,
        );
      }

      const resp = await postUpstream(acquired.url, {
        method: "POST",
        headers: {
          ...acquired.headers,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(upstreamBody),
        signal: args.req.signal,
      });
      if (resp === null) {
        const terminal = args.req.signal.aborted
          ? errorJson(499, "client aborted request")
          : errorJson(502, "upstream image provider is unreachable");
        return stamp(terminal, hop.modelId);
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        report(
          {
            model: hop.modelId,
            provider: hop.provider,
            status: statusFor(resp.status),
            tokens_in: 0,
            tokens_out: 0,
            latency_ms: Date.now() - args.startedAt,
            endpoint: args.endpoint,
            ...(acquired.accountHash !== null
              ? { account_hash: acquired.accountHash }
              : {}),
          },
          args.originParam,
        );
        lastError = new Response(body.length > 0 ? body : null, {
          status: resp.status,
          headers: passthroughHeaders(resp),
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
        return stamp(lastError, hop.modelId);
      }
      let upstream: unknown;
      try {
        upstream = await resp.json();
      } catch {
        return stamp(
          errorJson(502, "upstream image provider returned invalid JSON"),
          hop.modelId,
        );
      }
      let normalized: TImageGenerationResponse;
      try {
        normalized = normalizeImageResponse(upstream);
      } catch (err) {
        return stamp(
          errorJson(
            502,
            err instanceof Error
              ? `upstream image provider returned invalid data: ${err.message}`
              : "upstream image provider returned invalid data",
          ),
          hop.modelId,
        );
      }
      // The SSE lane's `completed` event REQUIRES `b64_json`, so a streaming
      // request needs the bytes retained whatever `response_format` says —
      // otherwise a URL-returning vendor yields zero frames and the walker
      // reports 502 for a generation that actually succeeded and persisted.
      const includeBase64 =
        imageRequest.response_format === "b64_json" ||
        imageRequest.stream === true;
      let persistedItems: ReadonlyArray<TImageDataItem>;
      try {
        persistedItems = await Promise.all(
          normalized.data.map((item) =>
            persistImageDataItem(item, includeBase64, args),
          ),
        );
      } catch {
        return stamp(
          errorJson(502, "Failed to persist generated image"),
          hop.modelId,
        );
      }
      report(
        {
          model: hop.modelId,
          provider: hop.provider,
          status: statusFor(resp.status),
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: Date.now() - args.startedAt,
          endpoint: args.endpoint,
          ...(acquired.accountHash !== null
            ? { account_hash: acquired.accountHash }
            : {}),
        },
        args.originParam,
      );
      // `stream: true` changes the TRANSPORT, not the result: the same
      // persisted bytes either ride one real completion event or the
      // JSON body. `false`/absent keeps the JSON path byte-for-byte.
      return stamp(
        imageRequest.stream === true
          ? imageStreamResponse(normalized, persistedItems, imageRequest)
          : new Response(
              JSON.stringify({ ...normalized, data: persistedItems }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        hop.modelId,
      );
    }
    attempted.push(hop.modelId);
    const forwarded = await forwardMediaHopToCloud(args, hop.modelId);
    if (forwarded.ok) {
      return stamp(forwarded, hop.modelId);
    }
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
    // Only names the hop when the cloud's own answer carried no attribution
    // of its own (`withMediaAttribution` never overwrites a set header), so a
    // forwarded refusal keeps whatever the cloud lane resolved.
    return stamp(forwarded, hop.modelId);
  }
  return stamp(
    lastError ??
      errorJson(
        404,
        "No image provider in the daemon plan can serve this request",
      ),
  );
};

// ─── Image EDITS ───────────────────────────────────────────────────────────
//
// A distinct entry point (`runImageEditWalker`) rather than a branch inside
// `runImageWalker`: edits have their own request shape (single reference
// image, no `style`/`background`, masks explicitly rejected — see
// `@openllmsh/protocol/image-edit-parse`), their own upstream wire per
// provider (`buildImageEditUpstreamBody`), and — critically — they must
// NEVER silently fall back to generation when a provider/credential is
// missing.

// `url` is optional for the same reason as `TImageDataItem` above: the
// b64-only storage-outage fallback never has (or fabricates) a hosted URL.
type TImageEditDataItem = {
  readonly url?: string;
  readonly b64_json?: string;
};

/**
 * Acquire the local credential for ONE subscription provider's image-EDIT
 * endpoint. Mirrors {@link acquireImageUpstream} but reads
 * `credentialForImageEdit` — a distinct delegate method so a provider can
 * target `/images/edits` without reusing its generation URL/headers.
 */
export const acquireImageEditUpstream = async (
  provider: string,
  args: TWalkArgs,
  hop: { readonly provider: string; readonly modelId: string },
  walkSessionKey?: string,
): Promise<TImageUpstream | "retry"> => {
  const delegate = getDelegate(provider);
  if (delegate?.credentialForImageEdit === undefined) return "retry";
  try {
    const cred: TImageCredential = await delegate.credentialForImageEdit(
      args.req.headers,
    );
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
      url: cred.url,
      accountHash: cred.account_hash ?? null,
    };
  } catch {
    return "retry";
  }
};

/** Decode the base64 payload out of a `data:...;base64,<payload>` URL. */
const bytesFromDataUrl = (url: string): Uint8Array => {
  const comma = url.indexOf(",");
  return base64ToBytes(comma === -1 ? "" : url.slice(comma + 1));
};

/**
 * Persist ONE edit-result image. Unlike generation's `persistImageDataItem`,
 * a result whose bytes don't sniff as a real image is REJECTED rather than
 * stored under a fallback MIME: an edit endpoint returning garbage (or a
 * truncated/corrupted payload) is a malformed provider result, and this is
 * a brand-new persistence path with no legacy behavior to preserve.
 */
export const persistImageEditResultItem = async (
  item: { readonly url?: string; readonly b64_json?: string },
  includeBase64: boolean,
  args: TWalkArgs,
): Promise<TImageEditDataItem> => {
  let bytes: Uint8Array;
  if (item.b64_json !== undefined) {
    bytes = base64ToBytes(item.b64_json);
  } else if (item.url !== undefined && item.url.length > 0) {
    // Every edit upstream this daemon knows (`buildImageEditUpstreamBody`)
    // requests `response_format: "b64_json"` / an inline `image_url`; a
    // provider answering with a bare `https://` result would mean fetching
    // a vendor-controlled URL this box cannot SSRF-vet. Only an inline
    // `data:` result is accepted.
    if (!isSupportedImageEditReference(item.url)) {
      throw new Error(
        "upstream image edit returned a fetchable URL result, which this daemon does not fetch",
      );
    }
    bytes = bytesFromDataUrl(item.url);
  } else {
    throw new Error("image edit result has no content");
  }

  const inspected = inspectImageBytes(bytes);
  if (inspected === null) {
    throw new Error("upstream image edit returned unrecognized image bytes");
  }

  // Same rejection-vs-null note as generation's `persistImageDataItem`
  // above: `uploadMedia` should never reject in production, but a caller
  // that does reject must degrade the same way a `null` resolution does.
  const saved = await uploadMedia(
    bytes,
    { contentType: inspected.mime, kind: "image", sourceRef: undefined },
    args.originParam,
  ).catch(() => null);
  if (saved === null) {
    // Same storage-outage fallback as generation's `persistImageDataItem`:
    // the edit result is already sniffed as a real image above (unlike
    // generation, edits never tolerate an unrecognized-format fallback), so
    // handing it back inline for an explicit b64_json request is safe. A
    // `url`-only caller still fails hard — there is no hosted URL to give it.
    if (includeBase64) {
      return {
        b64_json: item.b64_json ?? bytesToBase64(bytes),
      };
    }
    throw new Error("failed to upload edited image");
  }
  return {
    url: saved.url,
    ...(includeBase64 && item.b64_json !== undefined
      ? { b64_json: item.b64_json }
      : {}),
  };
};

/**
 * Walk one image-EDIT request. Same 403/400 plan gate as {@link runImageWalker}.
 * The plan candidate must be a subscription provider whose delegate exposes
 * `credentialForImageEdit` — an API-key (BYOK) hop is never considered here;
 * the cloud handler is responsible for refusing BYOK explicitly rather than
 * ever 307ing one to this walker.
 */
export const runImageEditWalker = async (
  args: TWalkArgs,
): Promise<Response> => {
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
  if (args.planParam === null) {
    return errorJson(400, "image edits require a daemon plan");
  }

  // The listener (`listener.ts`) already normalized this request once: a
  // JSON body goes straight through `parseImageEditInput`, and a multipart
  // upload is flattened by `parseImageEditMultipart` into the same shape
  // first — either way, `args.rawBody` here is that already-decoded
  // `TImageEditRequest`, not the original wire body. This is therefore a
  // SECOND, safe pass over the listener's own output: re-running the same
  // pure parser on its already-canonical shape is idempotent (no
  // `mask`/`style`/`background` survive the first pass, and `image` is
  // already `{ url }`), so it can't reject a request the listener accepted.
  // It exists so this walker never trusts an upstream cast without
  // re-validating against the one parser that owns the contract.
  const parsed = parseImageEditInput(args.rawBody);
  if (!parsed.ok) {
    return errorJson(400, parsed.error.message, parsed.error.code);
  }
  const editRequest: TImageEditRequest = parsed.request;

  if (!isSupportedImageEditReference(editRequest.image.url)) {
    return errorJson(
      400,
      "Image edits accept only an inline (data:) image upload in this release — remote image URLs are not supported.",
      "image_edit_remote_url_unsupported",
    );
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
    if (!isSubscriptionSlug(hop.provider)) {
      // A BYOK hop is the cloud's to serve; this walker never attempts one,
      // so it must not appear in the chain it reports.
      continue;
    }
    // Recorded before the body is built, for the same reason as the
    // generation walker above: an edit refused on this wire (a size this
    // transport has no mapping for) or for want of a local credential still
    // names the hop that refused it.
    attempted.push(hop.modelId);
    // Invalid caller options are terminal, even when this hop lacks credentials.
    let upstreamBody: Record<string, unknown>;
    try {
      upstreamBody = buildImageEditUpstreamBody(
        hop.provider,
        editRequest,
        hop.providerModelId,
      );
    } catch (err) {
      const errorCode =
        err instanceof ImageProviderUnavailableError
          ? "model_unavailable"
          : "caller_error";
      lastError = errorJson(
        400,
        err instanceof Error ? err.message : "Invalid image-edit request",
        errorCode,
      );
      if (!last && mediaHopAdvances({ dispatched: false, errorCode })) continue;
      return stamp(lastError, hop.modelId);
    }
    const acquired = await acquireImageEditUpstream(hop.provider, args, hop);
    if (acquired === "retry") {
      if (
        !last &&
        mediaHopAdvances({
          dispatched: false,
          errorCode: "missing_credential",
        })
      )
        continue;
      return stamp(
        errorJson(
          404,
          `No image-edit credential available for ${hop.provider}`,
        ),
        hop.modelId,
      );
    }
    const resp = await postUpstream(acquired.url, {
      method: "POST",
      headers: {
        ...acquired.headers,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(upstreamBody),
      signal: args.req.signal,
    });
    if (resp === null) {
      return stamp(
        args.req.signal.aborted
          ? errorJson(499, "client aborted request")
          : errorJson(502, "upstream image-edit provider is unreachable"),
        hop.modelId,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      report(
        {
          model: hop.modelId,
          provider: hop.provider,
          status: statusFor(resp.status),
          tokens_in: 0,
          tokens_out: 0,
          latency_ms: Date.now() - args.startedAt,
          endpoint: args.endpoint,
          ...(acquired.accountHash !== null
            ? { account_hash: acquired.accountHash }
            : {}),
        },
        args.originParam,
      );
      lastError = new Response(body.length > 0 ? body : null, {
        status: resp.status,
        headers: passthroughHeaders(resp),
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
      return stamp(lastError, hop.modelId);
    }
    let upstream: unknown;
    try {
      upstream = await resp.json();
    } catch {
      return stamp(
        errorJson(502, "upstream image-edit provider returned invalid JSON"),
        hop.modelId,
      );
    }
    let normalized: TImageGenerationResponse;
    try {
      normalized = normalizeImageResponse(upstream);
    } catch (err) {
      return stamp(
        errorJson(
          502,
          err instanceof Error
            ? `upstream image-edit provider returned invalid data: ${err.message}`
            : "upstream image-edit provider returned invalid data",
        ),
        hop.modelId,
      );
    }
    const includeBase64 = editRequest.response_format === "b64_json";
    let persistedItems: ReadonlyArray<TImageEditDataItem>;
    try {
      persistedItems = await Promise.all(
        normalized.data.map((item) =>
          persistImageEditResultItem(item, includeBase64, args),
        ),
      );
    } catch {
      return stamp(
        errorJson(502, "Failed to persist edited image"),
        hop.modelId,
      );
    }
    report(
      {
        model: hop.modelId,
        provider: hop.provider,
        status: statusFor(resp.status),
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: Date.now() - args.startedAt,
        endpoint: args.endpoint,
        ...(acquired.accountHash !== null
          ? { account_hash: acquired.accountHash }
          : {}),
      },
      args.originParam,
    );
    return stamp(
      new Response(JSON.stringify({ ...normalized, data: persistedItems }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      hop.modelId,
    );
  }
  return stamp(
    lastError ??
      errorJson(
        404,
        "No subscription image-edit provider in the daemon plan can serve this request",
      ),
  );
};
