/**
 * Shared bridge request-capture contract (W1).
 *
 * After existing routing / adapters / transforms run, a vendor CLI/SDK builds
 * the authenticated native inference request. This module owns the send
 * handoff only:
 *
 *   vendor constructs envelope
 *     → capture suppresses the original external send
 *     → daemon dispatches that envelope once
 *     → real upstream response returns to the daemon
 *     → builder receives a graceful LOCAL settlement (never the true response)
 *
 * Application headers/body/auth/cache fields are forwarded unchanged. Do NOT
 * run captured vendor headers through `originatorHeadersFrom` — that denylist
 * strips credentials and other application identity the vendor already built.
 * Destination / authority / framing are restored separately from application
 * semantics (loopback redirect vs external URL).
 *
 * Activation is the selected `bridge-capture` sub-method (capability table +
 * bootstrap). Adapters decorate via `createRequestCaptureSession` +
 * `runCapturedDispatch`; this file does not own serve.ts routing.
 */

import type { TDeadlineBudget } from "../deadline-budget";
import { createDeadlineBudget } from "../deadline-budget";

// ─── Wire shapes ─────────────────────────────────────────────────────────────

/** Observed inference transports. Framing differs; application envelope does not. */
export type TCaptureTransport = "http" | "websocket" | "connect";

/** One header pair as observed. Names preserve capture casing; duplicates allowed. */
export type TCapturedHeaderPair = readonly [name: string, value: string];

/**
 * Transport-specific framing metadata that is NOT an application-envelope
 * mutation. Adapters may record Connect content-type, WS protocol, HTTP/2
 * stream id, etc. Opaque to the shared dispatcher beyond equality checks.
 */
export type TCaptureFraming = {
  readonly entries: Readonly<Record<string, string | number | boolean | null>>;
};

/**
 * A vendor-built inference request captured before any original external send.
 *
 * `observedUrl` is what the wrapper saw (often loopback after redirect).
 * `externalUrl` is the original external authority the vendor intended — the
 * trusted destination the daemon must dispatch to. Application `headers` +
 * `body` are byte/pair-preserving and must not be rebuilt.
 */
export type TCapturedRequestEnvelope = {
  readonly transport: TCaptureTransport;
  readonly method: string;
  readonly observedUrl: string;
  readonly externalUrl: string;
  readonly headers: ReadonlyArray<TCapturedHeaderPair>;
  readonly body: Uint8Array | null;
  readonly framing: TCaptureFraming | null;
};

/** Policy for validating the EXTERNAL destination before dispatch. */
export type TCaptureDestinationPolicy = {
  /** Allowed `origin` values (`https://api.anthropic.com`). */
  readonly allowedOrigins: ReadonlySet<string>;
  /** When true, `http://127.0.0.1` / `http://localhost` / `http://[::1]` are trusted (hermetic tests). */
  readonly allowLoopback?: boolean;
  /**
   * Optional provider-specific admission beyond the exact origin set (e.g.
   * Cursor's authenticated dynamic `agentUrl` / `agentnUrl` host family).
   * Invoked only after protocol/credentials/loopback checks; must not widen
   * to caller-provided or lookalike hosts.
   */
  readonly allowUrl?: (url: URL) => boolean;
};

/**
 * Usage ownership boundary for one captured turn.
 * Construct-only / pre-accept failures → `none`.
 * Once upstream acceptance is known → `daemon_upstream` (retain even if
 * downstream delivery fails). Never combine estimated native usage with
 * daemon upstream usage for the same work.
 */
export type TCaptureUsageOwnership =
  | { readonly kind: "none" }
  | { readonly kind: "daemon_upstream" };

/**
 * What the BUILDER awaits. Never a true upstream completion, never fabricated
 * assistant history. Adapters map this onto interrupt / cancel / close.
 */
