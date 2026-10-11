/**
 * A bounded, one-shot client for Claude Code's native dictation WebSocket
 * (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`), verified
 * live (foundation research, ac06f4cb): connect with the bearer + identity
 * headers, send `{"type":"KeepAlive"}`, stream mono 16-bit 16kHz PCM in
 * binary frames, send `{"type":"CloseStream"}`, then read `TranscriptText` /
 * `TranscriptInterim` / `TranscriptEndpoint` / `TranscriptError` until the
 * endpoint (or socket close) finalizes the transcript.
 *
 * The transport is injectable (`wsFactory`) so this module is unit-testable
 * with a fake socket — no live network in tests, matching the coordinator's
 * "no live provider calls until post-review" constraint.
 */
import { PCM_S16LE_16K_MONO_BYTES_PER_SECOND } from "./pcm";

/** The minimal WebSocket surface this module needs — satisfied by the
 *  global `WebSocket` (Bun/Node) or a test fake. */
export type TWebSocketLike = {
  readonly readyState: number;
  send: (data: string | ArrayBufferLike | Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (
    type: "open" | "message" | "close" | "error",
    listener: (event: {
      readonly data?: unknown;
      readonly code?: number;
      readonly reason?: string;
    }) => void,
  ) => void;
  removeEventListener: (
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ) => void;
};

export type TWebSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => TWebSocketLike;

const WS_OPEN = 1;

/** Bun's global `WebSocket` client accepts a `headers` option (a runtime
 *  extension beyond the browser spec, not in the lib.dom.d.ts `WebSocket`
 *  type) — this local constructor signature types that extension WITHOUT
 *  `any`. This is the ONLY place that binds to it, so a test never needs
 *  the real network stack. */
type TBunWebSocketCtor = new (
  url: string,
  options?: { readonly headers?: Readonly<Record<string, string>> },
) => TWebSocketLike;

export const defaultWsFactory: TWebSocketFactory = (url, headers) =>
  new (WebSocket as unknown as TBunWebSocketCtor)(url, { headers });

export type TTranscriptEvent =
  | { readonly type: "interim"; readonly text: string }
  | { readonly type: "final"; readonly text: string }
  | { readonly type: "endpoint" }
  | { readonly type: "error"; readonly message: string };

/** Lenient parse of one dictation WS text frame. Unknown message types are
 *  ignored rather than treated as errors — the research recipe warns a
 *  production adapter must tolerate native message types beyond the ones it
 *  acts on.
 *
 *  Field name, verified live (2026-09-17 spoken-phrase capability re-test):
 *  the real `TranscriptText`/`TranscriptInterim` payload carries the
 *  transcript under `data` — `{"type":"TranscriptText","data":"Capability
 *  test. One, two, three."}` — not `text`/`transcript`. Checking only
 *  `text`/`transcript` (the foundation research's own written recipe never
 *  pinned the exact field name, only the message `type`s) meant every real
 *  session fell through to `""` and finalized with an empty transcript
 *  despite a clean 200/`TranscriptEndpoint` close — the reported "200 empty
 *  text" bug. `data` is checked last so a future/other build that does key
 *  it under `text`/`transcript` keeps working unchanged. */
export const parseDictationMessage = (raw: string): TTranscriptEvent | null => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const msg = json as Record<string, unknown>;
  const text =
    typeof msg.text === "string"
      ? msg.text
      : typeof msg.transcript === "string"
        ? msg.transcript
        : typeof msg.data === "string"
          ? msg.data
          : "";
  switch (msg.type) {
    case "TranscriptText":
      return { type: "final", text };
    case "TranscriptInterim":
      return { type: "interim", text };
    case "TranscriptEndpoint":
      return { type: "endpoint" };
    case "TranscriptError":
      return {
        type: "error",
        message:
          typeof msg.message === "string" ? msg.message : "transcript error",
      };
    default:
      return null;
  }
};

export type TClaudeDictationOptions = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly pcm: Uint8Array;
  /** Frames to send, in order (see `framePcm`). */
  readonly frames: ReadonlyArray<Uint8Array>;
  readonly wsFactory?: TWebSocketFactory;
  /** Awaited between frames — real time by default, a no-op in tests. */
  readonly pace?: (ms: number) => Promise<void>;
  readonly frameIntervalMs?: number;
  readonly openTimeoutMs?: number;
  readonly finalizeTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Silent PCM padding sent AFTER the real frames and BEFORE `CloseStream`
   * — the verified research recipe explicitly calls this out ("Send
   * silence at the tail, then CloseStream") and the connection's own
   * `utterance_end_ms`/`endpointing_ms` query params need a quiet tail to
   * detect the end of the utterance. Bursting straight into `CloseStream`
   * starves that VAD window and the vendor never emits a final transcript
   * for a short clip. Defaults to 0 (no padding) so existing callers/tests
   * that assert an exact `frames` → `CloseStream` sequence are unaffected;
   * the production caller (`audio-walker.ts`) sets this explicitly.
   */
  readonly trailingSilenceMs?: number;
};

