/**
 * Claude `sdk-facade` — the Hermes-inspired native stream-json completion
 * facade (plan phase 6 / H1-H3,
 * `docs/plan/bridge-variants-and-capture-adapters/12-hermes-adoption-plan.md`).
 * Distinct from BOTH existing Claude paths:
 *
 *   - `stream-json` (`claude-native.ts`) feeds ONE text turn via `--resume`
 *     and a single buffered stdin write; no caller tools.
 *   - `agent-sdk` (`claude-tool-session.ts`) drives the official
 *     `@anthropic-ai/claude-agent-sdk` `query()` and HOLDS it open across
 *     tool round-trips.
 *
 * `sdk-facade` instead replays the ENTIRE canonical history as FRAMED
 * `--input-format stream-json` lines on every turn (Hermes §3.B: "structured
 * full-history replay") and spawns a FRESH, STATELESS `claude` child each
 * time — `--no-session-persistence`, no `--resume`. There is no vendor
 * session and no daemon-held query to partition by execution identity
 * (00-requirements.md req. 5: no new conversation identifier) — the
 * client's own full message history IS the correlation, exactly like an
 * ordinary OpenAI-shaped completion call.
 *
 * History → frames reuses the SAME exact, non-lossy decomposition every
 * other Claude tool path already uses — `request-capture-history.ts`'s
 * `historyTurnsFromCanonicalMessages` and `claude-tool-capture.ts`'s
 * `anthropicMessagesFromHistoryTurns`/`buildClaudeToolNameMap` — rather than
 * a parallel history planner (00-requirements.md req. 3).
 *
 * Replay protocol (Hermes §3.B) — role-specific, matching the reference
 * implementation exactly (`tmp/hermes-claude-sdk-reference/directsdk.py:581-595`):
 * ONLY a `type:"user"` frame that is not the last frame is written with
 * `shouldQuery: false` and MUST be acknowledged by a zero-turn `result` line
 * before the next frame is sent. A `type:"assistant"` historical frame (any
 * prior assistant/tool-use turn) is written and NEVER waited on — the
 * installed CLI appends it to conversation state silently, with no ack and
 * no error, and only ever resumes generation on the next `type:"user"` frame
 * that omits `shouldQuery`. The final frame (always `type:"user"` — history
 * decomposition guarantees a trailing user/tool-result turn) omits
 * `shouldQuery` and is the turn's ONE real model call — replay itself makes
 * no network request (Hermes §3.E: admission is a transport invariant;
 * `sdk-facade-capture` in `claude-sdk-facade-capture.ts` relies on exactly
 * this to intercept only that one call).
 *
 * **Earlier adaptation error (corrected):** a prior version of
 * {@link planClaudeSdkFacadeTurn} assigned `shouldQuery: false` to EVERY
 * non-final frame regardless of role, including `type:"assistant"` frames.
 * Because {@link replayClaudeSdkFacadeHistory} waits for an ack whenever
 * `shouldQuery === false`, that misassignment made the replay loop wait for
 * an acknowledgment the CLI never sends for an assistant frame — a genuine
 * hang bound only by `PRE_COMMIT_TIMEOUT_MS`. A guard
 * (`sdkFacadeRequiresUnsupportedAssistantReplay`) was added to refuse any
 * plan containing an assistant frame before ever spawning the CLI, avoiding
 * the hang but also blocking every ordinary multi-turn or tool-continuation
 * request — a correctness bug in the adaptation, not a genuine CLI
 * limitation, per the reference source above (only `type:"user"` frames are
 * ever assigned `shouldQuery: false`; `type:"assistant"` frames are appended
 * unconditionally with no ack expectation at all).
 *
 * **H1 real-CLI construction proof (verified against the real installed
 * `claude` binary, not merely `--help`-inferred or the reference source
 * alone):** `tests/transport/claude-sdk-facade-real-cli-construction.e2e.test.ts`
 * (opt-in, `RUN_DAEMON_LIVE=1`, real installed `claude` binary, dummy API
 * key, no login, no network — either no request at all for the local ack
 * accounting, or a local mock upstream for the one real dispatch) now
 * proves the CORRECTED protocol end to end:
 *
 *   - A `type:"user"` `shouldQuery:false` frame DOES receive a zero-turn
 *     `result` line (`num_turns: 0`) before the next write.
 *   - A `type:"assistant"` frame written WITHOUT `shouldQuery` (the fixed
 *     construction) produces no ack and no error, exactly as expected — the
 *     replay loop does not wait on it, so there is nothing to hang on.
 *   - A genuine multi-turn history (system + user + assistant + user, with
 *     unique per-turn sentinel text) reaches the production dispatch
 *     function (`runClaudeSdkFacadeCapture`) exactly ONCE, and the
 *     captured body's `messages` array is the ORDERED `[user, assistant,
 *     user]` triple with each turn's own sentinel in the right slot and no
 *     other turn's sentinel bled into it (not merely "the text appears
 *     somewhere in the body") — proof against missing, reordered, or
 *     duplicated turns.
 *   - Separately, a tool_use/tool_result continuation (assistant `tool_use`
 *     for a declared caller tool + a `tool_result` user turn, both non-final
 *     history frames) reaches the same production function exactly once,
 *     and the captured `tool_use` block carries the CLI's own
 *     `mcp__openllm__`-prefixed wire name plus the original call id and
 *     parsed input, while the `tool_result` block carries the original id
 *     and content.
 *   - Separately again, `runClaudeSdkFacade` — the NORMAL, non-capture
 *     production path, not just the capture-interception path — replays the
 *     same multi-turn history against a real local fake `/v1/messages` SSE
 *     upstream and produces a COMMITTED run whose output matches that
 *     upstream's scripted completion, with the upstream's own captured
 *     request confirming the full history reached it.
 *
 * All of the above is CONSTRUCTION/SHAPE proof — the exact bytes this
 * facade builds are ones the real installed CLI accepts and threads through
 * correctly against a local mock upstream — never proof of correctness
 * under genuine AUTHENTICATED inference, a different installed CLI version,
 * or real network conditions (H6, separately tracked, still unattempted).
 * On that evidence, `sdkFacadeRequiresUnsupportedAssistantReplay` and its
 * refusal have been removed — the shape it blocked was never actually
 * unsupported by the CLI, only mis-encoded by this facade. See
 * 09-implementation-plan.md §13b for the corrected execution-status
 * wording.
 *
 * Streaming output reuses `@openllmsh/wire`'s
 * `fromAnthropicStreamEvent`/`newAnthropicStreamState` UNCHANGED — the same
 * `--include-partial-messages` NDJSON shape `claude-native.ts` already
 * decodes — with `toolNameMap` wired so a caller `tool_use` block decodes
 * under its ORIGINAL name, never the MCP-prefixed one. Caller tools are
 * declared (schema only) via `claude-facade-mcp-server.ts`'s loopback MCP
 * server; the model's `tool_use` block ends the turn (`--max-turns 1`)
 * before the CLI would ever actually invoke a tool — caller tools stay
 * caller-owned (00-requirements.md req. 6).
 */

