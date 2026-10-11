/**
 * ONE vendor realtime (voice) session — the local-only counterpart to
 * `image-walker.ts` / `video-walker.ts`, but duplex and long-lived instead of
 * request/response. Dials the provider's realtime WebSocket using the
 * delegate's `credentialForRealtime` (never a fabricated/exported token),
 * forwards the already-schema-validated client-event subset upstream
 * verbatim, and normalizes vendor events back through
 * `parseRealtimeServerEvent` before handing them to the caller — an
 * unrecognized vendor event is DROPPED, never relayed blind.
 *
 * Transport-agnostic on purpose: `realtime-handler.ts` adapts this to BOTH
 * the mux-serving path (browser/fleet via `TServeRealtime`) and the local
 * authenticated `/v1/realtime` WebSocket (non-browser loopback clients) —
 * one session core, two consumer transports. Putting the cloud
 * plan/policy gate (below) HERE, not in either transport adapter, is what
 * makes both transports share exactly one entitlement check — a browser
 * reaching this daemon over the mux/relay path is held to the SAME
 * account/model gate a same-machine 307 or the local-first-gateway direct
 * path enforces (`fetchPlan` + `planSignatureOk`, `walker.ts`); neither
 * transport can reach the vendor dial without passing it.
 *
 * No live network call happens anywhere in this module's OWN test suite —
 * `setRealtimeUpstreamFactory` swaps in a fake socket and
 * `setRealtimePlanCheckerForTests` swaps in a fake policy decision.
 * Production dials the real vendor URL/headers the delegate mints; this
 * daemon never constructs that URL itself (no arbitrary upstream targets).
 * The closing `report(...)` call's own network write (`recordRequest`,
 * `walker.ts`) is fire-and-forget exactly like every other subscription
 * surface's usage row — this module's tests don't mock it, matching
 * `audio-walker.ts`/`image-walker.ts`'s existing test convention.
 */
import type {
  TRealtimeClientEvent,
  TRealtimeServerEvent,
  TRealtimeStreamOpenPayload,
  TStreamResetCode,
} from "@openllmsh/protocol";
import {
  parseRealtimeServerEvent,
  REALTIME_MAX_QUEUED_EVENTS,
  REALTIME_SESSION_MAX_LIFETIME_MS,
} from "@openllmsh/protocol";
import { fetchPlan } from "./cloud-client";
import { getDelegate, isSubscriptionSlug } from "./delegation";
import { logWarn } from "./logger";
import { parsePlan, planSignatureOk, report } from "./walker";

// ---------------------------------------------------------------------------
// Cloud policy gate — the SAME account/entitlement check every other
// subscription surface enforces before a vendor dial
// ---------------------------------------------------------------------------

export type TRealtimePlanAuthorization =
  | { readonly ok: true; readonly origin: string | null }
  | { readonly ok: false };

/**
 * Ask the cloud to resolve + sign a plan for `${open.provider}/${open.model}`
 * — the SAME `GET /api/daemon/plan` every other subscription surface uses
 * (`fetchPlan`, `docs/proposals/local-first-gateway.md` §4.1) — and verify it
 * locally with `planSignatureOk`, exactly like `audio-walker.ts` /
 * `image-walker.ts`'s `requirePlanned`. Metadata only: no audio, text, or
 * client event ever rides this call.
 *
 * This is the ONE gate both transports share (`localRealtimeWebSocket` and
 * `serveMuxRealtime` both bottom out in `openRealtimeSession` below), so a
 * browser reaching the daemon over the mux/relay path is held to exactly the
 * account entitlement a same-machine 307 would enforce — neither transport
 * gets to skip it. Fails CLOSED on any unreachable/unsigned/mismatched
 * response: an unresolvable plan is refused, never treated as "unsigned dev
 * mode" (that leniency lives inside `planSignatureOk` itself, for a daemon
 * with no signing key configured at all).
 */
