/**
 * Direct upstream-output ownership for bridge-capture (shared scaffolding).
 *
 * After the daemon dispatches the captured vendor envelope once, the TRUE
 * upstream response is decoded into canonical chat chunks and published to the
 * CALLER — never to the vendor builder. This module owns the typed outcome
 * contract adapters share so they cannot:
 *   - feed the true response back into the vendor execution loop,
 *   - drop parallel tool-call IDs / structured arguments / reasoning,
 *   - retry a second upstream send after accept/uncertain,
 *   - treat process kill as proof of warm reuse.
 *
 * Stream lifetime: dispose/teardown runs only on close / error / cancel of the
 * published stream (or on pre-commit decline). Adapters wire their child/loopback
 * cleanup through {@link publishCapturedDirectOutput}'s `onRelease`.
 */

import type { TChatCompletionChunk, TToolCall } from "@openllmsh/protocol";
import type {
  TBuilderSettlement,
  TCapturedRequestEnvelope,
  TCaptureTerminalOutcome,
  TRequestCaptureSession,
} from "./request-capture";
import type { TCaptureOwnership } from "./types";
import { captureOwnershipFromSession } from "./types";

/**
 * Daemon-owned publication of a captured turn's decoded output.
 * `owner: "daemon"` is structural — builders only receive {@link TBuilderSettlement}.
 */
export type TCaptureDirectOutput = {
  readonly owner: "daemon";
  readonly chunks: ReadableStream<TChatCompletionChunk>;
  readonly envelope: TCapturedRequestEnvelope;
  readonly terminal: TCaptureTerminalOutcome;
  readonly captureOwnership: TCaptureOwnership;
  /** Always true for a published capture output — walker must not re-dispatch. */
  readonly noSecondSend: true;
  /** Local settlement already issued (or to issue) to the builder. */
  readonly builderSettlement: TBuilderSettlement;
};

export type TCaptureDirectOutputFailure = {
  readonly owner: "daemon";
  readonly kind: "failed";
  readonly reason: string;
  readonly captureOwnership: TCaptureOwnership;
  readonly noSecondSend: boolean;
  readonly builderSettlement: TBuilderSettlement | null;
  readonly envelope: TCapturedRequestEnvelope | null;
};

/**
 * Inspect a finite chunk list for parallel / structured tool-call fidelity.
 * Used by hermetic tests and adapter guards — does not re-encode wire formats.
 */
export type TCaptureToolCallInventory = {
  readonly toolCalls: ReadonlyArray<TToolCall>;
  readonly parallel: boolean;
  readonly reasoningContent: string | null;
  readonly reasoningItemCount: number;
  readonly finishReason: string | null;
};

export const inventoryToolCallsFromChunks = (
  chunks: ReadonlyArray<TChatCompletionChunk>,
): TCaptureToolCallInventory => {
  type TBuilder = {
    id: string;
    name: string;
    arguments: string;
  };
  const builders = new Map<number, TBuilder>();
  let reasoningContent = "";
  let reasoningItemCount = 0;
  let finishReason: string | null = null;

  for (const chunk of chunks) {
    for (const choice of chunk.choices) {
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        reasoningContent += delta.reasoning_content;
      }
      if (
        Array.isArray(delta.reasoning_items) &&
        delta.reasoning_items.length > 0
      ) {
        reasoningItemCount += delta.reasoning_items.length;
      }
      const toolDeltas = delta.tool_calls;
      if (!Array.isArray(toolDeltas)) continue;
      for (const td of toolDeltas) {
        const index =
          typeof (td as { index?: unknown }).index === "number"
            ? (td as { index: number }).index
            : 0;
        const existing = builders.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (typeof td.id === "string" && td.id.length > 0) existing.id = td.id;
        const fn = td.function;
        if (fn !== undefined && fn !== null) {
          if (typeof fn.name === "string" && fn.name.length > 0) {
            existing.name = fn.name;
          }
          if (typeof fn.arguments === "string") {
            existing.arguments += fn.arguments;
          }
        }
        builders.set(index, existing);
      }
    }
  }

  const ordered = [...builders.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: b.arguments },
    }));

  return {
    toolCalls: ordered,
    parallel: ordered.length > 1,
    reasoningContent: reasoningContent.length > 0 ? reasoningContent : null,
    reasoningItemCount,
    finishReason,
  };
};

/**
 * Wrap a decoded chunk stream so release/cleanup runs exactly once on
 * close, stream error, or cancel — never on first enqueue / mid-partial.
 */
