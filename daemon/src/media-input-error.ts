/**
 * Branded media input failures.
 *
 * The media walkers build a provider-native body before they dispatch
 * anything. Two very different things can go wrong there:
 *
 *  - a DELIBERATE refusal — the caller sent a value outside the
 *    provider's published domain, and we know that before spending a
 *    credential. Its message is written for the caller and is safe to
 *    return verbatim, with the offending field named.
 *  - an UNEXPECTED failure — a bug in our own body building. Its
 *    message is written for us, may contain internals, and says nothing
 *    useful about the caller's request.
 *
 * Returning both as `400 <err.message>` mislabelled our bugs as the
 * caller's mistake and leaked raw internals into an HTTP response. The
 * classes below let the walkers tell them apart by BRAND rather than by
 * guessing from the message text.
 */

/** A pre-dispatch refusal whose message is written for the caller. */
export class MediaInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaInputError";
  }
}

/** This daemon has no native request shape for the selected provider. */
export class MediaProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaProviderUnavailableError";
  }
}

/** Kind of failure a walker hit while preparing a request. */
export type TMediaBuildFailure =
  | { readonly kind: "input"; readonly field: string; readonly message: string }
  | { readonly kind: "provider_unavailable"; readonly message: string }
  | { readonly kind: "unexpected" };

/**
 * Classify a thrown value WITHOUT inspecting its message: only an error
 * we deliberately branded is treated as the caller's to fix. Everything
 * else is ours, and its text never reaches the response.
 */
export const classifyMediaBuildFailure = (err: unknown): TMediaBuildFailure => {
  if (err instanceof MediaInputError)
    return { kind: "input", field: err.field, message: err.message };
  if (err instanceof MediaProviderUnavailableError)
    return { kind: "provider_unavailable", message: err.message };
  return { kind: "unexpected" };
};

/** The one sanitized sentence an unexpected build failure may return. */
export const MEDIA_BUILD_FAILURE_MESSAGE =
  "The request could not be prepared for this provider. This is a gateway fault, not a problem with the request.";
