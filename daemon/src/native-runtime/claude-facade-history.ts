import type { TChatCompletionRequest, TChatMessage } from "@openllmsh/protocol";
import { AnthropicMessage } from "@openllmsh/protocol";
import { plainTextFromReasoningItems } from "@openllmsh/wire/adapters/messages/reasoning-from-items";
import { CLAUDE_NATIVE_ASSISTANT_CARRIER } from "@openllmsh/wire/adapters/messages/reasoning-signature";
import { contentToAnthropicBlocks } from "@openllmsh/wire/providers/anthropic";
import { Schema } from "effect";
import type {
  TClaudeAnthropicMessage,
  TClaudeToolNameMap,
} from "./claude-tool-capture";
import { anthropicMessagesFromHistoryTurns } from "./claude-tool-capture";

// Versioned, request-carried native history, analogous to Hermes's native
// assistant carrier. Signed blocks are replayed only with the same visible
// projection and model. Never synthesize a signature from reasoning text.
export { CLAUDE_NATIVE_ASSISTANT_CARRIER } from "@openllmsh/wire/adapters/messages/reasoning-signature";

type TAssistant = Extract<TChatMessage, { role: "assistant" }>;
type TProjection = {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
};

const textOf = (message: TAssistant): string => {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .map((part) => {
      if (part.type !== "text")
        throw new Error("assistant history must be text");
      return part.text;
    })
    .join("");
};

const toolInputOf = (argumentsJson: string): unknown => {
  try {
    const input: unknown = JSON.parse(argumentsJson);
    if (typeof input === "object" && input !== null && !Array.isArray(input))
      return input;
  } catch {
    // Report only the shape failure, never caller arguments.
  }
  throw new Error("history tool arguments must be a JSON object");
};

const projectionOf = (message: TAssistant): TProjection => ({
  content: textOf(message),
  toolCalls: (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: toolInputOf(call.function.arguments),
  })),
});

const equalJson = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  )
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equalJson(v, b[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => Object.hasOwn(right, k) && equalJson(left[k], right[k]))
  );
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nativeMessageOf = (value: unknown): TClaudeAnthropicMessage => {
  const message = recordOf(value);
  if (
    message?.role !== "assistant" ||
    !Array.isArray(message.content) ||
    message.content.length === 0
  ) {
    throw new Error("invalid native assistant history");
  }
  // Validate without using the decoded value: native block extension fields
  // must round-trip unchanged, not be stripped by the schema decoder.
  if (!Schema.is(AnthropicMessage)(message))
    throw new Error("invalid native assistant message schema");
  for (const block of message.content) {
    const b = recordOf(block);
    if (
      !b ||
      !["text", "thinking", "redacted_thinking", "tool_use"].includes(
        String(b.type),
      )
    ) {
      throw new Error("unsupported native assistant block");
    }
    if (
      b.type === "thinking" &&
      (typeof b.signature !== "string" || b.signature.length === 0)
    ) {
      throw new Error("unsigned native thinking history");
    }
  }
  return { role: "assistant", content: message.content };
};

export const claudeNativeAssistantCarrier = (
  messages: ReadonlyArray<unknown>,
  model: string,
  nameMap: TClaudeToolNameMap,
): unknown => {
  const native = messages.map(nativeMessageOf);
  const content: string[] = [];
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const message of native) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text") content.push(String(b.text));
      if (b.type === "tool_use")
        toolCalls.push({
          id: String(b.id),
          name: nameMap.mcpToCaller.get(String(b.name)) ?? String(b.name),
          input: b.input,
        });
    }
  }
  return {
    type: CLAUDE_NATIVE_ASSISTANT_CARRIER,
    version: 1,
    model,
    messages: native,
    projection: { content: content.join(""), toolCalls },
  };
};

