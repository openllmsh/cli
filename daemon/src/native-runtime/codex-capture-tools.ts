/**
 * Codex bridge-capture tool turns + history inject (W6 / P3–P4).
 *
 * Builds on the isolated text capture path:
 *   - `dynamicTools` are registered so the vendor-constructed `/responses`
 *     envelope carries caller tool schemas (hosted `web_search` collision
 *     still suppressed — see {@link suppressHostedSearchClientTool}).
 *   - The loopback receiver captures that envelope; the builder never sees
 *     the true upstream response and never executes `item/tool/call`.
 *   - Daemon decodes Responses tool/argument/reasoning events directly.
 *   - Interrupt order: settle builder → record terminal → publish chunks.
 *
 * `thread/inject_items` is the LIVE-proven multi-turn feed for the exact
 * shape tested: one prior assistant tool-call + its matching tool-result,
 * fed via `thread/inject_items` ahead of a real `turn/start`, against real
 * app-server 0.156.0 with production ChatGPT auth and a real upstream
 * `/responses` round trip (no fake builder, no fake sender) —
 * `/tmp/openllm-capture-live.43ljY8/result-28-chatgpt-bridge-capture-tool.json`
 * (real tool call issued) →
 * `result-29-chatgpt-bridge-capture-tool-followup.json` (real follow-up turn,
 * `finish_reason: "stop"`, non-empty billed usage, no truncation). See
 * {@link CODEX_STRUCTURED_INJECT_LIVE_PROVEN} for the exact proven scope —
 * it does NOT cover reasoning items, multiple simultaneous tool calls, or
 * cache-affinity guarantees across turns; those remain unproven and reasoning
 * injection still refuses explicitly (see `codexHistoryToResponsesItems`).
 */

import { join } from "node:path";
import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { logError, safeDiagnosticMessage } from "../logger";
import { daemonTempDir } from "../sandbox/working-set";
import type { TClientTool } from "./claude-tool-session";
import type {
  TCodexDynamicToolSpec,
  TCodexNativeParams,
} from "./codex-app-server";
import {
  codexDynamicToolsFrom,
  codexToolStartParams,
  codexTurnStartParams,
  createIsolatedCodexAppServerClient,
  effortOf,
} from "./codex-app-server";
import type { TCodexWorkspaceRouteMemory } from "./codex-capture";
import {
  codexCaptureDestinationPolicy,
  codexCaptureRedirectArgs,
  createCodexCapturedDispatchSender,
  decodeCodexUpstreamResponse,
  settleCodexCaptureTurn,
  startCodexCaptureReceiver,
} from "./codex-capture";
import type { TCodexCaptureEphemeralHomeHandle } from "./codex-capture-ephemeral-home";
import { createCodexCaptureEphemeralHome } from "./codex-capture-ephemeral-home";
import {
  createRequestCaptureSession,
  runCapturedDispatch,
} from "./request-capture";
import type { TCaptureHistoryBuilderPlan } from "./request-capture-history";
import { captureAwareHistoryBuilderPlan } from "./request-capture-history";
import {
  CAPTURE_INTERRUPT_ORDER,
  captureDirectOutputFailure,
  publishCapturedDirectOutput,
  requireCaptureTerminalFinishReason,
} from "./request-capture-output";
import type {
  TCaptureOwnership,
  TNativeHistoryTurn,
  TNativeRunResult,
} from "./types";
import { captureOwnershipFromSession, PRE_COMMIT_TIMEOUT_MS } from "./types";