import { existsSync } from "node:fs";
import type {
  TAnthropicStreamEvent,
  TChatCompletionChunk,
  TChatCompletionRequest,
} from "@openllmsh/protocol";
import { AnthropicStreamEvent } from "@openllmsh/protocol";
import { CLAUDE_NATIVE_ASSISTANT_PENDING } from "@openllmsh/wire/adapters/messages/reasoning-signature";
import { isRefusalChunk } from "@openllmsh/wire/lib/refusal";
import { isMeaningfulChunk } from "@openllmsh/wire/lib/streaming/peek";
import type { TAnthropicStreamState } from "@openllmsh/wire/providers/anthropic/streaming";
import {
  fromAnthropicStreamEvent,
  newAnthropicStreamState,
} from "@openllmsh/wire/providers/anthropic/streaming";
import { Schema } from "effect";
import { logDebug, logError, safeDiagnosticMessage } from "../logger";
import {
  claudeFacadeHistory,
  claudeNativeAssistantCarrier,
} from "./claude-facade-history";
import { startClaudeFacadeMcpServer } from "./claude-facade-mcp-server";
import { ndjsonLines } from "./claude-native";
import type { TClaudeFacadeMcpServerRef } from "./claude-spawn";
import { spawnClaudeFacadeCli } from "./claude-spawn";
import type {
  TClaudeAnthropicMessage,
  TClaudeToolNameMap,
} from "./claude-tool-capture";
import { buildClaudeToolNameMap } from "./claude-tool-capture";
import { clientToolsOf } from "./claude-tool-serve";
import type { TClientTool } from "./claude-tool-session";
import type { TNativeRunResult } from "./types";
import { cleanNativeSpawnEnv, PRE_COMMIT_TIMEOUT_MS } from "./types";

