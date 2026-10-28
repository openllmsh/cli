/**
 * `openllm exec ad --client claude|codex` — contextual sponsored-message hook.
 *
 * Hooks must never delay or disrupt the host client: malformed input, missing
 * configuration, no-fill, and every network or transcript error exit silently.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type { TCliConfig } from "./env";
import { cliConfig } from "./env";
import { sessionHostDir } from "./session-host";

/** Keep in parity with the schema/browser context contract (tested). */
export const GRAVITY_CHAT_AD_MAX_CONTENT_CHARS = 8000;
export const GRAVITY_CHAT_AD_CONTEXT_MESSAGES = 4;
export const GRAVITY_CHAT_AD_FETCH_TIMEOUT_MS = 1500;
export const GRAVITY_CHAT_AD_IMPRESSION_TIMEOUT_MS = 500;
export const GRAVITY_CHAT_AD_TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export type TAdHookClient = "claude" | "codex";

type TAdMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

type TAdHookInput = {
  readonly sessionId: string;
  readonly transcriptPath: string | null;
  readonly stopHookActive: boolean;
  readonly lastAssistantMessage: string | null;
};

type TGravityAd = {
  readonly adText: string;
  readonly brandName?: string;
  readonly title?: string;
  readonly cta?: string;
  readonly clickUrl: string;
  readonly impUrl?: string;
};

const textContent = (content: unknown): string | null => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : null;
};

const boundedMessage = (role: unknown, content: unknown): TAdMessage | null => {
  if ((role !== "user" && role !== "assistant") || typeof content !== "string")
    return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  return { role, content: trimmed.slice(0, GRAVITY_CHAT_AD_MAX_CONTENT_CHARS) };
};

const messagesFromTail = (
  jsonl: string,
  startsMidLine: boolean,
  parseLine: (line: string) => TAdMessage | null,
): TAdMessage[] => {
  const lines = jsonl.split("\n");
  const messages: TAdMessage[] = [];
  for (
    let index = lines.length - 1;
    index >= (startsMidLine ? 1 : 0);
    index--
  ) {
    const parsed = parseLine(lines[index] ?? "");
    if (parsed === null) continue;
    messages.push(parsed);
    if (messages.length === GRAVITY_CHAT_AD_CONTEXT_MESSAGES) break;
  }
  return messages.reverse();
};

