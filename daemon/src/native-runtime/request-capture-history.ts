/**
 * Bridge-capture history input planner (shared W6 scaffolding).
 *
 * Capture builders never observe the true assistant/tool response, so the next
 * turn's history must be reconstructed by the daemon. This module decides HOW
 * that history may be fed WITHOUT silently dropping tool call IDs, roles, or
 * reasoning items into a lossy text seed.
 *
 * Mechanisms:
 *   - `cold_text_seed` — proven today via {@link renderSeed} / cold start when
 *     EVERY prior turn is plain user/assistant text.
 *   - `structured_items` — reserved for a proven exact inject path (e.g. Codex
 *     `thread/inject_items`). Not selected until a provider adapter marks the
 *     mechanism proven; otherwise tool-bearing history is `unsupported`.
 *   - `unsupported` — refuse before send; never invent a success that lost IDs.
 *
 * No new conversation_id layer. Request-private capture correlation only.
 */

import type { TChatCompletionRequest } from "@openllmsh/protocol";
import { renderSeed } from "./session-store";
import type {
  TNativeHistoryToolCall,
  TNativeHistoryTurn,
  TNativeTurn,
} from "./types";

export type TCaptureHistoryMechanism =
  | "cold_text_seed"
  | "structured_items"
  | "unsupported";

export type TCaptureHistoryBuilderPlan =
  | {
      readonly kind: "cold_text_seed";
      readonly mechanism: "cold_text_seed";
      readonly builderResumeId: null;
      readonly publishResumeSession: false;
      readonly systemText: string | null;
      readonly userText: string;
      /** Plain text turns used for the seed (lossy path is only taken when
       *  historyHasStructuredArtifacts is false). */
      readonly textTurns: ReadonlyArray<TNativeTurn>;
    }
  | {
      readonly kind: "structured_items";
      readonly mechanism: "structured_items";
      readonly builderResumeId: null;
      readonly publishResumeSession: false;
      readonly systemText: string | null;
      readonly deltaText: string;
      readonly items: ReadonlyArray<TNativeHistoryTurn>;
      /**
       * Provider-specific inject that MUST already be proven by that adapter.
       * Shared scaffolding records the intent; it does not invent inject RPCs.
       */
      readonly injectProven: true;
    }
  | {
      readonly kind: "unsupported";
      readonly mechanism: "unsupported";
      readonly reason: string;
      readonly lostArtifacts: ReadonlyArray<
        "tool_calls" | "tool_results" | "reasoning"
      >;
    };

const isPlainTextHistoryTurn = (
  turn: TNativeHistoryTurn,
): turn is Extract<TNativeHistoryTurn, { kind: "text" }> =>
  turn.kind === "text";

/**
 * Detect structured artifacts that {@link renderSeed} cannot preserve exactly.
 * Empty toolCalls arrays are treated as absent (no ID to lose).
 */
export const historyStructuredArtifacts = (
  turns: ReadonlyArray<TNativeHistoryTurn>,
): ReadonlyArray<"tool_calls" | "tool_results" | "reasoning"> => {
  const lost = new Set<"tool_calls" | "tool_results" | "reasoning">();
  for (const turn of turns) {
    if (turn.kind === "tool_result") {
      lost.add("tool_results");
      continue;
    }
    if (turn.kind === "assistant_tools") {
      if (turn.toolCalls.length > 0) lost.add("tool_calls");
      if (
        (turn.reasoningItems !== undefined && turn.reasoningItems.length > 0) ||
        (typeof turn.reasoningContent === "string" &&
          turn.reasoningContent.length > 0)
      ) {
        lost.add("reasoning");
      }
    }
  }
  return [...lost];
};

export const textTurnsFromHistory = (
  turns: ReadonlyArray<TNativeHistoryTurn>,
): ReadonlyArray<TNativeTurn> | null => {
  const out: TNativeTurn[] = [];
  for (const turn of turns) {
    if (!isPlainTextHistoryTurn(turn)) return null;
    out.push({ role: turn.role, text: turn.text });
  }
  return out;
};

export const historyTurnsFromTextTurns = (
  turns: ReadonlyArray<TNativeTurn>,
): ReadonlyArray<TNativeHistoryTurn> =>
  turns.map((t) => ({ kind: "text" as const, role: t.role, text: t.text }));

