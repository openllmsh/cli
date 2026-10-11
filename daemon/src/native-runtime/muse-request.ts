/**
 * Muse request decomposition — flatten a canonical conversation into official
 * MSP `turn/start` input parts (`text` | `image`). Side-effect free so it is
 * unit-testable without a Muse binary or `@muse-code/sdk`.
 *
 * Official turn input is text/image only (pinned `@muse-code/sdk@1.3.0`
 * `TurnInputPart`). Structured native role replay and external tool-result
 * injection are not established; prior turns and tool results are serialized
 * into prompt text. That serialization is lossy — it is not native history.
 *
 * Unlike `cursorRequestOf`, unsupported surfaces are REJECTED rather than
 * silently dropped: audio, files, non-data image URLs, unsupported image
 * MIME types, empty prompts, and `response_format`.
 */

import type { TChatCompletionRequest } from "@openllmsh/protocol";
import { suppressMuseHostedSearchClientTool } from "./muse-web-search";

/** Official MSP turn input part (`TurnInputPart` in `@muse-code/sdk`). */
export type TMuseInputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly base64Data: string;
      readonly mediaType: string;
    };

/** One caller function tool exposed through the Muse loopback MCP server. */
export type TMuseCallerTool = {
  readonly name: string;
  readonly description: string | null;
  /** JSON-Schema `parameters` of the function tool (MCP `inputSchema`). */
  readonly parameters: unknown;
};

export type TMuseRequest =
  | {
      readonly ok: true;
      readonly systemText: string | null;
      readonly promptText: string;
      readonly parts: ReadonlyArray<TMuseInputPart>;
      readonly tools: ReadonlyArray<TMuseCallerTool>;
    }
  | { readonly ok: false; readonly reason: string };

/** Extract caller function tools; reject non-function entries. */
export const museCallerToolsOf = (
  tools: TChatCompletionRequest["tools"] | undefined,
):
  | { readonly ok: true; readonly tools: ReadonlyArray<TMuseCallerTool> }
  | { readonly ok: false; readonly reason: string } => {
  if (tools === undefined || tools === null) {
    return { ok: true, tools: [] };
  }
  if (!Array.isArray(tools)) {
    return { ok: false, reason: "tools must be an array" };
  }
  const out: TMuseCallerTool[] = [];
  for (const tool of tools) {
    if (
      typeof tool !== "object" ||
      tool === null ||
      (tool as { readonly type?: unknown }).type !== "function"
    ) {
      return { ok: false, reason: "only function tools are supported" };
    }
    const fn = (tool as { readonly function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) {
      return { ok: false, reason: "function tool is missing function body" };
    }
    const name = (fn as { readonly name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0) {
      return { ok: false, reason: "function tool requires a name" };
    }
    const description = (fn as { readonly description?: unknown }).description;
    const parameters = (fn as { readonly parameters?: unknown }).parameters;
    out.push({
      name,
      description: typeof description === "string" ? description : null,
      parameters: parameters ?? { type: "object", properties: {} },
    });
  }
  return { ok: true, tools: out };
};

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

/** MIME types the official turn-input image part accepts (reference
 *  `prompt-content.ts` IMAGE_EXTENSIONS, verified against SDK `TurnInputPart`). */
const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type TMessage = TChatCompletionRequest["messages"][number];

export type TContentScan =
  | {
      readonly ok: true;
      readonly text: string;
      readonly images: ReadonlyArray<TMuseInputPart>;
    }
  | { readonly ok: false; readonly reason: string };

/** Scan one message's content. Rejects audio, files, non-data images, and
 *  unsupported image MIME types instead of dropping them. */
export const scanMuseContent = (content: TMessage["content"]): TContentScan => {
  if (typeof content === "string") {
    return { ok: true, text: content, images: [] };
  }
  if (content === null || content === undefined) {
    return { ok: true, text: "", images: [] };
  }
  if (!Array.isArray(content)) {
    return { ok: false, reason: "unsupported message content" };
  }
  const parts: string[] = [];
  const images: TMuseInputPart[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      return { ok: false, reason: "unsupported message content part" };
    }
    const p = part as {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly image_url?: { readonly url?: unknown };
    };
    if (p.type === "text") {
      if (typeof p.text !== "string") {
        return { ok: false, reason: "unsupported text content part" };
      }
      parts.push(p.text);
      continue;
    }
    if (p.type === "image_url") {
      const url = p.image_url?.url;
      if (typeof url !== "string") {
        return { ok: false, reason: "unsupported image content part" };
      }
      const match = url.match(DATA_URL);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        return {
          ok: false,
          reason: "non-data image URLs are unsupported; send a data: URL",
        };
      }
      const mediaType = match[1].trim().toLowerCase();
      if (!IMAGE_MIME.has(mediaType)) {
        return {
          ok: false,
          reason: `unsupported image MIME type: ${mediaType}`,
        };
      }
      if (match[2].length === 0) {
        return { ok: false, reason: "empty image payload" };
      }
      images.push({ type: "image", mediaType, base64Data: match[2] });
      continue;
    }
    if (p.type === "input_audio" || p.type === "audio") {
      return { ok: false, reason: "audio content is unsupported" };
    }
    if (p.type === "file") {
      return { ok: false, reason: "file content is unsupported" };
    }
    return {
      ok: false,
      reason: `unsupported prompt content type: ${String(p.type ?? "unknown")}`,
    };
  }
  return { ok: true, text: parts.join("\n"), images };
};