/**
 * Hermetic fixture + schema-faithful wrapper prove inject appends history
 * without starting a user turn or executing tools. LIVE proof (real
 * app-server 0.156.0, production ChatGPT auth, real upstream `/responses`,
 * no fake builder/sender) additionally confirms the injected
 * `function_call` + `function_call_output` pair reaches the real vendor turn
 * and the model correctly answers using that injected result end-to-end:
 *
 *   - `result-28-chatgpt-bridge-capture-tool.json` — real tool call issued
 *     by the model (`noop_ping`, real `call_id`), captured, daemon-owned
 *     (never executed by the builder)
 *   - `result-29-chatgpt-bridge-capture-tool-followup.json` — the SAME
 *     `call_id` + the caller-supplied tool result injected via
 *     `thread/inject_items` into a FRESH isolated thread, followed by a real
 *     `turn/start`; the model replied `TOOL_DONE` /
 *     `finish_reason: "stop"` with billed, non-empty usage (12722 in / 7
 *     out / 2432 cached) — proof the injected pair was accepted as genuine
 *     turn history by the real backend, not merely echoed back unparsed.
 *
 * PROVEN SCOPE ONLY (do not read beyond this without new evidence):
 *   - ONE assistant tool-call + its ONE matching tool-result, injected once,
 *     immediately followed by a delta turn.
 *   - Plain-text follow-up turn (no further tool calls in the follow-up).
 *
 * NOT proven — still treat as open:
 *   - Reasoning items in history (`reasoningItems`/`reasoningContent`):
 *     `codexHistoryToResponsesItems` still THROWS on bare
 *     `reasoning_content` without opaque `reasoningItems`, and even opaque
 *     `reasoningItems` round-tripping has no live confirmation. Do not relax
 *     that refusal from this proof.
 *   - Multiple simultaneous / multiple sequential tool calls in one inject.
 *   - Cache-affinity / `prompt_cache_key` stability across an injected
 *     multi-turn conversation beyond this one single-hop case (the observed
 *     `cached_tokens: 2432` on the follow-up is consistent with cache reuse,
 *     but a single data point is not a general affinity guarantee).
 *   - Any transport other than the one exercised (HTTP or WS — the live runs
 *     did not pin which transport app-server chose for either attempt).
 *
 * Classification (do not collapse these):
 * - HERMETIC: fixture/wrapper contract proven in tests only.
 * - LIVE: proven for the exact scope above against the real vendor backend.
 * Production planning uses LIVE. Fixtures alone are never sufficient to flip
 * `CODEX_STRUCTURED_INJECT_LIVE_PROVEN` — this flip required the two live
 * attempts above.
 */
export const CODEX_STRUCTURED_INJECT_HERMETIC_PROVEN = true as const;
/**
 * LIVE-proven for: one assistant tool-call + one matching tool-result,
 * injected once via `thread/inject_items`, immediately followed by one
 * plain-text delta turn. See the file-level doc comment above for the exact
 * evidence and for what remains OUT of scope (reasoning items, multiple
 * tool calls, cache-affinity guarantees, transport pinning).
 */
export const CODEX_STRUCTURED_INJECT_LIVE_PROVEN = true as const;
/** Production gate — equals LIVE proof only. */
export const CODEX_STRUCTURED_INJECT_PROVEN =
  CODEX_STRUCTURED_INJECT_LIVE_PROVEN;

export type { TCodexDynamicToolSpec };

/**
 * Map caller tools → app-server `dynamicTools`, dropping hosted-search
 * clashes. Thin capture-path alias of the shared `codex-app-server.ts`
 * mapping (the bridge tool path, `codex-tool-session.ts`, uses the same
 * function directly) — kept as its own export since tests and callers here
 * already import it by this name.
 */
export const codexCaptureDynamicTools = (
  tools: ReadonlyArray<TClientTool>,
): ReadonlyArray<TCodexDynamicToolSpec> => codexDynamicToolsFrom(tools);

/**
 * Convert capture history into raw Responses items for `thread/inject_items`.
 * Preserves call IDs, arguments JSON, tool results, and opaque reasoning items.
 * Does not invent completion text for interrupted partial turns — callers must
 * only pass daemon-owned inventory.
 */
export const codexHistoryToResponsesItems = (
  turns: ReadonlyArray<TNativeHistoryTurn>,
): ReadonlyArray<Record<string, unknown>> => {
  const items: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    if (turn.kind === "text") {
      items.push({
        type: "message",
        role: turn.role,
        content: [
          {
            type: turn.role === "assistant" ? "output_text" : "input_text",
            text: turn.text,
          },
        ],
      });
      continue;
    }
    if (turn.kind === "assistant_tools") {
      const hasReasoningContent =
        typeof turn.reasoningContent === "string" &&
        turn.reasoningContent.length > 0;
      const hasReasoningItems =
        turn.reasoningItems !== undefined && turn.reasoningItems.length > 0;
      // Opaque Responses reasoning items round-trip verbatim. A bare
      // `reasoning_content` string has no proven Responses item mapping —
      // refuse rather than silently drop it on inject.
      if (hasReasoningContent && !hasReasoningItems) {
        throw new Error(
          "codex capture cannot inject reasoning_content without opaque reasoning_items",
        );
      }
      if (hasReasoningItems) {
        for (const raw of turn.reasoningItems ?? []) {
          if (raw !== null && typeof raw === "object") {
            items.push({ ...(raw as Record<string, unknown>) });
          }
        }
      }
      if (typeof turn.text === "string" && turn.text.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: turn.text }],
        });
      }
      for (const call of turn.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    items.push({
      type: "function_call_output",
      call_id: turn.toolCallId,
      output: turn.content,
    });
  }
  return items;
};