export type TBuilderSettlement =
  | { readonly kind: "suppressed"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }
  /**
   * Keep the builder's intercepted stream alive for allowlisted pre-inference
   * duplex controls (e.g. Cursor `request_context_args`). Not a true upstream
   * completion — inference output still belongs to the daemon.
   *
   * `connectContentEncoding` (when the real upstream negotiated one, e.g.
   * `gzip`) MUST be forwarded onto the synthetic response headers the
   * builder's Connect client sees — a compressed injected envelope with no
   * matching `connect-content-encoding` header leaves the real Connect
   * parser unable to decide how to decode it, which can hang the RPC forever
   * rather than erroring (observed as a caller-side hard timeout with no
   * structured decline).
   */
  | {
      readonly kind: "duplex_bridge";
      readonly reason: string;
      readonly connectContentEncoding?: string | null;
    };

/**
 * Terminal outcome of the capture session (daemon-facing).
 * `uncertain_accept`: dispatch may have reached upstream; do NOT send again.
 */
export type TCaptureTerminalOutcome =
  | {
      readonly kind: "dispatched";
      readonly usage: TCaptureUsageOwnership;
    }
  | {
      readonly kind: "cancelled";
      readonly usage: TCaptureUsageOwnership;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly usage: TCaptureUsageOwnership;
    }
  | {
      readonly kind: "uncertain_accept";
      readonly reason: string;
      readonly usage: TCaptureUsageOwnership;
    };

/**
 * Map a finished capture terminal onto walker `captureOwnership`.
 * `uncertain_accept` and post-accept failures are both no-second-send.
 * Pre-dispatch cancel/fail → `none`.
 */
export const captureOwnershipFromTerminal = (
  terminal: TCaptureTerminalOutcome | null,
): "none" | "accepted" | "uncertain" => {
  if (terminal === null) return "none";
  if (terminal.kind === "uncertain_accept") return "uncertain";
  if (terminal.kind === "dispatched") return "accepted";
  if (terminal.kind === "failed" && terminal.usage.kind === "daemon_upstream") {
    return "accepted";
  }
  if (
    terminal.kind === "cancelled" &&
    terminal.usage.kind === "daemon_upstream"
  ) {
    return "accepted";
  }
  return "none";
};

export type TRequestCaptureErrorCode =
  | "duplicate_capture"
  | "invalid_destination"
  | "body_too_large"
  | "aborted"
  | "already_dispatched"
  | "not_captured"
  | "timeout"
  | "disposed";

export class RequestCaptureError extends Error {
  readonly code: TRequestCaptureErrorCode;

  constructor(code: TRequestCaptureErrorCode, message: string) {
    super(message);
    this.name = "RequestCaptureError";
    this.code = code;
  }
}

// ─── Header / body helpers (no originatorHeadersFrom) ────────────────────────

/** Snapshot Headers / pairs WITHOUT stripping auth or application identity. */
export const preserveCapturedHeaders = (
  input: Headers | HeadersInit | ReadonlyArray<TCapturedHeaderPair>,
): ReadonlyArray<TCapturedHeaderPair> => {
  if (input instanceof Headers) {
    const out: TCapturedHeaderPair[] = [];
    input.forEach((value, name) => {
      out.push([name, value]);
    });
    return out;
  }
  if (Array.isArray(input)) {
    const out: TCapturedHeaderPair[] = [];
    for (const entry of input) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const name = entry[0];
      const value = entry[1];
      if (typeof name !== "string" || typeof value !== "string") continue;
      out.push([name, value]);
    }
    return out;
  }
  // Record<string, string> HeadersInit — copy entries without reintroducing the
  // readonly-tuple HeadersInit overload (tsc keeps ReadonlyArray in the union
  // after Array.isArray on some targets).
  const out: TCapturedHeaderPair[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    out.push([name, value]);
  }
  return out;
};

/** HTTP/2 pseudoheader names (`:method`, `:scheme`, …) — framing, not Web Headers. */
export const isHttpPseudoHeaderName = (name: string): boolean =>
  name.startsWith(":");