const decodeStreamEvent = Schema.decodeUnknownOption(AnthropicStreamEvent);

/** One framed `--input-format stream-json` input line. `shouldQuery: false`
 *  marks every historical turn (see module doc); the final frame omits it. */
export type TClaudeSdkFacadeFrame = {
  readonly type: "user" | "assistant";
  readonly message: TClaudeAnthropicMessage;
  readonly shouldQuery?: false;
};

export type TClaudeSdkFacadeTurnPlan =
  | {
      readonly ok: true;
      readonly systemText: string | null;
      readonly frames: ReadonlyArray<TClaudeSdkFacadeFrame>;
      readonly tools: ReadonlyArray<TClientTool>;
      readonly toolNameMap: TClaudeToolNameMap;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Decompose a canonical request into Hermes-style framed history. User
 * multimodal blocks and grouped tool results use the shared Anthropic wire
 * converter. Unsigned reasoning is visible context; native signed blocks use
 * a versioned, projection-checked carrier. Opaque foreign state, edited native
 * projections, unsupported content, and assistant prefills fail before spawn.
 */
export const planClaudeSdkFacadeTurn = (
  canonical: TChatCompletionRequest,
  providerModelId: string = canonical.model,
): TClaudeSdkFacadeTurnPlan => {
  const tools = clientToolsOf(canonical);
  const toolNameMap = buildClaudeToolNameMap(tools);
  let messages: ReadonlyArray<TClaudeAnthropicMessage>;
  let systemText: string | null;
  try {
    const history = claudeFacadeHistory(
      canonical,
      toolNameMap,
      providerModelId,
    );
    messages = history.messages;
    systemText = history.systemText;
  } catch (error) {
    return {
      ok: false,
      reason: `sdk-facade: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (messages.length === 0) {
    return { ok: false, reason: "no user turn to answer" };
  }
  const lastIndex = messages.length - 1;
  const frames: TClaudeSdkFacadeFrame[] = messages.map((message, i) => ({
    type: message.role,
    message,
    // Role-specific, matching the reference implementation exactly
    // (`tmp/hermes-claude-sdk-reference/directsdk.py:581-595`): ONLY a
    // non-final `type:"user"` frame is marked `shouldQuery: false` (and
    // therefore awaited for a zero-turn ack by
    // `replayClaudeSdkFacadeHistory`). A `type:"assistant"` frame is ALWAYS
    // written unconditionally — the installed CLI appends it to
    // conversation state with no ack and no error either way, and waiting
    // on one hangs the replay loop for no reason (see this module's doc
    // comment's "earlier adaptation error").
    ...(i < lastIndex && message.role === "user"
      ? { shouldQuery: false as const }
      : {}),
  }));
  return {
    ok: true,
    systemText,
    frames,
    tools,
    toolNameMap,
  };
};

/** Bun's writable stdin pipe, narrowed to the subset every framed writer in
 *  this codebase uses (matches `codex-app-server.ts`'s own narrowing). */
export type TClaudeFacadeStdinWriter = {
  readonly write: (s: string) => void;
  readonly flush?: () => void;
  readonly end?: () => void;
};

type TFacadeLine = Readonly<Record<string, unknown>>;

const parseFacadeLine = (raw: string): TFacadeLine | null => {
  try {
    return JSON.parse(raw) as TFacadeLine;
  } catch {
    return null;
  }
};

/** Read stdout lines until a `result` line (the zero-turn ack, or noise in
 *  between) or end-of-stream (`null`). Non-`result`, non-JSON lines are
 *  skipped — mirrors `claude-native.ts`'s tolerance of debug/system noise. */
const nextResultLine = async (
  reader: ReadableStreamDefaultReader<string>,
): Promise<TFacadeLine | null> => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    const line = parseFacadeLine(value);
    if (line === null) continue;
    if (line.type === "result") return line;
  }
};

/**
 * `nextResultLine`, bounded by {@link PRE_COMMIT_TIMEOUT_MS} — the SAME
 * "no output before deadline" budget `runFacadeDecode`'s own pre-commit race
 * already uses, and the same pattern `codex-app-server.ts#request` bounds
 * every JSON-RPC round trip with (`RPC_TIMEOUT_MS`). Without this, a `claude`
 * child that never emits the expected zero-turn `result` line for a
 * historical frame (rather than emitting a wrong one, which
 * {@link replayClaudeSdkFacadeHistory} already handles) would hang the
 * whole request — and the spawned child — indefinitely instead of declining
 * cleanly. This is not a hypothetical: the real installed CLI genuinely
 * never emits a `result` line for a `type:"assistant"` replay frame (this
 * module's doc comment, H1's real-CLI construction proof) — every multi-turn
 * request hits exactly this timeout in production today, rather than
 * hanging forever thanks to this bound.
 */
const nextResultLineOrTimeout = async (
  reader: ReadableStreamDefaultReader<string>,
  timeoutMs: number,
): Promise<TFacadeLine | null | "timeout"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      nextResultLine(reader),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export type TClaudeSdkFacadeReplayResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Write every frame, waiting for a zero-turn acknowledgment after each
 * `shouldQuery: false` one (Hermes §3.B). Refuses — rather than guessing —
 * the moment an ack is missing/non-zero-turn/erroring: history replay is
 * version-sensitive vendor protocol, never silently assumed supported (H1).
 * Leaves `reader` positioned exactly after the last ack, ready for the
 * caller's own decode of the FINAL (query) frame's response.
 */
export const replayClaudeSdkFacadeHistory = async (params: {
  readonly stdin: TClaudeFacadeStdinWriter;
  readonly reader: ReadableStreamDefaultReader<string>;
  readonly frames: ReadonlyArray<TClaudeSdkFacadeFrame>;
  readonly signal: AbortSignal;
  /** Override for tests — production omits this and gets
   *  {@link PRE_COMMIT_TIMEOUT_MS} (same `precommitMs` convention as
   *  `codex-app-server.ts`/`cursor-acp.ts`). */
  readonly precommitMs?: number;
}): Promise<TClaudeSdkFacadeReplayResult> => {
  const ackTimeoutMs = params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS;
  for (let i = 0; i < params.frames.length; i += 1) {
    if (params.signal.aborted) {
      return { ok: false, reason: "client aborted" };
    }
    const frame = params.frames[i];
    if (frame === undefined) continue;
    params.stdin.write(`${JSON.stringify(frame)}\n`);
    params.stdin.flush?.();
    if (frame.shouldQuery === false) {
      const ack = await nextResultLineOrTimeout(params.reader, ackTimeoutMs);
      if (ack === "timeout") {
        return {
          ok: false,
          reason:
            "sdk-facade: no replay acknowledgment before deadline — native runtime may be hung",
        };
      }
      if (ack === null) {
        return {
          ok: false,
          reason:
            "sdk-facade: native runtime exited before a replay acknowledgment",
        };
      }
      if (ack.num_turns !== 0 || ack.is_error === true) {
        return {
          ok: false,
          reason:
            "sdk-facade: native history replay is not supported by this claude CLI (expected a zero-turn acknowledgment) — see 12-hermes-adoption-plan.md H1",
        };
      }
    }
  }
  params.stdin.end?.();
  return { ok: true };
};

export type TClaudeSdkFacadeParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly canonical: TChatCompletionRequest;
  readonly signal: AbortSignal;
  /** Forwarded to {@link replayClaudeSdkFacadeHistory}'s `precommitMs` —
   *  tests only; production omits this. */
  readonly precommitMs?: number;
};

const assistantMessageChunk = (
  message: unknown,
  providerModelId: string,
  toolNameMap: ReadonlyMap<string, string>,
): TChatCompletionChunk | null => {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];
  const textParts: string[] = [];
  const toolCalls: Array<{
    index: number;
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown };
    if (
      b.type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      textParts.push((block as { text: string }).text);
    } else if (b.type === "tool_use") {
      const tb = block as { id?: unknown; name?: unknown; input?: unknown };
      if (typeof tb.id === "string" && typeof tb.name === "string") {
        toolCalls.push({
          index: toolCalls.length,
          id: tb.id,
          type: "function",
          function: {
            name: toolNameMap.get(tb.name) ?? tb.name,
            arguments: JSON.stringify(tb.input ?? {}),
          },
        });
      }
    }
  }
  const text = textParts.join("");
  if (text.length === 0 && toolCalls.length === 0) return null;
  const m = message as { id?: unknown };
  return {
    id: typeof m.id === "string" ? m.id : "msg_sdk_facade",
    object: "chat.completion.chunk",
    created: 0,
    model: providerModelId,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(text.length > 0 ? { content: text } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
  };
};

/**
 * Drive the decode loop for the FINAL frame's response (native mode only —
 * `sdk-facade-capture` never decodes this stdout as model output). Structure
 * mirrors `claude-native.ts`'s `nextChunk`/`pump` (pre-commit buffering,
 * assistant-line fallback when partials carried no output) but is a
 * SEPARATE implementation: it must also decode `tool_use` blocks and never
 * captures/publishes a `session_id` (the facade has no vendor session).
 */
/** How long we'll wait for the already-exited (or about-to-exit) child's
 *  real exit code before giving up on the `error_max_turns` boundary below
 *  — the process has already written its terminal `result` line by the
 *  time we check this, so it is either already exited or exiting; this is
 *  a safety bound, never an expected wait. */
const EXIT_CODE_WAIT_MS = 5_000;

/** In-flight `tool_use` content-block builder — accumulated from the RAW
 *  Anthropic stream events (never the already-decoded canonical chunk,
 *  which the wire layer intentionally forwards even while a call's JSON
 *  argument text is still only partially buffered). */
type TPendingToolCall = {
  readonly id: string;
  readonly name: string;
  argsText: string;
};

/**
 * Tracks whether the turn produced at least one COMPLETE, VALIDATED caller
 * tool call — never satisfied by a bare name delta. "Complete" here means:
 * a `content_block_start` of type `tool_use` with a non-empty id AND a name
 * that resolves through the plan's OWN `toolNameMap` (i.e. a KNOWN declared
 * caller tool, not an unrecognized or malformed one), followed by zero or
 * more `input_json_delta` deltas, followed by that SAME index's
 * `content_block_stop` with the accumulated argument text parsing as valid
 * JSON. A tool block that never reaches `content_block_stop`, whose name
 * never matches a declared tool, or whose accumulated arguments don't parse
 * is never counted — matching Hermes's own validation
 * (`tmp/hermes-claude-sdk-reference/directsdk.py:645-649`) before it will
 * accept the `error_max_turns` boundary.
 */
class TFacadeToolCallTracker {
  private readonly pending = new Map<number, TPendingToolCall>();
  private completedValid = 0;
  private invalidTool = false;
  sawMessageStop = false;
  lastStopReason: string | null = null;

  constructor(private readonly toolNameMap: ReadonlyMap<string, string>) {}

  observe(event: TAnthropicStreamEvent): void {
    if (event.type === "content_block_start") {
      if (event.content_block.type !== "tool_use") return;
      this.pending.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        argsText: "",
      });
      return;
    }
    if (event.type === "content_block_delta") {
      if (event.delta.type !== "input_json_delta") return;
      const p = this.pending.get(event.index);
      if (p === undefined) return;
      p.argsText += event.delta.partial_json;
      return;
    }
    if (event.type === "content_block_stop") {
      const p = this.pending.get(event.index);
      this.pending.delete(event.index);
      if (p === undefined) return;
      // One valid tool must never hide another invalid tool in the same turn.
      if (p.id.length === 0 || !this.toolNameMap.has(p.name)) {
        this.invalidTool = true;
        return;
      }
      const args = p.argsText.trim().length === 0 ? "{}" : p.argsText;
      try {
        const input: unknown = JSON.parse(args);
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input)
        ) {
          this.invalidTool = true;
          return;
        }
      } catch {
        this.invalidTool = true;
        return;
      }
      this.completedValid += 1;
      return;
    }
    if (event.type === "message_delta") {
      this.lastStopReason = event.delta.stop_reason;
      return;
    }
    if (event.type === "message_stop") {
      this.sawMessageStop = true;
    }
  }

  /** At least one genuinely complete, validated caller tool call — AND the
   *  message actually ended on it (`message_stop` observed, terminal
   *  `stop_reason: "tool_use"`), never a partial/malformed/unknown one. */
  hasCompleteValidatedToolCall(): boolean {
    return (
      this.completedValid > 0 &&
      !this.invalidTool &&
      this.pending.size === 0 &&
      this.sawMessageStop &&
      this.lastStopReason === "tool_use"
    );
  }
}

