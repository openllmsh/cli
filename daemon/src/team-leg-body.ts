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

/** Observe a team response; incomplete streams must not settle the hold. */
export const observeTeamResponse = async (
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
  protocol: TUsageProtocol,
): Promise<TAttemptUsage | null> => {
  const text = await new Response(body).text();
  const observer = createUsageObserver(protocol, eventStream ? "sse" : "json");
  if (eventStream) {
    if (
      !text.split("\n").some((line) => {
        const value = line.trim();
        return (
          value === "event: message_stop" ||
          value === "event: response.completed" ||
          value === "data: [DONE]"
        );
      })
    )
      throw new Error("team stream ended before completion");
    await observer.observeStream(
      new Response(text).body as ReadableStream<Uint8Array>,
    );
  } else {
    observer.observe(JSON.parse(text));
  }
  return observer.usage();
};