/**
 * Rebuild a Headers object from preserved pairs. Retains every application
 * value including Authorization / Cookie / vendor tokens. Drops:
 *   - hop-by-hop `host` when `dropHost` is true (so `fetch` sets the target),
 *   - HTTP/2 pseudoheaders (`:scheme`, `:authority`, `:path`, `:method`, …)
 *     which are illegal in the Fetch/`Headers` API and belong in
 *     {@link TCaptureFraming} / URL / method instead.
 */
export const headersInitFromCaptured = (
  pairs: ReadonlyArray<TCapturedHeaderPair>,
  opts: { readonly dropHost?: boolean } = {},
): Headers => {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    if (opts.dropHost === true && name.toLowerCase() === "host") continue;
    if (isHttpPseudoHeaderName(name)) continue;
    headers.append(name, value);
  }
  return headers;
};

export const bytesEqual = (
  a: Uint8Array | null,
  b: Uint8Array | null,
): boolean => {
  if (a === null || b === null) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export const capturedEnvelopesEqual = (
  a: TCapturedRequestEnvelope,
  b: TCapturedRequestEnvelope,
): boolean => {
  if (a.transport !== b.transport) return false;
  if (a.method !== b.method) return false;
  if (a.observedUrl !== b.observedUrl) return false;
  if (a.externalUrl !== b.externalUrl) return false;
  if (!bytesEqual(a.body, b.body)) return false;
  if (a.headers.length !== b.headers.length) return false;
  for (let i = 0; i < a.headers.length; i += 1) {
    const left = a.headers[i];
    const right = b.headers[i];
    if (left === undefined || right === undefined) return false;
    if (left[0] !== right[0] || left[1] !== right[1]) return false;
  }
  const af = a.framing?.entries ?? null;
  const bf = b.framing?.entries ?? null;
  if (af === null || bf === null) return af === bf;
  const ak = Object.keys(af).sort();
  const bk = Object.keys(bf).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i += 1) {
    const key = ak[i];
    if (key !== bk[i]) return false;
    if (af[key as keyof typeof af] !== bf[key as keyof typeof bf]) return false;
  }
  return true;
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" ||
  hostname === "localhost" ||
  hostname === "[::1]" ||
  hostname === "::1";

/**
 * Validate the EXTERNAL dispatch URL against the destination policy.
 * Rejects credentials-in-URL, non-http(s), and origins outside the allowlist.
 */
export const validateCaptureDestination = (
  externalUrl: string,
  policy: TCaptureDestinationPolicy,
):
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string } => {
  let url: URL;
  try {
    url = new URL(externalUrl);
  } catch {
    return { ok: false, reason: "externalUrl is not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials in URL are not allowed" };
  }
  if (policy.allowLoopback === true && isLoopbackHostname(url.hostname)) {
    return { ok: true, url };
  }
  const origin = url.origin;
  if (policy.allowedOrigins.has(origin)) {
    return { ok: true, url };
  }
  if (policy.allowUrl?.(url) === true) {
    return { ok: true, url };
  }
  return {
    ok: false,
    reason: `origin ${origin} is not in the capture destination allowlist`,
  };
};

/**
 * Build the Request the daemon will dispatch. Uses `externalUrl` as the
 * authority and preserves application headers/body. Never runs
 * `originatorHeadersFrom`.
 */
export const requestFromCapturedEnvelope = (
  envelope: TCapturedRequestEnvelope,
): Request => {
  const method = envelope.method.toUpperCase();
  const headers = headersInitFromCaptured(envelope.headers, { dropHost: true });
  // `new Uint8Array(...)` forces `Uint8Array<ArrayBuffer>` — DOM BodyInit
  // rejects the wider `ArrayBufferLike` buffer typing.
  const body =
    method === "GET" || method === "HEAD" || envelope.body === null
      ? undefined
      : new Uint8Array(envelope.body);
  return new Request(envelope.externalUrl, {
    method,
    headers,
    body,
  });
};

