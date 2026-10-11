/**
 * `openllm -p <prompt> [-m <model>]` — one-shot inference.
 *
 * Sends a single user message to `/v1/chat/completions` on the automatically
 * resolved gateway (local daemon when it answers, else the cloud origin) and
 * streams the reply text to stdout. Nothing else goes to stdout, so the output
 * can be piped or captured by scripts; diagnostics go to stderr.
 *
 * `--output-format json|stream-json` (or `--json`) swaps the plain text for
 * machine-readable output that carries what text alone loses: the model that
 * actually served the request, usage, finish reason and structured errors.
 */

import { CLI_VERSION } from "./cli-version";
import { resolveGateway } from "./clients/gateway";
import { requireCliApiKey } from "./onboarding";

export const DEFAULT_CHAT_MODEL = "ultra";

/** Identifies one-shot `-p` traffic in gateway logs and key activity. */
export const PROMPT_USER_AGENT = `OpenLLM/${CLI_VERSION}`;

export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
export type TOutputFormat = (typeof OUTPUT_FORMATS)[number];

export const CHAT_USAGE = `usage: openllm -p <prompt> [-m <model>] [-s <system>] [--output-format <fmt>]

One-shot inference: send a prompt, stream the reply to stdout.

  -p, --prompt <text>        the prompt (\`-p -\` or omitted with piped stdin reads stdin)
  -m, --model <id>           model or alias (default: ${DEFAULT_CHAT_MODEL})
  -s, --system <text>        optional system prompt
      --no-stream            wait for the full reply instead of streaming
      --output-format <fmt>  text (default) | json | stream-json
      --json                 same as --output-format json

json         one object on stdout once the reply is done:
             {"type":"result","text","reasoning","model","resolved_model",
              "finish_reason","usage","attempted_fallbacks","id"}
stream-json  one JSON object per line: {"type":"delta","text"} and
             {"type":"reasoning","text"} while streaming, then the result object
Errors in json modes are printed to stdout as {"type":"error","status",
"message","error_ref"} with exit code 1.

Requires an API key — run \`openllm login\` first.
`;

export type TChatArgs = {
  readonly prompt: string | null;
  readonly model: string;
  readonly system: string | null;
  readonly stream: boolean;
  readonly format: TOutputFormat;
};

const isOutputFormat = (s: string): s is TOutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(s);

export const parseChatArgs = (
  args: readonly string[],
): TChatArgs | { readonly error: string } => {
  let prompt: string | null = null;
  let model = DEFAULT_CHAT_MODEL;
  let system: string | null = null;
  let stream = true;
  let format: TOutputFormat = "text";
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? "";
    // `--flag=value` is accepted for every long flag that takes a value.
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const arg = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      i += 1;
      return args[i];
    };
    switch (arg) {
      case "-p":
      case "--prompt": {
        const v = value();
        if (v === undefined) return { error: `${arg} needs a value` };
        prompt = v;
        break;
      }
      case "-m":
      case "--model": {
        const v = value();
        if (v === undefined || v.length === 0)
          return { error: `${arg} needs a value` };
        model = v;
        break;
      }
      case "-s":
      case "--system": {
        const v = value();
        if (v === undefined) return { error: `${arg} needs a value` };
        system = v;
        break;
      }
      case "--output-format": {
        const v = value();
        if (v === undefined || !isOutputFormat(v))
          return {
            error: `${arg} must be one of ${OUTPUT_FORMATS.join(", ")}`,
          };
        format = v;
        break;
      }
      case "--json":
        format = "json";
        break;
      case "--no-stream":
        stream = false;
        break;
      default:
        return { error: `unknown argument "${raw}"` };
    }
  }
  return { prompt, model, system, stream, format };
};

type TUsage = Readonly<Record<string, unknown>>;

type TChoiceText = {
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
  readonly reasoning?: string | null;
};

type TChoiceChunk = {
  readonly id?: string;
  readonly usage?: TUsage | null;
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string | null;
    readonly delta?: TChoiceText;
    readonly message?: TChoiceText;
  }>;
};

/** What `json` / `stream-json` report once the reply is complete. */
type TChatResult = {
  readonly type: "result";
  readonly text: string;
  readonly reasoning: string | null;
  readonly model: string;
  readonly resolved_model: string | null;
  readonly finish_reason: string | null;
  readonly usage: TUsage | null;
  readonly attempted_fallbacks: number;
  readonly id: string | null;
};

type TStreamedReply = {
  readonly text: string;
  readonly reasoning: string;
  readonly finishReason: string | null;
  readonly usage: TUsage | null;
  readonly id: string | null;
};

const writeJsonLine = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const reasoningOf = (t: TChoiceText | undefined): string | null =>
  t?.reasoning_content ?? t?.reasoning ?? null;

/**
 * Reads an SSE chat-completions stream. `onText` / `onReasoning` see each
 * delta as it arrives; the return value is the accumulated reply.
 */
