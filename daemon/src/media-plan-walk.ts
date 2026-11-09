/**
 * Shared ordered walk over a signed media plan.
 *
 * Owns plan parse / stamp / attempted, dialable `finalHop`, local/API-key/oauth
 * branching policy hooks, and last-error return. Surface walkers keep only
 * build / dial / normalize / persist inside {@link TMediaHopDial}.
 *
 * Mirror: chat's ordered walk in `walker.ts` (`forwardCloudHop` + classify);
 * media overlays stop/continue via `mediaActionFor` (call sites in dials).
 */

import { isLocalKeyProviderSlug } from "@openllmsh/sdk/protocol";
import { errorJson } from "./cors";
import { isOAuthSlug } from "./delegation";
import { isLocalServerSlug } from "./local-servers";
import { withMediaAttribution } from "./media-attribution";
import { forwardMediaHopToCloud } from "./media-cloud-forward";
import { mediaHopAdvancesForHttp } from "./media-retry";
import {
  parsePlan,
  planSignatureOk,
  resolveHop,
  type TWalkArgs,
} from "./walker";

/** Resolved plan hop — same shape `resolveHop` returns. */
export type TMediaPlanHop = ReturnType<typeof resolveHop>;

export type TMediaHopDialContext = {
  readonly args: TWalkArgs;
  readonly hop: TMediaPlanHop;
  readonly finalHop: boolean;
  readonly attempted: string[];
};

/**
 * Per-hop outcome. `advances` is the dial's verdict (classifier / pre-dispatch
 * overlay); the walk still refuses to continue on `finalHop`.
 */
export type TMediaHopDialResult =
  | { readonly kind: "return"; readonly response: Response }
  | {
      readonly kind: "miss";
      readonly error: Response;
      readonly advances: boolean;
    };

export type TMediaHopDial = (
  ctx: TMediaHopDialContext,
) => Promise<TMediaHopDialResult>;

export type TWalkMediaPlanOptions = {
  readonly args: TWalkArgs;
  /** When the plan param is missing after a valid signature check. */
  readonly missingPlanMessage: string;
  /**
   * Hops that can actually serve this surface. A non-dialable hop is still
   * visited (so attribution names it) but never keeps `finalHop` false for an
   * earlier dialable hop — fixes trailing BYOK on image edit (M6).
   */
  readonly isDialableHop: (hop: TMediaPlanHop) => boolean;
  /**
   * Dial one hop. Typical split inside the dial:
   * local refuse · oauth `serveAcrossAccounts` · API-key forward/skip.
   */
  readonly dial: TMediaHopDial;
  /** Empty-plan / exhausted fallback when no hop produced a miss error. */
  readonly exhaustedMessage: string;
};

export const mediaPlanSignatureError = (args: TWalkArgs): Response | null => {
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
  return null;
};

export const resolveMediaPlanHops = (
  args: TWalkArgs,
): ReadonlyArray<TMediaPlanHop> => {
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  return parsePlan(args.planParam).map((modelId, index) =>
    resolveHop(modelId, pmids[index]),
  );
};

export const hasDialableMediaSuccessor = (
  hops: ReadonlyArray<TMediaPlanHop>,
  fromIndex: number,
  isDialableHop: (hop: TMediaPlanHop) => boolean,
): boolean => {
  for (let j = fromIndex + 1; j < hops.length; j += 1) {
    const hop = hops[j];
    if (hop !== undefined && isDialableHop(hop)) return true;
  }
  return false;
};

/**
 * Device-only providers with no media surface on this daemon: loopback local
 * servers, and `local_key` coding plans (chat-only; keys never leave the
 * device, so forwarding them to origin cannot serve media).
 */
export const isUnsupportedDeviceMediaProvider = (provider: string): boolean =>
  isLocalServerSlug(provider) || isLocalKeyProviderSlug(provider);

/** Default dialable set for STT/TTS/image gen/video create: cloud BYOK + oauth. */
export const isStandardMediaDialableHop = (hop: TMediaPlanHop): boolean =>
  !isUnsupportedDeviceMediaProvider(hop.provider);

/** Image-edit (P4a): subscription only until P4b adds API-key adapters. */
export const isImageEditDialableHop = (hop: TMediaPlanHop): boolean =>
  isOAuthSlug(hop.provider);

/**
 * Forward a BYOK/custom hop to origin and classify with the media overlay —
 * the media twin of chat's `forwardCloudHop` (no in-place retry).
 */
export const forwardMediaApiKeyHop = async (
  ctx: TMediaHopDialContext,
): Promise<TMediaHopDialResult> => {
  const { args, hop, finalHop, attempted } = ctx;
  attempted.push(hop.modelId);
  const forwarded = await forwardMediaHopToCloud(args, hop.modelId);
  if (forwarded.ok) {
    return { kind: "return", response: forwarded };
  }
  const forwardRaw = await forwarded
    .clone()
    .text()
    .catch(() => "");
  const advances =
    !finalHop &&
    mediaHopAdvancesForHttp(
      forwarded.status,
      forwardRaw,
      { dispatched: true, accepted: false },
      hop.provider,
    );
  return { kind: "miss", error: forwarded, advances };
};

export const localMediaUnsupportedMiss = (
  ctx: TMediaHopDialContext,
  surfaceLabel: string,
): TMediaHopDialResult => {
  const { hop, finalHop, attempted } = ctx;
  attempted.push(hop.modelId);
  const localKey = isLocalKeyProviderSlug(hop.provider);
  return {
    kind: "miss",
    error: errorJson(
      400,
      `${localKey ? "local_key" : "local"} provider "${hop.provider}" does not support ${surfaceLabel}`,
      "invalid_request_error",
      localKey ? "local_key_surface_unsupported" : "local_surface_unsupported",
    ),
    // Device-only unsupported always walks when a dialable successor remains (M9).
    advances: !finalHop,
  };
};

/**
 * Walk the signed plan in order. Returns a response already stamped with
 * media attribution headers when a hop resolved (or attempted).
 */
export const walkMediaPlan = async (
  options: TWalkMediaPlanOptions,
): Promise<Response> => {
  const signatureError = mediaPlanSignatureError(options.args);
  if (signatureError !== null) return signatureError;
  if (options.args.planParam === null) {
    return errorJson(400, options.missingPlanMessage);
  }

  const hops = resolveMediaPlanHops(options.args);
  const attempted: string[] = [];
  const stamp = (resp: Response, resolved?: string): Response =>
    withMediaAttribution(resp, {
      attempted,
      ...(resolved !== undefined ? { resolvedModel: resolved } : {}),
    });

  let lastError: Response | null = null;
  for (let i = 0; i < hops.length; i += 1) {
    const hop = hops[i];
    if (hop === undefined) continue;
    const finalHop = !hasDialableMediaSuccessor(hops, i, options.isDialableHop);
    const result = await options.dial({
      args: options.args,
      hop,
      finalHop,
      attempted,
    });
    if (result.kind === "return") {
      return stamp(result.response, hop.modelId);
    }
    lastError = result.error;
    if (result.advances) continue;
    return stamp(result.error, hop.modelId);
  }

  return stamp(lastError ?? errorJson(404, options.exhaustedMessage));
};
