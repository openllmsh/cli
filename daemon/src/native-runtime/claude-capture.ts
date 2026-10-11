/**
 * Claude Code text request-capture adapter (W2).
 *
 * After existing routing / transforms, the same `claude -p` builder constructs
 * the authenticated Anthropic Messages request. This module:
 *
 *   1. applies `ANTHROPIC_BASE_URL` to a private loopback recorder **after**
 *      `cleanNativeSpawnEnv` (never before — poison cleaning must win first),
 *   2. captures the FULL application headers + body (not the identity-filtered
 *      auth-config fixture),
 *   3. never forwards preamble traffic to the real vendor (no auth leak),
 *   4. suppresses the original external inference send,
 *   5. lets the daemon dispatch that envelope once,
 *   6. decodes the TRUE upstream response with `decodeAnthropicEventStream`
 *      (no request/response rebuild),
 *   7. settles the text `-p` builder locally.
 *
 * Text settlement is explicitly **unproven** as warm-builder reuse: returning
 * HTTP 204 (and/or killing the process) is local ownership transfer only — it
 * is NOT evidence of graceful SDK interrupt / reusable session state. Prefer
 * documented SDK `interrupt()` on the tool/Agent-SDK path when that path is
 * later proven; do not treat this text settlement as that proof.
 *
 * Tool capture lives in `claude-tool-capture.ts` (inert MCP schemas + daemon-
 * owned tool_use decode). This module stays the text `-p` loopback path;
 * {@link CLAUDE_TOOL_CAPTURE_STATUS} mirrors the tool adapter's proven label so
 * existing diagnostics keep a single constant. Serve wiring is out of scope
 * here — keep today's SDK bridge until the integrator routes tool turns.
 *
 * Default off via `request-capture-config.ts`. This module does not edit
 * `serve.ts` / `walker.ts` / shared capture files / session-store.
 */

import { existsSync } from "node:fs";
import type {
  TChatCompletionChunk,
  TChatCompletionRequest,
  TErrorEnvelope,
} from "@openllmsh/protocol";
import type { TClassifierInput } from "@openllmsh/wire/lib/error-class";
import { classifyHopError } from "@openllmsh/wire/lib/error-class";
import { isRefusalChunk } from "@openllmsh/wire/lib/refusal";
import { isMeaningfulChunk } from "@openllmsh/wire/lib/streaming/peek";
import { decodeAnthropicEventStream } from "@openllmsh/wire/providers/anthropic/streaming";
import { defaultUpstreamUrl } from "../delegation/auth-config";
import { logError, safeDiagnosticMessage } from "../logger";
import { createCaptureLoopbackGuard } from "./capture-loopback-guard";
import { spawnClaudeCli } from "./claude-spawn";
import type { TClaudeToolCaptureStatus } from "./claude-tool-capture-status";
import { CLAUDE_TOOL_CAPTURE_STATUS } from "./claude-tool-capture-status";
import type {
  TBuilderSettlement,
  TCaptureDestinationPolicy,
  TCapturedDispatchSender,
  TCapturedHeaderPair,
  TCapturedRequestEnvelope,
  TRequestCaptureSession,
  TRunCapturedDispatchResult,
} from "./request-capture";
import {
  createRequestCaptureSession,
  preserveCapturedHeaders,
  runCapturedDispatch,
} from "./request-capture";
import { requireCaptureTerminalFinishReason } from "./request-capture-output";
import type { TNativeRunResult } from "./types";
import {
  cleanNativeSpawnEnv,
  PRE_COMMIT_TIMEOUT_MS,
  unsupportedNativeControl,
} from "./types";

export type { TClaudeToolCaptureStatus } from "./claude-tool-capture-status";
export { CLAUDE_TOOL_CAPTURE_STATUS } from "./claude-tool-capture-status";

/** Trusted Anthropic Messages origin — dispatch target, never the loopback host. */
export const CLAUDE_CAPTURE_TRUSTED_ORIGIN = new URL(
  defaultUpstreamUrl("claude_code"),
).origin;

/** Default external Messages URL the daemon dispatches to. */
export const CLAUDE_CAPTURE_EXTERNAL_MESSAGES_URL =
  defaultUpstreamUrl("claude_code");