const runFacadeDecode = (args: {
  readonly reader: ReadableStreamDefaultReader<string>;
  readonly providerModelId: string;
  readonly toolNameMap: ReadonlyMap<string, string>;
  readonly state: TAnthropicStreamState;
  readonly kill: () => void;
  /** Resolves to the child's real exit code — required to confirm the
   *  `error_max_turns` boundary below the same way Hermes's reference does
   *  (`p.returncode == 1`). Every production caller passes it; bounded by
   *  {@link EXIT_CODE_WAIT_MS} so a process that somehow never settles can
   *  never hang the boundary check. */
  readonly exitCode: Promise<number>;
}): Promise<TNativeRunResult> => {
  let emittedContent = false;
  let terminalSucceeded = false;
  const toolTracker = new TFacadeToolCallTracker(args.toolNameMap);
  const nativeMessages: unknown[] = [];
  let pendingTerminal: TChatCompletionChunk | null = null;

  const successfulTerminal = (): TChatCompletionChunk | "end" => {
    terminalSucceeded = true;
    const terminal = pendingTerminal;
    pendingTerminal = null;
    return terminal ?? "end";
  };

  const boundedExitCode = async (): Promise<number | "timeout"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        args.exitCode,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), EXIT_CODE_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const nextChunk = async (): Promise<
    TChatCompletionChunk | "end" | { error: string }
  > => {
    if (terminalSucceeded) return "end";
    for (;;) {
      const { value, done } = await args.reader.read();
      if (done) {
        return terminalSucceeded
          ? "end"
          : {
              error:
                "sdk-facade: native runtime ended without a successful terminal result",
            };
      }
      const line = parseFacadeLine(value);
      if (line === null) continue;
      if (line.type === "stream_event" && line.event !== undefined) {
        const event = decodeStreamEvent(line.event);
        if (event._tag !== "Some") continue;
        toolTracker.observe(event.value);
        const chunk = fromAnthropicStreamEvent(event.value, args.state, {
          providerModelId: args.providerModelId,
        });
        if (chunk === null) continue;
        // A native message's finish is not the CLI's terminal outcome. Hold it
        // until the result line validates success, and emit the lossless carrier
        // first so a client stopping at finish_reason has already received it.
        if (chunk.choices.some((choice) => choice.finish_reason != null)) {
          pendingTerminal = chunk;
          continue;
        }
        if (isMeaningfulChunk(chunk)) emittedContent = true;
        // Tell the Messages encoder to hold thinking for its replay carrier,
        // instead of dumping it into visible text before the signed snapshot.
        return event.value.type === "message_start"
          ? {
              ...chunk,
              choices: chunk.choices.map((choice) => ({
                ...choice,
                delta: {
                  ...choice.delta,
                  reasoning_items: [{ type: CLAUDE_NATIVE_ASSISTANT_PENDING }],
                },
              })),
            }
          : chunk;
      }
      if (line.type === "assistant") {
        nativeMessages.push(line.message);
        const carrier = claudeNativeAssistantCarrier(
          nativeMessages,
          args.providerModelId,
          {
            mcpToCaller: args.toolNameMap,
            leafToCaller: new Map(),
          },
        );
        const chunk = !emittedContent
          ? assistantMessageChunk(
              line.message,
              args.providerModelId,
              args.toolNameMap,
            )
          : null;
        if (chunk !== null) {
          emittedContent = true;
          pendingTerminal ??= {
            ...chunk,
            choices: chunk.choices.map((choice) => ({ ...choice, delta: {} })),
          };
          return {
            ...chunk,
            choices: chunk.choices.map((choice) => ({
              ...choice,
              finish_reason: null,
              delta: { ...choice.delta, reasoning_items: [carrier] },
            })),
          };
        }
        return {
          id: args.state.id ?? "msg_sdk_facade",
          object: "chat.completion.chunk",
          created: args.state.created,
          model: args.providerModelId,
          choices: [
            {
              index: 0,
              delta: { reasoning_items: [carrier] },
              finish_reason: null,
            },
          ],
        };
      }
      if (line.type === "result") {
        const isError = line.is_error === true;
        const subtype = typeof line.subtype === "string" ? line.subtype : null;
        // Hermes's exact carved-out boundary
        // (`tmp/hermes-claude-sdk-reference/directsdk.py:653`): a genuine
        // `error_max_turns` terminal result that produced at least one
        // COMPLETE, VALIDATED new tool call (known name, real id, parseable
        // args — never a bare name delta), on the CLI's own
        // `error_max_turns` exit code (1), is a successful caller-tool
        // boundary — never a broad "ignore is_error because something
        // arrived" carve-out. Every other `is_error: true` shape (no
        // completed tool call, no message_stop, wrong stop_reason, wrong
        // subtype, wrong/unavailable exit code) still fails.
        if (
          isError &&
          subtype === "error_max_turns" &&
          toolTracker.hasCompleteValidatedToolCall()
        ) {
          const exitCode = await boundedExitCode();
          if (exitCode === 1) {
            return successfulTerminal();
          }
        }
        if (isError) {
          const reason =
            typeof line.result === "string" && line.result.length > 0
              ? line.result
              : "sdk-facade: native runtime reported an unsuccessful terminal result";
          return { error: reason };
        }
        return successfulTerminal();
      }
    }
  };

  const buffered: TChatCompletionChunk[] = [];
  const pump = async (): Promise<
    | { kind: "meaningful"; chunk: TChatCompletionChunk }
    | { kind: "exit" }
    | { kind: "error"; reason: string }
  > => {
    for (;;) {
      const next = await nextChunk();
      if (next === "end") return { kind: "exit" };
      if (typeof next === "object" && "error" in next) {
        return { kind: "error", reason: next.error };
      }
      const chunk = next;
      if (isMeaningfulChunk(chunk)) {
        if (isRefusalChunk(chunk)) {
          return {
            kind: "error",
            reason:
              "sdk-facade: claude runtime refused the request (content filter)",
          };
        }
        return { kind: "meaningful", chunk };
      }
      buffered.push(chunk);
    }
  };

  return (async (): Promise<TNativeRunResult> => {
    let precommitTimer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      pump().catch(() => ({
        kind: "error" as const,
        reason: "sdk-facade: invalid native response before commitment",
      })),
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
      const reason =
        first === "timeout"
          ? "sdk-facade: claude runtime produced no output before the pre-commit deadline"
          : "sdk-facade: claude runtime exited before producing output";
      logError(
        "native-runtime",
        safeDiagnosticMessage`sdk-facade hop declined pre-commit`,
        { reason },
      );
      return { kind: "declined", reason };
    }
    if (first.kind === "error") {
      args.kill();
      logError(
        "native-runtime",
        safeDiagnosticMessage`sdk-facade hop declined pre-commit`,
        { reason: first.reason },
      );
      return { kind: "declined", reason: first.reason };
    }
    const firstMeaningful = first.chunk;
    const chunks = new ReadableStream<TChatCompletionChunk>({
      start(controller) {
        for (const c of buffered) controller.enqueue(c);
        controller.enqueue(firstMeaningful);
      },
      async pull(controller) {
        try {
          const next = await nextChunk();
          if (next === "end") {
            controller.close();
            args.kill();
            return;
          }
          if ("error" in next) throw new Error(next.error);
          controller.enqueue(next);
        } catch (error) {
          logError(
            "native-runtime",
            safeDiagnosticMessage`sdk-facade stream failed post-commit`,
            { reason: error instanceof Error ? error.message : String(error) },
          );
          args.kill();
          controller.error(error);
        }
      },
      cancel() {
        args.kill();
      },
    });
    return { kind: "committed", chunks, sessionId: () => null };
  })();
};

