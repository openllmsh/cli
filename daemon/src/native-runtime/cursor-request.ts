/**
 * Cursor request decomposition + pure helpers — everything the cursor serve
 * path needs to turn a canonical request into ACP inputs, kept side-effect
 * free so it's unit-testable without a cursor-agent binary:
 *
 *   - {@link cursorRequestOf} — flatten the FULL canonical conversation
 *     (system, user/assistant turns, assistant tool_calls, tool results)
 *     into one prompt text + the inbound image blocks. Unlike
 *     `nativeRequestOf` this accepts tools / tool-role messages / images /
 *     response_format: the cursor bridge serves them (it has no manual
 *     fallback to decline to).
 *   - {@link acpPromptBlocks} — the `session/prompt` array: one text block
 *     followed by the image blocks ({ type: "image", data: <base64, no
 *     data: prefix>, mimeType }) — the shape t3code sends verbatim.
 *   - {@link jsonInstruction} — the structured-output contract: no protocol
 *     channel exists, so a terse "respond with ONLY a JSON object[ matching
 *     this schema ]" block is appended to the prompt and the reply is
 *     extracted locally.
 *   - {@link extractJsonObject} — first balanced JSON object out of the
 *     accumulated reply (tolerating ``` fences and surrounding prose);
 *     null when none parses — the caller falls back to the raw text,
 *     never errors the request.
 */

import type { TChatCompletionRequest } from "@openllmsh/protocol";

/** One ACP image prompt block (base64 payload, no `data:` prefix). */
export type TCursorImage = {
  readonly data: string;
  readonly mimeType: string;
};

/** One client tool forwarded to the loopback MCP server. */
export type TCursorTool = {
  readonly name: string;
  readonly description: string | null;
  /** JSON-Schema `parameters` of the function tool (MCP `inputSchema`). */
  readonly parameters: unknown;
};

export type TCursorRequest = {
  readonly systemText: string | null;
  /** The flattened conversation text (history + final user turn). */
  readonly promptText: string;
  /** Inbound image parts (data-URL sources only), in message order. */
  readonly images: ReadonlyArray<TCursorImage>;
  /** Client function tools, or empty when none were declared. */
  readonly tools: ReadonlyArray<TCursorTool>;
  /** Structured-output mode: null | "json_object" | "json_schema". */
  readonly jsonMode: "json_object" | "json_schema" | null;
  /** The declared JSON schema (json_schema mode only). */
  readonly jsonSchema: unknown;
};

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

type TMessage = TChatCompletionRequest["messages"][number];

/** Flatten one message's content to text, collecting data-URL images.
 *  Non-data image URLs degrade to a text mention (the bridge can't fetch). */
const textAndImagesOf = (
  content: TMessage["content"],
  images: TCursorImage[],
): string => {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly image_url?: { readonly url?: unknown };
    };
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
      continue;
    }
    if (p.type === "image_url" && typeof p.image_url?.url === "string") {
      const m = p.image_url.url.match(DATA_URL);
      if (m !== null && m[1] !== undefined && m[2] !== undefined) {
        images.push({ mimeType: m[1], data: m[2] });
      } else {
        parts.push(`[image: ${p.image_url.url}]`);
      }
    }
    // input_audio / file parts — no ACP mapping; dropped.
  }
  // Newline-join so adjacent text blocks don't fuse into one word run.
  return parts.join("\n");
};

const stringifyToolArgs = (args: unknown): string =>
  typeof args === "string" ? args : JSON.stringify(args ?? {});

/**
 * Decompose a canonical request for the cursor bridge. Tool calls and tool
 * results are rendered INLINE in the transcript (the bridge runs one cold
 * session per request — see cursor-acp.ts's header for the round-trip
 * semantics: the client executes tools and resends the conversation with
 * `tool`-role results, which this renderer folds back in as context).
 */