export const publishCapturedDirectOutput = (args: {
  readonly session: TRequestCaptureSession;
  readonly envelope: TCapturedRequestEnvelope;
  readonly terminal: TCaptureTerminalOutcome;
  readonly chunks: ReadableStream<TChatCompletionChunk>;
  readonly builderSettlement: TBuilderSettlement;
  readonly onRelease: () => void;
}): TCaptureDirectOutput => {
  const ownership = captureOwnershipFromSession(args.session);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    args.onRelease();
  };

  const reader = args.chunks.getReader();
  const chunks = new ReadableStream<TChatCompletionChunk>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
          release();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        reader.releaseLock();
        controller.error(err);
        release();
      }
    },
    cancel(reason) {
      // Release ownership promptly even if the source's cancellation hangs.
      void reader
        .cancel(reason)
        .finally(() => reader.releaseLock())
        .catch(() => undefined);
      release();
    },
  });

  return {
    owner: "daemon",
    chunks,
    envelope: args.envelope,
    terminal: args.terminal,
    captureOwnership: ownership === "none" ? "accepted" : ownership,
    noSecondSend: true,
    builderSettlement: args.builderSettlement,
  };
};

/**
 * Build a typed failure when dispatch / decode cannot publish chunks.
 * `noSecondSend` is true whenever ownership is accepted or uncertain.
 */
export const captureDirectOutputFailure = (args: {
  readonly session: TRequestCaptureSession;
  readonly reason: string;
  readonly builderSettlement?: TBuilderSettlement | null;
}): TCaptureDirectOutputFailure => {
  const ownership = captureOwnershipFromSession(args.session);
  return {
    owner: "daemon",
    kind: "failed",
    reason: args.reason,
    captureOwnership: ownership,
    noSecondSend: ownership === "accepted" || ownership === "uncertain",
    builderSettlement:
      args.builderSettlement ?? args.session.builderSettlement(),
    envelope: args.session.captured(),
  };
};

/**
 * Thrown by {@link requireCaptureTerminalFinishReason} when the captured
 * upstream closes cleanly (`done: true`) without ever emitting a chunk whose
 * `finish_reason` is non-null. A network drop / truncated body after a 2xx
 * response must not silently become `finish_reason: "stop"` with empty
 * content — `accumulateChunksToResponse` already converts any thrown read
 * error into `IncompleteStreamError` (preserving usage observed so far) when
 * no `finish_reason` was seen, so throwing here is sufficient; this class
 * exists only so callers/tests can identify the specific failure.
 */
export class CaptureTruncatedStreamError extends Error {
  constructor(
    message = "capture upstream closed before a terminal finish_reason",
  ) {
    super(message);
    this.name = "CaptureTruncatedStreamError";
  }
}

/**
 * Capture-only truncated-stream guard. Wraps an already-decoded chunk stream
 * (never the shared `packages/wire` accumulator/decoder — this is narrowly
 * scoped to bridge-capture adapters) so a clean EOF with no observed terminal
 * `finish_reason` errors instead of completing normally.
 *
 * - A legitimate terminal (including `finish_reason: "tool_calls"`) passes
 *   every chunk through unchanged and closes normally — no behavior change.
 * - A downstream `cancel()` (client hang-up / caller abort) is NEVER reported
 *   as a truncation failure: the flag set in `cancel()` suppresses both the
 *   error and any close-as-success signal for that read, and forwards the
 *   cancel to the source reader so upstream teardown still runs.
 */
export const requireCaptureTerminalFinishReason = (
  chunks: ReadableStream<TChatCompletionChunk>,
): ReadableStream<TChatCompletionChunk> => {
  let sawFinishReason = false;
  let cancelledByConsumer = false;
  const reader = chunks.getReader();
  return new ReadableStream<TChatCompletionChunk>({
    async start(controller) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            if (cancelledByConsumer) {
              controller.close();
              return;
            }
            if (!sawFinishReason) {
              controller.error(new CaptureTruncatedStreamError());
              return;
            }
            controller.close();
            return;
          }
          for (const choice of value.choices) {
            if (
              choice.finish_reason !== null &&
              choice.finish_reason !== undefined
            ) {
              sawFinishReason = true;
              break;
            }
          }
          controller.enqueue(value);
        }
      } catch (err) {
        if (cancelledByConsumer) return;
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      cancelledByConsumer = true;
      void reader.cancel(reason).catch(() => {});
    },
  });
};

/**
 * Ordering contract for interrupt vs publish:
 * 1. settle builder locally (never true response),
 * 2. mark terminal ownership,
 * 3. only then publish daemon-owned chunks (or fail).
 *
 * Hermetic tests assert this order; adapters must not invert it.
 */
export type TCaptureInterruptOrderStep =
  | "builder_settled"
  | "terminal_recorded"
  | "chunks_published_or_failed";

export const CAPTURE_INTERRUPT_ORDER: ReadonlyArray<TCaptureInterruptOrderStep> =
  ["builder_settled", "terminal_recorded", "chunks_published_or_failed"];