/**
 * Privacy-safe phase timing shared by BOTH `sdk-facade` (native, below) and
 * `sdk-facade-capture` (`claude-sdk-facade-capture.ts`, which imports and
 * calls this SAME function rather than a second implementation) — see
 * `09-implementation-plan.md` §8 ("Diagnostics + documentation... Effective
 * selection and phase timings truthful, privacy-safe and common to
 * base/capture"). Metadata-only: elapsed milliseconds and the run's closed
 * `kind` outcome — never prompt text, tool arguments, tokens, or
 * credentials, matching `muse-runtime.ts`'s existing phase-timing
 * convention (numbers + outcome only).
 */
export const logSdkFacadePhaseTiming = (params: {
  readonly capture: boolean;
  readonly startedAt: number;
  readonly outcome: TNativeRunResult["kind"];
}): void => {
  logDebug("native-runtime", "sdk-facade phase timing", {
    provider: "claude_code",
    variant: "sdk-facade",
    capture: params.capture,
    outcome: params.outcome,
    elapsed_ms: Math.max(0, Math.round(performance.now() - params.startedAt)),
  });
};

/** Run one `sdk-facade` completion turn — native mode (no capture; see
 *  `claude-sdk-facade-capture.ts` for `sdk-facade-capture`). A thin timing
 *  wrapper around {@link runClaudeSdkFacadeCore} — see
 *  {@link logSdkFacadePhaseTiming}'s doc comment. */
