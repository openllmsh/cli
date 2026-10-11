/**
 * Claude native bridge — executes an eligible `claude_code` hop through the
 * OFFICIAL Claude Code runtime instead of exporting its OAuth bearer for a
 * hand-built Anthropic fetch (the manual path in `walker.ts`).
 *
 *   claude -p --output-format stream-json --include-partial-messages …
 *
 * runs under the daemon's isolated CLI env (`cliEnv("claude_code")` — HOME +
 * CLAUDE_CONFIG_DIR pinned inside `~/.openllm/cli/claude_code/`), so the
 * runtime owns authentication, refresh, identity, and the upstream request
 * itself; the daemon never reads the credential store on this path.
 *
 * `--include-partial-messages` wraps the RAW Anthropic SSE events in
 * `{"type":"stream_event","event":{…}}` NDJSON lines — exactly the event
 * shape the walker already decodes for the manual anthropic wire — so this
 * bridge reuses `fromAnthropicStreamEvent` verbatim and emits the same
 * canonical chunks the rest of the pipeline consumes. Flags:
 *   --tools ""                   no built-in tools — the init frame reports
 *                                an EMPTY tool set, so the model can't run
 *                                bash/edits on the user's machine for a
 *                                gateway text request (`nativeRequestOf` also
 *                                gates out tool-bearing requests upstream)
 *   --setting-sources ""         hermetic: ignore user/project/local settings
 *                                (e.g. a stray ANTHROPIC_BASE_URL redirect)
 *   --max-turns 1                single-shot; no agentic loop
 * NB: NO `--bare` — it disables the setting sources that carry the Claude
 * subscription credential, so `claude -p --bare` reports "Not logged in"
 * even when logged in. Verified empirically against the isolated CLI.
 * Any flag the installed CLI rejects surfaces as an early exit with no
 * output → the bridge DECLINES and the manual transport serves the hop.
 */

import { existsSync } from "node:fs";
import type { TChatCompletionChunk, TUsage } from "@openllmsh/protocol";
import { AnthropicStreamEvent } from "@openllmsh/protocol";
import { isRefusalChunk } from "@openllmsh/wire/lib/refusal";
import { isMeaningfulChunk } from "@openllmsh/wire/lib/streaming/peek";
import {
  fromAnthropicStreamEvent,
  newAnthropicStreamState,
} from "@openllmsh/wire/providers/anthropic/streaming";
import { Schema } from "effect";
import { logError, safeDiagnosticMessage } from "../logger";
import { runClaudeTextCapture } from "./claude-capture";
import { spawnClaudeCli } from "./claude-spawn";
import type { TCapturedDispatchSender } from "./request-capture";
import type { TNativeRunResult } from "./types";
import {
  cleanNativeSpawnEnv,
  normalizeNativeTerminalResult,
  PRE_COMMIT_TIMEOUT_MS,
} from "./types";

const decodeStreamEvent = Schema.decodeUnknownOption(AnthropicStreamEvent);

/** Map an Anthropic `usage` object (from an `assistant` full-message line) to
 *  canonical usage, defensively — the daemon must never reject a real answer on
 *  a usage-shape mismatch. Mirrors `usageFor` in `@openllmsh/wire`. */
const usageFromAnthropic = (u: unknown): TUsage | undefined => {
  if (typeof u !== "object" || u === null) return undefined;
  const r = u as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const cached = num(r.cache_read_input_tokens);
  const created = num(r.cache_creation_input_tokens);
  const prompt = input + cached + created;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    ...(cached > 0 || created > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cached,
            cache_creation_tokens: created,
          },
        }
      : {}),
  };
};

/** Did this decoded chunk carry actual model OUTPUT (content / reasoning /
 *  tool calls) — as opposed to a finish- or usage-only terminal chunk? Used to
 *  decide whether the partial stream already delivered the answer (so the
 *  `assistant` full-message line is a redundant echo) or not. */