const authorizeRealtimeOpenViaCloudPlan = async (
  open: TRealtimeStreamOpenPayload,
): Promise<TRealtimePlanAuthorization> => {
  let fetched: Awaited<ReturnType<typeof fetchPlan>>;
  try {
    fetched = await fetchPlan(`${open.provider}/${open.model}`, 0);
  } catch {
    return { ok: false };
  }
  const overflow = fetched.context_overflow_strategy ?? null;
  if (
    !planSignatureOk(
      fetched.plan,
      fetched.pmids,
      fetched.origin,
      overflow,
      fetched.sig,
    )
  ) {
    return { ok: false };
  }
  // Strict identity: the cloud's FIRST (and, for realtime, only) resolved
  // hop must be EXACTLY the provider/model this OPEN asked for — never a
  // different hop the account happens to also be entitled to via fallback,
  // and never a multi-hop chain (realtime is single-hop only — see
  // `protocol/realtime.ts`'s closed provider/model literals).
  const hops = parsePlan(fetched.plan);
  if (hops[0] !== `${open.provider}/${open.model}`) return { ok: false };
  if (!isSubscriptionSlug(open.provider)) return { ok: false };
  return { ok: true, origin: fetched.origin };
};

export type TRealtimePlanChecker = (
  open: TRealtimeStreamOpenPayload,
) => Promise<TRealtimePlanAuthorization>;

let planChecker: TRealtimePlanChecker = authorizeRealtimeOpenViaCloudPlan;

/** Test seam ONLY — never call this from production code. `null` restores
 *  the real cloud-plan checker. Mirrors `setRealtimeUpstreamFactory` below. */
export const setRealtimePlanCheckerForTests = (
  fn: TRealtimePlanChecker | null,
): void => {
  planChecker = fn ?? authorizeRealtimeOpenViaCloudPlan;
};

/** Beyond this many concurrent realtime sessions, admission answers
 *  `realtime_busy` — voice sessions are heavier than a JSON tunnel hop, so
 *  the cap is intentionally tighter than `MAX_SERVED_TUNNELS`. */
const MAX_CONCURRENT_REALTIME_SESSIONS = 4;
let activeSessions = 0;

/** Synchronous reserve — no `await` between the capacity check and the
 *  increment, so two concurrent opens can never both slip past the cap. */
const reserveRealtimeSession = (): boolean => {
  if (activeSessions >= MAX_CONCURRENT_REALTIME_SESSIONS) return false;
  activeSessions += 1;
  return true;
};
const releaseRealtimeSession = (): void => {
  activeSessions = Math.max(0, activeSessions - 1);
};

/** Test-only observability seam. */
export const activeRealtimeSessionCount = (): number => activeSessions;

/** Test-only reset — production never calls this; the count only ever
 *  changes via `reserveRealtimeSession`/`releaseRealtimeSession`. */
export const resetActiveRealtimeSessionsForTests = (): void => {
  activeSessions = 0;
};

// ---------------------------------------------------------------------------
// Injectable upstream transport (production: a real WebSocket to the vendor)
// ---------------------------------------------------------------------------

export type TRealtimeUpstreamSocket = {
  readonly send: (data: string) => void;
  readonly close: () => void;
};

export type TRealtimeUpstreamHandlers = {
  readonly onMessage: (data: string) => void;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
  /**
   * Fires once the transport has actually completed its handshake with the
   * vendor (the WebSocket's own `open` event) — distinct from
   * `upstreamFactory`'s call RETURNING, which happens the instant the
   * transport object is constructed, before any network round trip to the
   * vendor completes. `openRealtimeSession` queues `sendClientEvent` calls
   * until this fires (see its `outboundQueue`) — a test fake standing in for
   * an already-connected transport should call it synchronously, before
   * returning, so queued sends flush immediately.
   */
  readonly onOpen?: () => void;
};

export type TRealtimeUpstreamFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
  handlers: TRealtimeUpstreamHandlers,
) => TRealtimeUpstreamSocket;

const defaultUpstreamFactory: TRealtimeUpstreamFactory = (
  url,
  headers,
  handlers,
) => {
  // Bun's `WebSocket` accepts a `headers` option (a Bun-only extension) to
  // carry the bearer credential the vendor requires at connect time — a
  // browser CANNOT do this, which is exactly why this transport is
  // daemon-only (see `realtime-handler.ts`'s local-WS auth gate).
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  socket.onopen = (): void => handlers.onOpen?.();
  socket.onmessage = (event: MessageEvent): void => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  };
  socket.onerror = (event: Event): void => handlers.onError?.(event);
  socket.onclose = (): void => handlers.onClose();
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
};

let upstreamFactory: TRealtimeUpstreamFactory = defaultUpstreamFactory;

/** Test seam ONLY — never call this from production code. `null` restores
 *  the real WebSocket factory. */
