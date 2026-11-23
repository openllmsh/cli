/**
 * Antigravity ACP conversation identity — the pure half of persistent
 * sessions. The gateway is stateless (the client resends the whole message
 * list), `agy acp` is not: a session keeps its history, so a follow-up should
 * send only what is new. Like the headless path's `deriveConversation`, a
 * conversation is correlated by CONTENT: the hash of everything up to and
 * including the last assistant message, under the model, the account slot's
 * HOME, the sign-in epoch and the caller's tool set. After a turn the session
 * is re-keyed under the hash of the request PLUS the reply it produced, which
 * is exactly the prefix of the client's next request.
 *
 * A key that does not match (an edited or compacted history, another account,
 * a sign-in change, a different model or tool set) starts a fresh session
 * seeded with the full transcript.
 */

import { createHash } from "node:crypto";
import type { TChatCompletionRequest } from "@openllmsh/sdk/protocol";
import type { TCursorImage, TCursorTool } from "./cursor-request";
import { cursorRequestOf } from "./cursor-request";

type TMessage = TChatCompletionRequest["messages"][number];

/** What one turn produced — the assistant message the client will resend. */
export type TAntigravityReply = {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{
    readonly name: string;
    readonly arguments: string;
  }>;
};

export type TAntigravityConversationIdentity = {
  readonly model: string;
  /** The account slot's isolated HOME. */
  readonly home: string;
  /** The account epoch (`antigravityHeadlessEpoch()`). */
  readonly epoch: number;
  readonly tools: ReadonlyArray<TCursorTool>;
};

export type TAntigravityConversationPlan = {
  /** The conversation to continue; null when there is no assistant turn yet. */
  readonly continueKey: string | null;
  /** Only what follows the last assistant turn (user and tool-result turns). */
  readonly delta: {
    readonly promptText: string;
    readonly images: ReadonlyArray<TCursorImage>;
  };
  /** The key the conversation lands under once `reply` is the assistant turn. */
  readonly nextKey: (reply: TAntigravityReply) => string;
};

const textOf = (content: TMessage["content"]): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const p = part as { readonly type?: unknown; readonly text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
    })
    .join("\n");
};

/** Tool-call arguments as the client resends them (a JSON string). */
const normalizedArguments = (args: unknown): string => {
  if (typeof args !== "string") return JSON.stringify(args ?? {});
  try {
    return JSON.stringify(JSON.parse(args));
  } catch {
    return args;
  }
};

const normalizedAssistant = (
  text: string,
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>,
): unknown => ({
  role: "assistant",
  // Clients trim the reply they resend (same rule as `session-store`).
  text: text.trimEnd(),
  calls: calls.map((c) => ({
    name: c.name,
    arguments: normalizedArguments(c.arguments),
  })),
});

const normalizedMessage = (message: TMessage): unknown => {
  if (message.role === "assistant") {
    return normalizedAssistant(
      textOf(message.content),
      (message.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    );
  }
  if (message.role === "tool") {
    return { role: "tool", text: textOf(message.content) };
  }
  return { role: message.role, content: message.content };
};

/** Identity of the tool set: a session's loopback MCP server lists its tools
 *  once, so a different set is a different conversation. */
const toolsDigestOf = (tools: ReadonlyArray<TCursorTool>): string =>
  createHash("sha256").update(JSON.stringify(tools)).digest("hex");

const keyOf = (
  identity: TAntigravityConversationIdentity,
  system: ReadonlyArray<string>,
  turns: ReadonlyArray<unknown>,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        model: identity.model,
        home: identity.home,
        epoch: identity.epoch,
        tools: toolsDigestOf(identity.tools),
        system,
        turns,
      }),
    )
    .digest("hex");

export const antigravityConversationPlan = (
  canonical: TChatCompletionRequest,
  identity: TAntigravityConversationIdentity,
): TAntigravityConversationPlan => {
  const messages = canonical.messages;
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  const systemOf = (upTo: number): string[] =>
    messages
      .slice(0, upTo)
      .filter((m) => m.role === "system")
      .map((m) => textOf(m.content));
  const turnsOf = (upTo: number): unknown[] =>
    messages
      .slice(0, upTo)
      .filter((m) => m.role !== "system")
      .map(normalizedMessage);
  const afterAssistant = messages.slice(lastAssistant + 1);
  // A system/developer message after the last assistant turn cannot be folded
  // into the session's delta: the history diverged, so start fresh.
  const lateSystem = afterAssistant.some((m) => m.role === "system");
  const deltaMessages = afterAssistant.filter((m) => m.role !== "system");
  const delta = cursorRequestOf({ ...canonical, messages: deltaMessages });
  return {
    continueKey:
      lastAssistant >= 0 && deltaMessages.length > 0 && !lateSystem
        ? keyOf(
            identity,
            systemOf(lastAssistant + 1),
            turnsOf(lastAssistant + 1),
          )
        : null,
    delta: { promptText: delta.promptText, images: delta.images },
    nextKey: (reply) =>
      keyOf(identity, systemOf(messages.length), [
        ...turnsOf(messages.length),
        normalizedAssistant(reply.text, reply.toolCalls),
      ]),
  };
};