const stringifyToolArgs = (args: unknown): string =>
  typeof args === "string" ? args : JSON.stringify(args ?? {});

/** Official MSP `turn/start.input` array: system + prompt text, then images. */
export const museInputParts = (
  systemText: string | null,
  promptText: string,
  images: ReadonlyArray<TMuseInputPart>,
): ReadonlyArray<TMuseInputPart> => {
  const text =
    systemText !== null && systemText.length > 0
      ? `${systemText}\n\n${promptText}`
      : promptText;
  const parts: TMuseInputPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const image of images) parts.push(image);
  return parts;
};

/**
 * Decompose a canonical request for the Muse native runtime. Tool calls and
 * tool results are rendered INLINE in the transcript (v1 is one cold session
 * per request). `response_format` is rejected: prompt-instruction JSON is not
 * an advertised guarantee.
 */
export const museRequestOf = (
  canonical: TChatCompletionRequest,
): TMuseRequest => {
  if (
    canonical.response_format !== undefined &&
    canonical.response_format !== null
  ) {
    return { ok: false, reason: "response_format is unsupported" };
  }
  if (
    canonical.tool_choice !== undefined &&
    canonical.tool_choice !== null &&
    canonical.tool_choice !== "auto"
  ) {
    return { ok: false, reason: "forced tool_choice is unsupported" };
  }

  const callerTools = museCallerToolsOf(canonical.tools);
  if (!callerTools.ok) return callerTools;

  const systemParts: string[] = [];
  const lines: string[] = [];
  const images: TMuseInputPart[] = [];
  let nonSystemTurns = 0;
  let loneUserText: string | null = null;

  for (const message of canonical.messages) {
    const scanned = scanMuseContent(message.content);
    if (!scanned.ok) return scanned;
    for (const image of scanned.images) images.push(image);

    if (message.role === "system") {
      if (scanned.text.length > 0) systemParts.push(scanned.text);
      continue;
    }
    if (message.role === "tool") {
      nonSystemTurns += 1;
      lines.push(`Tool result (${message.tool_call_id}): ${scanned.text}`);
      continue;
    }
    if (message.role === "user") {
      nonSystemTurns += 1;
      loneUserText = scanned.text;
      lines.push(`User: ${scanned.text}`);
      continue;
    }
    if (message.role === "assistant") {
      if (message.audio !== undefined && message.audio !== null) {
        return { ok: false, reason: "audio content is unsupported" };
      }
      const calls = (message.tool_calls ?? [])
        .map(
          (call) =>
            `[tool call ${call.id}: ${call.function.name}(${stringifyToolArgs(call.function.arguments)})]`,
        )
        .join(" ");
      const rendered = [scanned.text, calls]
        .filter((s) => s.length > 0)
        .join(" ");
      if (rendered.length > 0) {
        nonSystemTurns += 1;
        lines.push(`Assistant: ${rendered}`);
      }
      continue;
    }
    const _exhaustive: never = message;
    void _exhaustive;
    return { ok: false, reason: "unsupported message role" };
  }

  const promptText =
    nonSystemTurns === 1 && loneUserText !== null && lines.length === 1
      ? loneUserText
      : lines.join("\n\n");
  const systemText = systemParts.length > 0 ? systemParts.join("\n\n") : null;
  const parts = museInputParts(systemText, promptText, images);
  if (parts.length === 0) {
    return { ok: false, reason: "prompt contains no text or image content" };
  }
  return {
    ok: true,
    systemText,
    promptText,
    parts,
    // Host-native Muse web_search owns search on this hop — suppress a
    // caller function of the same name so it cannot race as MCP tool_calls.
    tools: suppressMuseHostedSearchClientTool(callerTools.tools),
  };
};