const plainTextContent = (
  content: TChatCompletionRequest["messages"][number]["content"],
): string | null => {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part !== "object" ||
      part === null ||
      (part as { type?: unknown }).type !== "text" ||
      typeof (part as { text?: unknown }).text !== "string"
    ) {
      return null;
    }
    parts.push((part as { text: string }).text);
  }
  return parts.join("");
};

export type TCanonicalCaptureHistory = {
  readonly systemText: string | null;
  /**
   * Prior turns excluding a trailing user-text delta. For tool-result-only
   * continuations (`deltaKind: "tool_results"`), this includes the trailing
   * tool_result turns so a session-resume inject can persist them verbatim.
   */
  readonly historyTurns: ReadonlyArray<TNativeHistoryTurn>;
  readonly deltaText: string;
  readonly hasPrior: boolean;
  /**
   * `user_text` — trailing plain user message is the delta (existing shape).
   * `tool_results` — request ends on tool role message(s); no new user text.
   */
  readonly deltaKind: "user_text" | "tool_results";
};

/**
 * Decompose a canonical chat request into capture history + trailing user
 * delta. Returns null when the shape cannot be represented (images, missing
 * trailing user turn, non-text parts). Does NOT silently drop tool IDs —
 * assistant tool_calls and tool results become structured history turns so
 * {@link captureAwareHistoryBuilderPlan} can refuse when inject is unproven.
 */
