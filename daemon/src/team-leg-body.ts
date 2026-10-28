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

type TUsage = { readonly input: number; readonly output: number };

const usageOf = (value: unknown): TUsage => {
  if (value === null || typeof value !== "object")
    return { input: 0, output: 0 };
  const owner = (value as { readonly response?: unknown }).response;
  const usageOwner =
    owner !== null && typeof owner === "object" && !Array.isArray(owner)
      ? owner
      : value;
  const usage = (usageOwner as { readonly usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object")
    return { input: 0, output: 0 };
  const data = usage as {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
  };
  const input =
    typeof data.prompt_tokens === "number"
      ? data.prompt_tokens
      : typeof data.input_tokens === "number"
        ? data.input_tokens
        : 0;
  const output =
    typeof data.completion_tokens === "number"
      ? data.completion_tokens
      : typeof data.output_tokens === "number"
        ? data.output_tokens
        : 0;
  return {
    input: Math.max(0, Math.floor(input)),
    output: Math.max(0, Math.floor(output)),
  };
};

/** Read OpenAI-shaped JSON or SSE usage; malformed/truncated streams reject. */
export const observedTeamLegTokens = async (
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
): Promise<number> => {
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  if (!eventStream) {
    const usage = usageOf(JSON.parse(text));
    return usage.input + usage.output;
  }
  let usage: TUsage = { input: 0, output: 0 };
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
      usage = {
        input: Math.max(usage.input, next.input),
        output: Math.max(usage.output, next.output),
      };
    } catch {
      // A provider can interleave non-JSON SSE control frames.
    }
  }
  if (!complete) throw new Error("team stream ended before completion");
  return usage.input + usage.output;
};
