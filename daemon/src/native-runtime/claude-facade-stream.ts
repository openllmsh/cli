import type { TChatCompletionChunk } from "@openllmsh/protocol";
import { AnthropicStreamEvent } from "@openllmsh/protocol";
import { CLAUDE_NATIVE_ASSISTANT_PENDING } from "@openllmsh/wire/adapters/messages/reasoning-signature";
import { decodeProviderEventStream } from "@openllmsh/wire/lib/streaming/provider-decode";
import {
  fromAnthropicStreamEvent,
  newAnthropicStreamState,
} from "@openllmsh/wire/providers/anthropic/streaming";
import { claudeNativeAssistantCarrier } from "./claude-facade-history";
import type { TClaudeToolNameMap } from "./claude-tool-capture";

/** Capture receives the REAL response only in the daemon, never in CLI stdout.
 * Preserve its native blocks/signatures while reusing the shared wire decoder.
 * The terminal chunk waits for message_stop so the carrier arrives before a
 * client can stop reading at finish_reason. No stream tee or second send.
 */
export const chunksFromFacadeCapturedResponse = (
  response: Response,
  providerModelId: string,
  nameMap: TClaudeToolNameMap,
): ReadableStream<TChatCompletionChunk> => {
  if (response.body === null)
    return new ReadableStream({
      start(c) {
        c.close();
      },
    });
  const state = newAnthropicStreamState({
    providerModelId,
    toolNameMap: nameMap.mcpToCaller,
  });
  const blocks = new Map<number, Record<string, unknown>>();
  const inputJson = new Map<number, string>();
  let terminal: TChatCompletionChunk | null = null;
  return decodeProviderEventStream(
    response.body,
    {
      eventSchema: AnthropicStreamEvent,
      initialState: () => state,
      isTerminalEvent: (event) => event.type === "message_stop",
      eventToChunk: (event, current, options) => {
        if (event.type === "message_start") {
          blocks.clear();
          inputJson.clear();
          terminal = null;
        } else if (event.type === "content_block_start") {
          blocks.set(event.index, { ...event.content_block });
        } else if (event.type === "content_block_delta") {
          const block = blocks.get(event.index);
          if (block !== undefined) {
            const delta = event.delta;
            if (delta.type === "text_delta")
              block.text = String(block.text ?? "") + delta.text;
            else if (delta.type === "thinking_delta")
              block.thinking = String(block.thinking ?? "") + delta.thinking;
            else if (delta.type === "signature_delta")
              block.signature = String(block.signature ?? "") + delta.signature;
            else if (delta.type === "input_json_delta")
              inputJson.set(
                event.index,
                (inputJson.get(event.index) ?? "") + delta.partial_json,
              );
          }
        } else if (event.type === "content_block_stop") {
          const json = inputJson.get(event.index);
          const block = blocks.get(event.index);
          if (json !== undefined && block !== undefined) {
            try {
              block.input = JSON.parse(json) as unknown;
            } catch {
              throw new Error(
                "Claude facade capture returned invalid tool JSON",
              );
            }
          }
        }
        if (event.type === "message_stop") {
          if (terminal === null)
            throw new Error(
              "Claude facade capture ended without a message_delta",
            );
          const carrier = claudeNativeAssistantCarrier(
            [
              {
                role: "assistant",
                content: [...blocks.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([, block]) => block),
              },
            ],
            providerModelId,
            nameMap,
          );
          return {
            ...terminal,
            choices: terminal.choices.map((choice) => ({
              ...choice,
              delta: { ...choice.delta, reasoning_items: [carrier] },
            })),
          };
        }
        const chunk = fromAnthropicStreamEvent(event, current, options);
        if (chunk === null) return null;
        if (event.type === "message_delta") {
          terminal = chunk;
          return null;
        }
        return event.type === "message_start"
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
      },
    },
    { providerModelId },
  );
};