const readStream = async (
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  onReasoning: (text: string) => void,
): Promise<TStreamedReply> => {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: TUsage | null = null;
  let id: string | null = null;
  const handleLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") return;
    let chunk: TChoiceChunk;
    try {
      chunk = JSON.parse(data) as TChoiceChunk;
    } catch {
      return; // a non-JSON keepalive or comment frame
    }
    if (typeof chunk.id === "string") id = chunk.id;
    if (chunk.usage != null) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    const r = reasoningOf(choice?.delta);
    if (r !== null && r.length > 0) {
      reasoning += r;
      onReasoning(r);
    }
    const t = choice?.delta?.content;
    if (typeof t === "string" && t.length > 0) {
      text += t;
      onText(t);
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      handleLine(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  handleLine(buffer.trim());
  return { text, reasoning, finishReason, usage, id };
};

/** Pulls a human message out of an OpenAI- or Anthropic-shaped error body. */
export const errorMessageOf = (detail: string, fallback: string): string => {
  try {
    const parsed = JSON.parse(detail) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return detail.trim().length > 0 ? detail.trim() : fallback;
};

export const runChat = async (args: readonly string[]): Promise<number> => {
  const parsed = parseChatArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`[openllm] ${parsed.error}\n\n${CHAT_USAGE}`);
    return 2;
  }
  const structured = parsed.format !== "text";
  const fail = (
    status: number | null,
    message: string,
    errorRef: string | null = null,
  ): number => {
    if (structured)
      writeJsonLine({ type: "error", status, message, error_ref: errorRef });
    else process.stderr.write(`[openllm] ${message}\n`);
    return 1;
  };

  let prompt = parsed.prompt;
  if (prompt === "-" || (prompt === null && process.stdin.isTTY !== true)) {
    prompt = await Bun.stdin.text();
  }
  if (prompt === null || prompt.trim().length === 0) {
    process.stderr.write(`[openllm] a prompt is required\n\n${CHAT_USAGE}`);
    return 2;
  }

  const gate = requireCliApiKey("machine");
  if (!gate.ok) {
    if (structured) return fail(null, gate.message.trim());
    process.stderr.write(gate.message);
    return 1;
  }
  const gateway = await resolveGateway({ config: gate.config });

  const messages = [
    ...(parsed.system === null
      ? []
      : [{ role: "system", content: parsed.system }]),
    { role: "user", content: prompt },
  ];
  // `json` gains nothing from streaming; `stream-json` always streams.
  const stream =
    parsed.format === "stream-json" ||
    (parsed.format === "text" && parsed.stream);
  let res: Response;
  try {
    res = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        "content-type": "application/json",
        "user-agent": PROMPT_USER_AGENT,
      },
      body: JSON.stringify({
        model: parsed.model,
        messages,
        stream,
        ...(stream && structured
          ? { stream_options: { include_usage: true } }
          : {}),
      }),
    });
  } catch (error) {
    return fail(
      null,
      `request to ${gateway.base} failed: ${(error as Error).message}`,
    );
  }
  if (!res.ok || res.body === null) {
    const detail = await res.text().catch(() => "");
    if (structured)
      return fail(
        res.status,
        errorMessageOf(detail, res.statusText),
        res.headers.get("x-openllm-error-ref"),
      );
    return fail(
      res.status,
      `${res.status} ${res.statusText}${detail.length > 0 ? `: ${detail.trim()}` : ""}`,
    );
  }

  const meta = {
    model: parsed.model,
    resolved_model: res.headers.get("x-openllm-resolved-model"),
    attempted_fallbacks: Number(
      res.headers.get("x-openllm-attempted-fallbacks") ?? "0",
    ),
  };

  if (stream) {
    const streamJson = parsed.format === "stream-json";
    let endedWithNewline = true;
    const reply = await readStream(
      res.body,
      streamJson
        ? (text) => writeJsonLine({ type: "delta", text })
        : (text) => {
            process.stdout.write(text);
            endedWithNewline = text.endsWith("\n");
          },
      streamJson
        ? (text) => writeJsonLine({ type: "reasoning", text })
        : () => {},
    );
    if (!streamJson) {
      if (!endedWithNewline) process.stdout.write("\n");
      return 0;
    }
    const result: TChatResult = {
      type: "result",
      text: reply.text,
      reasoning: reply.reasoning.length > 0 ? reply.reasoning : null,
      ...meta,
      finish_reason: reply.finishReason,
      usage: reply.usage,
      id: reply.id,
    };
    writeJsonLine(result);
    return 0;
  }

  const json = (await res.json()) as TChoiceChunk;
  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!structured) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  const reasoning = reasoningOf(choice?.message);
  const result: TChatResult = {
    type: "result",
    text,
    reasoning: reasoning !== null && reasoning.length > 0 ? reasoning : null,
    ...meta,
    finish_reason: choice?.finish_reason ?? null,
    usage: json.usage ?? null,
    id: json.id ?? null,
  };
  writeJsonLine(result);
  return 0;
};