export const runClaudeSdkFacade = async (
  params: TClaudeSdkFacadeParams,
): Promise<TNativeRunResult> => {
  const startedAt = performance.now();
  const result = await runClaudeSdkFacadeCore(params);
  logSdkFacadePhaseTiming({
    capture: false,
    startedAt,
    outcome: result.kind,
  });
  return result;
};

const runClaudeSdkFacadeCore = async (
  params: TClaudeSdkFacadeParams,
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

  let mcpServer: TClaudeFacadeMcpServerRef | null = null;
  let stopMcpServer: (() => void) | null = null;
  if (plan.tools.length > 0) {
    const server = startClaudeFacadeMcpServer({
      tools: plan.tools,
      onForbiddenCall: (name) => {
        logError(
          "native-runtime",
          safeDiagnosticMessage`sdk-facade inert MCP handler was invoked`,
          { name },
        );
      },
    });
    mcpServer = { url: server.url, headers: server.headers };
    stopMcpServer = server.stop;
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawnClaudeFacadeCli({
      bin: params.bin,
      providerModelId: params.providerModelId,
      systemText: plan.systemText,
      mcpServer,
      finalEnv: cleanNativeSpawnEnv(params.env),
    });
  } catch (error) {
    stopMcpServer?.();
    return {
      kind: "declined",
      reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const kill = (): void => {
    params.signal.removeEventListener("abort", kill);
    stopMcpServer?.();
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
  };
  if (params.signal.aborted) {
    kill();
    return { kind: "declined", reason: "client aborted" };
  }
  params.signal.addEventListener("abort", kill, { once: true });

  const stdin = proc.stdin as unknown as TClaudeFacadeStdinWriter;
  const reader = ndjsonLines(
    proc.stdout as ReadableStream<Uint8Array>,
  ).getReader();

  const replay = await replayClaudeSdkFacadeHistory({
    stdin,
    reader,
    frames: plan.frames,
    signal: params.signal,
    ...(params.precommitMs !== undefined
      ? { precommitMs: params.precommitMs }
      : {}),
  });
  if (!replay.ok) {
    kill();
    logError(
      "native-runtime",
      safeDiagnosticMessage`sdk-facade hop declined during history replay`,
      { reason: replay.reason },
    );
    return { kind: "declined", reason: replay.reason };
  }

  const state = newAnthropicStreamState({
    providerModelId: params.providerModelId,
    ...(plan.toolNameMap.mcpToCaller.size > 0
      ? { toolNameMap: plan.toolNameMap.mcpToCaller }
      : {}),
  });
  return runFacadeDecode({
    reader,
    providerModelId: params.providerModelId,
    toolNameMap: plan.toolNameMap.mcpToCaller,
    exitCode: proc.exited,
    state,
    kill,
  });
};
