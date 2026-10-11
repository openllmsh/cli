/**
 * Muse SDK event → canonical stream translation.
 *
 * Maps official `@muse-code/sdk` folded items / item-deltas / session usage
 * onto `TChatCompletionChunk` without inventing reasoning signatures or
 * treating SDK-internal events as user text. Public surfaces:
 * `agentMessage` text, `reasoning` *summaries*, and completed host-native
 * `web_search` toolCalls (reported as canonical `server_search_calls`).
 * Private reasoning is never inspected. Provider-executed search is NEVER
 * re-emitted as caller `tool_calls` — that channel stays reserved for the
 * loopback MCP handoff.
 *
 * Usage prefers vendor-reported numbers. Root-session last-call counted-once
 * totals (`promptTokens` / `totalTokens` from `session/tokenUsage`) are the
 * honest per-completion row. Cumulative session totals and child-item usage
 * are not folded in. Missing usage is omitted (never estimated as real).
 * Completion is exactly-once.
 */

import type { TChatCompletionChunk, TUsage } from "@openllmsh/protocol";
import { serverSearchCallFromMuseToolCall } from "./muse-web-search";

/** Official fold item fields this mapper actually reads. */
export type TMuseFoldedItem = {
  readonly itemId: string;
  readonly kind: string;
  readonly revision: number;
  readonly status?: string;
  readonly text?: string;
  readonly summary?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  /** `toolCall`: provider call id when present. */
  readonly callId?: string;
  /** `toolCall`: tool name (`web_search`, `search`, …). */
  readonly tool?: string;
  /** `toolCall`: model-authored argument JSON, verbatim. */
  readonly args?: string;
  /** `toolCall`/`userShell`: bounded transcript-visible result text. */
  readonly visibleOutput?: string;
};

/** Official `item/delta` payload (`ItemDeltaParams`). */
export type TMuseItemDelta = {
  readonly itemId: string;
  readonly delta: string;
  readonly field?: string;
};

/** Official `session/tokenUsage` fields this mapper actually reads. */
export type TMuseSessionUsage = {
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
  };
  readonly cumulative?: {
    readonly promptTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
};

export type TMuseTurnState = {
  readonly handleItem: (item: TMuseFoldedItem) => TChatCompletionChunk | null;
  readonly handleDelta: (delta: TMuseItemDelta) => TChatCompletionChunk | null;
  readonly observeUsage: (usage: TMuseSessionUsage) => void;
  readonly finish: (terminal: string | null) => TChatCompletionChunk[];
  /** Caller-tool handoff: tool_calls delta + finish_reason tool_calls. */
  readonly emitToolCall: (
    name: string,
    args: unknown,
  ) => ReadonlyArray<TChatCompletionChunk>;
  readonly sawOutput: () => boolean;
  readonly finished: () => boolean;
};

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Map official last-call usage onto the canonical usage row. Missing fields
 *  stay omitted so the recorder does not treat estimates as vendor counts. */