const chunkHasOutput = (chunk: TChatCompletionChunk): boolean =>
  chunk.choices.some((choice) => {
    const d = choice.delta;
    const nonEmpty = (s: string | null | undefined): boolean =>
      typeof s === "string" && s.length > 0;
    const nonEmptyArr = (
      a: ReadonlyArray<unknown> | null | undefined,
    ): boolean => Array.isArray(a) && a.length > 0;
    return (
      nonEmpty(d.content) ||
      nonEmpty(d.reasoning_content) ||
      nonEmptyArr(d.tool_calls) ||
      nonEmptyArr(d.reasoning_items) ||
      nonEmptyArr(d.server_search_calls)
    );
  });

/** Extract the plain text of an `assistant` full-message line's `message`
 *  content — SCHEMA-FREE (a strict decode would reject a real message on any
 *  unmodelled block type, e.g. an opus `thinking` block, and lose the answer).
 *  Concatenates every `text` block; ignores the rest. */
const assistantMessageText = (message: unknown): string => {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
};

export type TClaudeNativeParams = {
  /** Absolute path to the isolated claude binary (`cliBin("claude_code")`). */
  readonly bin: string;
  /** Isolated run env (`cliEnv("claude_code")`), merged onto process.env. */
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  /** System prompt — applied ONLY when starting a fresh session (a resumed
   *  session already carries it). Null when the client sent none. */
  readonly systemText: string | null;
  /** The turn text to feed: the delta user turn on resume, or the seed prompt
   *  on a fresh start. */
  readonly userText: string;
  /** Resume this session id (feed only `userText`), or null → fresh session. */
  readonly resumeSessionId: string | null;
  readonly signal: AbortSignal;
  /**
   * Optional request-capture decoration (W2 text path). When set (serve passes
   * this for selected sub-method `bridge-capture` on ready providers) the CLI
   * builds the Messages envelope against a private loopback; the daemon
   * dispatches that envelope once and decodes the true response. Tool-bearing
   * capture is owned by `serve.ts` → `runClaudeToolCapture` (not this runner).
   *
   * Hermetic tests MUST inject `sender` (mock upstream). A production enable
   * without `sender` uses `fetch` against the captured external URL.
   */
  readonly requestCapture?: {
    readonly sender?: TCapturedDispatchSender;
    readonly allowLoopbackDestinations?: boolean;
    readonly captureTimeoutMs?: number;
    readonly maxBodyBytes?: number;
  };
};

/** One NDJSON line of `claude -p --output-format stream-json` output. */
type TClaudeStreamLine = Readonly<Record<string, unknown>> & {
  readonly type?: unknown;
  readonly event?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly session_id?: unknown;
};

const defaultCaptureSender: TCapturedDispatchSender = async (
  request,
  _envelope,
  signal,
): Promise<Response> => fetch(request, { signal });

