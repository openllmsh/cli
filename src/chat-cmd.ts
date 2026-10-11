/**
 * `openllm -p <prompt> [-m <model>]` — one-shot inference.
 *
 * Sends a single user message to `/v1/chat/completions` on the automatically
 * resolved gateway (local daemon when it answers, else the cloud origin) and
 * streams the reply text to stdout. Nothing else goes to stdout, so the output
 * can be piped or captured by scripts; diagnostics go to stderr.
 */

import { CLI_VERSION } from "./cli-version";
import { resolveGateway } from "./clients/gateway";
import { requireCliApiKey } from "./onboarding";

export const DEFAULT_CHAT_MODEL = "ultra";

/** Identifies one-shot `-p` traffic in gateway logs and key activity. */
export const PROMPT_USER_AGENT = `OpenLLM/${CLI_VERSION}`;

export const CHAT_USAGE = `usage: openllm -p <prompt> [-m <model>] [-s <system>]

One-shot inference: send a prompt, stream the reply to stdout.

  -p, --prompt <text>   the prompt (\`-p -\` or omitted with piped stdin reads stdin)
  -m, --model <id>      model or alias (default: ${DEFAULT_CHAT_MODEL})
  -s, --system <text>   optional system prompt
      --no-stream       wait for the full reply instead of streaming

Requires an API key — run \`openllm login\` first.
`;

export type TChatArgs = {
  readonly prompt: string | null;
  readonly model: string;
  readonly system: string | null;
  readonly stream: boolean;
};

export const parseChatArgs = (
  args: readonly string[],
): TChatArgs | { readonly error: string } => {
  let prompt: string | null = null;
  let model = DEFAULT_CHAT_MODEL;
  let system: string | null = null;
  let stream = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const value = (): string | undefined => {
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
      case "--no-stream":
        stream = false;
        break;
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  return { prompt, model, system, stream };
};

type TChoiceText = {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string | null };
    readonly message?: { readonly content?: string | null };
  }>;
};

const writeStreamedReply = async (
  body: ReadableStream<Uint8Array>,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = "";
  let endedWithNewline = true;
  const handleLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") return;
    try {
      const text = (JSON.parse(data) as TChoiceText).choices?.[0]?.delta
        ?.content;
      if (typeof text === "string" && text.length > 0) {
        process.stdout.write(text);
        endedWithNewline = text.endsWith("\n");
      }
    } catch {
      // a non-JSON keepalive or comment frame
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
  if (!endedWithNewline) process.stdout.write("\n");
};

export const runChat = async (args: readonly string[]): Promise<number> => {
  const parsed = parseChatArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`[openllm] ${parsed.error}\n\n${CHAT_USAGE}`);
    return 2;
  }
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
        stream: parsed.stream,
      }),
    });
  } catch (error) {
    process.stderr.write(
      `[openllm] request to ${gateway.base} failed: ${(error as Error).message}\n`,
    );
    return 1;
  }
  if (!res.ok || res.body === null) {
    const detail = await res.text().catch(() => "");
    process.stderr.write(
      `[openllm] ${res.status} ${res.statusText}${detail.length > 0 ? `: ${detail.trim()}` : ""}\n`,
    );
    return 1;
  }

  if (parsed.stream) {
    await writeStreamedReply(res.body);
    return 0;
  }
  const json = (await res.json()) as TChoiceText;
  const text = json.choices?.[0]?.message?.content ?? "";
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
};
