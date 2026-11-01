import type { TOutputLimitSurface } from "@openllmsh/wire/features/output-limit-clamp";
import { clampOutputLimitBytes } from "@openllmsh/wire/features/output-limit-clamp";
import type { TAttemptUsage } from "@openllmsh/wire/lib/attempt-outcome";
import { estimateCapInputTokens } from "@openllmsh/wire/lib/canonical/token-estimate";
import type { TUsageProtocol } from "@openllmsh/wire/lib/usage-observer";
import { createUsageObserver } from "@openllmsh/wire/lib/usage-observer";

export const estimateTeamLegInputTokens = estimateCapInputTokens;

export const clampTeamLegBody = (
  body: Uint8Array,
  surface: TOutputLimitSurface,
  limit: number,
): Uint8Array => {
  return clampOutputLimitBytes(body, surface, limit);
};

/** Read the caller's requested output budget without trusting malformed JSON. */
export const maxOutputTokensFromTeamLegBody = (body: Uint8Array): number => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return 0;
    }
    const record = parsed as Record<string, unknown>;
    for (const key of [
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
    ] as const) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
    }
  } catch {
    // The eventual supplier dispatch will return the request validation error.
  }
  return 0;
};

export const rewriteTeamLegBodyModel = (
  body: Uint8Array,
  resolvedModel: string,
): Uint8Array => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return body;
    }
    return new TextEncoder().encode(
      JSON.stringify({
        ...(parsed as Record<string, unknown>),
        model: resolvedModel,
      }),
    );
  } catch {
    return body;
  }
};

const MAX_OBSERVATION_BYTES = 1024 * 1024;

/** Observe only bytes pulled by the consumer. Cancellation and failures are unknown. */
export const observeTeamResponseStream = (
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
  protocol: TUsageProtocol,
  settle: (usage: TAttemptUsage | null) => void,
  onIncomplete?: () => void,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const observer = createUsageObserver(protocol, eventStream ? "sse" : "json");
  let pending = "";
  let bytes = 0;
  let overflow = false;
  let complete = false;
  let failed = false;
  let settled = false;
  const finish = (usage: TAttemptUsage | null): void => {
    if (settled) return;
    settled = true;
    settle(usage);
  };
  const frame = (text: string): void => {
    const data: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (
        value === "event: message_stop" ||
        value === "event: response.completed" ||
        value === "data: [DONE]"
      )
        complete = true;
      if (value === "event: error") failed = true;
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) {
      try {
        const payload: unknown = JSON.parse(data.join("\n"));
        if (
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload)
        ) {
          const record = payload as Record<string, unknown>;
          if ("error" in record || record.type === "error") failed = true;
        }
        observer.observe(payload);
      } catch {
        /* malformed event */
      }
    }
  };
  const append = (text: string): void => {
    if (overflow) return;
    if (!eventStream) {
      bytes += encoder.encode(text).byteLength;
      if (bytes > MAX_OBSERVATION_BYTES) {
        overflow = true;
        pending = "";
        return;
      }
      pending += text;
      return;
    }
    // Process complete frames before applying the limit, so a large chunk of
    // small frames does not count as one retained frame.
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\n") continue;
      const part = text.slice(start, i + 1);
      bytes += encoder.encode(part).byteLength;
      if (bytes > MAX_OBSERVATION_BYTES) {
        overflow = true;
        pending = "";
        return;
      }
      pending += part;
      start = i + 1;
      if (/\r?\n\r?\n$/.test(pending.slice(-4))) {
        frame(pending);
        pending = "";
        bytes = 0;
      }
    }
    const rest = text.slice(start);
    bytes += encoder.encode(rest).byteLength;
    if (bytes > MAX_OBSERVATION_BYTES) {
      overflow = true;
      pending = "";
      return;
    }
    pending += rest;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const result = await reader.read();
        if (!result.done) {
          if (
            !overflow &&
            bytes + result.value.byteLength > MAX_OBSERVATION_BYTES
          ) {
            overflow = true;
            pending = "";
          }
          if (!overflow) append(decoder.decode(result.value, { stream: true }));
          controller.enqueue(result.value);
          return;
        }
        if (!overflow) append(decoder.decode());
        if (!overflow && !eventStream) {
          try {
            observer.observe(JSON.parse(pending));
          } catch {
            /* unknown usage */
          }
        }
        if (!overflow && eventStream && !complete) onIncomplete?.();
        finish(
          !overflow && !failed && (!eventStream || complete)
            ? observer.usage()
            : null,
        );
        controller.close();
      } catch (error) {
        finish(null);
        controller.error(error);
      }
    },
    async cancel(reason): Promise<void> {
      finish(null);
      await reader.cancel(reason);
    },
  });
};

/** Drain an observation for callers that explicitly need a standalone result. */
export const observeTeamResponse = async (
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
  protocol: TUsageProtocol,
): Promise<TAttemptUsage | null> => {
  let usage: TAttemptUsage | null = null;
  let incomplete = false;
  const stream = observeTeamResponseStream(
    body,
    eventStream,
    protocol,
    (value) => {
      usage = value;
    },
    () => {
      incomplete = true;
    },
  );
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
  if (incomplete) throw new Error("team stream ended before completion");
  return usage;
};