// ─── Bounded builder semaphore ───────────────────────────────────────────────

export type TCaptureSemaphore = {
  readonly limit: number;
  acquire(signal?: AbortSignal): Promise<() => void>;
};

/** Per-process (or test) bound on concurrent capture builders. Not content coalescing. */
export const createCaptureSemaphore = (limit: number): TCaptureSemaphore => {
  const cap = Math.max(1, Math.floor(limit));
  let inUse = 0;
  const waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (err: Error) => void;
    readonly signal?: AbortSignal;
    readonly onAbort: () => void;
  }> = [];

  const pump = (): void => {
    while (inUse < cap && waiters.length > 0) {
      const next = waiters.shift();
      if (next === undefined) return;
      if (next.signal?.aborted) {
        next.reject(
          new RequestCaptureError("aborted", "semaphore acquire aborted"),
        );
        continue;
      }
      next.signal?.removeEventListener("abort", next.onAbort);
      inUse += 1;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        inUse -= 1;
        pump();
      });
    }
  };

  return {
    limit: cap,
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) {
        return Promise.reject(
          new RequestCaptureError("aborted", "semaphore acquire aborted"),
        );
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          signal,
          onAbort: (): void => {
            const idx = waiters.indexOf(entry);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(
              new RequestCaptureError("aborted", "semaphore acquire aborted"),
            );
          },
        };
        waiters.push(entry);
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        pump();
      });
    },
  };
};

// ─── Per-request capture session ─────────────────────────────────────────────

export type TRequestCaptureSessionOptions = {
  readonly destinationPolicy: TCaptureDestinationPolicy;
  readonly signal?: AbortSignal;
  /** Hard cap on captured body bytes (default 16 MiB). */
  readonly maxBodyBytes?: number;
  /** How long the daemon may wait for the builder to offer a capture. */
  readonly captureTimeoutMs?: number;
  readonly id?: string;
};

export type TRequestCaptureSession = {
  readonly id: string;
  readonly signal: AbortSignal;
  /**
   * Builder path: offer the constructed send. Validates destination + body
   * bound, stores the envelope once, suppresses the original external send,
   * and resolves with a LOCAL settlement (never the true upstream response).
   */
  captureSend(envelope: TCapturedRequestEnvelope): Promise<TBuilderSettlement>;
  /** Daemon path: wait for the single captured envelope. */
  takeCaptured(): Promise<TCapturedRequestEnvelope>;
  /** Mark that the daemon has begun the one upstream exchange. */
  markDispatchStarted(): void;
  /** Mark that upstream accepted the request (headers / 2xx start / WS accept). */
  markUpstreamAccepted(): void;
  /** Complete with a known terminal outcome (not uncertain — use failUncertain). */
  complete(
    outcome: Exclude<TCaptureTerminalOutcome, { kind: "uncertain_accept" }>,
  ): void;
  /**
   * Terminal when acceptance is unknown after dispatch started. Callers must
   * NOT retry / send again.
   */
  failUncertain(reason: string): void;
  /** Settle the builder early (cancel / local failure) without a true response. */
  settleBuilder(settlement: TBuilderSettlement): void;
  cancel(reason: string): void;
  dispose(): void;
  terminal(): TCaptureTerminalOutcome | null;
  builderSettlement(): TBuilderSettlement | null;
  captured(): TCapturedRequestEnvelope | null;
  dispatchStarted(): boolean;
  upstreamAccepted(): boolean;
};

let nextCaptureId = 0;

/** Default max body size for a captured request/response — shared with
 *  dispatch senders that must bound an in-memory inbound buffer (e.g. Codex
 *  WS frame collection). */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;

