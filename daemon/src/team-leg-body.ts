import type { TOutputLimitSurface } from "@openllmsh/wire/features/output-limit-clamp";
import { clampOutputLimitFields } from "@openllmsh/wire/features/output-limit-clamp";

export const clampTeamLegBody = (
  body: Uint8Array,
  surface: TOutputLimitSurface,
  limit: number,
): Uint8Array => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid team request body");
  return new TextEncoder().encode(
    JSON.stringify(
      clampOutputLimitFields(parsed as Record<string, unknown>, surface, limit),
    ),
  );
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

type TUsage = { readonly input: number | null; readonly output: number | null };

const usageOf = (value: unknown): TUsage | null => {
  if (value === null || typeof value !== "object") return null;
  const record = value as {
    readonly response?: unknown;
    readonly message?: unknown;
  };
  const response = record.response;
  const owner =
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response)
      ? response
      : record.message;
  const usageOwner =
    owner !== null && typeof owner === "object" && !Array.isArray(owner)
      ? owner
      : value;
  const usage = (usageOwner as { readonly usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const data = usage as {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
  };
  const token = (primary: unknown, alternate: unknown): number | null => {
    const value = typeof primary === "number" ? primary : alternate;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : null;
  };
  return {
    input: token(data.prompt_tokens, data.input_tokens),
    output: token(data.completion_tokens, data.output_tokens),
  };
};

/** Read OpenAI-shaped JSON or SSE usage; malformed/truncated streams reject. */
export const observedTeamLegUsage = async (
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
): Promise<{
  readonly tokensIn: number;
  readonly tokensOut: number;
} | null> => {
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  if (!eventStream) {
    const usage = usageOf(JSON.parse(text));
    return usage?.input == null || usage.output === null
      ? null
      : { tokensIn: usage.input, tokensOut: usage.output };
  }
  let input: number | null = null;
  let output: number | null = null;
  let complete = false;
  for (const line of text.split("\n")) {
    const value = line.trim();
    if (
      value === "event: message_stop" ||
      value === "event: response.completed"
    )
      complete = true;
    if (!value.startsWith("data:")) continue;
    const data = value.slice(5).trim();
    if (data === "[DONE]") {
      complete = true;
      continue;
    }
    if (data.length === 0) continue;
    try {
      const next = usageOf(JSON.parse(data));
      if (next !== null) {
        if (next.input !== null) input = Math.max(input ?? 0, next.input);
        if (next.output !== null) output = Math.max(output ?? 0, next.output);
      }
    } catch {
      // A provider can interleave non-JSON SSE control frames.
    }
  }
  if (!complete) throw new Error("team stream ended before completion");
  return input === null || output === null
    ? null
    : { tokensIn: input, tokensOut: output };
};

export const observedTeamLegTokens = async (
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
): Promise<number | null> => {
  const usage = await observedTeamLegUsage(body, eventStream);
  return usage === null ? null : usage.tokensIn + usage.tokensOut;
};