/**
 * Local settlement of the text `-p` builder. `unproven_text_settlement` means
 * the original external send was suppressed and the process was settled
 * locally (typically HTTP 204). That is NOT proof of graceful warm reuse or
 * of the Agent SDK interrupt handshake.
 */
export type TClaudeTextSettlementKind =
  | "unproven_text_settlement"
  | "cancelled"
  | "failed";

export type TClaudeCaptureDiagnostics = {
  readonly textSettlement: TClaudeTextSettlementKind | null;
  readonly toolCapture: TClaudeToolCaptureStatus;
  readonly daemonDispatchCount: number;
  /** Preamble requests forwarded to the real vendor — must stay 0. */
  readonly preambleExternalForwards: 0;
  readonly capturedEnvelope: TCapturedRequestEnvelope | null;
};

export type TClaudeCaptureAdapterResult = {
  readonly run: TNativeRunResult;
  readonly diagnostics: TClaudeCaptureDiagnostics;
};

export const isClaudeMessagesInferencePath = (pathname: string): boolean =>
  pathname.endsWith("/v1/messages");

export const claudeCaptureDestinationPolicy = (opts?: {
  readonly allowLoopback?: boolean;
}): TCaptureDestinationPolicy => ({
  allowedOrigins: new Set([CLAUDE_CAPTURE_TRUSTED_ORIGIN]),
  allowLoopback: opts?.allowLoopback === true,
});

/**
 * Apply the loopback redirect AFTER env cleaning. Callers must pass the result
 * of `cleanNativeSpawnEnv` (or an equivalent cleaned map) — never raw ambient
 * env — so a pre-clean `ANTHROPIC_BASE_URL` cannot survive.
 */
export const withClaudeCaptureBaseUrl = (
  cleanedEnv: Record<string, string>,
  loopbackBase: string,
): Record<string, string> => ({
  ...cleanedEnv,
  ANTHROPIC_BASE_URL: loopbackBase,
});

const settlementKindOf = (
  settlement: TBuilderSettlement,
): TClaudeTextSettlementKind => {
  if (settlement.kind === "cancelled") return "cancelled";
  if (settlement.kind === "failed") return "failed";
  return "unproven_text_settlement";
};

const httpStatusForSettlement = (settlement: TBuilderSettlement): number => {
  if (settlement.kind === "cancelled") return 499;
  if (settlement.kind === "failed") return 502;
  // 204 = local ownership transfer for the text builder. Unproven as graceful
  // warm-session settlement — see TClaudeTextSettlementKind.
  return 204;
};

export type TClaudeCaptureLoopback = {
  readonly baseUrl: string;
  readonly stop: () => void;
};

/**
 * Optional gate for `/v1/messages` posts. Text capture omits this (first
 * Messages POST is the inference). Tool capture supplies a classifier so
 * SDK auxiliary traffic (session-title generation, etc.) is settled locally
 * and never becomes the daemon-owned envelope.
 */
export type TClaudeCaptureInferenceGate = (args: {
  readonly envelope: TCapturedRequestEnvelope;
}) =>
  | { readonly action: "capture" }
  | { readonly action: "settle_auxiliary"; readonly reason: string };

/**
 * Private loopback recorder for Claude Messages capture.
 *
 * Inference (`…/v1/messages`): full headers+body → `session.captureSend`, then
 * a local settlement status (never the true upstream body) — unless
 * {@link TClaudeCaptureInferenceGate} classifies the POST as auxiliary, in
 * which case it is settled locally with HTTP 204 and never offered.
 *
 * Preamble / other paths: synthetic local JSON 200. Never forwards to the
 * trusted origin (no authorization leak onto the public network).
 */