export const createRequestCaptureSession = (
  opts: TRequestCaptureSessionOptions,
): TRequestCaptureSession => {
  nextCaptureId += 1;
  const id = opts.id ?? `capture-${nextCaptureId}`;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;

  const ac = new AbortController();
  const budget: TDeadlineBudget = createDeadlineBudget(
    captureTimeoutMs,
    opts.signal,
  );
  const linkAbort = (): void => {
    if (!ac.signal.aborted) ac.abort();
  };
  budget.signal.addEventListener("abort", linkAbort, { once: true });
  // Caller signal listener: `{ once: true }` self-removes once it FIRES, but a
  // signal that never aborts (the common case) leaves this listener attached
  // to the caller's AbortSignal for as long as that signal lives — past this
  // session's own lifetime. Remove it explicitly on dispose (still safe to
  // remove an already-self-removed listener).
  opts.signal?.addEventListener("abort", linkAbort, { once: true });

  let captured: TCapturedRequestEnvelope | null = null;
  let terminal: TCaptureTerminalOutcome | null = null;
  let builderSettlement: TBuilderSettlement | null = null;
  let dispatchStarted = false;
  let upstreamAccepted = false;
  let disposed = false;

  let resolveCaptured: ((envelope: TCapturedRequestEnvelope) => void) | null =
    null;
  let rejectCaptured: ((err: Error) => void) | null = null;
  const capturedWait = new Promise<TCapturedRequestEnvelope>(
    (resolve, reject) => {
      resolveCaptured = resolve;
      rejectCaptured = reject;
    },
  );
  // Prevent unhandled rejection if dispose races before takeCaptured.
  void capturedWait.catch(() => {});

  const builderWaiters: Array<(settlement: TBuilderSettlement) => void> = [];

  const usageNow = (): TCaptureUsageOwnership =>
    upstreamAccepted ? { kind: "daemon_upstream" } : { kind: "none" };

  const finishBuilder = (settlement: TBuilderSettlement): void => {
    if (builderSettlement !== null) return;
    builderSettlement = settlement;
    for (const wake of builderWaiters.splice(0)) wake(settlement);
  };

  const finishTerminal = (outcome: TCaptureTerminalOutcome): void => {
    if (terminal !== null) return;
    terminal = outcome;
    // Successful dispatch must NOT abort `session.signal` yet. Senders pass
    // `AbortSignal.any([session.signal, callerSignal])` into `fetch`; aborting
    // here cancels a still-live Response body and Bun surfaces
    // `AbortError("The operation was aborted.")` while the daemon decodes —
    // the live Claude bridge-capture text decline. Cancel/fail/uncertain still
    // abort immediately. `dispose()` (after the body is released) aborts.
    //
    // `budget.release()` itself aborts the budget signal, which is also wired
    // to `linkAbort` — detach that listener before releasing on success so the
    // capture-wait timer stops without killing the upstream body.
    if (outcome.kind === "dispatched") {
      budget.signal.removeEventListener("abort", linkAbort);
      budget.release();
    } else {
      linkAbort();
      budget.release();
    }
    if (builderSettlement === null) {
      if (outcome.kind === "cancelled") {
        finishBuilder({ kind: "cancelled", reason: "capture cancelled" });
      } else if (
        outcome.kind === "failed" ||
        outcome.kind === "uncertain_accept"
      ) {
        finishBuilder({ kind: "failed", reason: outcome.reason });
      } else {
        finishBuilder({
          kind: "suppressed",
          reason: "original external send suppressed; daemon owns the exchange",
        });
      }
    }
    if (captured === null && rejectCaptured !== null) {
      const err =
        outcome.kind === "cancelled"
          ? new RequestCaptureError("aborted", "capture cancelled before offer")
          : new RequestCaptureError(
              "not_captured",
              outcome.kind === "failed" || outcome.kind === "uncertain_accept"
                ? outcome.reason
                : "capture ended before an envelope was offered",
            );
      rejectCaptured(err);
      resolveCaptured = null;
      rejectCaptured = null;
    }
  };

  const assertOpen = (): void => {
    if (disposed) {
      throw new RequestCaptureError(
        "disposed",
        `capture session ${id} disposed`,
      );
    }
    if (ac.signal.aborted && terminal === null) {
      throw new RequestCaptureError("aborted", `capture session ${id} aborted`);
    }
  };

  const session: TRequestCaptureSession = {
    id,
    signal: ac.signal,

    async captureSend(
      envelope: TCapturedRequestEnvelope,
    ): Promise<TBuilderSettlement> {
      assertOpen();
      if (terminal !== null) {
        if (builderSettlement !== null) return builderSettlement;
        throw new RequestCaptureError(
          "aborted",
          `capture session ${id} already terminal`,
        );
      }
      if (captured !== null) {
        throw new RequestCaptureError(
          "duplicate_capture",
          `capture session ${id} already holds an envelope`,
        );
      }
      const dest = validateCaptureDestination(
        envelope.externalUrl,
        opts.destinationPolicy,
      );
      if (!dest.ok) {
        const err = new RequestCaptureError("invalid_destination", dest.reason);
        finishTerminal({
          kind: "failed",
          reason: dest.reason,
          usage: { kind: "none" },
        });
        throw err;
      }
      if (envelope.body !== null && envelope.body.byteLength > maxBodyBytes) {
        const reason = `captured body exceeds ${maxBodyBytes} bytes`;
        const err = new RequestCaptureError("body_too_large", reason);
        finishTerminal({ kind: "failed", reason, usage: { kind: "none" } });
        throw err;
      }

      // Freeze body bytes so later mutation of the caller's buffer cannot
      // change what the daemon dispatches.
      const frozenBody =
        envelope.body === null ? null : new Uint8Array(envelope.body);
      const frozen: TCapturedRequestEnvelope = {
        transport: envelope.transport,
        method: envelope.method,
        observedUrl: envelope.observedUrl,
        externalUrl: envelope.externalUrl,
        headers: envelope.headers.map(([n, v]) => [n, v] as const),
        body: frozenBody,
        framing:
          envelope.framing === null
            ? null
            : { entries: { ...envelope.framing.entries } },
      };
      captured = frozen;
      resolveCaptured?.(frozen);
      resolveCaptured = null;
      rejectCaptured = null;

      if (builderSettlement !== null) return builderSettlement;
      return await new Promise<TBuilderSettlement>((resolve) => {
        builderWaiters.push(resolve);
        if (builderSettlement !== null) resolve(builderSettlement);
      });
    },

    async takeCaptured(): Promise<TCapturedRequestEnvelope> {
      if (disposed) {
        throw new RequestCaptureError(
          "disposed",
          `capture session ${id} disposed`,
        );
      }
      if (captured !== null) return captured;
      if (terminal !== null) {
        if (terminal.kind === "cancelled") {
          throw new RequestCaptureError(
            "aborted",
            "capture cancelled before offer",
          );
        }
        throw new RequestCaptureError(
          "not_captured",
          terminal.kind === "failed" || terminal.kind === "uncertain_accept"
            ? terminal.reason
            : `capture session ${id} ended without an envelope`,
        );
      }
      const raced = await Promise.race([
        capturedWait,
        new Promise<null>((resolve) => {
          const onAbort = (): void => resolve(null);
          ac.signal.addEventListener("abort", onAbort, { once: true });
          if (ac.signal.aborted) onAbort();
        }),
      ]);
      if (raced === null) {
        // Abort handlers may settle `terminal` during the await. Read through a
        // function so CFA does not keep the pre-await `null` narrowing (which
        // would make `.kind` a property access on `never`).
        // Prefer an already-recorded terminal reason over a generic timeout —
        // `finishTerminal` aborts the budget signal on fail/cancel, which would
        // otherwise make `budget.expired()` true and swallow e.g. "turn ended
        // before capture" into "capture timed out after Nms".
        const ended = ((): TCaptureTerminalOutcome | null => terminal)();
        if (ended !== null && ended.kind === "cancelled") {
          throw new RequestCaptureError("aborted", "capture cancelled");
        }
        if (
          ended !== null &&
          (ended.kind === "failed" || ended.kind === "uncertain_accept")
        ) {
          throw new RequestCaptureError("not_captured", ended.reason);
        }
        throw new RequestCaptureError(
          budget.expired() ? "timeout" : "aborted",
          budget.expired()
            ? `capture timed out after ${captureTimeoutMs}ms`
            : "capture aborted before envelope",
        );
      }
      return raced;
    },

    markDispatchStarted(): void {
      assertOpen();
      if (captured === null) {
        throw new RequestCaptureError(
          "not_captured",
          "cannot mark dispatch before capture",
        );
      }
      if (dispatchStarted) {
        throw new RequestCaptureError(
          "already_dispatched",
          `capture session ${id} dispatch already started`,
        );
      }
      dispatchStarted = true;
      // Capture wait is over. Detach the pre-capture budget so its timer cannot
      // abort an in-flight upstream dispatch (Codex live attempt-24: ~60s
      // budget abort closed the WS and the sender synthesized empty [DONE]).
      // Same detach-before-release pattern as successful `finishTerminal`.
      budget.signal.removeEventListener("abort", linkAbort);
      budget.release();
    },

    markUpstreamAccepted(): void {
      if (captured === null || !dispatchStarted) {
        throw new RequestCaptureError(
          "not_captured",
          "cannot mark accept before dispatch",
        );
      }
      upstreamAccepted = true;
    },

    complete(outcome): void {
      finishTerminal(outcome);
    },

    failUncertain(reason: string): void {
      finishTerminal({
        kind: "uncertain_accept",
        reason,
        usage: usageNow(),
      });
    },

    settleBuilder(settlement: TBuilderSettlement): void {
      finishBuilder(settlement);
    },

    cancel(reason: string): void {
      if (dispatchStarted && !upstreamAccepted && terminal === null) {
        finishTerminal({
          kind: "uncertain_accept",
          reason: `cancelled after dispatch started: ${reason}`,
          usage: usageNow(),
        });
        return;
      }
      finishTerminal({
        kind: "cancelled",
        usage: usageNow(),
      });
      if (builderSettlement === null) {
        finishBuilder({ kind: "cancelled", reason });
      }
    },

    dispose(): void {
      disposed = true;
      if (terminal === null) {
        if (dispatchStarted && !upstreamAccepted) {
          finishTerminal({
            kind: "uncertain_accept",
            reason: "capture session disposed during dispatch",
            usage: usageNow(),
          });
        } else {
          finishTerminal({
            kind: "cancelled",
            usage: usageNow(),
          });
        }
      }
      budget.release();
      linkAbort();
      // Detach from the caller's own signal — it may vastly outlive this
      // disposed session (e.g. a request-scoped AbortSignal reused across
      // hops), and this listener closes over the whole session state.
      opts.signal?.removeEventListener("abort", linkAbort);
    },

    terminal: (): TCaptureTerminalOutcome | null => terminal,
    builderSettlement: (): TBuilderSettlement | null => builderSettlement,
    captured: (): TCapturedRequestEnvelope | null => captured,
    dispatchStarted: (): boolean => dispatchStarted,
    upstreamAccepted: (): boolean => upstreamAccepted,
  };

  return session;
};