const assistantMessages = (
  message: TAssistant,
  model: string,
  nameMap: TClaudeToolNameMap,
): ReadonlyArray<TClaudeAnthropicMessage> => {
  const projection = projectionOf(message);
  const items = message.reasoning_items ?? [];
  const carriers = items.filter(
    (item) => recordOf(item)?.type === CLAUDE_NATIVE_ASSISTANT_CARRIER,
  );
  if (carriers.length > 0) {
    const carrier = recordOf(carriers[0]);
    if (
      carriers.length !== 1 ||
      items.length !== 1 ||
      carrier?.version !== 1 ||
      !Array.isArray(carrier.messages)
    ) {
      throw new Error("invalid native assistant carrier");
    }
    if (carrier.model !== model)
      throw new Error("native assistant history belongs to another model");
    if (!equalJson(carrier.projection, projection))
      throw new Error(
        "native assistant projection changed; signed history cannot be restored",
      );
    const native = carrier.messages.map(nativeMessageOf);
    // The carrier is untrusted client data: verify its own native projection,
    // not merely the projection it claims to have preserved.
    const rebuilt = recordOf(
      claudeNativeAssistantCarrier(native, model, nameMap),
    );
    if (!equalJson(rebuilt?.projection, carrier.projection))
      throw new Error("native assistant carrier projection mismatch");
    return native;
  }
  const summary = plainTextFromReasoningItems(items);
  // Unsigned summaries from other providers are visible context, NOT Claude
  // thinking. Opaque encrypted-only history still fails closed rather than
  // silently disappearing or being masqueraded as a Claude signature.
  if (items.some((item) => recordOf(item)?.type !== "reasoning"))
    throw new Error("unknown reasoning history carrier");
  const reasoning = message.reasoning_content || summary;
  if (items.length > 0 && !reasoning)
    throw new Error("opaque foreign reasoning has no portable summary");
  const messages = anthropicMessagesFromHistoryTurns(
    [
      {
        kind: "assistant_tools",
        text: textOf(message),
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      },
    ],
    "",
    nameMap,
  );
  const native = messages[0];
  if (!native || !Array.isArray(native.content))
    throw new Error("invalid assistant history");
  return [
    {
      role: "assistant",
      content: [
        ...(reasoning ? [{ type: "text", text: reasoning }] : []),
        ...native.content,
      ],
    },
  ];
};

const contentBlocks = (
  content: TChatMessage["content"],
): ReturnType<typeof contentToAnthropicBlocks> => {
  if (
    Array.isArray(content) &&
    content.some((part) => part.type === "input_audio")
  ) {
    throw new Error("audio history is unsupported by the Claude facade");
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part.type === "image_url" &&
        !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
          part.image_url.url,
        )
      ) {
        throw new Error("Claude facade images require a base64 image data URL");
      }
      if (part.type === "file") {
        const file = part.file;
        if (
          file.file_data === undefined ||
          !/^data:(application\/pdf|text\/plain|image\/(png|jpeg|gif|webp));base64,[A-Za-z0-9+/]+={0,2}$/.test(
            file.file_data,
          )
        ) {
          throw new Error(
            "Claude facade documents require supported base64 file data",
          );
        }
      }
    }
  }
  return contentToAnthropicBlocks(content);
};

export const claudeFacadeHistory = (
  canonical: TChatCompletionRequest,
  nameMap: TClaudeToolNameMap,
  model: string,
): {
  readonly systemText: string | null;
  readonly messages: ReadonlyArray<TClaudeAnthropicMessage>;
} => {
  const messages: TClaudeAnthropicMessage[] = [];
  const system: string[] = [];
  const appendUser = (
    content: ReadonlyArray<Record<string, unknown>>,
  ): void => {
    const last = messages.at(-1);
    if (last?.role === "user") {
      const prior =
        typeof last.content === "string"
          ? [{ type: "text", text: last.content }]
          : last.content;
      messages[messages.length - 1] = {
        role: "user",
        content: [...prior, ...content],
      };
    } else messages.push({ role: "user", content });
  };
  for (const message of canonical.messages) {
    if (message.role === "system") {
      const blocks = contentBlocks(message.content);
      if (blocks.some((b) => b.type !== "text"))
        throw new Error("system history must be text");
      const text = blocks
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      // Only the leading run is the CLI's system prompt. A later one (Codex
      // `developer` instructions between turns) keeps its position as a
      // reminder in the user frame, the way Claude Code itself injects
      // mid-conversation instructions; hoisting it would reorder it and
      // rewrite the cached system prefix.
      if (messages.length === 0) system.push(text);
      else if (text.length > 0)
        appendUser([
          {
            type: "text",
            text: `<system-reminder>\n${text}\n</system-reminder>`,
          },
        ]);
    } else if (message.role === "assistant") {
      messages.push(...assistantMessages(message, model, nameMap));
    } else if (message.role === "tool") {
      appendUser([
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content:
            typeof message.content === "string"
              ? message.content
              : contentBlocks(message.content),
        },
      ]);
    } else appendUser(contentBlocks(message.content));
  }
  const last = messages.at(-1);
  if (!last || last.role !== "user" || last.content.length === 0)
    throw new Error("history must end with a nonempty user/tool-result turn");
  // Retain the existing compact string form for single plain-text user frames.
  return {
    systemText: system.length > 0 ? system.join("\n\n") : null,
    messages: messages.map((m) => {
      if (
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.length === 1
      ) {
        const b = recordOf(m.content[0]);
        if (
          b?.type === "text" &&
          typeof b.text === "string" &&
          b.cache_control == null
        )
          return { role: "user", content: b.text };
      }
      return m;
    }),
  };
};
