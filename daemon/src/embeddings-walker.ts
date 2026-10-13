/**
 * Daemon `POST /v1/embeddings` path. Local `local_*` / `local_port_*` hops
 * are served on-device via {@link serveLocalEmbeddings}; everything else
 * passes through to origin (cloud registry / BYOK).
 *
 * Kept out of `walker.ts` so the chat walker stays free of the embeddings
 * single-shot path, and so this module can stay `@openllm/core`-free.
 */

import { LOCAL_REQUIRES_DAEMON_ERROR_CODE } from "@openllmsh/protocol";
import { errorJson } from "./cors";
import { isOAuthSlug } from "./delegation";
import { passthroughToOrigin } from "./forward";
import { isLocalServerSlug, serveLocalEmbeddings } from "./local-servers";
import {
  parsePlan,
  planSignatureOk,
  resolveHop,
  type TWalkArgs,
} from "./walker";

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

const serveLocalOrNull = async (
  provider: string,
  providerModelId: string,
  args: TWalkArgs,
): Promise<Response | null> =>
  serveLocalEmbeddings({
    provider,
    providerModelId,
    body: args.rawBody,
    signal: args.req.signal,
  });

/**
 * Walk a signed plan (when present) for a local embeddings hop; otherwise
 * honour an explicit `local_*` model id on the body. Non-local requests
 * forward to origin unchanged.
 */
export const runEmbeddings = async (args: TWalkArgs): Promise<Response> => {
  const planTrusted = planSignatureOk(
    args.planParam,
    args.pmidsParam,
    args.originParam,
    args.contextOverflowStrategy ?? null,
    args.sigParam,
  );

  if (planTrusted) {
    const hops = parsePlan(args.planParam);
    const pmids =
      args.pmidsParam === null || args.pmidsParam.length === 0
        ? []
        : args.pmidsParam.split(",");
    for (let i = 0; i < hops.length; i += 1) {
      const modelId = hops[i];
      if (modelId === undefined) continue;
      const hop = resolveHop(modelId, pmids[i]);
      if (isLocalServerSlug(hop.provider)) {
        const local = await serveLocalOrNull(
          hop.provider,
          hop.providerModelId,
          args,
        );
        if (local !== null) return local;
        continue;
      }
      // OAuth subscription hops have no embeddings surface in v1.
      if (isOAuthSlug(hop.provider)) continue;
      // Remaining API-key hop: cloud owns credentials + registry.
      return passthroughToOrigin(args.req, args.rawBytes);
    }
  }

  const bodyModel = modelIdFromBody(args.rawBody);
  if (bodyModel === null) {
    return errorJson(400, "model is required");
  }
  const parts = splitProviderModel(bodyModel);
  if (parts !== null && isLocalServerSlug(parts.provider)) {
    const local = await serveLocalOrNull(
      parts.provider,
      parts.providerModelId,
      args,
    );
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
