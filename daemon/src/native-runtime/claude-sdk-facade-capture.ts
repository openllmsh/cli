/**
 * `sdk-facade-capture` — H4
 * (`docs/plan/bridge-variants-and-capture-adapters/12-hermes-adoption-plan.md`
 * §3.E/§5). Attaches interception BEFORE starting the SAME `sdk-facade` base
 * runtime (`claude-sdk-facade.ts`'s history plan + framed-replay writer +
 * `claude-spawn.ts#spawnClaudeFacadeCli`) — never a second, duplicated
 * implementation (00-requirements.md req. 2/3).
 *
 * History replay itself makes NO network request (see
 * `claude-sdk-facade.ts`'s module doc — every non-final frame's zero-turn
 * acknowledgment is a purely local CLI accounting step); ONLY the final
 * (query) frame triggers exactly the one real `/v1/messages` POST the
 * existing Claude capture loopback (`claude-capture.ts#startClaudeCapture
 * Loopback`) already intercepts for `stream-json-capture`. This module
 * reuses that SAME loopback, the SAME `request-capture.ts` exactly-once
 * session (`createRequestCaptureSession`/`runCapturedDispatch`), and the
 * SAME commit/decline machinery (`claude-capture.ts#commitFromChunkStream`/
 * `declinedForNonOkCapturedResponse`) — the return-side ownership difference
 * the plan requires (12-hermes-adoption-plan.md's "Response ownership"
 * table) is already that machinery's job for `stream-json-capture`; this
 * variant differs only in HOW the request reaches that one real call
 * (framed replay vs a single buffered stdin write), never in who owns the
 * response.
 *
 * The facade child's OWN stdout is NEVER decoded as model output here (it
 * only ever saw a local settlement status, never the true response) — it is
 * drained in the background purely so the process can exit cleanly, exactly
 * mirroring `runClaudeTextCapture`'s `stdoutTask`.
 *
 * Multi-turn and tool-continuation history is construction-proven against
 * the real installed CLI (see `claude-sdk-facade.ts`'s module doc for the H1
 * evidence — wire-shape/protocol proof against a local mock upstream, never
 * proof under genuine authenticated inference) — there is no pre-spawn
 * refusal for it. The one shared history plan (`planClaudeSdkFacadeTurn`)
 * and shared framed-replay writer (`replayClaudeSdkFacadeHistory`) are
 * exactly what both this module and `runClaudeSdkFacadeCore` use, so the two
 * variants never drift.
 */

import { existsSync } from "node:fs";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { logError, safeDiagnosticMessage } from "../logger";
import {
  claudeCaptureDestinationPolicy,
  commitFromChunkStream,
  declinedForNonOkCapturedResponse,
  startClaudeCaptureLoopback,
  withClaudeCaptureBaseUrl,
} from "./claude-capture";
import { startClaudeFacadeMcpServer } from "./claude-facade-mcp-server";
import { chunksFromFacadeCapturedResponse } from "./claude-facade-stream";
import { ndjsonLines } from "./claude-native";
import type {
  TClaudeFacadeStdinWriter,
  TClaudeSdkFacadeParams,
} from "./claude-sdk-facade";
import {
  logSdkFacadePhaseTiming,
  planClaudeSdkFacadeTurn,
  replayClaudeSdkFacadeHistory,
} from "./claude-sdk-facade";
import type { TClaudeFacadeMcpServerRef } from "./claude-spawn";
import { spawnClaudeFacadeCli } from "./claude-spawn";
import type { TCapturedDispatchSender } from "./request-capture";
import {
  createRequestCaptureSession,
  runCapturedDispatch,
} from "./request-capture";
import { requireCaptureTerminalFinishReason } from "./request-capture-output";
import type { TNativeRunResult } from "./types";
import { cleanNativeSpawnEnv } from "./types";

export type TClaudeSdkFacadeCaptureParams = TClaudeSdkFacadeParams & {
  /** Daemon-owned upstream sender — tests inject a mock; production uses a
   *  real `fetch` (never omit in hermetic runs, matching `claude-native.ts`'s
   *  own `requestCapture.sender` contract). */
  readonly captureSender: TCapturedDispatchSender;
  readonly allowLoopbackDestinations?: boolean;
  readonly captureTimeoutMs?: number;
  readonly maxBodyBytes?: number;
};