export const startClaudeCaptureLoopback = (args: {
  readonly session: TRequestCaptureSession;
  readonly onSettlement?: (kind: TClaudeTextSettlementKind) => void;
  readonly inferenceGate?: TClaudeCaptureInferenceGate;
  readonly onAuxiliarySettled?: (reason: string) => void;
}): TClaudeCaptureLoopback => {
  const guard = createCaptureLoopbackGuard();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      // Request-private nonce gate FIRST — before any body read, before any
      // path/inference classification, before capture/preamble handling.
      // Loopback + an ephemeral port is not authentication: a different
      // local user, or a page in the user's own browser, could otherwise
      // race the real `claude` child to this port. Never log the raw
      // (pre-peel) URL — it carries the secret path segment.
      const peeled = guard.peel(new URL(req.url));
      if (peeled === null) {
        return new Response(null, { status: 404 });
      }

      if (!isClaudeMessagesInferencePath(peeled.pathname)) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const method = req.method.toUpperCase();
      const rawBody =
        method === "GET" || method === "HEAD"
          ? null
          : new Uint8Array(await req.arrayBuffer());
      const body = rawBody !== null && rawBody.byteLength > 0 ? rawBody : null;
      const headers: ReadonlyArray<TCapturedHeaderPair> =
        preserveCapturedHeaders(req.headers);
      // Restored external URL and observed-URL diagnostics are built from
      // the PEELED url only — the nonce never reaches the vendor origin and
      // never lands in a recorded/loggable envelope field.
      const externalUrl = `${CLAUDE_CAPTURE_TRUSTED_ORIGIN}${peeled.pathname}${peeled.search}`;
      const envelope: TCapturedRequestEnvelope = {
        transport: "http",
        method,
        observedUrl: peeled.toString(),
        externalUrl,
        headers,
        body,
        framing: null,
      };

      if (args.inferenceGate !== undefined) {
        const decision = args.inferenceGate({ envelope });
        if (decision.action === "settle_auxiliary") {
          args.onAuxiliarySettled?.(decision.reason);
          // Local ownership transfer only — never forward aux to the vendor and
          // never install it as the capture envelope.
          return new Response(null, { status: 204 });
        }
      }

      try {
        const settlement = await args.session.captureSend(envelope);
        args.onSettlement?.(settlementKindOf(settlement));
        return new Response(null, {
          status: httpStatusForSettlement(settlement),
        });
      } catch (err) {
        args.onSettlement?.("failed");
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    },
  });

  return {
    baseUrl: guard.baseUrl(`http://127.0.0.1:${server.port}`),
    stop: (): void => {
      server.stop(true);
    },
  };
};

/**
 * Text-capture spawn params. Mirrors `TClaudeNativeParams` without a runtime
 * import cycle against `claude-native.ts`.
 */
export type TClaudeTextCaptureParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly systemText: string | null;
  readonly userText: string;
  readonly resumeSessionId: string | null;
  readonly signal: AbortSignal;
  /** Daemon-owned upstream sender (tests inject a mock; never omit in hermetic runs). */
  readonly captureSender: TCapturedDispatchSender;
  /** Hermetic tests set true so dispatch may target loopback fakes. */
  readonly allowLoopbackDestinations?: boolean;
  readonly captureTimeoutMs?: number;
  readonly maxBodyBytes?: number;
};

const emptyDiagnostics = (): TClaudeCaptureDiagnostics => ({
  textSettlement: null,
  toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
  daemonDispatchCount: 0,
  preambleExternalForwards: 0,
  capturedEnvelope: null,
});

/**
 * Decline unsupported generation controls before any loopback/upstream work.
 * Reuses the shared native gate — does not expand handrolled eligibility.
 */
export const declineClaudeCaptureForUnsupportedControls = (
  canonical: TChatCompletionRequest,
): string | null => unsupportedNativeControl(canonical);

const killProc = (proc: ReturnType<typeof Bun.spawn>): void => {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already exited
  }
};

/**
 * Decode the daemon-owned Anthropic upstream response into canonical chunks
 * via the existing wire helper — never rebuild system/tools/history.
 */
export const chunksFromCapturedAnthropicResponse = (
  response: Response,
  providerModelId: string,
  toolNameMap?: ReadonlyMap<string, string>,
): ReadableStream<TChatCompletionChunk> => {
  const body = response.body;
  if (body === null) {
    return new ReadableStream<TChatCompletionChunk>({
      start(controller) {
        controller.close();
      },
    });
  }
  return decodeAnthropicEventStream(body, {
    providerModelId,
    ...(toolNameMap !== undefined && toolNameMap.size > 0
      ? { toolNameMap }
      : {}),
  });
};

/** Hard cap on how much of a non-2xx error body we read into memory. Vendor
 *  error JSON is always small; this bounds a captured-but-hostile/broken
 *  upstream response independent of the (much larger) request-side
 *  `maxBodyBytes` budget. */
const MAX_CAPTURED_ERROR_BODY_BYTES = 32 * 1024;

