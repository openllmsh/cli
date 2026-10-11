/**
 * Serving-side realtime dispatch — binds ONE `realtime-session.ts` vendor
 * session to whichever transport a consumer used to reach it:
 *
 *  - `serveMuxRealtime` — the mux `kind:"realtime"` path (browser via the
 *    cloud relay / RTC, or a fleet-peer daemon). Wired into
 *    `mux-host.ts`'s `serveMuxOnStream`. Events ride NDJSON-framed over the
 *    mux DATA channel (`pumpRealtimeEvents` / `sendRealtimeEvent`).
 *
 *  - `localRealtimeWebSocket` — the authenticated LOCAL `/v1/realtime`
 *    WebSocket (`main.ts`'s upgrade wiring), for non-browser clients on this
 *    machine. Native WS message framing already preserves one-event-per-
 *    message, so no NDJSON framing is needed here — one JSON text message
 *    IS one event, mirroring the vendor's own wire shape.
 *
 * Browsers reach realtime ONLY through the mux path (already gated by
 * channel/device-grant/seedgate auth at the relay). The local WS path is
 * deliberately NOT reachable from a browser: `authorizeLocalRealtimeRequest`
 * requires an `Authorization: Bearer <key>` header, which the WebSocket
 * browser API cannot set on the handshake — only a non-browser client
 * (a script, the openllm CLI) can supply it. See `main.ts` for where the
 * request is rejected (401) BEFORE the upgrade.
 */
import type {
  TRealtimeClientEvent,
  TRealtimeStreamOpenPayload,
} from "@openllmsh/protocol";
import {
  parseRealtimeClientEvent,
  REALTIME_MAX_QUEUED_EVENTS,
  RealtimeStreamOpenPayload,
} from "@openllmsh/protocol";
import { encodeJsonPayload } from "@openllmsh/tunnel/codec";
import type { TMuxStream } from "@openllmsh/tunnel/mux";
import type { TServeRealtime } from "@openllmsh/tunnel/streams";
import {
  pumpRealtimeEvents,
  sendRealtimeEvent,
} from "@openllmsh/tunnel/streams";
import { Either, Schema } from "effect";
import { daemonEnv } from "./env";
import type { TRealtimeSessionHandle } from "./realtime-session";
import { openRealtimeSession } from "./realtime-session";

const resetPayload = (code: string, message?: string): Uint8Array =>
  encodeJsonPayload({ code, ...(message === undefined ? {} : { message }) });

// ---------------------------------------------------------------------------
// Mux-serving path (browser via relay/RTC, or a fleet-peer daemon)
// ---------------------------------------------------------------------------

/** Daemon adapter for the generic mux serving seam — wired into
 *  `mux-host.ts`'s `serveMuxOnStream({ realtime: serveMuxRealtime, ... })`. */
export const serveMuxRealtime: TServeRealtime = async (
  stream: TMuxStream,
  open: TRealtimeStreamOpenPayload,
): Promise<void> => {
  const result = await openRealtimeSession(open, {
    onServerEvent: (event) => sendRealtimeEvent(stream, event),
    onClose: (code) => {
      if (code === "done") stream.end();
      else stream.reset(resetPayload(code));
    },
  });
  if (!result.ok) {
    stream.reset(resetPayload(result.refused));
    return;
  }
  stream.sendCtrl(encodeJsonPayload({ t: "open_ack", ok: true }));
  const offEvents = pumpRealtimeEvents(
    stream,
    parseRealtimeClientEvent,
    (event) => result.session.sendClientEvent(event),
    () =>
      stream.reset(resetPayload("lagging", "realtime event line too large")),
  );
  // Either teardown direction closes the upstream exactly once (`close()` on
  // `openRealtimeSession`'s handle is idempotent) — no orphaned upstream
  // socket survives a consumer that just vanishes.
  const teardown = (): void => {
    offEvents();
    result.session.close();
  };
  stream.onReset(teardown);
  stream.onEnd(teardown);
};

// ---------------------------------------------------------------------------
// Local `/v1/realtime` WebSocket (authenticated, non-browser clients)
// ---------------------------------------------------------------------------

/**
 * `Authorization: Bearer <sk-llm-key>` — the SAME convention `/v1/*` HTTP
 * already uses on this daemon (`cors.ts`: "the `/v1/*` surface takes
 * `Authorization: Bearer sk-llm-…`"). A browser's `WebSocket` constructor
 * cannot set this header on the handshake, so this check alone keeps the
 * route non-browser — it is not an incidental gate, it is THE gate. No key
 * configured on this daemon means no local realtime client either.
 */
export const authorizeLocalRealtimeRequest = (req: Request): boolean => {
  const configured = daemonEnv().apiKey;
  if (configured === null) return false;
  return req.headers.get("authorization") === `Bearer ${configured}`;
};

const decodeRealtimeOpen = Schema.decodeUnknownEither(
  RealtimeStreamOpenPayload,
);

/**
 * Parse `?provider=&model=&voice=` on the local `/v1/realtime` upgrade
 * request into the same closed-vocabulary struct the mux OPEN uses — one
 * schema, two transports. Returns null on any missing/unsupported value;
 * the caller answers 400 and never upgrades.
 */