const killProc = (proc: ReturnType<typeof Bun.spawn>): void => {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already exited
  }
};

/** Thin timing wrapper around {@link runClaudeSdkFacadeCaptureCore} — reuses
 *  `claude-sdk-facade.ts`'s SAME `logSdkFacadePhaseTiming` the native mode
 *  uses, so the two modes' timing signal is structurally identical (never a
 *  second, capture-only implementation). */
export const runClaudeSdkFacadeCapture = async (
  params: TClaudeSdkFacadeCaptureParams,
): Promise<TNativeRunResult> => {
  const startedAt = performance.now();
  const result = await runClaudeSdkFacadeCaptureCore(params);
  logSdkFacadePhaseTiming({
    capture: true,
    startedAt,
    outcome: result.kind,
  });
  return result;
};

const runClaudeSdkFacadeCaptureCore = async (
  params: TClaudeSdkFacadeCaptureParams,
): Promise<TNativeRunResult> => {
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "claude CLI not installed" };
  }
  const plan = planClaudeSdkFacadeTurn(
    params.canonical,
    params.providerModelId,
  );
  if (!plan.ok) {
    return { kind: "declined", reason: plan.reason };
  }

  const session = createRequestCaptureSession({
    destinationPolicy: claudeCaptureDestinationPolicy({
      allowLoopback: params.allowLoopbackDestinations === true,
    }),
    signal: params.signal,
    captureTimeoutMs: params.captureTimeoutMs,
    maxBodyBytes: params.maxBodyBytes,
  });
  const loopback = startClaudeCaptureLoopback({ session });

  let mcpServer: TClaudeFacadeMcpServerRef | null = null;
  let stopMcpServer: (() => void) | null = null;
  if (plan.tools.length > 0) {
    const server = startClaudeFacadeMcpServer({
      tools: plan.tools,
      onForbiddenCall: (name) => {
        logError(
          "native-runtime",
          safeDiagnosticMessage`sdk-facade-capture inert MCP handler was invoked`,
          { name },
        );
      },
    });
    mcpServer = { url: server.url, headers: server.headers };
    stopMcpServer = server.stop;
  }

  const cleaned = cleanNativeSpawnEnv(params.env);
  const spawnEnv = withClaudeCaptureBaseUrl(cleaned, loopback.baseUrl);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawnClaudeFacadeCli({
      bin: params.bin,
      providerModelId: params.providerModelId,
      systemText: plan.systemText,
      mcpServer,
      finalEnv: spawnEnv,
    });
  } catch (error) {
    stopMcpServer?.();
    loopback.stop();
    session.dispose();
    return {
      kind: "declined",
      reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const kill = (): void => {
    params.signal.removeEventListener("abort", kill);
    stopMcpServer?.();
    killProc(proc);
  };
  if (params.signal.aborted) {
    kill();
    loopback.stop();
    session.dispose();
    return { kind: "declined", reason: "client aborted" };
  }
  params.signal.addEventListener("abort", kill, { once: true });

  const stdin = proc.stdin as unknown as TClaudeFacadeStdinWriter;
  const reader = ndjsonLines(
    proc.stdout as ReadableStream<Uint8Array>,
  ).getReader();

  // Never decoded as output — see module doc. Best-effort; a killed/closed
  // stream simply ends the loop. MUST NOT start before replay finishes: it
  // reads from the SAME `reader` the replay loop uses to await zero-turn
  // acknowledgments — starting it early would race the replay loop for
  // those very lines.
  let drainRemaining: Promise<void> = Promise.resolve();
  const startDrainingRemainingStdout = (): void => {
    drainRemaining = (async (): Promise<void> => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // closed/killed
      }
    })();
  };

  let daemonDispatchCount = 0;
  const dispatchPromise = runCapturedDispatch({
    session,
    sender: async (request, envelope, signal) => {
      daemonDispatchCount += 1;
      return params.captureSender(request, envelope, signal);
    },
    signal: params.signal,
    suppressReason:
      "claude sdk-facade capture: original external send suppressed; the facade builder never sees the true response",
  });
  // Dispatch may reject before historical replay finishes. Observe it now;
  // later awaits still see the original rejection and preserve ownership.
  void dispatchPromise.catch(() => undefined);

  const replay = await replayClaudeSdkFacadeHistory({
    stdin,
    reader,
    frames: plan.frames,
    signal: params.signal,
    ...(params.precommitMs !== undefined
      ? { precommitMs: params.precommitMs }
      : {}),
  });
  // Safe to start draining now — the replay loop no longer touches `reader`
  // (see the comment on `startDrainingRemainingStdout` above).
  startDrainingRemainingStdout();
  if (!replay.ok) {
    kill();
    loopback.stop();
    // A replay failure does not by itself mean no real dispatch happened:
    // `dispatchPromise` races independently of `replay` and begins capturing
    // + sending as soon as the loopback sees ANY request — including a
    // premature one, if the still-unproven `shouldQuery: false` contract
    // (see `claude-sdk-facade.ts`'s module doc) is ever violated by the real
    // CLI. Compute ownership the SAME way the `catch` branch below does
    // BEFORE disposing the session, so a caller never treats a possibly-
    // dispatched turn as `captureOwnership: 'none'`.
    const ownership =
      daemonDispatchCount > 0
        ? session.upstreamAccepted()
          ? ("accepted" as const)
          : ("uncertain" as const)
        : ("none" as const);
    // No captured envelope can arrive now (the loopback is stopped and the
    // child is killed) — dispose so `dispatchPromise`'s `takeCaptured()`
    // rejects instead of hanging forever.
    session.dispose();
    // A late or signal-independent sender may still produce a live body.
    // Discard it explicitly, without waiting for dispatch or cancellation.
    void dispatchPromise
      .then(({ response }) => response.body?.cancel())
      .catch(() => undefined);
    void drainRemaining.catch(() => undefined);
    logError(
      "native-runtime",
      safeDiagnosticMessage`sdk-facade-capture declined during history replay`,
      { reason: replay.reason, captureOwnership: ownership },
    );
    return {
      kind: "declined",
      reason: replay.reason,
      ...(ownership !== "none" ? { captureOwnership: ownership } : {}),
    };
  }

  let dispatchResult: Awaited<ReturnType<typeof runCapturedDispatch>>;
  try {
    dispatchResult = await dispatchPromise;
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
    await drainRemaining.catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    logError(
      "native-runtime",
      safeDiagnosticMessage`sdk-facade-capture dispatch failed`,
      { reason },
    );
    return {
      kind: "declined",
      reason: `sdk-facade-capture dispatch failed: ${reason}`,
      ...(ownership !== "none" ? { captureOwnership: ownership } : {}),
    };
  }

  if (!dispatchResult.response.ok) {
    const declined = await declinedForNonOkCapturedResponse(
      dispatchResult.response,
      params.signal,
    );
    kill();
    loopback.stop();
    session.dispose();
    await drainRemaining.catch(() => undefined);
    return declined;
  }

  const rawChunks = chunksFromFacadeCapturedResponse(
    dispatchResult.response,
    params.providerModelId,
    plan.toolNameMap,
  );
  // Same EOF-without-terminal-finish-reason guard `stream-json-capture` uses
  // — a clean upstream close with no observed finish reason must not
  // silently synthesize "stop".
  const chunks = requireCaptureTerminalFinishReason(rawChunks);
  const run = await commitFromChunkStream({
    chunks,
    signal: params.signal,
    kill,
    sessionId: () => null,
  });

  if (run.kind === "declined") {
    kill();
    loopback.stop();
    session.dispose();
    void drainRemaining.catch(() => undefined);
    return { ...run, captureOwnership: "accepted" as const };
  }

  const committedChunks = run.chunks;
  let lifetimeReader: ReadableStreamDefaultReader<TChatCompletionChunk> | null =
    null;
  let lifetimeCleaned = false;
  const cleanupLifetime = (): void => {
    if (lifetimeCleaned) return;
    lifetimeCleaned = true;
    kill();
    loopback.stop();
    session.dispose();
    void drainRemaining.catch(() => undefined);
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
      const reader2 = lifetimeReader;
      lifetimeReader = null;
      if (reader2 !== null) {
        void reader2.cancel(reason).catch(() => undefined);
      } else {
        void committedChunks.cancel(reason).catch(() => undefined);
      }
      cleanupLifetime();
    },
  });

  return {
    kind: "committed",
    chunks: lifetimeChunks,
    sessionId: run.sessionId,
  };
};