export const setRealtimeUpstreamFactory = (
  fn: TRealtimeUpstreamFactory | null,
): void => {
  upstreamFactory = fn ?? defaultUpstreamFactory;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type TRealtimeSessionHandlers = {
  /** Deliver ONE normalized server event to the consumer transport. May
   *  return a promise the bounded queue below awaits for backpressure. */
  readonly onServerEvent: (event: TRealtimeServerEvent) => void | Promise<void>;
  /** Fires exactly once, however the session ends. */
  readonly onClose: (code: TStreamResetCode | "done") => void;
};

export type TRealtimeSessionHandle = {
  /** Forward an already-validated client event upstream verbatim. No-op
   *  once the session has ended. */
  readonly sendClientEvent: (event: TRealtimeClientEvent) => void;
  /** Consumer-initiated graceful end (mirrors a PTY session's `detach`). */
  readonly close: () => void;
};

export type TRealtimeSessionResult =
  | { readonly ok: true; readonly session: TRealtimeSessionHandle }
  | { readonly ok: false; readonly refused: TStreamResetCode };

/**
 * Open one realtime session for `open.provider`. Admission order:
 * capacity → cloud plan/policy (account entitlement, `planChecker`) →
 * delegate exposes `credentialForRealtime` → a usable (non-stale) credential.
 * Only past all four does an upstream socket get created. The policy check
 * runs BEFORE the daemon ever asks its delegate for a credential, so an
 * unentitled OPEN never even reveals whether this box has a usable
 * subscription for that provider.
 */
export const openRealtimeSession = async (
  open: TRealtimeStreamOpenPayload,
  handlers: TRealtimeSessionHandlers,
  inbound?: Headers,
): Promise<TRealtimeSessionResult> => {
  if (!reserveRealtimeSession()) {
    return { ok: false, refused: "realtime_busy" };
  }

  const authorization = await planChecker(open);
  if (!authorization.ok) {
    releaseRealtimeSession();
    return { ok: false, refused: "realtime_policy_refused" };
  }

  const delegate = getDelegate(open.provider);
  if (delegate?.credentialForRealtime === undefined) {
    releaseRealtimeSession();
    return { ok: false, refused: "realtime_unsupported" };
  }

  let cred: Awaited<
    ReturnType<NonNullable<typeof delegate.credentialForRealtime>>
  >;
  try {
    cred = await delegate.credentialForRealtime(inbound);
  } catch {
    releaseRealtimeSession();
    return { ok: false, refused: "realtime_refused" };
  }
  if (cred.stale_refresh !== undefined) {
    releaseRealtimeSession();
    return { ok: false, refused: "realtime_refused" };
  }

  // Real wall-clock duration for the audit row below — never a fabricated
  // token count (this session reports 0/0 tokens; the cloud has no per-event
  // pricing for voice audio yet, so `report`'s usage-calibration side effect
  // is a no-op for a zero-token row, but the request ROW itself still lands
  // so a served realtime session is never invisible to account activity).
  const startedAt = Date.now();
  let closed = false;
  let released = false;
  // Declared here (not at their point of assignment below) and left OPTIONAL
  // on purpose: `upstreamFactory` can synchronously invoke `onClose` (and
  // thus `finish`) from inside its own construction call — a fake factory in
  // tests does this deliberately, and a real vendor transport can too on an
  // immediate connect failure. If `finish` referenced `const upstream` /
  // `const lifetimeTimer` declared after this point, that synchronous
  // reentrancy would hit them in the temporal dead zone and throw. Optional
  // + assigned-not-redeclared below keeps `finish` safe no matter when it
  // first runs.
  let upstream: TRealtimeUpstreamSocket | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseRealtimeSession();
  };
  const finish = (code: TStreamResetCode | "done"): void => {
    if (closed) return;
    closed = true;
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    outboundQueue.length = 0;
    release();
    try {
      upstream?.close();
    } catch {
      // Already-closed transport — nothing to do.
    }
    report(
      {
        model: open.model,
        provider: open.provider,
        status: code === "done" || code === "peer_gone" ? "success" : "error",
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: Date.now() - startedAt,
        endpoint: "/v1/realtime",
        ...(cred.account_hash !== undefined
          ? { account_hash: cred.account_hash }
          : {}),
      },
      authorization.origin,
    );
    handlers.onClose(code);
  };

  // Bounded outbound queue: the upstream can outrun a slow consumer
  // transport. Rather than buffer without limit, cap in-flight deliveries
  // and end the session (`lagging`) once the consumer falls behind — the
  // realtime counterpart of the PTY session's bounded output queue.
  let inFlight = 0;
  let overflowed = false;
  const deliver = (event: TRealtimeServerEvent): void => {
    if (closed || overflowed) return;
    if (inFlight >= REALTIME_MAX_QUEUED_EVENTS) {
      overflowed = true;
      finish("lagging");
      return;
    }
    inFlight += 1;
    void Promise.resolve(handlers.onServerEvent(event)).finally(() => {
      inFlight -= 1;
    });
  };

  // Bounded OUTBOUND queue: `sendClientEvent` can be called the instant this
  // function's promise resolves (both consumer transports do exactly that —
  // the local WS's `open` handler stashes the handle as soon as admission
  // settles, and `serveMuxRealtime` starts pumping right after), which is
  // BEFORE the just-constructed `upstream` socket has actually completed its
  // own handshake with the vendor. Calling `.send()` on a not-yet-open
  // WebSocket throws synchronously — this used to surface as an immediate
  // `dispatch_failed` on every session, caught live: a probe against the
  // real Grok realtime endpoint through this exact path opened, received
  // `session.created`, and then the FIRST client-sent `session.update`
  // ended the session with `dispatch_failed` before the vendor ever saw it.
  // Queue until `onOpen` fires; bounded like the inbound `deliver` queue
  // above, for the same reason (a caller that never gets a chance to slow
  // down must not grow this without limit).
  let upstreamReady = false;
  const outboundQueue: string[] = [];
  const flushOutbound = (): void => {
    upstreamReady = true;
    // The session may have already ended (e.g. `lagging` from the bound
    // below, or any other `finish`) by the time a belated `onOpen` fires —
    // never replay a stale queue onto a socket nothing is consuming for
    // anymore.
    if (closed) {
      outboundQueue.length = 0;
      return;
    }
    while (outboundQueue.length > 0) {
      const data = outboundQueue.shift();
      if (data === undefined) break;
      try {
        upstream?.send(data);
      } catch {
        finish("dispatch_failed");
        return;
      }
    }
  };

  try {
    upstream = upstreamFactory(
      cred.url,
      { ...cred.headers, authorization: `Bearer ${cred.access_token}` },
      {
        onOpen: flushOutbound,
        onMessage: (data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          // Unknown/unsupported vendor events are dropped, never forwarded
          // verbatim — the closed vocabulary in `@openllmsh/protocol/realtime`
          // is the entire supported subset (see
          // docs/research/subscription-provider-capabilities-2026-09-17.md).
          const event = parseRealtimeServerEvent(parsed);
          if (event !== null) deliver(event);
        },
        onError: () => {
          logWarn("realtime", "upstream realtime socket error", {
            provider: open.provider,
          });
        },
        onClose: () => finish("peer_gone"),
      },
    );
  } catch {
    // A SYNCHRONOUS throw from the factory itself (e.g. an invalid URL, or a
    // test fake) never reached `finish`/`release` above — nothing else in
    // this function will ever call them for this attempt, so without this
    // catch the reserved session slot (`reserveRealtimeSession` above) leaks
    // forever and the caller sees a thrown exception instead of the same
    // `TRealtimeSessionResult` refusal shape every other admission failure
    // in this function returns. No upstream object exists yet, so there is
    // nothing to close and no report to file (matches the
    // `credentialForRealtime` throw path just above, which also releases and
    // refuses without reporting).
    release();
    return { ok: false, refused: "realtime_refused" };
  }

  if (closed) {
    // `finish` already ran SYNCHRONOUSLY from inside the factory call above
    // (its own `upstream?.close()` was a no-op then — `upstream` wasn't
    // assigned yet). The real socket now exists but nothing has closed it:
    // close it here so a synchronous construction failure can never leak a
    // live upstream connection, and never arm a lifetime timer for a session
    // that is already over.
    try {
      upstream.close();
    } catch {
      // Already-closed transport — nothing to do.
    }
  } else {
    lifetimeTimer = setTimeout(() => {
      finish("timeout");
    }, REALTIME_SESSION_MAX_LIFETIME_MS);
  }

  return {
    ok: true,
    session: {
      sendClientEvent: (event) => {
        if (closed) return;
        const data = JSON.stringify(event);
        if (!upstreamReady) {
          if (outboundQueue.length >= REALTIME_MAX_QUEUED_EVENTS) {
            finish("lagging");
            return;
          }
          outboundQueue.push(data);
          return;
        }
        try {
          upstream?.send(data);
        } catch {
          finish("dispatch_failed");
        }
      },
      close: () => finish("done"),
    },
  };
};
