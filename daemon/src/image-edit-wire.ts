/**
 * Pure upstream-body builders for subscription image EDITS. No I/O, no
 * daemon state, no delegate lookups — kept separate from `image-walker.ts`
 * so the exact per-provider wire shapes are unit-testable without walker
 * plumbing (network mocks, delegate registry, plan signing, …).
 *
 * Verified upstream shapes (foundation research, ac06f4cb):
 *   - chatgpt (Codex `gpt-image-2` edit): the Responses-adjacent images edit
 *     body — `{model,prompt,images:[{image_url:<data-url>}],n,quality,size}`.
 *   - grok (xAI `grok-imagine-image-2.0` generation+edit model):
 *     `{model,prompt,image:{url:<data-url>},n,
 *     response_format:"b64_json",quality}`.
 *
 * The `quality` param forwarded to grok here is carried over from the
 * generation body-builder's shape, not independently live-verified against
 * the EDIT endpoint specifically — see
 * `docs/proposals/subscription-oauth-terms-compliance.md` context and the
 * research commit (ac06f4cb) for what was and wasn't confirmed live. It is
 * forwarded because the documented wire contract includes it, not because
 * an edit call has been run against it.
 */

import type { TImageEditRequest } from "@openllmsh/protocol";

/** Only a missing provider implementation is an availability failure; invalid inputs are terminal. */
export class ImageProviderUnavailableError extends Error {}

/** Subscription providers this daemon knows an image-edit upstream shape for. */
export type TImageEditProvider = "chatgpt" | "grok";

export const isImageEditProvider = (
  provider: string,
): provider is TImageEditProvider =>
  provider === "chatgpt" || provider === "grok";

/**
 * Build the upstream JSON body for one subscription image-edit call. Throws
 * for a provider this daemon has no verified edit wire for — the walker
 * converts that into a clean 400 rather than forwarding a guessed shape.
 */
export const buildImageEditUpstreamBody = (
  provider: string,
  req: TImageEditRequest,
  providerModelId: string,
): Record<string, unknown> => {
  if (provider === "chatgpt") {
    return {
      model: providerModelId,
      prompt: req.prompt,
      images: [{ image_url: req.image.url }],
      n: req.n ?? 1,
      ...(req.quality !== undefined ? { quality: req.quality } : {}),
      ...(req.size !== undefined ? { size: req.size } : {}),
    };
  }
  if (provider === "grok") {
    // No verified canonical size mapping on this edit transport.
    if (req.size !== undefined)
      throw new Error(
        "Grok image-edit size is not supported by this transport",
      );
    return {
      model: providerModelId,
      prompt: req.prompt,
      image: { url: req.image.url },
      n: req.n ?? 1,
      response_format: "b64_json",
      ...(req.quality !== undefined ? { quality: req.quality } : {}),
    };
  }
  throw new ImageProviderUnavailableError(
    `Unsupported subscription image-edit provider: ${provider}`,
  );
};

/**
 * True only for an inline `data:` image reference. The daemon has no
 * SSRF-safe resolver for an arbitrary caller-supplied `https://` image URL
 * (that would require importing `@openllm/core`'s fetch-guard machinery,
 * which the coreless daemon never does), and the tunnel's own byte/host
 * bounds protect ITS OWN transport — they do not vet a URL the client
 * asks the daemon to fetch on its behalf. So this first release accepts
 * only inline uploads; a remote reference is rejected explicitly rather
 * than fetched.
 */
export const isSupportedImageEditReference = (url: string): boolean =>
  url.startsWith("data:");