export type TCodexInjectItemsResult =
  | { readonly ok: true; readonly raw: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Append daemon-owned Responses items to model-visible history without
 * starting a user turn. Call only after builder interrupt terminal.
 */
export const injectCodexCaptureHistory = async (args: {
  readonly client: {
    request(method: string, params: unknown): Promise<unknown>;
  };
  readonly threadId: string;
  readonly items: ReadonlyArray<Record<string, unknown>>;
}): Promise<TCodexInjectItemsResult> => {
  if (args.items.length === 0) {
    return { ok: true, raw: { empty: true } };
  }
  try {
    const raw = await args.client.request("thread/inject_items", {
      threadId: args.threadId,
      items: args.items,
    });
    return { ok: true, raw };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Codex-specific history plan: structured inject only when LIVE-proven
 * (or an explicit test override for hermetic inject coverage).
 */
export const planCodexCaptureHistory = (args: {
  readonly systemText: string | null;
  readonly turns: ReadonlyArray<TNativeHistoryTurn>;
  readonly deltaText: string;
  readonly hasPrior: boolean;
  /** Test/injection only — never set from serve with hermetic-only proof. */
  readonly structuredInjectProven?: boolean;
}): TCaptureHistoryBuilderPlan =>
  captureAwareHistoryBuilderPlan({
    ...args,
    structuredInjectProven:
      args.structuredInjectProven ?? CODEX_STRUCTURED_INJECT_PROVEN,
  });

export type TCodexCaptureToolTurnParams = TCodexNativeParams & {
  readonly tools: ReadonlyArray<TClientTool>;
  /**
   * Prior capture history for multi-turn. When tool artifacts are present
   * they are fed via `thread/inject_items` before the delta `turn/start` —
   * LIVE-proven for one tool-call + matching tool-result (see
   * `CODEX_STRUCTURED_INJECT_LIVE_PROVEN`'s doc comment for exact scope and
   * open gaps). Reasoning artifacts without opaque `reasoningItems` are still
   * refused (`codexHistoryToResponsesItems` throws) — that has NOT changed.
   * Plain text uses cold seed into `userText` instead.
   */
  readonly historyTurns?: ReadonlyArray<TNativeHistoryTurn>;
  /**
   * Test override only. Production should simply omit this and rely on
   * `CODEX_STRUCTURED_INJECT_PROVEN` (now LIVE-proven for the scope
   * documented on `CODEX_STRUCTURED_INJECT_LIVE_PROVEN`). Passing `false`
   * here forces cold-seed even for tool-bearing history (e.g. a caller that
   * wants to test the pre-proof fallback path).
   */
  readonly structuredInjectProven?: boolean;
  /** Test seam: remap chatgpt.com → loopback fake upstream without global patch. */
  readonly fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  /**
   * Hermetic/tests only. Production omits — routes come from forwarded
   * `/wham/accounts/check`. Empty memory fails closed.
   */
  readonly captureWorkspaceRoutes?: TCodexWorkspaceRouteMemory;
};

type TCaptureClient = ReturnType<typeof createIsolatedCodexAppServerClient>;
type TCaptureReceiver = ReturnType<typeof startCodexCaptureReceiver>;
type TCaptureSession = ReturnType<typeof createRequestCaptureSession>;

/**
 * Refuse any builder-side `item/tool/call` without executing it. Capture
 * ownership means the daemon consumes true Responses tool intents; the
 * builder must not become a second execution boundary.
 *
 * Registered BEFORE `turn/start` and stays the active sink through the
 * whole capture/dispatch window — `settleCodexCaptureTurn`'s own `addSink`
 * call only replaces it AFTER `runCapturedDispatch` resolves. Its
 * `onCompleted` therefore mirrors the text-capture path's early-watch sink
 * (`codex-capture.ts`'s `runCodexCapturedTextTurn`): a native
 * `turn/completed` that lands before anything has been captured/dispatched
 * must fail the capture session immediately with the real reason, not be
 * swallowed — otherwise the daemon silently waits out the full precommit
 * timeout instead of surfacing why the native side already ended the turn.
 */
const attachToolCallRefusalSink = (
  client: TCaptureClient,
  threadId: string,
  session: TCaptureSession,
  receiver: TCaptureReceiver,
): {
  readonly refusedCallIds: () => ReadonlyArray<string>;
  readonly onToolCall: (
    requestId: number,
    callId: string,
    tool: string,
    args: unknown,
  ) => void;
} => {
  const refused: string[] = [];
  const onToolCall = (
    requestId: number,
    callId: string,
    _tool: string,
    _args: unknown,
  ): void => {
    refused.push(callId);
    client.respondToServer(requestId, {
      contentItems: [
        {
          type: "inputText",
          text: "(capture: tool execution suppressed; daemon owns the exchange)",
        },
      ],
      success: false,
    });
  };
  client.addSink({
    threadId,
    onDelta: () => {},
    onAgentMessage: () => {},
    onUsage: () => {},
    onCompleted: (status, errorMessage) => {
      if (receiver.capturedCount() > 0 || session.dispatchStarted()) {
        // Capture/dispatch already under way — terminal ownership belongs
        // to `settleCodexCaptureTurn`'s own (later) sink; do not interfere.
        return;
      }
      const detail =
        errorMessage !== null && errorMessage.length > 0
          ? `${status}: ${errorMessage}`
          : status;
      try {
        session.complete({
          kind: "failed",
          reason: `codex turn ended before capture (${detail})`,
          usage: { kind: "none" },
        });
      } catch {
        // session may already be terminal/disposed
      }
    },
    onToolCall,
  });
  return {
    refusedCallIds: (): ReadonlyArray<string> => refused,
    onToolCall,
  };
};

/**
 * Isolated capture tool route: register dynamicTools → vendor builds the
 * authenticated tool-bearing envelope → daemon dispatches once → builder
 * interrupt settlement → daemon publishes decoded chunks (including parallel
 * function_call intents). Never feeds the true response into the SDK loop.
 */
export const runCodexCapturedToolTurn = async (
  params: TCodexCaptureToolTurnParams,
): Promise<TNativeRunResult> => {
  const historyTurns = params.historyTurns ?? [];
  const hasPrior = historyTurns.length > 0;
  const plan = planCodexCaptureHistory({
    systemText: params.systemText,
    turns: historyTurns,
    deltaText: params.userText,
    hasPrior,
    ...(params.structuredInjectProven !== undefined
      ? { structuredInjectProven: params.structuredInjectProven }
      : {}),
  });

  if (plan.kind === "unsupported") {
    return {
      kind: "declined",
      reason: `codex capture history unsupported: ${plan.reason}`,
    };
  }

  const dynamicTools = codexCaptureDynamicTools(params.tools);
  // Empty after web_search suppression is still valid: hosted search alone.
  const session = createRequestCaptureSession({
    destinationPolicy: codexCaptureDestinationPolicy({ allowLoopback: false }),
    // Bind the CALLER's abort signal at session creation — same as the text
    // capture path (`runCodexCapturedTextTurn`). Without this, `session.signal`
    // is driven only by the capture-wait budget and by `dispatchStarted`/
    // `complete()`'s own terminal transitions; a caller abort mid-dispatch
    // (fetch/WS in flight) would never propagate to the in-flight sender at
    // all. (CodeRabbit round-2: this was previously omitted here — the removed
    // comment above claimed the text path's contract was "matched" by relying
    // on `session.signal` alone, which was true only for the text path,
    // because THAT session creation call already binds `signal: params.signal`.
    // This call site did not, so caller abort was silently unhandled during
    // dispatch. `runCapturedDispatch` completing the session on success does
    // NOT abort `session.signal` — see `finishTerminal` in
    // request-capture.ts — so binding this is safe on the success path too.)
    signal: params.signal,
    captureTimeoutMs: params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
  });

  const receiver = startCodexCaptureReceiver({
    session,
    signal: params.signal,
    ...(params.captureWorkspaceRoutes !== undefined
      ? { workspaceRoutes: params.captureWorkspaceRoutes }
      : {}),
  });
  const redirects = codexCaptureRedirectArgs(receiver.guardedBaseUrl);

  let threadId: string | null = null;
  let turnId: string | null = null;
  let captureOwnership: TCaptureOwnership = "none";
  let refusal: ReturnType<typeof attachToolCallRefusalSink> | null = null;
  const order: string[] = [];

  // Request-private ephemeral `CODEX_HOME` for the redirect keys — see
  // `codex-capture-ephemeral-home.ts` for the full source-verified
  // rationale. Never `-c` argv, never the daemon's shared/durable
  // `cliEnv("chatgpt").CODEX_HOME`. Must be built BEFORE the client is
  // constructed (the client's env carries the ephemeral home).
  const durableCodexHome = params.env.CODEX_HOME;
  if (typeof durableCodexHome !== "string" || durableCodexHome.length === 0) {
    receiver.stop();
    session.dispose();
    return {
      kind: "declined",
      reason:
        "codex capture: CODEX_HOME missing from isolated env; refusing to spawn without a private redirect config",
    };
  }
  let ephemeralHome: TCodexCaptureEphemeralHomeHandle;
  try {
    ephemeralHome = await createCodexCaptureEphemeralHome({
      durableCodexHome,
      chatgptBaseUrl: redirects.chatgptBaseUrl,
      openaiBaseUrl: redirects.openaiBaseUrl,
      tempRoot: join(daemonTempDir(), "codex-capture-home"),
    });
  } catch (err) {
    receiver.stop();
    session.dispose();
    return {
      kind: "declined",
      reason: `codex capture: ephemeral CODEX_HOME setup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const client = createIsolatedCodexAppServerClient(
    params.bin,
    {
      ...params.env,
      CODEX_HOME: ephemeralHome.ephemeralHome,
    },
    { modelMetadataHome: durableCodexHome },
  );

  const disposeAll = (): void => {
    if (threadId !== null) {
      try {
        client.removeSink(threadId);
      } catch {
        // ignore
      }
    }
    receiver.stop();
    // `dispose()` only SIGNALS the child; the ephemeral home it was reading
    // its redirect config from must not be deleted until the child has
    // ACTUALLY exited (`disposeAndWaitForExit` awaits the persistent exit
    // promise) — otherwise a still-live child could be mid-read/mid-write
    // against a directory this removes out from under it. Fire-and-forget
    // from here (this function stays synchronous), but the two steps are
    // chained. An unexpected rejection from `disposeAndWaitForExit` is NOT
    // treated as a confirmed exit — cleanup only runs in the success branch,
    // never from a `.catch()` — so this deliberately leaks the ephemeral
    // directory rather than risk deleting it out from under a child we could
    // not confirm has exited; the rejection is logged, not swallowed, and
    // never left as an unhandled promise.
    client
      .disposeAndWaitForExit()
      .then(() => ephemeralHome.cleanup())
      .catch((err) => {
        logError(
          "native-runtime",
          safeDiagnosticMessage`codex capture: could not confirm isolated app-server exit; ephemeral CODEX_HOME left in place rather than risk deleting a live directory`,
          { message: err instanceof Error ? err.message : String(err) },
        );
      });
    // Defer session dispose: completing the capture session aborts its
    // internal signal, and Bun can surface that as a late AbortError on the
    // dispatch AbortSignal.any used during fetch. Releasing on a microtask
    // after the dispatch await stack has unwound keeps that off the turn.
    void Promise.resolve().then(() => {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    });
  };

  try {
    await client.ensureStarted();
    const started = (await client.request(
      "thread/start",
      await client.prepareThreadParams(
        codexToolStartParams(
          params.providerModelId,
          params.systemText,
          dynamicTools,
          params.serviceTier,
          params.modelContextWindow,
        ),
      ),
    )) as { thread?: { id?: string } };
    if (typeof started.thread?.id !== "string") {
      disposeAll();
      return {
        kind: "declined",
        reason: "codex capture tool thread/start returned no thread id",
      };
    }
    threadId = started.thread.id;
    refusal = attachToolCallRefusalSink(client, threadId, session, receiver);

    let turnUserText: string;
    if (plan.kind === "structured_items") {
      let injectItems: ReadonlyArray<Record<string, unknown>>;
      try {
        injectItems = codexHistoryToResponsesItems(plan.items);
      } catch (error) {
        disposeAll();
        return {
          kind: "declined",
          reason: `codex capture history unsupported: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const injected = await injectCodexCaptureHistory({
        client,
        threadId,
        items: injectItems,
      });
      if (!injected.ok) {
        disposeAll();
        return {
          kind: "declined",
          reason: `codex capture inject_items failed: ${injected.reason}`,
        };
      }
      turnUserText = plan.deltaText;
    } else {
      turnUserText = plan.userText;
    }

    if (params.signal.aborted) {
      disposeAll();
      return { kind: "declined", reason: "client aborted" };
    }

    const effort = effortOf(params.reasoningEffort);
    const turn = (await client.request(
      "turn/start",
      codexTurnStartParams(threadId, turnUserText, effort, params.serviceTier),
    )) as { turn?: { id?: string } };
    turnId = typeof turn.turn?.id === "string" ? turn.turn.id : null;

    const sender = createCodexCapturedDispatchSender({
      session,
      ...(params.fetchImpl !== undefined
        ? { fetchImpl: params.fetchImpl }
        : {}),
    });
    // No independent dispatch signal passed here: `session.signal` is now
    // bound to `params.signal` at session creation (see above), so
    // `runCapturedDispatch`'s default (`session.signal` when `args.signal` is
    // omitted) already carries caller abort into the in-flight sender —
    // matches the text-capture path (`codex-capture.ts`), which passes
    // `signal: params.signal` explicitly to the same effect.
    const dispatched = await runCapturedDispatch({
      session,
      sender,
      suppressReason:
        "codex original external send suppressed; daemon owns the tool exchange",
    });
    captureOwnership = "accepted";

    // CAPTURE_INTERRUPT_ORDER: settle builder before publishing chunks.
    order.push(CAPTURE_INTERRUPT_ORDER[0]);
    const terminal = await settleCodexCaptureTurn({
      client,
      threadId,
      turnId,
      ...(refusal !== null ? { onToolCall: refusal.onToolCall } : {}),
    });
    order.push(CAPTURE_INTERRUPT_ORDER[1]);

    // Builder must not have executed tools. Refusals are acceptable; a
    // successful tool loop on the builder would violate capture ownership.
    void refusal?.refusedCallIds();

    // Builder interrupt is local settlement evidence — not a success signal
    // for the model. Prefer the dispatch outcome for terminal ownership.
    void terminal;

    const rawDecoded = decodeCodexUpstreamResponse(
      dispatched.response,
      params.providerModelId,
    );
    // Capture-only guard: same HTTP-transport truncation class as the text
    // path (codex-capture.ts `runCodexCapturedTextTurn`) — a clean upstream
    // EOF with no observed terminal `finish_reason` (`stop`, `tool_calls`,
    // etc.) must not silently publish as an empty success. WS dispatch is
    // already guarded at the sender before this Response exists.
    const decoded = requireCaptureTerminalFinishReason(rawDecoded);

    const published = publishCapturedDirectOutput({
      session,
      envelope: dispatched.envelope,
      terminal: dispatched.outcome,
      chunks: decoded,
      builderSettlement: session.builderSettlement() ?? {
        kind: "suppressed",
        reason: "codex capture builder settled via turn/interrupt",
      },
      onRelease: () => {
        disposeAll();
      },
    });
    order.push(CAPTURE_INTERRUPT_ORDER[2]);

    // Ensure interrupt ordering was respected (hermetic tests assert this
    // array shape via the exported helper when needed).
    if (order.join(",") !== CAPTURE_INTERRUPT_ORDER.join(",")) {
      disposeAll();
      return {
        kind: "declined",
        reason: "codex capture interrupt order violated",
        captureOwnership,
      };
    }

    const capturedThreadId = threadId;
    // Ownership is carried on declines; committed streams are already
    // daemon-owned via publishCapturedDirectOutput (noSecondSend).
    void published.captureOwnership;
    return {
      kind: "committed",
      chunks: published.chunks,
      sessionId: () => capturedThreadId,
    };
  } catch (error) {
    if (threadId !== null) {
      try {
        await settleCodexCaptureTurn({
          client,
          threadId,
          turnId,
          timeoutMs: 1_000,
        });
      } catch {
        // best-effort
      }
    }
    if (captureOwnership === "none" && session.dispatchStarted()) {
      captureOwnership = captureOwnershipFromSession(session);
    }
    const failure = captureDirectOutputFailure({
      session,
      reason: error instanceof Error ? error.message : String(error),
    });
    disposeAll();
    // Accepted/uncertain: TERMINAL — never handroll/retry/next-provider here.
    return {
      kind: "declined",
      reason: failure.reason,
      ...(failure.captureOwnership !== "none"
        ? { captureOwnership: failure.captureOwnership }
        : captureOwnership !== "none"
          ? { captureOwnership }
          : {}),
    };
  }
};

/** Drain a finite chunk stream (tests / inventory helpers). */
export const collectCodexCaptureChunks = async (
  stream: ReadableStream<TChatCompletionChunk>,
): Promise<ReadonlyArray<TChatCompletionChunk>> => {
  const out: TChatCompletionChunk[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
};