export const cursorRequestOf = (
  canonical: TChatCompletionRequest,
): TCursorRequest => {
  const systemParts: string[] = [];
  const lines: string[] = [];
  const images: TCursorImage[] = [];
  // Track the non-system turns from the MESSAGE list (not rendered lines) so a
  // lone user turn is detected structurally — a user whose text literally
  // begins with "User: " must not be mistaken for framing and stripped.
  let nonSystemTurns = 0;
  let loneUserText: string | null = null;
  for (const message of canonical.messages) {
    if (message.role === "system") {
      const text = textAndImagesOf(message.content, images);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    if (message.role === "tool") {
      const text = textAndImagesOf(message.content, images);
      nonSystemTurns += 1;
      lines.push(`Tool result (${message.tool_call_id}): ${text}`);
      continue;
    }
    if (message.role === "user") {
      const text = textAndImagesOf(message.content, images);
      nonSystemTurns += 1;
      loneUserText = text;
      lines.push(`User: ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      const text = textAndImagesOf(message.content, images);
      const calls = (message.tool_calls ?? [])
        .map(
          (call) =>
            `[tool call ${call.id}: ${call.function.name}(${stringifyToolArgs(call.function.arguments)})]`,
        )
        .join(" ");
      const rendered = [text, calls].filter((s) => s.length > 0).join(" ");
      if (rendered.length > 0) {
        nonSystemTurns += 1;
        lines.push(`Assistant: ${rendered}`);
      }
    }
  }
  // Single user turn feeds the bare text (no "User:" framing); anything else
  // renders the transcript (mirrors session-store's renderSeed). Keyed off the
  // message structure so a user's own "User: " prefix survives verbatim.
  let promptText =
    nonSystemTurns === 1 && loneUserText !== null && lines.length === 1
      ? loneUserText
      : lines.join("\n\n");
  // ACP starts cold after a caller-tool handoff. Mark the resumption boundary
  // rather than presenting the original request as fresh work a second time.
  // Do not apply this to historical tool results followed by a new user turn.
  if (
    canonical.messages.findLast((message) => message.role !== "system")
      ?.role === "tool"
  ) {
    promptText +=
      "\n\nContinue from the returned tool results above. They are completed responses from the caller, not requests to execute those same calls again. Do not restart the original request merely because its history was replayed. Additional tool calls remain available when needed for the next step.";
  }

  const tools: TCursorTool[] = (canonical.tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  }));

  const rf = canonical.response_format;
  const jsonMode =
    rf === undefined || rf === null
      ? null
      : rf.type === "json_schema"
        ? ("json_schema" as const)
        : rf.type === "json_object"
          ? ("json_object" as const)
          : null;
  const jsonSchema =
    rf !== undefined && rf !== null && rf.type === "json_schema"
      ? ((rf as { readonly json_schema?: { readonly schema?: unknown } })
          .json_schema?.schema ?? null)
      : null;

  return {
    systemText: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    promptText,
    images,
    tools,
    jsonMode,
    jsonSchema,
  };
};

/** One ACP `session/prompt` content block. */
export type TAcpPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

/** The `session/prompt` array: text first, then the image blocks. */
export const acpPromptBlocks = (
  text: string,
  images: ReadonlyArray<TCursorImage>,
): ReadonlyArray<TAcpPromptBlock> => [
  { type: "text", text },
  ...images.map(
    (img): TAcpPromptBlock => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    }),
  ),
];

/** The structured-output instruction appended to the prompt text. */
export const jsonInstruction = (
  mode: "json_object" | "json_schema",
  schema: unknown,
): string =>
  mode === "json_schema" && schema !== null && schema !== undefined
    ? `\n\nRespond with ONLY a JSON object matching this JSON Schema (no prose, no markdown fences):\n${JSON.stringify(schema)}`
    : "\n\nRespond with ONLY a JSON object (no prose, no markdown fences).";

/**
 * Extract the first balanced top-level JSON object from `text`, tolerating
 * markdown fences and surrounding prose. Returns the parsed-and-reserialized
 * object (guaranteed valid JSON), or null when nothing parses.
 */
export const extractJsonObject = (text: string): string | null => {
  // Prefer fenced bodies first (```json ... ``` or plain ``` ... ```).
  const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  for (const fence of fences) {
    const body = fence[1];
    if (body === undefined) continue;
    const extracted = firstBalancedObject(body);
    if (extracted !== null) return extracted;
  }
  return firstBalancedObject(text);
};

/** Scan for the first `{...}` whose braces balance (string-aware) AND parse. */
const firstBalancedObject = (text: string): string | null => {
  for (
    let start = text.indexOf("{");
    start >= 0;
    start = text.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.stringify(JSON.parse(candidate));
          } catch {
            break; // this opener doesn't parse — try the next one
          }
        }
      }
    }
  }
  return null;
};