export type TClaudeDictationResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

const realPace = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one full bounded dictation session: connect, KeepAlive, stream every
 * frame, CloseStream, collect the transcript. Resolves `error` (never
 * throws) on connect failure, an upstream `TranscriptError`, or a
 * finalize timeout so the caller can turn it into a clean HTTP response.
 */
export const runClaudeDictationSession = (
  options: TClaudeDictationOptions,
): Promise<TClaudeDictationResult> =>
  new Promise<TClaudeDictationResult>((resolve) => {
    const wsFactory = options.wsFactory ?? defaultWsFactory;
    const pace = options.pace ?? realPace;
    const openTimeoutMs = options.openTimeoutMs ?? 10_000;
    const finalizeTimeoutMs = options.finalizeTimeoutMs ?? 30_000;
    let settled = false;
    let lastFinalText = "";
    let ws: TWebSocketLike;

    const finish = (result: TClaudeDictationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(finalizeTimer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // already closing/closed
      }
      resolve(result);
    };

    const onAbort = (): void => finish({ kind: "error", message: "aborted" });
    if (options.signal?.aborted === true) {
      // No socket to close yet — resolve directly.
      resolve({ kind: "error", message: "aborted" });
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const openTimer = setTimeout(() => {
      finish({ kind: "error", message: "dictation connection timed out" });
    }, openTimeoutMs);
    let finalizeTimer: ReturnType<typeof setTimeout>;

    try {
      ws = wsFactory(options.url, options.headers);
    } catch (err) {
      clearTimeout(openTimer);
      resolve({
        kind: "error",
        message: err instanceof Error ? err.message : "failed to open socket",
      });
      return;
    }

    const armFinalizeTimeout = (): void => {
      finalizeTimer = setTimeout(() => {
        // No TranscriptEndpoint arrived — serve what we collected so far
        // rather than hang; empty means the vendor never transcribed anything.
        finish(
          lastFinalText.length > 0
            ? { kind: "ok", text: lastFinalText }
            : { kind: "error", message: "dictation finalize timed out" },
        );
      }, finalizeTimeoutMs);
    };

    const frameIntervalMs = options.frameIntervalMs ?? 100;
    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      void (async (): Promise<void> => {
        try {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
          // Paced roughly real-time (matching the verified ~100ms-chunk
          // recipe) so the vendor's endpointing (`endpointing_ms` /
          // `utterance_end_ms`) sees the same cadence a live mic would —
          // bursting the whole file instantly races that VAD window.
          for (const frame of options.frames) {
            if (settled) return;
            if (frame.byteLength > 0) ws.send(frame);
            await pace(frameIntervalMs);
          }
          const trailingSilenceMs = options.trailingSilenceMs ?? 0;
          if (trailingSilenceMs > 0) {
            const bytesPerMs = PCM_S16LE_16K_MONO_BYTES_PER_SECOND / 1000;
            // Keep the silence frame 16-bit-aligned (even byte count),
            // matching `framePcm`'s own alignment.
            const frameBytes = Math.max(
              2,
              Math.floor((bytesPerMs * frameIntervalMs) / 2) * 2,
            );
            const silenceFrame = new Uint8Array(frameBytes);
            const silenceFrameCount = Math.ceil(
              trailingSilenceMs / frameIntervalMs,
            );
            for (let i = 0; i < silenceFrameCount; i++) {
              if (settled) return;
              ws.send(silenceFrame);
              await pace(frameIntervalMs);
            }
          }
          if (settled) return;
          ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch (err) {
          finish({
            kind: "error",
            message: err instanceof Error ? err.message : "send failed",
          });
          return;
        }
        armFinalizeTimeout();
      })();
    });

    ws.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data !== "string") return; // binary frames aren't expected inbound
      const parsed = parseDictationMessage(data);
      if (parsed === null) return;
      if (parsed.type === "final") {
        lastFinalText = parsed.text;
      } else if (parsed.type === "endpoint") {
        finish({ kind: "ok", text: lastFinalText });
      } else if (parsed.type === "error") {
        finish({ kind: "error", message: parsed.message });
      }
    });

    ws.addEventListener("error", () => {
      finish({ kind: "error", message: "dictation socket error" });
    });

    ws.addEventListener("close", () => {
      // A close with no explicit endpoint still finalizes with whatever we
      // have — mirrors the finalize-timeout fallback above.
      finish(
        lastFinalText.length > 0
          ? { kind: "ok", text: lastFinalText }
          : { kind: "error", message: "dictation socket closed early" },
      );
    });
  });

export const WS_READY_STATE_OPEN = WS_OPEN;