export const usageFromMuseSession = (
  reported: TMuseSessionUsage | null,
): TUsage | undefined => {
  if (reported === null) return undefined;
  const prompt =
    count(reported.promptTokens) ?? count(reported.usage?.inputTokens);
  const completion =
    count(reported.outputTokens) ?? count(reported.usage?.outputTokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const cached = count(reported.usage?.cachedTokens);
  const cacheWrite = count(reported.usage?.cacheWriteTokens);
  const reasoning = count(reported.usage?.reasoningTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      count(reported.totalTokens) ?? promptTokens + completionTokens,
    ...(cached !== undefined || cacheWrite !== undefined
      ? {
          prompt_tokens_details: {
            ...(cached !== undefined ? { cached_tokens: cached } : {}),
            ...(cacheWrite !== undefined
              ? { cache_creation_tokens: cacheWrite }
              : {}),
          },
        }
      : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  };
};

const finishReasonOf = (
  terminal: string | null,
): "stop" | "length" | "content_filter" | "tool_calls" => {
  if (terminal === "tool_calls") return "tool_calls";
  // Non-moderation turn failures must NOT look like a successful
  // content_filter completion. Callers error the stream instead of
  // finishing with `failed`; if `finish("failed")` is still invoked,
  // emit no terminal chunk (empty) so a success-shaped finish_reason
  // cannot leak.
  if (terminal === "failed") return "stop";
  if (terminal === "cancelled") return "stop";
  return "stop";
};

/**
 * Per-turn mapper. Snapshot/delta text is prefix-checked so a late rewrite
 * cannot rewind the stream. `finish` is exactly-once.
 */
export const createMuseTurnState = (params: {
  readonly providerModelId: string;
}): TMuseTurnState => {
  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-muse-${created.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const items = new Map<string, TMuseFoldedItem>();
  const emittedText = new Map<string, string>();
  let sawOutput = false;
  let openerEmitted = false;
  let finished = false;
  let lastUsage: TMuseSessionUsage | null = null;

  const baseChunk = (
    delta: Record<string, unknown>,
    finish: "stop" | "length" | "content_filter" | "tool_calls" | null,
    usage?: TUsage,
  ): TChatCompletionChunk =>
    ({
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: params.providerModelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    }) as TChatCompletionChunk;

  const opener = (delta: Record<string, unknown>): TChatCompletionChunk => {
    sawOutput = true;
    if (openerEmitted) return baseChunk(delta, null);
    openerEmitted = true;
    return baseChunk({ role: "assistant", content: "", ...delta }, null);
  };

  const append = (
    key: string,
    next: string,
    thought: boolean,
  ): TChatCompletionChunk | null => {
    if (next.length === 0) return null;
    const prior = emittedText.get(key) ?? "";
    if (next === prior) return null;
    if (!next.startsWith(prior)) return null;
    const suffix = next.slice(prior.length);
    if (suffix.length === 0) return null;
    emittedText.set(key, next);
    return opener(
      thought ? { reasoning_content: suffix } : { content: suffix },
    );
  };

  const reportedSearches = new Set<string>();

  const textFromItem = (item: TMuseFoldedItem): TChatCompletionChunk | null => {
    if (item.kind === "agentMessage") {
      return append(item.itemId, item.text ?? "", false);
    }
    if (item.kind === "reasoning") {
      const summaries = item.summary ?? [];
      let last: TChatCompletionChunk | null = null;
      for (let i = 0; i < summaries.length && i < 500; i++) {
        const part = summaries[i];
        if (typeof part !== "string" || part.length === 0) continue;
        const chunk = append(`${item.itemId}:summary.${i}`, part, true);
        if (chunk !== null) last = chunk;
      }
      return last;
    }
    // Host-native web_search → canonical server_search_calls. Filesystem
    // `search` and every other toolCall stay silent here (not tool_calls).
    if (item.kind === "toolCall") {
      const call = serverSearchCallFromMuseToolCall(item);
      if (call === null) return null;
      if (reportedSearches.has(call.id)) return null;
      reportedSearches.add(call.id);
      sawOutput = true;
      if (!openerEmitted) {
        openerEmitted = true;
        return baseChunk(
          { role: "assistant", content: "", server_search_calls: [call] },
          null,
        );
      }
      return baseChunk({ server_search_calls: [call] }, null);
    }
    return null;
  };

  return {
    handleItem: (item) => {
      if (finished) return null;
      const previous = items.get(item.itemId);
      if (previous !== undefined && previous.revision >= item.revision) {
        return null;
      }
      items.set(item.itemId, item);
      return textFromItem(item);
    },
    handleDelta: (delta) => {
      if (finished) return null;
      const item = items.get(delta.itemId);
      if (item === undefined) return null;
      if (item.status !== undefined && item.status !== "inProgress")
        return null;
      if (
        item.kind === "agentMessage" &&
        (delta.field === undefined || delta.field === "text")
      ) {
        const prior = emittedText.get(delta.itemId) ?? "";
        return append(delta.itemId, prior + delta.delta, false);
      }
      const summary = delta.field?.match(/^summary\.(\d+)$/);
      if (
        item.kind === "reasoning" &&
        summary !== null &&
        summary !== undefined
      ) {
        const index = Number(summary[1]);
        if (!Number.isFinite(index) || index >= 500) return null;
        const key = `${delta.itemId}:summary.${index}`;
        const prior = emittedText.get(key) ?? "";
        return append(key, prior + delta.delta, true);
      }
      return null;
    },
    observeUsage: (usage) => {
      lastUsage = usage;
    },
    finish: (terminal) => {
      if (finished) return [];
      finished = true;
      // See finishReasonOf: a failed terminal is not a successful completion.
      if (terminal === "failed") return [];
      return [
        baseChunk(
          {},
          finishReasonOf(terminal),
          usageFromMuseSession(lastUsage),
        ),
      ];
    },
    emitToolCall: (name, args) => {
      if (finished) return [];
      finished = true;
      const open = opener({
        tool_calls: [
          {
            index: 0,
            id: `call_${created.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            type: "function",
            function: {
              name,
              arguments:
                typeof args === "string" ? args : JSON.stringify(args ?? {}),
            },
          },
        ],
      });
      const terminal = baseChunk(
        {},
        "tool_calls",
        usageFromMuseSession(lastUsage),
      );
      return [open, terminal];
    },
    sawOutput: () => sawOutput,
    finished: () => finished,
  };
};