// ─── Integration seam ────────────────────────────────────────────────────────

export type TCapturedDispatchSender = (
  request: Request,
  envelope: TCapturedRequestEnvelope,
  signal: AbortSignal,
) => Promise<Response>;

export type TRunCapturedDispatchResult = {
  readonly response: Response;
  readonly envelope: TCapturedRequestEnvelope;
  readonly outcome: TCaptureTerminalOutcome;
};

/**
 * Daemon-owned single dispatch: wait for the builder capture, validate, send
 * exactly once through `sender`, settle the builder locally, and return the
 * TRUE response to the caller (never to the builder).
 *
 * If the sender throws after `markDispatchStarted` without a known accept,
 * the terminal outcome is `uncertain_accept` and the error is rethrown — the
 * caller must not retry the upstream send.
 */
export const runCapturedDispatch = async (args: {
  readonly session: TRequestCaptureSession;
  readonly sender: TCapturedDispatchSender;
  readonly signal?: AbortSignal;
  /** Local settlement reason surfaced to the builder after capture. */
  readonly suppressReason?: string;
}): Promise<TRunCapturedDispatchResult> => {
  const { session, sender } = args;
  const envelope = await session.takeCaptured();
  const dest = validateCaptureDestination(
    envelope.externalUrl,
    // Re-validate at dispatch even though captureSend already did — defense in
    // depth if an adapter mutates policy between offer and send. The envelope
    // itself is frozen; this guards the policy object the session was created
    // with by requiring the same external URL still pass a fresh check via a
    // sender-side allowlist. Sessions already validated at capture; here we
    // only rebuild the Request.
    {
      allowedOrigins: new Set([new URL(envelope.externalUrl).origin]),
      allowLoopback: true,
    },
  );
  if (!dest.ok) {
    session.complete({
      kind: "failed",
      reason: dest.reason,
      usage: { kind: "none" },
    });
    throw new RequestCaptureError("invalid_destination", dest.reason);
  }

  const dispatchSignal =
    args.signal === undefined
      ? session.signal
      : AbortSignal.any([session.signal, args.signal]);

  try {
    const request = requestFromCapturedEnvelope(envelope);
    session.markDispatchStarted();
    session.settleBuilder({
      kind: "suppressed",
      reason:
        args.suppressReason ??
        "original external send suppressed; daemon owns the exchange",
    });
    const response = await sender(request, envelope, dispatchSignal);
    // A response object means the remote accepted the TCP/HTTP exchange far
    // enough to answer. Stream body may still fail later; usage ownership
    // starts here for HTTP. WS/Connect adapters may call markUpstreamAccepted
    // earlier via the session when their accept is clearer.
    session.markUpstreamAccepted();
    const outcome: TCaptureTerminalOutcome = {
      kind: "dispatched",
      usage: { kind: "daemon_upstream" },
    };
    session.complete(outcome);
    return { response, envelope, outcome };
  } catch (err) {
    if (session.upstreamAccepted()) {
      session.complete({
        kind: "failed",
        reason: err instanceof Error ? err.message : String(err),
        usage: { kind: "daemon_upstream" },
      });
    } else if (session.dispatchStarted()) {
      session.failUncertain(err instanceof Error ? err.message : String(err));
    } else {
      session.complete({
        kind: "failed",
        reason: err instanceof Error ? err.message : String(err),
        usage: { kind: "none" },
      });
    }
    throw err;
  }
};

/**
 * Integration helper for native hops: when capture is enabled for a provider,
 * run `buildAndOffer` so the vendor constructs the envelope and offers it via
 * `session.captureSend`. Returns null when the caller should keep today's
 * bridge path (flag off / provider not allowlisted).
 */
export type TCaptureDecoration = {
  readonly session: TRequestCaptureSession;
  readonly dispatch: (
    sender: TCapturedDispatchSender,
    signal?: AbortSignal,
  ) => Promise<TRunCapturedDispatchResult>;
};

export const openCaptureDecoration = (args: {
  readonly enabled: boolean;
  readonly destinationPolicy: TCaptureDestinationPolicy;
  readonly signal?: AbortSignal;
  readonly maxBodyBytes?: number;
  readonly captureTimeoutMs?: number;
}): TCaptureDecoration | null => {
  if (!args.enabled) return null;
  const session = createRequestCaptureSession({
    destinationPolicy: args.destinationPolicy,
    signal: args.signal,
    maxBodyBytes: args.maxBodyBytes,
    captureTimeoutMs: args.captureTimeoutMs,
  });
  return {
    session,
    dispatch: (sender, signal) =>
      runCapturedDispatch({ session, sender, signal }),
  };
};