export const parseLocalRealtimeOpen = (
  url: URL,
): TRealtimeStreamOpenPayload | null => {
  const candidate = {
    kind: "realtime",
    provider: url.searchParams.get("provider") ?? undefined,
    model: url.searchParams.get("model") ?? undefined,
    voice: url.searchParams.get("voice") ?? undefined,
  };
  const result = decodeRealtimeOpen(candidate);
  return Either.isRight(result) ? result.right : null;
};

export type TLocalRealtimeSocketData = {
  readonly open: TRealtimeStreamOpenPayload;
  handle: TRealtimeSessionHandle | null;
  /** Set the moment the LOCAL socket closes. Admission (`openRealtimeSession`)
   *  is async, so the socket can close while it's still in flight — `closed`
   *  is what lets the completion callback below tell that apart from a
   *  handle that simply hasn't arrived yet. */
  closed: boolean;
  /**
   * Client events received BEFORE `handle` exists. Unlike the mux-serving
   * path (`serveMuxRealtime`), which never starts reading the stream's
   * inbound events until `openRealtimeSession` has already resolved and
   * sent `open_ack`, the local WS is upgraded — and therefore accepting
   * client sends — the moment `main.ts` calls `server.upgrade`, well before
   * the async admission chain (cloud plan fetch, then the delegate's
   * `credentialForRealtime`) settles. A client that sends its opening
   * `session.update`/`conversation.item.create` right after `onopen` (the
   * documented, expected usage — see `lib/realtime-voice-client.ts`) races
   * ahead of that admission and would otherwise be silently dropped by
   * `message` below, since `handle` is still `null`. Bounded the same as
   * the outbound queue (`REALTIME_MAX_QUEUED_EVENTS`) — a client opening a
   * session sends a handful of setup events, never an unbounded stream,
   * before it has any server event telling it to stop.
   */
  pending: TRealtimeClientEvent[];
};

/**
 * `Bun.serve({ websocket })` handlers for the local realtime upgrade.
 * `main.ts` validates + parses the request and only calls `server.upgrade`
 * with `data: { open, handle: null, closed: false }` once
 * `authorizeLocalRealtimeRequest` and `parseLocalRealtimeOpen` both succeed —
 * this object never sees an unauthenticated or malformed open.
 */
export const localRealtimeWebSocket = {
  open: (socket: Bun.ServerWebSocket<TLocalRealtimeSocketData>): void => {
    void openRealtimeSession(socket.data.open, {
      onServerEvent: (event) => {
        socket.sendText(JSON.stringify(event));
      },
      onClose: (code) => {
        socket.close(code === "done" ? 1000 : 1011, code);
      },
    }).then((result) => {
      if (!result.ok) {
        socket.sendText(
          JSON.stringify({ type: "error", code: result.refused }),
        );
        socket.close(1011, result.refused);
        return;
      }
      // The LOCAL socket may already have closed by the time the (async)
      // upstream dial settles. `close` below only ever tears down a handle
      // it actually SEES — a socket that closed before this point already
      // ran through `close` with `socket.data.handle` still `null`, so it
      // never called `.close()` on this session at all. Stashing the handle
      // here regardless would leak a live upstream connection forever (no
      // consumer transport left to eventually close it). Close it now
      // instead of storing it whenever the socket is already gone.
      if (socket.data.closed) {
        result.session.close();
        return;
      }
      socket.data.handle = result.session;
      // Flush, IN ORDER, whatever the client already sent while admission
      // was still in flight (see `pending`'s doc on `TLocalRealtimeSocketData`)
      // — a client that opened and immediately sent `session.update` must
      // not have that setup event silently dropped just because it won the
      // race against the daemon's own async admission chain.
      if (socket.data.pending.length > 0) {
        const queued = socket.data.pending;
        socket.data.pending = [];
        for (const event of queued) result.session.sendClientEvent(event);
      }
    });
  },
  message: (
    socket: Bun.ServerWebSocket<TLocalRealtimeSocketData>,
    message: string | Buffer,
  ): void => {
    if (typeof message !== "string") return; // audio input is unmodeled (see protocol/realtime.ts)
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const event = parseRealtimeClientEvent(parsed);
    if (event === null) {
      socket.sendText(
        JSON.stringify({ type: "error", code: "unsupported_event" }),
      );
      return;
    }
    if (socket.data.handle !== null) {
      socket.data.handle.sendClientEvent(event);
      return;
    }
    // Admission hasn't resolved yet — queue rather than drop (see `pending`'s
    // doc). Bounded exactly like the outbound queue: a client racing ahead of
    // admission with more than this many setup events before any server
    // event has told it to stop is treated as `lagging`, the same verdict a
    // slow-consumer overflow gets on the outbound side.
    if (socket.data.pending.length >= REALTIME_MAX_QUEUED_EVENTS) {
      socket.sendText(JSON.stringify({ type: "error", code: "lagging" }));
      socket.close(1011, "lagging");
      return;
    }
    socket.data.pending.push(event);
  },
  close: (socket: Bun.ServerWebSocket<TLocalRealtimeSocketData>): void => {
    // Mark closed BEFORE touching any existing handle, so the `open` handler
    // above — running concurrently on the still-in-flight admission promise
    // — can tell a socket that closed just now from one that never will.
    socket.data.closed = true;
    socket.data.handle?.close();
  },
};
