/**
 * Shared request-private nonce guard for the native-runtime capture loopback
 * receivers. Loopback + an OS-assigned ephemeral port is not authentication:
 * another local process that discovers the port could submit a valid-shaped
 * request and win the single-shot capture race. Browser-originated requests
 * may also be possible, depending on browser CORS/private-network policies.
 *
 * One guard is minted per receiver instance (per capture-session spawn), not
 * shared across receivers or processes. It is a pure transport-layer secret:
 * it never touches, inspects, or rewrites the vendor application request
 * (method/headers/body) — only the loopback URL's own leading path segment,
 * which the daemon itself controls end-to-end (it hands the prefixed base
 * URL to the spawned child via private environment or request-private config,
 * never public command-line arguments). This does not isolate the secret
 * from other processes with equivalent access to that user's private state.
 *
 * `baseUrl(origin)` appends the secret path segment once, for the receiver
 * to hand to the child process. `peel(url)` is the receiver's own inbound
 * gate: it requires an EXACT path-segment match of that same secret at the
 * start of the URL, in constant time, and returns a URL with only that
 * segment stripped — same origin, same remaining pathname, same query,
 * same hash — or `null` when the segment is absent, wrong, or a
 * lookalike (a prefix match that is not a full path segment, e.g.
 * `/tokenXYZ` when the token is `token`). Callers must reject with 404
 * BEFORE reading the request body or doing anything capture/preamble
 * related, and must never log the raw nonce or the raw pre-peel URL.
 *
 * Use this only after verifying that the actual native request builder
 * preserves the configured base URL's path. Config validation alone does
 * not establish request construction behavior; neither does a different
 * endpoint's behavior. A builder that discards the path needs another
 * authenticated transport, not an unauthenticated receiver fallback.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** 128 bits — the minimum the security review specified. */
const NONCE_BYTES = 16;

export type TCaptureLoopbackGuard = {
  /** Append this guard's secret path segment once to `origin` (no trailing
   *  slash expected/produced beyond the segment itself). */
  readonly baseUrl: (origin: string) => string;
  /**
   * Require the secret path segment as an exact leading path segment of
   * `url`. Returns a new `URL` with only that segment removed — same
   * origin/search/hash, remaining pathname preserved verbatim (defaulting
   * to `/` when the segment was the entire path) — or `null` when missing,
   * wrong, or not a full segment (a same-prefix lookalike).
   */
  readonly peel: (url: URL) => URL | null;
};

/** Fresh, unguessable per-receiver guard. Never reuse across receivers. */
export const createCaptureLoopbackGuard = (): TCaptureLoopbackGuard => {
  const token = randomBytes(NONCE_BYTES).toString("hex");
  const tokenBytes = Buffer.from(token, "utf8");
  const prefix = `/${token}`;

  const baseUrl = (origin: string): string => `${origin}${prefix}`;

  const peel = (url: URL): URL | null => {
    const pathname = url.pathname;
    if (!pathname.startsWith("/") || pathname.length < prefix.length)
      return null;
    // Exact path-segment boundary: the char right after the token must end
    // the path or start the next segment — never a same-prefix lookalike
    // like `/${token}extra`.
    const boundary = pathname.charAt(prefix.length);
    if (boundary !== "" && boundary !== "/") return null;

    // Structural checks do not compare secret content. Compare the presented
    // segment only here, using fixed-length buffers.
    const presented = pathname.slice(1, 1 + token.length);
    const presentedBytes = Buffer.from(presented, "utf8");
    if (presentedBytes.length !== tokenBytes.length) return null;
    if (!timingSafeEqual(presentedBytes, tokenBytes)) return null;

    const rest = pathname.slice(prefix.length);
    const peeled = new URL(url.toString());
    peeled.pathname = rest.length === 0 ? "/" : rest;
    return peeled;
  };

  return { baseUrl, peel };
};