/** Cap on the `message`/detail text folded into `reason` — independent of
 *  {@link MAX_CAPTURED_ERROR_BODY_BYTES}, since a hostile body can still put
 *  an oversized string inside otherwise-valid JSON within that byte bound. */
const MAX_ERROR_DETAIL_CHARS = 200;

/**
 * Best-effort structured envelope from a bounded error body — mirrors the
 * shared daemon parse (`walker.ts`'s `errorEnvelopeFrom`) closely enough for
 * {@link classifyHopError}, without importing `walker.ts` (would cycle back
 * into native-runtime). Validates `message`/`type`/`code` as strings with a
 * fallback rather than casting `unknown` to `TErrorEnvelope["error"]` — an
 * object-shaped but malformed field (e.g. `message: 123` or `message: {}`)
 * must not reach {@link classifyHopError} untyped and must not throw here.
 */
const errorEnvelopeFromBoundedBody = (
  raw: string,
): TErrorEnvelope | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > 0
      ? {
          error: {
            message: raw.slice(0, MAX_ERROR_DETAIL_CHARS),
            type: "upstream_error",
          },
        }
      : undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const errorField = (parsed as Record<string, unknown>).error;
  if (typeof errorField === "string") {
    return {
      error: {
        message: errorField.slice(0, MAX_ERROR_DETAIL_CHARS),
        type: "upstream_error",
      },
    };
  }
  if (typeof errorField !== "object" || errorField === null) {
    return undefined;
  }
  const e = errorField as Record<string, unknown>;
  return {
    error: {
      message:
        typeof e.message === "string"
          ? e.message.slice(0, MAX_ERROR_DETAIL_CHARS)
          : "upstream error (unparseable message)",
      type: typeof e.type === "string" ? e.type : "upstream_error",
      ...(typeof e.code === "string" ? { code: e.code } : {}),
    },
  };
};

/**
 * Read at most {@link MAX_CAPTURED_ERROR_BODY_BYTES} of a non-2xx captured
 * response body, bounded by BOTH byte count and time. A vendor 4xx/5xx body
 * is always small JSON; a stalled/slow-drip body must not hang capture
 * cleanup indefinitely, and the caller's own abort must cancel the read
 * immediately rather than waiting out the full deadline. Never throws — any
 * failure/timeout/abort yields whatever partial snippet was captured so far,
 * so classification still proceeds on status alone if nothing was read.
 */