export const historyTurnsFromCanonicalMessages = (
  messages: TChatCompletionRequest["messages"],
): TCanonicalCaptureHistory | null => {
  const systemParts: string[] = [];
  const nonSystem: Array<TChatCompletionRequest["messages"][number]> = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = plainTextContent(message.content);
      if (text === null) return null;
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    nonSystem.push(message);
  }
  if (nonSystem.length === 0) return null;

  const turnFromMessage = (
    message: TChatCompletionRequest["messages"][number],
  ): TNativeHistoryTurn | null => {
    if (message.role === "user") {
      const text = plainTextContent(message.content);
      if (text === null) return null;
      return { kind: "text", role: "user", text };
    }
    if (message.role === "assistant") {
      const text = plainTextContent(message.content);
      if (text === null) return null;
      const toolCallsRaw = (
        message as {
          tool_calls?: ReadonlyArray<{
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }>;
        }
      ).tool_calls;
      if (toolCallsRaw !== undefined && !Array.isArray(toolCallsRaw)) {
        return null;
      }
      const toolCalls: TNativeHistoryToolCall[] = [];
      for (const call of toolCallsRaw ?? []) {
        if (
          typeof call.id !== "string" ||
          typeof call.function?.name !== "string" ||
          typeof call.function.arguments !== "string"
        ) {
          return null;
        }
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      const reasoningContentRaw = (message as { reasoning_content?: unknown })
        .reasoning_content;
      const reasoningItemsRaw = (message as { reasoning_items?: unknown })
        .reasoning_items;
      if (
        reasoningContentRaw !== undefined &&
        reasoningContentRaw !== null &&
        typeof reasoningContentRaw !== "string"
      ) {
        return null;
      }
      if (
        reasoningItemsRaw !== undefined &&
        reasoningItemsRaw !== null &&
        !Array.isArray(reasoningItemsRaw)
      ) {
        return null;
      }
      const reasoningContent =
        typeof reasoningContentRaw === "string" &&
        reasoningContentRaw.length > 0
          ? reasoningContentRaw
          : undefined;
      const reasoningItems =
        Array.isArray(reasoningItemsRaw) && reasoningItemsRaw.length > 0
          ? (reasoningItemsRaw as ReadonlyArray<unknown>)
          : undefined;
      const hasReasoning =
        reasoningContent !== undefined || reasoningItems !== undefined;
      if (toolCalls.length > 0 || hasReasoning) {
        return {
          kind: "assistant_tools",
          text: text.length > 0 ? text : null,
          toolCalls,
          ...(reasoningContent !== undefined ? { reasoningContent } : {}),
          ...(reasoningItems !== undefined ? { reasoningItems } : {}),
        };
      }
      return { kind: "text", role: "assistant", text };
    }
    if (message.role === "tool") {
      const toolCallId = (message as { tool_call_id?: string }).tool_call_id;
      const content = plainTextContent(message.content);
      if (typeof toolCallId !== "string" || content === null) return null;
      return {
        kind: "tool_result",
        toolCallId,
        content,
      };
    }
    return null;
  };

  const last = nonSystem[nonSystem.length - 1];
  if (last === undefined) return null;

  // Tool-result-only continuation: request ends on one or more `tool` messages.
  if (last.role === "tool") {
    let firstTrailingTool = nonSystem.length - 1;
    while (
      firstTrailingTool > 0 &&
      nonSystem[firstTrailingTool - 1]?.role === "tool"
    ) {
      firstTrailingTool -= 1;
    }
    const historyTurns: TNativeHistoryTurn[] = [];
    for (let i = 0; i < nonSystem.length; i += 1) {
      const message = nonSystem[i];
      if (message === undefined) continue;
      const turn = turnFromMessage(message);
      if (turn === null) return null;
      historyTurns.push(turn);
    }
    if (firstTrailingTool === 0) {
      // Tool results with no prior user/assistant — unusable.
      return null;
    }
    return {
      systemText: systemParts.length > 0 ? systemParts.join("\n\n") : null,
      historyTurns,
      deltaText: "",
      hasPrior: true,
      deltaKind: "tool_results",
    };
  }

  let lastUser = -1;
  for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
    if (nonSystem[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return null;
  const deltaText = plainTextContent(nonSystem[lastUser]?.content ?? "");
  if (deltaText === null || deltaText.length === 0) return null;

  // Trailing non-user messages after the last user text are not representable
  // as a user-text delta (would drop them). Refuse rather than silently lose.
  if (lastUser !== nonSystem.length - 1) return null;

  const historyTurns: TNativeHistoryTurn[] = [];
  for (let i = 0; i < lastUser; i += 1) {
    const message = nonSystem[i];
    if (message === undefined) continue;
    const turn = turnFromMessage(message);
    if (turn === null) return null;
    historyTurns.push(turn);
  }

  return {
    systemText: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    historyTurns,
    deltaText,
    hasPrior: historyTurns.length > 0,
    deltaKind: "user_text",
  };
};

export const captureAwareHistoryBuilderPlan = (args: {
  readonly systemText: string | null;
  readonly turns: ReadonlyArray<TNativeHistoryTurn>;
  readonly deltaText: string;
  readonly hasPrior: boolean;
  readonly structuredInjectProven?: boolean;
}): TCaptureHistoryBuilderPlan => {
  const artifacts = historyStructuredArtifacts(args.turns);
  if (artifacts.length > 0) {
    if (args.structuredInjectProven === true) {
      return {
        kind: "structured_items",
        mechanism: "structured_items",
        builderResumeId: null,
        publishResumeSession: false,
        systemText: args.systemText,
        deltaText: args.deltaText,
        items: args.turns,
        injectProven: true,
      };
    }
    return {
      kind: "unsupported",
      mechanism: "unsupported",
      reason:
        "capture history contains tool/reasoning artifacts that cold text seed would silently lose; no proven structured inject for this provider yet",
      lostArtifacts: artifacts,
    };
  }

  const textTurns = textTurnsFromHistory(args.turns);
  if (textTurns === null) {
    // Defensive: artifacts empty but conversion failed — refuse rather than seed.
    return {
      kind: "unsupported",
      mechanism: "unsupported",
      reason: "capture history could not be reduced to plain text turns",
      lostArtifacts: ["tool_calls"],
    };
  }

  return {
    kind: "cold_text_seed",
    mechanism: "cold_text_seed",
    builderResumeId: null,
    publishResumeSession: false,
    systemText: args.systemText,
    // `renderSeed` drops its LAST input turn on the assumption that it is
    // the trailing delta (true for session-store's own full-turns caller,
    // whose `turns` always ends on the delta user turn). `textTurns` here
    // is `historyTurns` from `historyTurnsFromCanonicalMessages`, which
    // already EXCLUDES the trailing delta — so the delta must be appended
    // back on before calling `renderSeed`, or its real last turn (typically
    // the latest assistant reply) would be silently dropped instead.
    userText: args.hasPrior
      ? renderSeed(
          [...textTurns, { role: "user" as const, text: args.deltaText }],
          args.deltaText,
        )
      : args.deltaText,
    textTurns,
  };
};