const claudeMessage = (line: string): TAdMessage | null => {
  try {
    const item = JSON.parse(line) as {
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    if (item.type !== "user" && item.type !== "assistant") return null;
    const message = item.message;
    return boundedMessage(
      message?.role ?? item.type,
      textContent(message?.content),
    );
  } catch {
    return null;
  }
};

const codexMessage = (line: string): TAdMessage | null => {
  try {
    const item = JSON.parse(line) as {
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        content?: ReadonlyArray<{ type?: unknown; text?: unknown }>;
      };
    };
    if (item.type !== "response_item" || item.payload?.type !== "message")
      return null;
    const content = item.payload.content
      ?.filter(
        (
          block,
        ): block is {
          readonly type: "input_text" | "output_text";
          readonly text: string;
        } =>
          (block.type === "input_text" || block.type === "output_text") &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
    return boundedMessage(item.payload.role, content);
  } catch {
    return null;
  }
};

/** Extract Claude Code's text user/assistant JSONL records. */
export const parseClaudeTranscript = (jsonl: string): TAdMessage[] =>
  messagesFromTail(jsonl, false, claudeMessage);

/** Extract Codex's `response_item` message records after zstd decompression. */
export const parseCodexTranscript = (jsonl: string): TAdMessage[] =>
  messagesFromTail(jsonl, false, codexMessage);

const safeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const adOf = (value: unknown): TGravityAd | null => {
  if (typeof value !== "object" || value === null) return null;
  const ad = (value as { ad?: unknown }).ad;
  if (typeof ad !== "object" || ad === null) return null;
  const record = ad as Record<string, unknown>;
  const clickUrl = safeHttpUrl(record.clickUrl);
  if (
    typeof record.adText !== "string" ||
    record.adText.length === 0 ||
    clickUrl === null
  )
    return null;
  return {
    adText: record.adText,
    clickUrl,
    ...(typeof record.brandName === "string"
      ? { brandName: record.brandName }
      : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.cta === "string" ? { cta: record.cta } : {}),
    ...(safeHttpUrl(record.impUrl) === null
      ? {}
      : { impUrl: safeHttpUrl(record.impUrl) ?? undefined }),
  };
};

/** Ad fields are third-party text bound for a terminal: drop C0/C1 controls
 *  (keeping tab and newline) so no escape sequence can restyle the output or
 *  hide the "Sponsored" label. */
const printable = (value: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal escapes
  value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** Keep the tracked URL out of the visible transcript while leaving a direct,
 * terminal-native destination for the ad's CTA. `clickUrl` was validated by
 * `safeHttpUrl` before this point. */
const terminalHyperlink = (url: string, text: string): string =>
  `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

const renderAd = (ad: TGravityAd, origin: string): string => {
  const brand = printable(ad.brandName ?? "").trim() || "Sponsor";
  const title = printable(ad.title ?? "").trim();
  const cta = printable(ad.cta ?? "").trim() || `Visit ${brand}`;
  return [
    `Sponsored · ${brand}${title === "" ? "" : ` — ${title}`}`,
    printable(ad.adText),
    terminalHyperlink(ad.clickUrl, cta),
    `Go ad-free: ${origin}/settings/plan`,
  ]
    .join("\n")
    .slice(0, 9000);
};

const parseInput = (text: string): TAdHookInput | null => {
  try {
    const input = JSON.parse(text) as {
      session_id?: unknown;
      transcript_path?: unknown;
      stop_hook_active?: unknown;
      last_assistant_message?: unknown;
    };
    if (typeof input.session_id !== "string" || input.session_id.trim() === "")
      return null;
    return {
      sessionId: input.session_id,
      transcriptPath:
        typeof input.transcript_path === "string"
          ? input.transcript_path
          : null,
      stopHookActive: input.stop_hook_active === true,
      lastAssistantMessage:
        typeof input.last_assistant_message === "string"
          ? input.last_assistant_message
          : null,
    };
  } catch {
    return null;
  }
};

const readStdin = async (): Promise<string> => {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
};

type TTranscriptTail = {
  readonly bytes: Uint8Array;
  readonly startsMidLine: boolean;
};

const readClaudeTranscriptTail = (path: string): TTranscriptTail => {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, GRAVITY_CHAT_AD_TRANSCRIPT_TAIL_BYTES);
    const bytes = new Uint8Array(length);
    readSync(descriptor, bytes, 0, length, size - length);
    return { bytes, startsMidLine: size > length };
  } finally {
    closeSync(descriptor);
  }
};

const messagesFor = async (
  client: TAdHookClient,
  input: TAdHookInput,
  readFile: (path: string) => Uint8Array,
  readClaudeTail: (path: string) => TTranscriptTail,
  decompress: (value: Uint8Array) => Promise<Uint8Array>,
): Promise<TAdMessage[]> => {
  try {
    if (input.transcriptPath === null) throw new Error("No transcript");
    const transcript =
      client === "claude"
        ? readClaudeTail(input.transcriptPath)
        : (() => {
            const bytes = readFile(input.transcriptPath);
            return { bytes, startsMidLine: false };
          })();
    const decoded =
      client === "codex"
        ? await decompress(transcript.bytes)
        : transcript.bytes;
    const tail = decoded.slice(-GRAVITY_CHAT_AD_TRANSCRIPT_TAIL_BYTES);
    const text = new TextDecoder().decode(tail);
    const startsMidLine =
      transcript.startsMidLine || decoded.length > tail.length;
    const messages = messagesFromTail(
      text,
      startsMidLine,
      client === "codex" ? codexMessage : claudeMessage,
    );
    if (messages.length > 0) return messages;
  } catch {
    // Codex explicitly falls back to the Stop payload when its compressed rollout
    // cannot be read; Claude has the same safe no-op fallback.
  }
  const fallback = boundedMessage("assistant", input.lastAssistantMessage);
  return fallback === null ? [] : [fallback];
};

/** True only for a valid host focus record that currently assigns the browser. */
export const sessionUserAtBrowser = (
  sessionId: string,
  readFile: (path: string) => Uint8Array = (path) => readFileSync(path),
): boolean => {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(
        readFile(join(sessionHostDir(sessionId), "focus.json")),
      ),
    );
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { readonly user_at?: unknown }).user_at === "browser"
    );
  } catch {
    return false;
  }
};

export type TAdHookDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly config?: () => TCliConfig;
  readonly readFile?: (path: string) => Uint8Array;
  readonly readClaudeTail?: (path: string) => TTranscriptTail;
  readonly focusReadFile?: (path: string) => Uint8Array;
  readonly decompress?: (value: Uint8Array) => Promise<Uint8Array>;
  readonly write?: (text: string) => void;
};

export const runAdHookCommand = async (
  args: readonly string[],
  deps: TAdHookDeps = {},
): Promise<number> => {
  const client = args[0] === "--client" ? args[1] : undefined;
  if (client !== "claude" && client !== "codex") return 0;
  const env = deps.env ?? process.env;
  const deviceSessionId = (env.OPENLLM_DEVICE_SESSION_ID ?? "").trim();
  if (
    env.OPENLLM_ADS === "0" ||
    (deviceSessionId !== "" &&
      sessionUserAtBrowser(deviceSessionId, deps.focusReadFile))
  )
    return 0;
  const input = parseInput(await (deps.stdin ?? readStdin)());
  if (input === null || input.stopHookActive) return 0;
  const config = (deps.config ?? cliConfig)();
  if (config.apiKey.trim() === "" || config.gatewayUrl.trim() === "") return 0;
  const messages = await messagesFor(
    client,
    input,
    deps.readFile ?? ((path) => readFileSync(path)),
    deps.readClaudeTail ??
      (deps.readFile === undefined
        ? readClaudeTranscriptTail
        : (path) => ({
            bytes: deps.readFile?.(path) ?? new Uint8Array(),
            startsMidLine: false,
          })),
    deps.decompress ?? (async (value) => Bun.zstdDecompress(value)),
  );
  if (messages.length === 0) return 0;
  try {
    const response = await (deps.fetch ?? fetch)(
      `${config.gatewayUrl}/api/gravity/chat-ad`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: input.sessionId,
          messages,
          surface: client === "claude" ? "cli_claude" : "cli_codex",
        }),
        signal: AbortSignal.timeout(GRAVITY_CHAT_AD_FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return 0;
    const ad = adOf(await response.json());
    if (ad === null) return 0;
    (deps.write ?? ((text) => process.stdout.write(text)))(
      `${JSON.stringify({ systemMessage: renderAd(ad, config.gatewayUrl) })}\n`,
    );
    if (ad.impUrl !== undefined) {
      try {
        await (deps.fetch ?? fetch)(ad.impUrl, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(GRAVITY_CHAT_AD_IMPRESSION_TIMEOUT_MS),
        });
      } catch {
        // Impression delivery is best-effort after the visible message.
      }
    }
  } catch {
    // Hooks must always preserve the host client's successful Stop path.
  }
  return 0;
};
