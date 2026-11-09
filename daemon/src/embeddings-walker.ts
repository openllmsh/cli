/**
 * Daemon `POST /v1/embeddings` path. Local `local_*` / `local_port_*` hops
 * are served on-device via {@link serveLocalEmbeddings}; API-key / custom hops
 * forward to origin with fallthrough (P6); oauth has no embeddings surface and
 * is skipped without poisoning dialable `finalHop`.
 *
 * Kept out of `walker.ts` so the chat walker stays free of the embeddings
 * single-shot path, and so this module can stay `@openllm/core`-free.
 */

import { LOCAL_REQUIRES_DAEMON_ERROR_CODE } from "@openllmsh/sdk/protocol";
import { errorJson } from "./cors";
import { isOAuthSlug } from "./delegation";
import { passthroughToOrigin } from "./forward";
import { isLocalServerSlug, serveLocalEmbeddings } from "./local-servers";
import type {
  TMediaHopDialContext,
  TMediaHopDialResult,
  TMediaPlanHop,
} from "./media-plan-walk";
import {
  forwardMediaApiKeyHop,
  mediaPlanSignatureError,
  walkMediaPlan,
} from "./media-plan-walk";
import type { TWalkArgs } from "./walker";

const modelIdFromBody = (rawBody: unknown): string | null => {
  if (
    rawBody === null ||
    typeof rawBody !== "object" ||
    Array.isArray(rawBody)
  ) {
    return null;
  }
  const model = (rawBody as { model?: unknown }).model;
  return typeof model === "string" && model.length > 0 ? model : null;
};

const splitProviderModel = (
  modelId: string,
): { readonly provider: string; readonly providerModelId: string } | null => {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return null;
  return {
    provider: modelId.slice(0, slash),
    providerModelId: modelId.slice(slash + 1),
  };
};

/** Embeddings dialable hops: local servers and API-key/custom (not oauth). */
export const isEmbeddingsDialableHop = (hop: TMediaPlanHop): boolean =>
  isLocalServerSlug(hop.provider) || !isOAuthSlug(hop.provider);

const dialEmbeddingsHop = async (
  ctx: TMediaHopDialContext,
): Promise<TMediaHopDialResult> => {
  const { args, hop, finalHop, attempted } = ctx;
  if (isLocalServerSlug(hop.provider)) {
    attempted.push(hop.modelId);
    const local = await serveLocalEmbeddings({
      provider: hop.provider,
      providerModelId: hop.providerModelId,
      body: args.rawBody,
      signal: args.req.signal,
      finalHop,
    });
    if (local !== null) {
      return { kind: "return", response: local };
    }
    // Local miss — walk to a later dialable hop when one exists.
    return {
      kind: "miss",
      error: errorJson(
        503,
        `Local embedding model "${hop.modelId}" is unavailable on this device`,
        "server_error",
        LOCAL_REQUIRES_DAEMON_ERROR_CODE,
      ),
      advances: !finalHop,
    };
  }
  if (isOAuthSlug(hop.provider)) {
    // No embeddings surface — skip without counting as dialable (finalHop
    // already ignores oauth via isEmbeddingsDialableHop).
    return {
      kind: "miss",
      error: errorJson(
        400,
        `subscription provider "${hop.provider}" does not support embeddings`,
        "invalid_request_error",
        "subscription_surface_unsupported",
      ),
      advances: !finalHop,
    };
  }
  // API-key / custom: forward pinned to this hop; classify + fallthrough.
  return forwardMediaApiKeyHop(ctx);
};

/**
 * Walk a signed plan (when present) for embeddings; otherwise honour an
 * explicit `local_*` model id on the body. Non-local body-only requests
 * forward to origin unchanged.
 */
export const runEmbeddings = async (args: TWalkArgs): Promise<Response> => {
  const signatureError = mediaPlanSignatureError(args);
  // An invalid signature still allows the body-only local / passthrough path
  // below — only a trusted plan walks the ordered chain.
  if (signatureError === null && args.planParam !== null) {
    return walkMediaPlan({
      args,
      missingPlanMessage: "embeddings require a daemon plan",
      exhaustedMessage:
        "No embeddings provider in the daemon plan can serve this request",
      isDialableHop: isEmbeddingsDialableHop,
      dial: dialEmbeddingsHop,
    });
  }

  const bodyModel = modelIdFromBody(args.rawBody);
  if (bodyModel === null) {
    return errorJson(400, "model is required");
  }
  const parts = splitProviderModel(bodyModel);
  if (parts !== null && isLocalServerSlug(parts.provider)) {
    const local = await serveLocalEmbeddings({
      provider: parts.provider,
      providerModelId: parts.providerModelId,
      body: args.rawBody,
      signal: args.req.signal,
      finalHop: true,
    });
    if (local !== null) return local;
    return errorJson(
      503,
      `Local embedding model "${bodyModel}" is unavailable on this device`,
      "server_error",
      LOCAL_REQUIRES_DAEMON_ERROR_CODE,
    );
  }

  return passthroughToOrigin(args.req, args.rawBytes);
};