export const runClaudeNative = async (
  params: TClaudeNativeParams,
): Promise<TNativeRunResult> => {
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "claude CLI not installed" };
  }

  if (params.requestCapture !== undefined) {
    const { run } = await runClaudeTextCapture({
      ...params,
      captureSender: params.requestCapture?.sender ?? defaultCaptureSender,
      allowLoopbackDestinations:
        params.requestCapture?.allowLoopbackDestinations,
      captureTimeoutMs: params.requestCapture?.captureTimeoutMs,
      maxBodyBytes: params.requestCapture?.maxBodyBytes,
    });
    return run;
  }

  // NB: the bridge deliberately does NOT unlock or re-partition the isolated
  // keychain. `claude` reads its OWN keychain item (resolved from the isolated
  // HOME), and the daemon's status watcher already keeps that keychain
  // unlocked; a `set-key-partition-list` here would RESTRICT claude's access
  // and break auth. The load-bearing prep is the SCRUBBED env below —
  // `cleanNativeSpawnEnv` drops `ANTHROPIC_*`/`CLAUDE_CODE_*` auth vars that
  // would otherwise override the subscription credential.
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // The bridge reads claude's isolated login-keychain credential to serve the
    // request; securityd denies a Seatbelt-confined caller, so it runs
    // unconfined on macOS (confined on Linux) — `sandbox/policy.ts`.
    proc = spawnClaudeCli({
      bin: params.bin,
      providerModelId: params.providerModelId,
      systemText: params.systemText,
      resumeSessionId: params.resumeSessionId,
      userText: params.userText,
      finalEnv: cleanNativeSpawnEnv(params.env),
    });
  } catch (error) {
    return {
      kind: "declined",
      reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const kill = (): void => {
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

  const state = newAnthropicStreamState({
    providerModelId: params.providerModelId,
  });
  const lines = ndjsonLines(proc.stdout as ReadableStream<Uint8Array>);
  const reader = lines.getReader();

  // Captured from every line that carries a `session_id` — the `system`/init
  // line (available at commit) and the terminal `result` line (authoritative
  // for the NEXT resume, in case Claude rotated the id mid-turn). The serve
  // adapter reads this AFTER the stream drains.
  let capturedSessionId: string | null = params.resumeSessionId;
  let terminalSucceeded = false;
  // Did any `stream_event` deliver MEANINGFUL output (content/finish/usage/
  // tool)? When true, the `assistant` full-message line is a redundant echo of
  // those partials and is skipped. When FALSE — the CLI emitted no usable
  // partial deltas for this turn (observed live: short turns whose answer
  // arrives ONLY in the `assistant` line + the terminal `result.result`) — we
  // decode the `assistant` line itself so the answer isn't lost. Without this
  // the turn reaches the terminal with zero output and (mis)classifies as a
  // decline, surfacing the model's OWN reply text as a bogus failure reason.
  let emittedContent = false;

  /** Convert an `assistant` full-message line's `message` into one canonical
   *  chunk (content + finish + usage), or null when it carries no text. */
  const chunkFromAssistantLine = (
    message: unknown,
  ): TChatCompletionChunk | null => {
    const text = assistantMessageText(message);
    if (text.length === 0) return null;
    const m = message as { id?: unknown; usage?: unknown };
    const usage = usageFromAnthropic(m.usage);
    return {
      id: typeof m.id === "string" ? m.id : "msg_native",
      object: "chat.completion.chunk",
      created: 0,
      model: params.providerModelId,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      ...(usage !== undefined ? { usage } : {}),
    };
  };

  /** Pull NDJSON lines until the next canonical chunk (or end/failure). */
  const nextChunk = async (): Promise<
    TChatCompletionChunk | "end" | { error: string }
  > => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return terminalSucceeded
          ? "end"
          : {
              error:
                "native runtime ended without a successful terminal result",
            };
      }
      let line: TClaudeStreamLine;
      try {
        line = JSON.parse(value) as TClaudeStreamLine;
      } catch {
        continue; // non-JSON noise (debug output) — skip
      }
      if (typeof line.session_id === "string" && line.session_id.length > 0) {
        capturedSessionId = line.session_id;
      }
      if (line.type === "stream_event" && line.event !== undefined) {
        const event = decodeStreamEvent(line.event);
        if (event._tag !== "Some") continue; // unknown event shape — skip
        const chunk = fromAnthropicStreamEvent(event.value, state, {
          providerModelId: params.providerModelId,
        });
        if (chunk === null) continue;
        // Track actual OUTPUT (content/reasoning/tool), NOT a finish- or
        // usage-only chunk — otherwise a partials stream that carries a
        // terminal `message_delta` but no `content_block_delta` would flip
        // this flag and wrongly skip the authoritative `assistant` line.
        if (chunkHasOutput(chunk)) emittedContent = true;
        return chunk;
      }
      // `assistant` full-message line: the authoritative answer. Use it only
      // when the partial stream_events did NOT already carry the content
      // (dedup) — so the normal streaming path is unchanged, and a turn that
      // streamed no partials still delivers its answer.
      if (line.type === "assistant" && !emittedContent) {
        const chunk = chunkFromAssistantLine(line.message);
        if (chunk !== null) {
          emittedContent = true;
          return chunk;
        }
        continue;
      }
      if (line.type === "result") {
        const terminal = normalizeNativeTerminalResult(line);
        // Post-commit (content already emitted from the assistant line or
        // partials), a terminal failure just ends the stream — the answer is
        // already delivered. Pre-commit it declines to the manual transport.
        if (terminal.kind === "failure" && !emittedContent) {
          return { error: terminal.reason };
        }
        terminalSucceeded = true;
        return "end";
      }
      // "system" (init) line — carries no content; skip.
    }
  };

  // ── Pre-commit: buffer housekeeping until the FIRST MEANINGFUL output ─
  // A role-only `message_start` decodes to an empty canonical chunk; it is
  // NOT model output and must not commit the response — a structured
  // failure or refusal can still follow it (the AUP/cyber-safeguard shape:
  // `message_start`, then a `result`/`stream_event:error`). Committing on
  // housekeeping would forfeit the native-decline → same-hop manual
  // fallback for exactly that case (shared `isMeaningfulChunk` semantics,
  // parity with the walker + cloud peek). Buffered housekeeping is replayed
  // ahead of the first meaningful chunk so no event is lost.
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
      const chunk = next as TChatCompletionChunk;
      if (isMeaningfulChunk(chunk)) {
        // A structured refusal (content filter) before any output is not
        // model output: decline so the manual transport can serve the same
        // hop, and — failing that — the walker advances to the next hop.
        if (isRefusalChunk(chunk)) {
          return {
            kind: "error",
            reason: "claude runtime refused the request (content filter)",
          };
        }
        return { kind: "meaningful", chunk };
      }
      buffered.push(chunk); // housekeeping — replay ahead of the live tail
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
    kill();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>)
      .text()
      .catch(() => "");
    const reason =
      first === "timeout"
        ? "claude runtime produced no output before the pre-commit deadline"
        : `claude runtime exited before producing output${stderr.length > 0 ? `: ${stderr.slice(0, 300)}` : ""}`;
    logError(
      "native-runtime",
      safeDiagnosticMessage`claude hop declined pre-commit`,
      { reason },
    );
    return { kind: "declined", reason };
  }
  if (first.kind === "error") {
    kill();
    logError(
      "native-runtime",
      safeDiagnosticMessage`claude hop declined pre-commit`,
      {
        reason: first.reason,
      },
    );
    return { kind: "declined", reason: first.reason };
  }
  const firstMeaningful = first.chunk;

  // ── Committed: stream canonical chunks until the result line ────────
  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      for (const c of buffered) controller.enqueue(c);
      controller.enqueue(firstMeaningful);
    },
    async pull(controller) {
      const next = await nextChunk();
      if (next === "end" || typeof next !== "object" || "error" in next) {
        // Post-commit failure can't re-route (commit-on-first-byte): end the
        // stream; the accumulated usage/finish state is whatever arrived.
        if (typeof next === "object" && "error" in next) {
          logError(
            "native-runtime",
            safeDiagnosticMessage`claude stream failed post-commit`,
            {
              reason: next.error,
            },
          );
        }
        controller.close();
        kill();
        return;
      }
      controller.enqueue(next);
    },
    cancel() {
      kill();
    },
  });
  return { kind: "committed", chunks, sessionId: () => capturedSessionId };
};

/** Split a byte stream into NDJSON lines (no trailing-newline loss). Exported
 *  for `claude-sdk-facade.ts` — the ONE NDJSON line-splitter both Claude
 *  stdout decoders use; the facade's own decode loop differs (framed replay,
 *  tool_use handling) but must not re-implement this framing primitive. */
export const ndjsonLines = (
  raw: ReadableStream<Uint8Array>,
): ReadableStream<string> => {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = raw.getReader();
  return new ReadableStream<string>({
    async pull(controller) {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            controller.enqueue(line);
            return;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          const rest = buffer.trim();
          buffer = "";
          if (rest.length > 0) controller.enqueue(rest);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
};