const readBoundedErrorBody = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const pump = async (): Promise<void> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value === undefined) continue;
      const remaining = MAX_CAPTURED_ERROR_BODY_BYTES - total;
      if (remaining <= 0) return;
      const slice =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (total >= MAX_CAPTURED_ERROR_BODY_BYTES) return;
    }
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      pump().catch(() => undefined),
      new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(resolve, PRE_COMMIT_TIMEOUT_MS);
      }),
      new Promise<void>((resolve) => {
        onAbort = () => resolve();
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    // Closing pending reads is synchronous; an upstream cancel hook may
    // never settle, so it must not extend the read deadline or caller abort.
    void reader.cancel().catch(() => undefined);
  }
  if (chunks.length === 0) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

/**
 * Classify a non-2xx captured Anthropic response into a declined
 * `TNativeRunResult` — status, vendor error body (bounded read, bounded
 * time), and `Retry-After` (surfaced via `cooldownReason`, the shared
 * rate-limit/quota signal; the exact header value is not separately threaded
 * through `TNativeRunResult`) are all preserved. Reuses {@link
 * classifyHopError}, the same cloud/daemon policy every other hop classifies
 * through, instead of a capture-local status table that could silently drift
 * from it. `signal` bounds the body read so a stalled 429/5xx body cannot
 * delay the decline (and the ownership cleanup that follows it) past the
 * caller's own abort or the shared pre-commit deadline.
 */
/** Exported so `claude-sdk-facade-capture.ts` (`sdk-facade-capture`) shares
 *  this EXACT non-2xx-captured-response decline instead of a duplicate —
 *  both variants intercept the same `/v1/messages` shape via the same
 *  loopback (`startClaudeCaptureLoopback`). Cursor's capture paths also reuse
 *  this bounded reader/classifier with their provider label and wire format. */
export const declinedForNonOkCapturedResponse = async (
  response: Response,
  signal: AbortSignal,
  options: {
    readonly provider: string;
    readonly providerFormat: TClassifierInput["providerFormat"];
  } = { provider: "claude", providerFormat: "anthropic" },
): Promise<Extract<TNativeRunResult, { readonly kind: "declined" }>> => {
  const raw = await readBoundedErrorBody(response, signal);
  const envelope = errorEnvelopeFromBoundedBody(raw);
  const classified = classifyHopError({
    status: response.status,
    envelope,
    providerFormat: options.providerFormat,
    aborted: false,
  });
  const retryAfter = response.headers.get("retry-after");
  const detail =
    envelope?.error?.message ?? raw.slice(0, MAX_ERROR_DETAIL_CHARS);
  const reason = [
    `${options.provider} capture upstream HTTP ${response.status}`,
    detail.length > 0 ? `: ${detail}` : "",
    retryAfter !== null ? ` (retry-after: ${retryAfter})` : "",
  ].join("");
  return {
    kind: "declined",
    reason,
    // A committed-hop abort never reaches this path (aborted: false above),
    // so classifyHopError always returns "transient" here.
    ...(classified.kind === "transient"
      ? { cooldownReason: classified.reason }
      : {}),
    captureOwnership: "accepted",
  };
};

/**
 * Called ONLY after `runCapturedDispatch` already succeeded (single call
 * site, post-dispatch) — every decline returned here MUST carry
 * `captureOwnership: "accepted"` so the walker never retries/handrolls/
 * fleets for a hop whose upstream send already landed. This includes a
 * `reader.read()` rejection from {@link requireCaptureTerminalFinishReason}
 * (clean EOF with no terminal `finish_reason`) — that rejection must be
 * translated here, never allowed to propagate out of this function (its
 * callers do not wrap it in try/catch and would otherwise lose ownership).
 */
/** Exported so `claude-sdk-facade-capture.ts` (`sdk-facade-capture`) reuses
 *  this EXACT pre-commit-buffered commit/decline machinery — same ownership
 *  tagging (`captureOwnership: "accepted"` on every decline here), same
 *  refusal/pre-commit-timeout handling — instead of a parallel copy. */
export const commitFromChunkStream = async (args: {
  readonly chunks: ReadableStream<TChatCompletionChunk>;
  readonly signal: AbortSignal;
  readonly kill: () => void;
  readonly sessionId: () => string | null;
}): Promise<TNativeRunResult> => {
  const reader = args.chunks.getReader();
  const buffered: TChatCompletionChunk[] = [];

  const pump = async (): Promise<
    | { kind: "meaningful"; chunk: TChatCompletionChunk }
    | { kind: "exit" }
    | { kind: "error"; reason: string }
  > => {
    for (;;) {
      let read: { value: TChatCompletionChunk; done: false } | { done: true };
      try {
        read = await reader.read();
      } catch (err) {
        return {
          kind: "error",
          reason: `claude capture upstream stream failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (read.done) return { kind: "exit" };
      const value = read.value;
      if (isMeaningfulChunk(value)) {
        if (isRefusalChunk(value)) {
          return {
            kind: "error",
            reason:
              "claude capture upstream refused the request (content filter)",
          };
        }
        return { kind: "meaningful", chunk: value };
      }
      buffered.push(value);
    }
  };

  let precommitTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    pump(),
    new Promise<"timeout">((resolve) => {
      precommitTimer = setTimeout(
        () => resolve("timeout"),
        PRE_COMMIT_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(precommitTimer);

  if (first === "timeout" || first.kind === "exit") {
    args.kill();
    void reader.cancel().catch(() => undefined);
    return {
      kind: "declined",
      reason:
        first === "timeout"
          ? "claude capture produced no output before the pre-commit deadline"
          : "claude capture upstream ended before producing output",
      captureOwnership: "accepted",
    };
  }
  if (first.kind === "error") {
    args.kill();
    void reader.cancel().catch(() => undefined);
    return {
      kind: "declined",
      reason: first.reason,
      captureOwnership: "accepted",
    };
  }

  const firstMeaningful = first.chunk;
  const out = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      for (const c of buffered) controller.enqueue(c);
      controller.enqueue(firstMeaningful);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        args.kill();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      args.kill();
      void reader.cancel().catch(() => undefined);
    },
  });

  return {
    kind: "committed",
    chunks: out,
    sessionId: args.sessionId,
  };
};

/**
 * Text-only capture path: spawn the vendor CLI against a private loopback,
 * capture its Messages envelope, daemon-dispatch once, decode with the
 * Anthropic wire helper, settle the builder locally (unproven warm reuse).
 */
export const runClaudeTextCapture = async (
  params: TClaudeTextCaptureParams,
): Promise<TClaudeCaptureAdapterResult> => {
  const diagnostics = emptyDiagnostics();
  if (!existsSync(params.bin)) {
    return {
      run: { kind: "declined", reason: "claude CLI not installed" },
      diagnostics,
    };
  }

  const session = createRequestCaptureSession({
    destinationPolicy: claudeCaptureDestinationPolicy({
      allowLoopback: params.allowLoopbackDestinations === true,
    }),
    signal: params.signal,
    captureTimeoutMs: params.captureTimeoutMs,
    maxBodyBytes: params.maxBodyBytes,
  });

  let textSettlement: TClaudeTextSettlementKind | null = null;
  const loopback = startClaudeCaptureLoopback({
    session,
    onSettlement: (kind) => {
      textSettlement = kind;
    },
  });

  const cleaned = cleanNativeSpawnEnv(params.env);
  const spawnEnv = withClaudeCaptureBaseUrl(cleaned, loopback.baseUrl);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawnClaudeCli({
      bin: params.bin,
      providerModelId: params.providerModelId,
      systemText: params.systemText,
      resumeSessionId: params.resumeSessionId,
      userText: params.userText,
      finalEnv: spawnEnv,
    });
  } catch (error) {
    loopback.stop();
    session.dispose();
    return {
      run: {
        kind: "declined",
        reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      diagnostics,
    };
  }

  const kill = (): void => killProc(proc);
  if (params.signal.aborted) {
    kill();
    loopback.stop();
    session.dispose();
    return {
      run: { kind: "declined", reason: "client aborted" },
      diagnostics: {
        ...diagnostics,
        textSettlement: "cancelled",
      },
    };
  }
  params.signal.addEventListener("abort", kill, { once: true });

  // Best-effort session_id from builder stdout (init line). Answer content
  // comes from the daemon-owned upstream decode — never from the builder.
  let capturedSessionId: string | null = params.resumeSessionId;
  const stdoutTask = (async (): Promise<void> => {
    try {
      const text = await new Response(
        proc.stdout as ReadableStream<Uint8Array>,
      ).text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed = JSON.parse(trimmed) as { session_id?: unknown };
          if (
            typeof parsed.session_id === "string" &&
            parsed.session_id.length > 0
          ) {
            capturedSessionId = parsed.session_id;
          }
        } catch {
          // non-JSON noise
        }
      }
    } catch {
      // closed/killed
    }
  })();

  let dispatchResult: TRunCapturedDispatchResult;
  let daemonDispatchCount = 0;
  try {
    dispatchResult = await runCapturedDispatch({
      session,
      sender: async (request, envelope, signal) => {
        daemonDispatchCount += 1;
        return params.captureSender(request, envelope, signal);
      },
      signal: params.signal,
      suppressReason:
        "claude text capture: original external send suppressed; local settlement is unproven_text_settlement (not warm-reuse proof)",
    });
  } catch (err) {
    kill();
    loopback.stop();
    const ownership =
      daemonDispatchCount > 0
        ? session.upstreamAccepted()
          ? ("accepted" as const)
          : ("uncertain" as const)
        : ("none" as const);
    session.dispose();
    await stdoutTask.catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    logError(
      "native-runtime",
      safeDiagnosticMessage`claude capture dispatch failed`,
      { reason },
    );
    return {
      run: {
        kind: "declined",
        reason: `claude capture dispatch failed: ${reason}`,
        ...(ownership !== "none" ? { captureOwnership: ownership } : {}),
      },
      diagnostics: {
        textSettlement: textSettlement ?? "failed",
        toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
        daemonDispatchCount,
        preambleExternalForwards: 0,
        capturedEnvelope: session.captured(),
      },
    };
  }

  // Dispatch success only means the daemon reached the upstream — a non-2xx
  // status (429 rate limit, 401 auth, 5xx, …) is a real vendor rejection, not
  // an SSE stream to decode. Decoding it as SSE anyway silently discards the
  // status, the vendor error body, and any `Retry-After`/cooldown signal.
  // Ownership is already `accepted` at this point (the send landed) — decline
  // here, never fall through to `chunksFromCapturedAnthropicResponse`.
  if (!dispatchResult.response.ok) {
    const declined = await declinedForNonOkCapturedResponse(
      dispatchResult.response,
      params.signal,
    );
    kill();
    loopback.stop();
    session.dispose();
    await stdoutTask.catch(() => undefined);
    return {
      run: declined,
      diagnostics: {
        textSettlement: textSettlement ?? "unproven_text_settlement",
        toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
        daemonDispatchCount,
        preambleExternalForwards: 0,
        capturedEnvelope: dispatchResult.envelope,
      },
    };
  }

  const rawChunks = chunksFromCapturedAnthropicResponse(
    dispatchResult.response,
    params.providerModelId,
  );
  // Capture-only guard: a clean upstream EOF with no observed terminal
  // finish_reason (dropped connection, truncated body after 200) must not
  // silently become a synthesized "stop" — see request-capture-output.ts.
  // Must wrap the RAW decoded Anthropic SSE stream, not a client-wire
  // re-encoding: `chunksToMessagesSseBytes` has its own EOF-without-
  // finish_reason synthesis (a real limitation for ordinary non-capture
  // streams) that only ever sees a clean `done` — making this stream
  // reject instead routes it into that re-encoder's error branch, not its
  // synthesis branch.
  const chunks = requireCaptureTerminalFinishReason(rawChunks);
  const run = await commitFromChunkStream({
    chunks,
    signal: params.signal,
    kill,
    sessionId: () => capturedSessionId,
  });

  // Once the daemon owns the exchange, ensure the builder is not left hanging.
  // Kill is cleanup — not evidence of graceful reuse (see settlement kind).
  if (run.kind === "declined") {
    kill();
    loopback.stop();
    session.dispose();
    void stdoutTask.catch(() => undefined);
    return {
      run: {
        ...run,
        // Dispatch already completed — walker must not handroll/fleet retry.
        captureOwnership: "accepted" as const,
      },
      diagnostics: {
        textSettlement: textSettlement ?? "failed",
        toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
        daemonDispatchCount,
        preambleExternalForwards: 0,
        capturedEnvelope: dispatchResult.envelope,
      },
    };
  }

  // Defer session/loopback teardown until the committed SSE body is fully
  // consumed. `dispose()` aborts the capture session signal; doing that while
  // a fetch body is still open truncates decode (same class of failure as the
  // old `complete(dispatched)` → linkAbort race fixed in request-capture).
  // Builder child exit after local HTTP 204 is ownership transfer only — it is
  // not a signal to abort the daemon-owned upstream body.
  const committedChunks = run.chunks;
  let lifetimeReader: ReadableStreamDefaultReader<TChatCompletionChunk> | null =
    null;
  let lifetimeCleaned = false;
  const cleanupLifetime = (): void => {
    if (lifetimeCleaned) return;
    lifetimeCleaned = true;
    loopback.stop();
    session.dispose();
    void stdoutTask.catch(() => undefined);
  };
  const lifetimeChunks = new ReadableStream<TChatCompletionChunk>({
    async pull(controller) {
      if (lifetimeReader === null) {
        lifetimeReader = committedChunks.getReader();
      }
      try {
        const { value, done } = await lifetimeReader.read();
        if (done) {
          controller.close();
          cleanupLifetime();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        cleanupLifetime();
        controller.error(err);
      }
    },
    cancel(reason) {
      const reader = lifetimeReader;
      lifetimeReader = null;
      if (reader !== null) {
        void reader.cancel(reason).catch(() => undefined);
      } else {
        void committedChunks.cancel(reason).catch(() => undefined);
      }
      kill();
      cleanupLifetime();
    },
  });

  return {
    run: {
      kind: "committed",
      chunks: lifetimeChunks,
      sessionId: run.sessionId,
    },
    diagnostics: {
      textSettlement: textSettlement ?? "unproven_text_settlement",
      toolCapture: CLAUDE_TOOL_CAPTURE_STATUS,
      daemonDispatchCount,
      preambleExternalForwards: 0,
      capturedEnvelope: dispatchResult.envelope,
    },
  };
};

export type TClaudeCaptureAdapterInput = {
  readonly native: Omit<
    TClaudeTextCaptureParams,
    | "captureSender"
    | "allowLoopbackDestinations"
    | "captureTimeoutMs"
    | "maxBodyBytes"
  >;
  /**
   * When provided, unsupported generation controls decline BEFORE any
   * loopback listen, CLI spawn, or upstream attempt.
   */
  readonly canonical?: TChatCompletionRequest;
  /**
   * Non-empty → tool capture via dynamic import of `claude-tool-capture.ts`
   * (avoids a static import cycle). Hermetic suites MUST pass
   * `toolCapture.builder` (fixture); default fixture builder never spawns a
   * real Claude binary.
   */
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  }>;
  readonly toolCapture?: {
    readonly historyTurns?: ReadonlyArray<import("./types").TNativeHistoryTurn>;
    readonly deltaText?: string;
    readonly hasPrior?: boolean;
    readonly historyFeed?:
      | "fixture_messages"
      | "sdk_unproven"
      | "sdk_session_resume";
    readonly builder?: import("./claude-tool-capture").TClaudeToolCaptureBuilder;
  };
  readonly capture: {
    readonly sender: TCapturedDispatchSender;
    readonly allowLoopbackDestinations?: boolean;
    readonly captureTimeoutMs?: number;
    readonly maxBodyBytes?: number;
  };
};

/**
 * Integration entry: control gate + text or tool capture. Explicit capture
 * with tools does NOT silently fall back to the ordinary held-query bridge —
 * unsupported history/controls decline with a clear reason.
 */
export const runClaudeCaptureAdapter = async (
  input: TClaudeCaptureAdapterInput,
): Promise<TClaudeCaptureAdapterResult> => {
  if (input.canonical !== undefined) {
    const unsupported = declineClaudeCaptureForUnsupportedControls(
      input.canonical,
    );
    if (unsupported !== null) {
      return {
        run: {
          kind: "declined",
          reason: `native runtime can't honor ${unsupported}`,
        },
        diagnostics: emptyDiagnostics(),
      };
    }
  }

  if (input.tools !== undefined && input.tools.length > 0) {
    const { runClaudeToolCapture, CLAUDE_TOOL_CAPTURE_STATUS: toolStatus } =
      await import("./claude-tool-capture");
    // Production defaults: official SDK builder + sdk_session_resume.
    // Hermetic suites MUST inject fixture builder + fixture_messages explicitly
    // so ordinary tests never spawn the real CLI / Keychain.
    const toolResult = await runClaudeToolCapture({
      bin: input.native.bin,
      env: input.native.env,
      providerModelId: input.native.providerModelId,
      systemText: input.native.systemText,
      tools: input.tools,
      historyTurns: input.toolCapture?.historyTurns ?? [],
      deltaText: input.toolCapture?.deltaText ?? input.native.userText,
      hasPrior: input.toolCapture?.hasPrior ?? false,
      signal: input.native.signal,
      captureSender: input.capture.sender,
      historyFeed: input.toolCapture?.historyFeed ?? "sdk_session_resume",
      ...(input.toolCapture?.builder !== undefined
        ? { builder: input.toolCapture.builder }
        : {}),
      allowLoopbackDestinations: input.capture.allowLoopbackDestinations,
      captureTimeoutMs: input.capture.captureTimeoutMs,
      maxBodyBytes: input.capture.maxBodyBytes,
      canonical: input.canonical,
    });
    return {
      run: toolResult.run,
      diagnostics: {
        textSettlement:
          toolResult.diagnostics.textSettlement === "interrupted"
            ? "unproven_text_settlement"
            : toolResult.diagnostics.textSettlement,
        toolCapture: toolStatus,
        daemonDispatchCount: toolResult.diagnostics.daemonDispatchCount,
        preambleExternalForwards: 0,
        capturedEnvelope: toolResult.diagnostics.capturedEnvelope,
      },
    };
  }

  return runClaudeTextCapture({
    ...input.native,
    captureSender: input.capture.sender,
    allowLoopbackDestinations: input.capture.allowLoopbackDestinations,
    captureTimeoutMs: input.capture.captureTimeoutMs,
    maxBodyBytes: input.capture.maxBodyBytes,
  });
};
