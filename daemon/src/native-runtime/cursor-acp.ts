/**
 * Cursor ACP bridge — executes a `cursor` hop through the OFFICIAL
 * `cursor-agent acp` runtime (Agent Client Protocol v1). Cursor has NO manual
 * HTTP inference path (api2.cursor.sh is a dashboard host, not a model
 * endpoint), so this bridge is the provider's ONLY transport.
 *
 * Protocol facts VERIFIED LIVE against `cursor-agent 2026.07.23-e383d2b`:
 * newline-delimited JSON-RPC 2.0 over stdio (WITH the `"jsonrpc":"2.0"`
 * field, unlike the Codex app-server); flow per turn:
 *
 *   initialize            → { protocolVersion: 1, clientCapabilities, clientInfo }
 *   authenticate          → { methodId: "cursor_login" } (the CLI's own stored
 *                           login — fails when not logged in → bridge decline)
 *   session/new           → { cwd, mcpServers } → { sessionId, models:
 *                           { availableModels: [{ modelId, name }] }, modes }
 *                           (mcpServers carries the per-request loopback HTTP
 *                           MCP server exposing CLIENT tools — see
 *                           cursor-mcp-server.ts)
 *   session/set_model     → { sessionId, modelId } (explicit pin; rejection
 *                           declines before submission, never auto routing)
 *   session/prompt        → { sessionId, prompt: [{ type: "text", text },
 *                           { type: "image", data, mimeType }...] };
 *                           resolves with { stopReason } when the turn ENDS
 *   session/update NOTIF  → { sessionId, update: { sessionUpdate:
 *                           "agent_message_chunk" | "agent_thought_chunk",
 *                           content: { type: "text", text } } } (plus
 *                           tool_call / plan / info updates — Cursor's NATIVE
 *                           agent tools; never surfaced as OpenAI tool_calls)
 *   session/cancel NOTIF  → { sessionId } on client abort / tool cutover
 *
 * v1 scope: one COLD ACP session per request (the conversation is flattened
 * by `cursorRequestOf`; the run result's `sessionId()` is always null so the
 * session store records nothing). Serves text + images + structured output +
 * CLIENT function tools:
 *   - images ride as ACP image prompt blocks (base64 + mimeType);
 *   - structured output is a prompt-embedded instruction + local JSON
 *     extraction of the buffered reply (no protocol channel exists);
 *   - client tools ride the loopback MCP server; the FIRST agent tools/call
 *     ends the turn with OpenAI `tool_calls` semantics (session cancelled,
 *     client executes and resends with tool-role results, which the renderer
 *     folds back in). Correct OpenAI semantics at the cost of a cold session
 *     per tool round — the documented v1 tradeoff.
 * TODO(cursor-resume): prefix-hash session resume via ACP `session/load`
 * (`loadSession: true` is advertised) — follow-up, not v1.
 *
 * ACP reports NO token usage; the terminal chunk carries a `chars/4`
 * ESTIMATE (`estimateBodyTokens`, the walker's own routing ruler) so the
 * recorder gets non-zero figures instead of silent zeros.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TChatCompletionChunk, TUsage } from "@openllmsh/protocol";
import { estimateBodyTokens } from "@openllmsh/wire/lib/canonical/token-estimate";
import { spawnCwd } from "../delegation/util";
import { logInfo, safeDiagnosticMessage } from "../logger";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { DAEMON_VERSION } from "../version";
import { declinedForNonOkCapturedResponse } from "./claude-capture";
import type {
  TCursorCaptureBridge,
  TCursorTransactionSender,
} from "./cursor-capture";
import {
  CursorCaptureDecodeError,
  chunksStreamFromCursorConnectResponseBody,
  defaultCursorCaptureSender,
  forwardCursorKvControlThroughBuilder,
  forwardCursorMcpStateExecThroughBuilder,
  forwardCursorRequestContextThroughBuilder,
  isCursorHttp2Envelope,
  openCursorCaptureBridge,
  openCursorCapturedHttp2Session,
  runCursorCapturedTransaction,
  settleCursorCaptureViaAcpCancel,
} from "./cursor-capture";
import {
  cursorExecServerFailure,
  decodeAgentServerMessage,
  encodeConnectEnvelope,
  resolveConnectEnvelopePayload,
  takeConnectEnvelopesStrict,
} from "./cursor-capture-decode";
import type { TCursorNativeImageAsset } from "./cursor-image-assets";
import {
  cleanupCursorImageProjectDir,
  collectJailedCursorImages,
  cursorImageJailOf,
  provenancePathsOf,
} from "./cursor-image-assets";
import {
  cursorImageToolEnforcement,
  handleCursorImageServerRequest,
  isCursorGenerateImageTool,
} from "./cursor-image-permissions";
import type { TCursorMcpServer } from "./cursor-mcp-server";
import { startCursorMcpServer } from "./cursor-mcp-server";
import {
  cursorNativeModelGeneration,
  observeCursorNativeModelsFromSession,
  parseCursorListAvailableModels,
  takeCursorNativeModelObservationTicket,
} from "./cursor-model-observation";
import type { TCursorImage, TCursorTool } from "./cursor-request";
import { acpPromptBlocks, extractJsonObject } from "./cursor-request";
import type { TCaptureDestinationPolicy } from "./request-capture";
import type { TNativeRunResult } from "./types";
import {
  captureOwnershipFromSession,
  cleanNativeSpawnEnv,
  PRE_COMMIT_TIMEOUT_MS,
} from "./types";

export type {
  TCursorCaptureBridge,
  TCursorCaptureChildEnv,
} from "./cursor-capture";
export {
  buildCursorCaptureChildEnv,
  CURSOR_AGENT_DEFAULT_ORIGIN,
  CURSOR_AGENT_STATIC_ORIGINS,
  CURSOR_DYNAMIC_AGENT_HOST_RE,
  classifyCursorOutboundRequest,
  cursorCaptureDestinationPolicy,
  defaultCursorCaptureSender,
  isCursorAgentServiceInferencePath,
  isCursorBridgeRequestCaptureEnabled,
  isCursorHttp2Envelope,
  isCursorOwnedHostname,
  isOfficialCursorAgentCaptureUrl,
  materializeCursorCapturePreload,
  openCursorCaptureBridge,
  runCursorCapturedTransaction,
  sendCursorCapturedEnvelope,
  sendCursorCapturedHttp2,
  settleCursorCaptureViaAcpCancel,
} from "./cursor-capture";

/**
 * Merge a capture bridge's child env into an AcpClient spawn env.
 * No-op when bridge is null — today's path unchanged.
 */
export const applyCursorCaptureBridgeEnv = (
  env: Record<string, string>,
  bridge: TCursorCaptureBridge | null,
): Record<string, string> => {
  if (bridge === null) return env;
  return {
    ...env,
    ...bridge.childEnv,
  };
};

/** Handshake RPC budget (initialize / authenticate / session/new). */
const RPC_TIMEOUT_MS = 30_000;

type TAcpErrorKind = "rpc" | "timeout" | "transport";

/** Typed ACP request failure so setup declines can tell an explicit
 *  authenticate rejection from a timeout/crash/transport drop. */
class AcpRpcError extends Error {
  readonly method: string;
  readonly kind: TAcpErrorKind;
  readonly rpcCode: number | undefined;

  constructor(opts: {
    readonly method: string;
    readonly kind: TAcpErrorKind;
    readonly message: string;
    readonly rpcCode?: number;
  }) {
    super(opts.message);
    this.name = "AcpRpcError";
    this.method = opts.method;
    this.kind = opts.kind;
    this.rpcCode = opts.rpcCode;
  }
}

/** Vendor JSON-RPC authenticate errors that mean the stored login was
 *  rejected — not a timeout, child exit, or generic protocol failure. */
const AUTHENTICATE_REJECTION_RE =
  /not logged in|not signed in|unauthorized|unauthenticated|authentication (?:failed|rejected)|auth(?:entication)? rejected|please (?:log|sign)[\s-]?in/i;

const isExplicitAuthenticateRejection = (error: unknown): boolean =>
  error instanceof AcpRpcError &&
  error.method === "authenticate" &&
  error.kind === "rpc" &&
  AUTHENTICATE_REJECTION_RE.test(error.message);

/** Hard per-turn budget — the prompt is abandoned (child killed) past this. */
export const CURSOR_TURN_TIMEOUT_MS = 180_000;
/** Idle-chunk budget — no session/update within this window kills the turn. */
export const CURSOR_IDLE_TIMEOUT_MS = 60_000;

type TJsonRpcId = number;

/** One inbound JSON-RPC frame (response or notification). */
export type TAcpInbound = {
  readonly id?: TJsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
};

/**
 * Parse one newline-delimited frame. Malformed lines (non-JSON stdout noise,
 * non-object values) return null — the pump skips them, never crashes.
 */
export const parseAcpLine = (line: string): TAcpInbound | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as TAcpInbound;
  } catch {
    return null;
  }
};

/** The text payload of a `session/update` content block, or null. */
const updateText = (content: unknown): string | null => {
  if (typeof content !== "object" || content === null) return null;
  const c = content as { readonly type?: unknown; readonly text?: unknown };
  return c.type === "text" && typeof c.text === "string" ? c.text : null;
};

/**
 * The per-turn chunk mapper: `session/update` payloads → canonical chunks.
 * `agent_message_chunk` → content deltas (with the role-opener on first
 * output); `agent_thought_chunk` → `reasoning_content` deltas (the canonical
 * delta models reasoning natively — see `protocol/chat.ts`); everything else
 * (tool_call, plan, info updates) is ignored in v1.
 *
 * Two non-text modes reshape the tail:
 *   - JSON mode (`response_format` json_object / json_schema): visible content
 *     is BUFFERED (not streamed) and `finish` emits ONE content chunk with the
 *     first balanced JSON object extracted from the reply (raw text on
 *     extraction failure — never errors).
 *   - Tool mode: the loopback MCP server calls `emitToolCall`, which yields an
 *     OpenAI `tool_calls` delta + a `finish_reason: "tool_calls"` terminal.
 *
 * `finish` / `emitToolCall` return chunk ARRAYS (JSON mode needs two).
 * Exported for tests (fabricated sequences).
 */
export type TAcpTurnState = {
  /** Map one `session/update`'s `update` value; null → nothing to emit. */
  readonly handleUpdate: (update: unknown) => TChatCompletionChunk | null;
  /** The terminal chunk(s): estimated usage + finish_reason (+ buffered JSON
   *  content in json mode). */
  readonly finish: (stopReason: string | null) => TChatCompletionChunk[];
  /** The `tool_calls` terminal for one agent tool invocation. */
  readonly emitToolCall: (
    name: string,
    args: unknown,
  ) => TChatCompletionChunk[];
  /** Whether any model OUTPUT (content or thought) was observed. */
  readonly sawOutput: () => boolean;
  /** Accumulated visible content chars (usage estimation input). */
  readonly contentChars: () => number;
};

export const createAcpTurnState = (params: {
  readonly providerModelId: string;
  /** Prompt text fed to the session — the input side of the usage estimate. */
  readonly promptText: string;
  /** Buffer + JSON-extract the reply instead of streaming it. */
  readonly jsonMode?: boolean;
}): TAcpTurnState => {
  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-cursor-${created.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let sawOutput = false;
  let outputChars = 0;
  let thoughtChars = 0;
  let buffered = "";
  const baseChunk = (
    delta: Record<string, unknown>,
    finish: "stop" | "length" | "tool_calls" | null,
    usage?: TUsage,
  ): TChatCompletionChunk =>
    ({
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: params.providerModelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    }) as TChatCompletionChunk;
  // `openerEmitted` tracks the on-WIRE role preamble separately from
  // `sawOutput` (the pre-commit "output is arriving" gate): JSON mode flips
  // `sawOutput` while buffering with nothing on the wire yet, so the first
  // real chunk (from `finish`/`emitToolCall`) must still carry
  // `role: "assistant"`.
  let openerEmitted = false;
  const opener = (
    delta: Record<string, unknown>,
  ): TChatCompletionChunk | null => {
    sawOutput = true;
    if (openerEmitted) return baseChunk(delta, null);
    openerEmitted = true;
    return baseChunk({ role: "assistant", content: "", ...delta }, null);
  };
  const usageRow = (): TUsage => {
    // ACP reports no token counts — ESTIMATE with the walker's own chars/4
    // ruler (marked by construction: prompt side runs through
    // estimateBodyTokens; output side is the accumulated chunk text).
    const promptTokens = estimateBodyTokens(params.promptText);
    const completionTokens = Math.ceil((outputChars + thoughtChars) / 4);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  };
  return {
    handleUpdate: (update) => {
      if (typeof update !== "object" || update === null) return null;
      const u = update as {
        readonly sessionUpdate?: unknown;
        readonly content?: unknown;
      };
      if (u.sessionUpdate === "agent_message_chunk") {
        const text = updateText(u.content);
        if (text === null || text.length === 0) return null;
        outputChars += text.length;
        // JSON mode buffers the whole reply; `finish` emits the extracted
        // object as one content chunk. `sawOutput` still flips so the
        // pre-commit gate commits (output IS arriving, just not on the wire).
        if (params.jsonMode === true) {
          buffered += text;
          sawOutput = true;
          return null;
        }
        return opener({ content: text });
      }
      if (u.sessionUpdate === "agent_thought_chunk") {
        const text = updateText(u.content);
        if (text === null || text.length === 0) return null;
        thoughtChars += text.length;
        if (params.jsonMode === true) {
          sawOutput = true;
          return null;
        }
        return opener({ reasoning_content: text });
      }
      // tool_call / tool_call_update / plan / session_info_update /
      // available_commands_update — ignored in v1 (Cursor's NATIVE agent
      // tools run agent-side; only CLIENT tools via the MCP server surface).
      return null;
    },
    finish: (stopReason) => {
      const terminal = baseChunk(
        {},
        stopReason === "max_tokens" ? "length" : "stop",
        usageRow(),
      );
      if (params.jsonMode !== true) return [terminal];
      const extracted = extractJsonObject(buffered) ?? buffered;
      const content = opener({ content: extracted });
      return content !== null ? [content, terminal] : [terminal];
    },
    emitToolCall: (name, args) => {
      const open = opener({
        tool_calls: [
          {
            index: 0,
            id: `call_${created.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            type: "function",
            function: {
              name,
              arguments:
                typeof args === "string" ? args : JSON.stringify(args ?? {}),
            },
          },
        ],
      });
      const terminal = baseChunk({}, "tool_calls", usageRow());
      return open !== null ? [open, terminal] : [terminal];
    },
    sawOutput: () => sawOutput,
    contentChars: () => outputChars,
  };
};

/**
 * Minimal hand-rolled JSON-RPC 2.0 client over one `cursor-agent acp` child:
 * id counter, pending map, notification handler. One child per use — the
 * caller kills it via `dispose()` when the turn (or the model-list probe)
 * completes. No dependency — ~80 lines beats shipping a protocol package.
 */
class AcpClient {
  private nextId: TJsonRpcId = 1;
  private readonly pending = new Map<
    TJsonRpcId,
    {
      readonly method: string;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly stdin: { write: (s: string) => void; flush?: () => void };
  private disposed = false;
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  readonly rpcCounts: Record<string, number> = {};

  constructor(
    bin: string,
    env: Record<string, string>,
    private readonly onNotification: (method: string, params: unknown) => void,
    /** Handle a server→client REQUEST. Returns the JSON-RPC `result` to send,
     *  or null to refuse with a "not supported" error. Defaults to refusing. */
    private readonly onServerRequest: (
      method: string,
      params: unknown,
    ) => unknown = () => null,
  ) {
    // The ACP bridge reads cursor's isolated macOS keychain credential;
    // securityd denies a Seatbelt-confined caller, so it runs unconfined on
    // macOS (confined on Linux) — `sandbox/policy.ts`.
    this.proc = Bun.spawn(
      sandboxSpawnArgs([bin, "acp"], { probe: unwrapKeychainSpawn("cursor") }),
      {
        stdin: "pipe",
        stdout: "pipe",
        // Native stderr is not a safe diagnostic channel (may contain secrets).
        stderr: "ignore",
        cwd: spawnCwd(env),
        env: cleanNativeSpawnEnv(env),
      },
    );
    this.stdin = this.proc.stdin as unknown as {
      write: (s: string) => void;
      flush?: () => void;
    };
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>).then(
      () => this.failAllPending("cursor-agent acp stdout closed"),
      () => this.failAllPending("cursor-agent acp stdout failed"),
    );
    void this.proc.exited.then(() => {
      clearTimeout(this.cancelTimer);
      this.failAllPending("cursor-agent acp exited");
    });
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    this.rpcCounts[method] = (this.rpcCounts[method] ?? 0) + 1;
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new AcpRpcError({
              method,
              kind: "timeout",
              message: `cursor-agent acp ${method} timed out`,
            }),
          );
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new AcpRpcError({
            method,
            kind: "transport",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // child gone — dispose path handles it
    }
  }

  /** Give the native prompt its cancellation response before killing it.
   * The guard bounds teardown only, never successful turn completion. */
  cancelAndDispose(sessionId: string): void {
    if (this.disposed || this.cancelTimer !== undefined) return;
    this.notify("session/cancel", { sessionId });
    this.cancelTimer = setTimeout(() => this.dispose(), 1_000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.cancelTimer);
    this.failAllPending("cursor-agent acp disposed");
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // already exited
    }
  }

  private failAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.reject(
        new AcpRpcError({
          method: entry.method,
          kind: "transport",
          message: reason,
        }),
      );
    }
    this.pending.clear();
  }

  private send(message: Record<string, unknown>): void {
    if (this.disposed) throw new Error("cursor-agent acp not running");
    this.stdin.write(`${JSON.stringify(message)}\n`);
    this.stdin.flush?.();
  }

  private async pump(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = parseAcpLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message !== null) this.route(message);
      }
    }
  }

  private route(message: TAcpInbound): void {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (this.cancelTimer !== undefined && entry.method === "session/prompt") {
        this.dispose();
      }
      if (message.error !== undefined) {
        entry.reject(
          new AcpRpcError({
            method: entry.method,
            kind: "rpc",
            message: message.error.message ?? "cursor-agent acp error",
            ...(typeof message.error.code === "number"
              ? { rpcCode: message.error.code }
              : {}),
          }),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }
    // Server→client REQUEST. Permission asks / question prompts are answered
    // (auto-approve / empty) so the agent never blocks; fs reads and anything
    // else the handler declines get a "not supported" error.
    if (message.id !== undefined && message.method !== undefined) {
      const result = this.onServerRequest(message.method, message.params);
      try {
        this.send(
          result !== null
            ? { jsonrpc: "2.0", id: message.id, result }
            : {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "not supported by openllmd" },
              },
        );
      } catch {
        // child gone
      }
      return;
    }
    // Notification.
    if (message.method !== undefined) {
      this.onNotification(message.method, message.params);
    }
  }
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "openllm-daemon", version: DAEMON_VERSION },
} as const;

/** `initialize` + `authenticate` (the CLI's own stored login). Throws on
 *  failure — the caller maps it to a bridge decline / null model list.
 *
 *  NB: the agent advertises `promptCapabilities.image` at initialize, but it's
 *  a STATIC protocol capability (always true for current cursor-agent), NOT
 *  per-model — so it can't gate images by the selected model. Verified live
 *  (2026-07-29): composer-2.5 reads image blocks correctly (blue→"blue",
 *  green→"green"); the models accept `{ type:"image", data, mimeType }` blocks
 *  as-is. So we send images unconditionally and let the model handle them. */
const handshake = async (
  client: AcpClient,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<void> => {
  await client.request("initialize", INIT_PARAMS, timeoutMs);
  await client.request("authenticate", { methodId: "cursor_login" }, timeoutMs);
};

/** Native error bodies and stderr may include prompts, paths or credentials. */
const acpFailureMessage = (error: unknown): string => {
  if (isExplicitAuthenticateRejection(error)) {
    return "cursor ACP authenticate rejected the stored login";
  }
  if (error instanceof AcpRpcError) {
    return `cursor ACP ${error.method} ${
      error.kind === "timeout"
        ? "timed out"
        : error.kind === "transport"
          ? "transport failed"
          : "request rejected"
    }`;
  }
  return "cursor ACP setup failed";
};

const setupDecline = (
  error: unknown,
  signal: AbortSignal,
): TNativeRunResult => {
  if (signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  return {
    kind: "declined",
    reason: acpFailureMessage(error),
    ...(isExplicitAuthenticateRejection(error)
      ? { cooldownReason: "auth" as const }
      : {}),
  };
};

/**
 * Server→client request handler: auto-approve permission asks (Cursor's
 * native agent tools run agent-side under our auto-approval — we advertise
 * fs/terminal off and never block) and answer `cursor/ask_question`
 * immediately so the agent never stalls. Everything else → null (refused).
 */
export const handleCursorServerRequest = (
  method: string,
  params: unknown,
): unknown => {
  if (method === "session/request_permission") {
    const options = (
      params as {
        readonly options?: ReadonlyArray<{
          readonly optionId?: unknown;
          readonly kind?: unknown;
        }>;
      }
    )?.options;
    const pick =
      (Array.isArray(options)
        ? (options.find((o) => o.kind === "allow_always") ??
          options.find((o) => o.kind === "allow_once"))
        : undefined) ?? undefined;
    const optionId =
      typeof pick?.optionId === "string" ? pick.optionId : "allow-always";
    logInfo("native-runtime", "cursor auto-approving permission request", {
      optionId,
    });
    return { outcome: { outcome: "selected", optionId } };
  }
  if (method === "cursor/ask_question") {
    const questions = (
      params as {
        readonly questions?: ReadonlyArray<{
          readonly options?: ReadonlyArray<{ readonly value?: unknown }>;
        }>;
      }
    )?.questions;
    logInfo("native-runtime", "cursor auto-answering ask_question", {});
    const answers = Array.isArray(questions)
      ? questions.map((q) => {
          const first = Array.isArray(q.options) ? q.options[0] : undefined;
          return typeof first?.value === "string" ? first.value : "";
        })
      : [];
    return { answers };
  }
  return null;
};

/** Read-first model pin. Prefer an exact advertised id when listed; bare
 * catalog ids accept a native variant only when that exact id is absent.
 * Explicitly bracketed selections must match exactly. A rejected pin never
 * submits a prompt on auto. ACP set_model acknowledges application with `{}`;
 * unlike Muse it has no model-read RPC to call afterwards. */
const ensureCursorModel = async (
  client: AcpClient,
  sessionId: string,
  providerModelId: string,
  sessionResult: unknown,
  timeoutMs: number,
): Promise<void> => {
  const requested = providerModelId.trim();
  if (requested === "auto" || requested === "default") return;
  const matches = (value: unknown): value is string =>
    typeof value === "string" &&
    (requested.includes("[")
      ? value === requested
      : value.split("[")[0] === requested);
  const models = (
    sessionResult as {
      readonly models?: {
        readonly currentModelId?: unknown;
        readonly availableModels?: ReadonlyArray<{
          readonly modelId?: unknown;
        }>;
      };
    } | null
  )?.models;
  const available = models?.availableModels;
  const exact = available?.find((model) => model.modelId === requested);
  // Skip set_model only when already on the pin we would choose: exact
  // current always wins; a base-id variant current is enough only when no
  // exact advertised id exists (otherwise prefer the exact pin).
  if (requested.length > 0) {
    if (models?.currentModelId === requested) return;
    if (exact === undefined && matches(models?.currentModelId)) return;
  }
  const match = exact ?? available?.find((model) => matches(model.modelId));
  const modelId =
    typeof match?.modelId === "string" ? match.modelId : requested;
  await client.request("session/set_model", { sessionId, modelId }, timeoutMs);
};

export type TCursorNativeParams = {
  /** Absolute path to the isolated cursor-agent binary (`cliBin("cursor")`). */
  readonly bin: string;
  /** Isolated run env (`cliEnv("cursor")`), merged onto process.env. */
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  /** System prompt — prepended to the rendered prompt (ACP has no separate
   *  system channel on `session/prompt`). Null when the client sent none. */
  readonly systemText: string | null;
  /** The rendered conversation text (seed or single turn) to feed. */
  readonly userText: string;
  /** Inbound image parts, forwarded as ACP image prompt blocks. */
  readonly images?: ReadonlyArray<TCursorImage>;
  /** Client function tools, exposed via the loopback MCP server. The FIRST
   *  agent `tools/call` ends the turn with OpenAI `tool_calls` semantics. */
  readonly tools?: ReadonlyArray<TCursorTool>;
  /** Structured output: append the JSON instruction, buffer the reply, and
   *  emit the extracted JSON object as the single content chunk. */
  readonly jsonInstructionText?: string | null;
  readonly signal: AbortSignal;
  /** Test overrides for the three deadlines. */
  readonly precommitMs?: number;
  readonly idleMs?: number;
  readonly turnTimeoutMs?: number;
  /** Test override for handshake RPC timeout. */
  readonly rpcTimeoutMs?: number;
  /**
   * Optional request-capture bridge (default off / omit). When set, the child
   * spawn receives the preload + IPC env. Omitting this preserves today's ACP
   * path exactly.
   */
  readonly captureBridge?: TCursorCaptureBridge | null;
  /**
   * When true with `captureBridge`, serve owns waitForTransaction / dispatch /
   * settle / dispose. ACP only injects the preload env and must NOT cancel the
   * builder before companions are collected or dispose the bridge.
   */
  readonly serveOwnedCapture?: boolean;
};

/**
 * Run one COLD ACP turn: spawn → handshake → session/new → exact model
 * pin → session/prompt, streaming `session/update` chunks until the prompt
 * response (stopReason) ends the turn. Commit-on-first-output; every
 * pre-commit failure declines (the walker advances the plan — cursor has no
 * manual transport). The child is killed on completion, abort, and both
 * timeouts (hard 180s turn / 60s idle).
 */
export const runCursorNative = async (
  params: TCursorNativeParams,
): Promise<TNativeRunResult> => {
  // Generation is captured at request entry, before the vendor child or MCP
  // server exists, so a logout during spawn/handshake cannot be stamped as
  // the current account when session/new later returns.
  const observationGeneration = cursorNativeModelGeneration();
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "cursor-agent CLI not installed" };
  }

  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  const startedAt = performance.now();
  const phases: Record<string, number> = {};
  const mark = (phase: string): void => {
    phases[phase] ??=
      Math.round((performance.now() - startedAt) * 1_000) / 1_000;
  };
  type TQueueItem = TChatCompletionChunk | "end" | { readonly error: Error };
  const queue: TQueueItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: TQueueItem): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };

  const jsonMode =
    params.jsonInstructionText !== undefined &&
    params.jsonInstructionText !== null;
  const promptText =
    (params.systemText !== null
      ? `${params.systemText}\n\n${params.userText}`
      : params.userText) + (jsonMode ? (params.jsonInstructionText ?? "") : "");
  const turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
    jsonMode,
  });

  let sessionId: string | null = null;
  let ended = false;
  let cleaned = false;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let lastActivityAt = Date.now();
  const endWith = (
    chunks: ReadonlyArray<TChatCompletionChunk>,
    outcome: "completed" | "tool_handoff",
  ): void => {
    if (ended) return;
    ended = true;
    for (const chunk of chunks) push(chunk);
    push("end");
    report(outcome);
    cleanup(outcome === "tool_handoff");
  };
  const failStream = (error: Error): void => {
    if (ended) return;
    ended = true;
    push({ error });
    report(error.name === "AbortError" ? "aborted" : "failed");
    cleanup(true);
  };

  // Client tools ride an ephemeral loopback MCP server. The FIRST agent
  // tools/call cuts the turn over to OpenAI tool_calls semantics: emit the
  // tool_calls delta + finish_reason "tool_calls", cancel the ACP session,
  // and let the client execute the tool + resend with tool-role results
  // (folded back in by cursorRequestOf) — one cold session per tool round.
  let mcp: TCursorMcpServer | null = null;
  const stopMcp = (): void => {
    mcp?.stop();
    mcp = null;
  };

  // `client` is created FIRST so the MCP server's onToolCall never closes over
  // it before initialization (a tools/call can only arrive after session/new,
  // which needs `client` — but declaring it first makes that ordering explicit
  // rather than relying on it).
  const captureBridge = params.captureBridge ?? null;
  const spawnEnv = applyCursorCaptureBridgeEnv(params.env, captureBridge);

  let client: AcpClient;
  try {
    mark("spawn_started_ms");
    client = new AcpClient(
      params.bin,
      spawnEnv,
      (method, p) => {
        if (method !== "session/update" || ended) return;
        const notif = p as
          | { readonly sessionId?: unknown; readonly update?: unknown }
          | undefined;
        if (sessionId === null || notif?.sessionId !== sessionId) return;
        lastActivityAt = Date.now();
        const chunk = turn.handleUpdate(notif.update);
        if (turn.sawOutput()) mark("first_output_ms");
        if (chunk !== null) push(chunk);
      },
      handleCursorServerRequest,
    );
  } catch (error) {
    return setupDecline(error, params.signal);
  }

  // Capture bridge: serve-owned mode only injects preload env — serve runs
  // waitForTransaction → dispatch → settle after the final BidiAppend is
  // buffered so the ACP builder is not cancelled mid-construction. Legacy
  // auto mode (tests without serve) still waits then settles/cancels locally.
  // Never feed the true model stream back into the vendor child.
  const serveOwnedCapture = params.serveOwnedCapture === true;
  let pendingCaptureCancel: {
    readonly method: string;
    readonly externalUrl: string;
  } | null = null;
  const runCaptureAcpCancel = (args: {
    readonly method: string;
    readonly externalUrl: string;
  }): void => {
    settleCursorCaptureViaAcpCancel({
      settlement: {
        kind: "suppressed",
        reason: `captured ${args.method} ${args.externalUrl}`,
      },
      cancelSession: () => {
        if (sessionId !== null) client.cancelAndDispose(sessionId);
      },
    });
  };
  if (captureBridge !== null && !serveOwnedCapture) {
    void captureBridge
      .waitForTransaction()
      .then((tx) => {
        mark("capture_offered_ms");
        captureBridge.settleChild({
          kind: "suppressed",
          reason:
            "original AgentService + BidiAppend sends suppressed; daemon owns the transaction",
        });
        if (sessionId !== null) {
          runCaptureAcpCancel({
            method: tx.primary.method,
            externalUrl: tx.primary.externalUrl,
          });
        } else {
          pendingCaptureCancel = {
            method: tx.primary.method,
            externalUrl: tx.primary.externalUrl,
          };
        }
      })
      .catch(() => {
        // Timeout / cancel / dispose — cleanup path owns the rest.
      });
  }

  const report = (
    outcome: "completed" | "tool_handoff" | "failed" | "aborted",
  ): void => {
    mark("terminal_ms");
    logInfo(
      "native-runtime",
      safeDiagnosticMessage`cursor native turn phase timings`,
      {
        provider: "cursor",
        clock: "performance.now",
        outcome,
        // All marks are offsets from request entry, not separate durations.
        ...phases,
        rpc_counts: { ...client.rpcCounts },
      },
    );
  };
  const cleanup = (cancel: boolean): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(idleTimer);
    params.signal.removeEventListener("abort", abort);
    if (cancel && sessionId !== null) client.cancelAndDispose(sessionId);
    else client.dispose();
    stopMcp();
    // Serve-owned capture disposes the bridge after the daemon response stream
    // completes — ACP must not tear it down while companions may still arrive.
    if (captureBridge !== null && !serveOwnedCapture) {
      void captureBridge.dispose();
    }
  };
  const abort = (): void => {
    failStream(new DOMException("client aborted", "AbortError"));
  };
  params.signal.addEventListener("abort", abort, { once: true });
  if (params.signal.aborted) {
    abort();
    return { kind: "declined", reason: "client aborted" };
  }

  // ── Handshake + session ────────────────────────────────────────────
  const rpcTimeoutMs = params.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  const failSetup = (error: unknown): TNativeRunResult => {
    if (!ended) {
      ended = true;
      report(params.signal.aborted ? "aborted" : "failed");
    }
    cleanup(false);
    return setupDecline(error, params.signal);
  };
  try {
    if ((params.tools?.length ?? 0) > 0) {
      mcp = startCursorMcpServer({
        tools: params.tools ?? [],
        onRequest: (method) => mark(`mcp_${method.replaceAll("/", "_")}_ms`),
        onToolCall: (name, args) => {
          if (ended) return;
          mark("first_output_ms");
          endWith(turn.emitToolCall(name, args), "tool_handoff");
        },
      });
    }
    await client.request("initialize", INIT_PARAMS, rpcTimeoutMs);
    mark("initialized_ms");
    await client.request(
      "authenticate",
      { methodId: "cursor_login" },
      rpcTimeoutMs,
    );
    mark("authenticated_ms");
  } catch (error) {
    return failSetup(error);
  }
  const observationTicket = takeCursorNativeModelObservationTicket(
    params.env,
    observationGeneration,
  );
  let opened: unknown;
  try {
    opened = await client.request(
      "session/new",
      {
        // A daemon-owned, empty cwd — the isolated cursor home (spawnCwd already
        // pins the child's process cwd there too), never the user's project.
        // Empty also bounds what Cursor's NATIVE fs tools can see.
        cwd: spawnCwd(params.env),
        // Client tools ride the ephemeral loopback MCP server (see above).
        mcpServers:
          mcp !== null
            ? [
                {
                  type: "http",
                  name: "openllm-client-tools",
                  url: mcp.url,
                  headers: mcp.headers,
                },
              ]
            : [],
      },
      rpcTimeoutMs,
    );
  } catch (error) {
    return failSetup(error);
  }
  const sid = (opened as { readonly sessionId?: unknown } | null)?.sessionId;
  if (typeof sid !== "string" || sid.length === 0) {
    return failSetup(
      new AcpRpcError({
        method: "session/new",
        kind: "rpc",
        message: "missing sessionId",
      }),
    );
  }
  sessionId = sid;
  mark("session_ready_ms");
  if (pendingCaptureCancel !== null) {
    const pending = pendingCaptureCancel;
    pendingCaptureCancel = null;
    runCaptureAcpCancel(pending);
  }
  if (observationTicket !== null) {
    observeCursorNativeModelsFromSession({
      ticket: observationTicket,
      env: params.env,
      sessionResult: opened,
    });
  }
  try {
    if (params.signal.aborted)
      throw new DOMException("client aborted", "AbortError");
    await ensureCursorModel(
      client,
      sid,
      params.providerModelId,
      opened,
      rpcTimeoutMs,
    );
    if (params.signal.aborted)
      throw new DOMException("client aborted", "AbortError");
  } catch (error) {
    return failSetup(error);
  }

  mark("model_ready_ms");
  // ── The prompt turn ────────────────────────────────────────────────
  lastActivityAt = Date.now();
  mark("prompt_submitted_ms");
  const turnBudget = params.turnTimeoutMs ?? CURSOR_TURN_TIMEOUT_MS;
  const promptDone = client
    .request(
      "session/prompt",
      {
        sessionId,
        prompt: acpPromptBlocks(promptText, params.images ?? []),
      },
      turnBudget,
    )
    .then((result) => {
      if (ended) return;
      mark("native_terminal_ms");
      const stop = (result as { readonly stopReason?: unknown } | null)
        ?.stopReason;
      if (stop === "cancelled") {
        failStream(new Error("cursor native turn cancelled"));
      } else if (
        stop !== "end_turn" &&
        stop !== "max_tokens" &&
        stop !== "max_turn_requests" &&
        stop !== "refusal"
      ) {
        failStream(
          new Error("cursor native turn returned an invalid terminal"),
        );
      } else if (!turn.sawOutput() || (jsonMode && turn.contentChars() === 0)) {
        failStream(new Error("cursor turn ended before producing output"));
      } else {
        endWith(turn.finish(stop), "completed");
      }
    })
    .catch((error: unknown) => {
      failStream(new Error(acpFailureMessage(error)));
    });
  void promptDone;

  // Idle-chunk watchdog: no session/update (or terminal) within the idle
  // budget kills the turn. The hard turn budget rides the RPC timeout above.
  const idleBudget = params.idleMs ?? CURSOR_IDLE_TIMEOUT_MS;
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt > idleBudget) {
      failStream(new Error("cursor native turn idle timeout"));
    }
  }, 1_000);

  const nextItem = async (): Promise<TQueueItem> => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  // ── Pre-commit: first output, terminal, or deadline ─────────────────
  // JSON mode buffers the reply (no chunk reaches the queue until `finish`),
  // so a deadline hit with output ALREADY OBSERVED (`sawOutput`) keeps
  // waiting — the model is generating, the wire is just deliberately quiet;
  // the idle watchdog + turn budget still bound the wait.
  let first: TQueueItem | "timeout";
  const pendingFirst = nextItem();
  for (;;) {
    let precommitTimer: ReturnType<typeof setTimeout> | undefined;
    first = await Promise.race([
      pendingFirst,
      new Promise<"timeout">((resolve) => {
        precommitTimer = setTimeout(
          () => resolve("timeout"),
          params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(precommitTimer);
    if (first === "timeout" && turn.sawOutput()) continue;
    break;
  }
  if (first === "timeout") {
    failStream(
      new Error("cursor ACP produced no output before the pre-commit deadline"),
    );
    return {
      kind: "declined",
      reason: "cursor ACP produced no output before the pre-commit deadline",
    };
  }
  if (first === "end" || "error" in first) {
    cleanup(true);
    return {
      kind: "declined",
      reason:
        first === "end"
          ? "cursor turn ended before producing output"
          : first.error.message,
    };
  }

  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const next = await nextItem();
      if (next === "end") {
        controller.close();
      } else if ("error" in next) {
        controller.error(next.error);
      } else {
        controller.enqueue(next);
      }
    },
    cancel() {
      abort();
    },
  });
  // Cold sessions in v1 — never record a resumable id (see module header).
  return { kind: "committed", chunks, sessionId: () => null };
};

export type TCursorNativeCaptureParams = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly systemText: string | null;
  readonly userText: string;
  readonly images?: ReadonlyArray<TCursorImage>;
  readonly tools?: ReadonlyArray<TCursorTool>;
  readonly jsonInstructionText?: string | null;
  readonly signal: AbortSignal;
  readonly precommitMs?: number;
  readonly idleMs?: number;
  readonly turnTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  /**
   * Production omits → {@link defaultCursorCaptureSender} (HTTP/2 via
   * `node:http2`, HTTP/1 via fetch). Injected senders are tests only.
   */
  readonly sender?: TCursorTransactionSender;
  /**
   * Hermetic tests may inject a fake ACP runner that still goes through the
   * capture preload / Connect offer path. Production omits → {@link runCursorNative}.
   */
  readonly runAcp?: (params: TCursorNativeParams) => Promise<TNativeRunResult>;
  /**
   * CodeRabbit round 2: production must NEVER default to loopback-allowed
   * capture destinations. Omitted here → {@link openCursorCaptureBridge}'s
   * own STRICT default (official Cursor hosts only). Hermetic local tests
   * that dispatch against a `127.0.0.1` fake upstream pass
   * `cursorCaptureDestinationPolicy({ allowLoopback: true })` explicitly —
   * this is a test-only override, never a production relaxation.
   */
  readonly destinationPolicy?: TCaptureDestinationPolicy;
};

/**
 * Official Cursor bridge-capture runner: spawn the vendor ACP builder with the
 * capture preload, collect the opaque RunSSE + BidiAppend transaction (builder
 * not cancelled until companions are buffered), dispatch each exact RPC once,
 * stream Connect→chunks to the CALLER, then settle/cancel the builder locally.
 * Never feeds the true model stream back into ACP.
 */
const CURSOR_CAPTURE_ERROR_OPTIONS = {
  provider: "cursor",
  providerFormat: "openai",
} as const;

export const runCursorNativeCapture = async (
  params: TCursorNativeCaptureParams,
): Promise<TNativeRunResult> => {
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "cursor-agent CLI not installed" };
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }

  const bridge = await openCursorCaptureBridge({
    signal: params.signal,
    captureTimeoutMs: params.precommitMs ?? 60_000,
    destinationPolicy: params.destinationPolicy,
  });
  const builderAbort = new AbortController();
  const builderSignal = AbortSignal.any([params.signal, builderAbort.signal]);
  const runAcp = params.runAcp ?? runCursorNative;
  // Always decorate env here so injected hermetic `runAcp` implementations
  // still receive the preload + IPC socket (they may not call
  // applyCursorCaptureBridgeEnv themselves).
  const captureEnv = applyCursorCaptureBridgeEnv(params.env, bridge);
  const acpPromise = runAcp({
    bin: params.bin,
    env: captureEnv,
    providerModelId: params.providerModelId,
    systemText: params.systemText,
    userText: params.userText,
    images: params.images,
    tools: params.tools,
    jsonInstructionText: params.jsonInstructionText,
    signal: builderSignal,
    precommitMs: params.precommitMs,
    idleMs: params.idleMs,
    turnTimeoutMs: params.turnTimeoutMs,
    rpcTimeoutMs: params.rpcTimeoutMs,
    captureBridge: bridge,
    serveOwnedCapture: true,
  });
  void acpPromise.catch(() => {});

  let dispatchStarted = false;
  try {
    // CodeRabbit round 3: `runAcp` can decline FAST (auth failure, missing
    // CLI, immediate vendor exit) — e.g. `{ kind: "declined", cooldownReason:
    // "auth" }` resolved well before any transaction is ever captured. The
    // previous code discarded that entirely (`void acpPromise.catch(() =>
    // {})` only guards against an unhandled REJECTION) and unconditionally
    // waited out the full `waitForTransaction` timeout, then declined with a
    // generic "no output" reason — losing the real cooldown attribution and
    // stalling for up to 30s on a process that had already exited. Race the
    // two: an early ACP decline/rejection wins immediately and its
    // cooldownReason/message is preserved; the normal happy path (a
    // transaction arrives first) is unaffected.
    // A single, shared transaction-wait promise — reused below if the ACP
    // side settles first with something other than an early decline, so we
    // never issue a second/duplicate `waitForTransaction` call.
    const transactionPromise = bridge.waitForTransaction({
      quietMs: 75,
      maxWaitMs: Math.min(params.precommitMs ?? 60_000, 30_000),
    });
    const raced = await Promise.race([
      transactionPromise.then((tx) => ({ kind: "transaction" as const, tx })),
      acpPromise.then(
        (result) =>
          result.kind === "declined"
            ? ({ kind: "acp_declined" as const, result } as const)
            : ({ kind: "acp_settled_other" as const } as const),
        (err: unknown) => ({ kind: "acp_error" as const, err }) as const,
      ),
    ]);
    if (raced.kind === "acp_declined") {
      // No dispatch was ever attempted — nothing touched upstream. Save
      // ownership BEFORE disposing (dispose tears down the session this
      // reads from), then release the bridge's socket/temp-file resources
      // and signal the builder abort — every other return path here does
      // both; this early-decline race must too, not just skip cleanup
      // because nothing was ever dispatched.
      const ownership = captureOwnershipFromSession(bridge.session);
      builderAbort.abort();
      try {
        await bridge.dispose();
      } catch {
        // ignore — best-effort cleanup
      }
      return {
        ...raced.result,
        captureOwnership: ownership,
      };
    }
    if (raced.kind === "acp_error") {
      const ownership = captureOwnershipFromSession(bridge.session);
      builderAbort.abort();
      try {
        await bridge.dispose();
      } catch {
        // ignore — best-effort cleanup
      }
      return {
        kind: "declined",
        reason:
          raced.err instanceof Error ? raced.err.message : String(raced.err),
        captureOwnership: ownership,
      };
    }
    // `acp_settled_other` (acpPromise resolved "committed" — unexpected in
    // bridge-capture mode, since the builder's own send is meant to be
    // captured rather than streamed through ACP directly) falls through to
    // await the SAME `transactionPromise` already in flight — no behavior
    // change from before this fix for that edge case, and no duplicate
    // `waitForTransaction` call.
    const tx =
      raced.kind === "transaction" ? raced.tx : await transactionPromise;

    const captureId = bridge.lastCaptureId();

    let ownershipAtAccept: ReturnType<typeof captureOwnershipFromSession>;

    if (isCursorHttp2Envelope(tx.primary) && params.sender === undefined) {
      // Production H2 path: keep builder alive for allowlisted request_context.
      if (captureId === null) {
        throw new Error("missing primary capture id for duplex bridge");
      }
      // Only from here on has a real dispatch actually begun — a missing
      // capture id above is a pure local validation failure with zero
      // upstream contact, so `dispatchStarted` must stay false for it
      // (CodeRabbit round 3: it was previously set unconditionally right
      // after `waitForTransaction`, before this id check, which would
      // mislabel that validation failure as "uncertain" capture ownership).
      dispatchStarted = true;
      // Rebind as a non-null local — the async generator below closes over
      // this across an `await`, and TS does not retain the `!== null`
      // narrowing of the outer `const` through that closure boundary.
      const nonNullCaptureId: string = captureId;
      bridge.session.markDispatchStarted();
      // Open the REAL upstream H2 session BEFORE settling the child as
      // duplex_bridge, so the negotiated `connect-content-encoding` (if any)
      // is known and can be mirrored onto the synthetic response headers the
      // builder's own Connect client sees. Settling first (as before) meant
      // the builder's client learned no encoding, so a later COMPRESSED
      // injected frame had no algorithm to decode with — a silent hang, not
      // an error (retest #26 root cause).
      const http2 = await openCursorCapturedHttp2Session(
        tx.primary,
        params.signal,
      );
      bridge.session.markUpstreamAccepted();
      ownershipAtAccept = captureOwnershipFromSession(bridge.session);
      if (!http2.response.ok) {
        try {
          return await declinedForNonOkCapturedResponse(
            http2.response,
            params.signal,
            CURSOR_CAPTURE_ERROR_OPTIONS,
          );
        } finally {
          http2.close();
          builderAbort.abort();
          await bridge.dispose();
        }
      }
      if (http2.response.body === null) {
        http2.close();
        builderAbort.abort();
        await bridge.dispose();
        return {
          kind: "declined",
          reason: "cursor capture upstream returned an empty body",
          captureOwnership: ownershipAtAccept,
        };
      }
      const connectContentEncoding = http2.response.headers.get(
        "connect-content-encoding",
      );
      bridge.settleChild({
        kind: "duplex_bridge",
        reason:
          "HTTP/2 capture open for allowlisted request_context duplex; daemon owns inference",
        connectContentEncoding,
      });
      // Peel leading Connect envelopes; bridge request_context_args, then
      // decode remaining envelopes INCREMENTALLY (never buffer-then-decode —
      // that made the ONLY way to finish the turn "wait for the H2 socket to
      // close", and this long-lived native stream does not close on its own
      // after model output ends). The Connect `endStream` envelope (spec:
      // "the final Enveloped-Message... must appear last") is the ONE
      // genuine native completion marker; plain reader EOF without ever
      // seeing it — whether from a real close or from OUR OWN
      // `reader.cancel()` on caller abort resolving a pending read with
      // `{done:true}` — must never be treated as success. That exact
      // cancel()-masks-as-clean-EOF race produced retest #30's fabricated
      // `finish_reason:"stop"`/0-token completion at the caller's abort
      // deadline: the check for `params.signal.aborted` ran only BEFORE each
      // `reader.read()` call, never immediately after one resolved, so an
      // abort that fired while blocked inside `read()` was indistinguishable
      // from a real clean close.
      const reader = http2.response.body.getReader();
      let pending = new Uint8Array(0);
      let contextBridged = false;
      // Verified generic-exec-loop behavior: `stream_close` is written
      // unconditionally after EVERY exec result — not just request_context
      // — so a queued one can reference ANY earlier completed control
      // exchange (request_context OR mcp_state_exec, including a prior one
      // in a batch of several). Tracks EVERY completed exchange's numeric
      // id (never just the most recent — a single "latest wins" scalar
      // would incorrectly reject a still-valid stream_close for an OLDER
      // completed exchange once a newer one has also completed) for exact
      // correlation; never used to relax/guess an unknown id. Fed into both
      // KV and mcp_state_exec forward calls.
      const completedControlExecNumericIds = new Set<number>();
      let sawModelOutput = false;
      // Metadata-only diagnostics (never payload/args/content) so a stuck
      // phase is identifiable from the decline reason alone.
      let phase:
        | "awaiting_first_frame"
        | "context_handshake"
        | "post_context_wait"
        | "model_stream"
        | "done" = "awaiting_first_frame";
      let framesSeen = 0;
      let execFramesSeen = 0;
      let modelFramesSeen = 0;
      let endStreamFramesSeen = 0;
      // Per-kind counters for frames that carry no model output — added so a
      // frame-count mismatch (e.g. live retest #32's 36 total frames vs the
      // 9 accounted for by exec/model/endStream) can be attributed to a
      // specific decoded kind without another live capture. Metadata-only:
      // counts and bounded reason/tag strings, never prompts/args/payload.
      let heartbeatFramesSeen = 0;
      let ignoredFramesSeen = 0;
      let requiresDuplexFramesSeen = 0;
      let nativeToolFramesSeen = 0;
      // KV control (AgentServerMessage.kv_server_message, field 4) counts —
      // metadata only, never the blob id/data bytes.
      let kvGetFramesSeen = 0;
      let kvSetFramesSeen = 0;
      // `exec_server_message.mcp_state_exec_args` (field 36) relay count —
      // metadata only, never server names/tool schemas/instructions.
      let mcpStateExecFramesSeen = 0;
      // Bounded, deduplicated inventory of `ignored`-kind reasons (each
      // already carries only bounded field-tag metadata — see
      // `describeProtoFieldTags` — never payload/value).
      const MAX_TRACKED_IGNORED_REASONS = 8;
      const ignoredReasonsSeen: string[] = [];
      // `InteractionUpdate.turn_ended` (field 14) is the real native
      // turn-completion marker the official client relies on — it is
      // authoritative independent of the Connect transport `endStream`
      // envelope. Once observed, a subsequent transport close/reset is
      // benign (mirrors the official client's own "Ignoring transport close
      // after terminal agent stream" behavior) rather than a failure.
      let turnEndedSeen = false;
      const diagSnapshot = (): string =>
        `phase=${phase} frames=${framesSeen} exec=${execFramesSeen} model=${modelFramesSeen} endStream=${endStreamFramesSeen} heartbeat=${heartbeatFramesSeen} ignored=${ignoredFramesSeen} requiresDuplex=${requiresDuplexFramesSeen} nativeTool=${nativeToolFramesSeen} kvGet=${kvGetFramesSeen} kvSet=${kvSetFramesSeen} mcpStateExec=${mcpStateExecFramesSeen} turnEnded=${turnEndedSeen} contextBridged=${contextBridged} ignoredReasons=[${ignoredReasonsSeen.join(";")}]`;
      const onAbortDuringPeel = (): void => {
        try {
          reader.cancel().catch(() => undefined);
        } catch {
          // ignore
        }
      };
      params.signal.addEventListener("abort", onAbortDuringPeel, {
        once: true,
      });

      const createdAt = Math.floor(Date.now() / 1000);
      const chunkId = `cursor-capture-${createdAt}`;
      let toolIndex = 0;
      const toolIndexByCallId = new Map<string, number>();
      const ensureToolIndex = (callId: string): number => {
        const existing = toolIndexByCallId.get(callId);
        if (existing !== undefined) return existing;
        const next = toolIndex;
        toolIndexByCallId.set(callId, next);
        toolIndex += 1;
        return next;
      };
      // Only tool NAMES the caller itself registered for this turn may ever
      // be handed off as a successful `exec_server_message.mcp_args` — an
      // unregistered name still fails closed via `cursorExecServerFailure`,
      // never a generic/blanket approval.
      const registeredToolNames = new Set(
        (params.tools ?? []).map((tool) => tool.name),
      );
      // `InteractionUpdate.partial_tool_call` / `tool_call_started` can
      // stream a call's arguments incrementally as raw, possibly-INCOMPLETE
      // JSON fragments (fine on its own — the caller reconstructs by
      // concatenation). But the SAME call id can also later receive an
      // AUTHORITATIVE, complete `exec_server_message.mcp_args` map (live
      // retest #37's shape). The two must never both reach the caller:
      // streaming the partial fragments AND THEN the full map would either
      // corrupt the concatenated JSON, or — the sharper bug — silently
      // WITHHOLDING the full map (as an earlier fix here mistakenly did)
      // would leave the caller with only a truncated partial fragment
      // treated as a successful, complete tool call.
      //
      // Fix: buffer partial argument text per call id here WITHOUT ever
      // yielding it to the caller. Only once (a) an authoritative
      // `mcp_args` arrives for that id, emit ONE complete tool_calls delta
      // with the real decoded arguments — the buffered partial is simply
      // discarded, since the authoritative source is strictly better; or
      // (b) the turn ends with no authoritative `mcp_args` ever arriving
      // for a buffered call, flush its buffered text once as a best-effort
      // delta (preserves the ordinary MCP-tool-only flow, which has no
      // second exchange at all).
      // Bound both the number of distinct buffered calls and the total
      // buffered text — a hostile/corrupt stream that keeps sending partial
      // fragments with no authoritative resolution and no terminal must not
      // be able to grow this buffer without limit.
      const MAX_PENDING_MCP_TOOL_CALLS = 32;
      const MAX_PENDING_MCP_ARGS_BYTES = 64 * 1024;
      let pendingMcpArgsBytes = 0;
      const pendingMcpToolCalls = new Map<
        string,
        {
          readonly name: string;
          readonly index: number;
          argsText: string;
          /**
           * True once this call's `argsText` is already a COMPLETE,
           * schema-confirmed map (from a `mcp_tool_started` that carried a
           * full args map — see `decodeCursorMcpArgs`/`parseMcpArgs`).
           * Once true, further `mcp_tool_partial` fragments for the SAME
           * call id must never be concatenated onto it — that would corrupt
           * otherwise-valid JSON into garbage (round 9 review). Normal
           * fragment-only accumulation (seeded empty, appended by partials)
           * is unaffected — this flag stays false for that case throughout.
           */
          complete: boolean;
        }
      >();
      const bufferMcpToolCallUpdate = (
        callId: string,
        name: string,
        argsTextDelta: string,
        isCompleteSeed: boolean,
      ): void => {
        const existing = pendingMcpToolCalls.get(callId);
        if (
          existing === undefined &&
          pendingMcpToolCalls.size >= MAX_PENDING_MCP_TOOL_CALLS
        ) {
          throw new CursorCaptureDecodeError(
            "invalid_protobuf",
            `pending MCP tool call count exceeds ${MAX_PENDING_MCP_TOOL_CALLS}`,
          );
        }
        if (existing?.complete === true) {
          // Already a complete, authoritative-shaped map — silently ignore
          // any further fragment; never append onto it.
          return;
        }
        pendingMcpArgsBytes += argsTextDelta.length;
        if (pendingMcpArgsBytes > MAX_PENDING_MCP_ARGS_BYTES) {
          throw new CursorCaptureDecodeError(
            "invalid_protobuf",
            `pending MCP tool call argument bytes exceed ${MAX_PENDING_MCP_ARGS_BYTES}`,
          );
        }
        if (existing !== undefined) {
          existing.argsText = isCompleteSeed
            ? argsTextDelta
            : existing.argsText + argsTextDelta;
          existing.complete = isCompleteSeed;
          return;
        }
        pendingMcpToolCalls.set(callId, {
          name,
          index: ensureToolIndex(callId),
          argsText: argsTextDelta,
          complete: isCompleteSeed,
        });
      };
      /**
       * Flush every still-pending (never authoritatively resolved) MCP tool
       * call — called ONLY at a genuine turn terminal, never mid-turn. Live
       * retest #38 review: this previously yielded each pending entry's raw
       * `name`/`argsText` completely unvalidated — an unregistered name, or
       * argument text that never finished as a complete JSON object (e.g. a
       * lone `{"token":` fragment when no authoritative `mcp_args` ever
       * arrived before the terminal), could reach the caller as an
       * apparently-successful tool call. Fix: validate EVERY pending entry
       * — registered name AND parses as one complete JSON value — BEFORE
       * yielding ANY of them. A single invalid entry fails the whole flush
       * closed (never a partial success, never a fabricated `"{}"`
       * stand-in); only once every pending entry is verified valid does any
       * of them get yielded, and each yields its own real, already-complete
       * buffered JSON text unchanged.
       */
      function* flushPendingMcpToolCalls(): Generator<TChatCompletionChunk> {
        if (pendingMcpToolCalls.size === 0) return;
        const verified: Array<{
          readonly callId: string;
          readonly name: string;
          readonly index: number;
          readonly argsText: string;
        }> = [];
        for (const [callId, pending] of pendingMcpToolCalls) {
          if (!registeredToolNames.has(pending.name)) {
            throw new CursorCaptureDecodeError(
              "unsupported_native_tool_intent",
              `pending MCP tool call ${callId} name is not in the caller's registered tools`,
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(pending.argsText);
          } catch {
            throw new CursorCaptureDecodeError(
              "invalid_protobuf",
              `pending MCP tool call ${callId} arguments never completed as valid JSON`,
            );
          }
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            throw new CursorCaptureDecodeError(
              "invalid_protobuf",
              `pending MCP tool call ${callId} arguments did not decode to a JSON object`,
            );
          }
          verified.push({
            callId,
            name: pending.name,
            index: pending.index,
            argsText: pending.argsText,
          });
        }
        // Stable index order — explicit, not relied on implicitly from Map
        // insertion order.
        verified.sort((a, b) => a.index - b.index);
        for (const entry of verified) {
          yield {
            ...baseChunk(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: entry.index,
                      id: entry.callId,
                      type: "function",
                      function: {
                        name: entry.name,
                        arguments: entry.argsText,
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
        pendingMcpToolCalls.clear();
        pendingMcpArgsBytes = 0;
      }
      const baseChunk = (): Pick<
        TChatCompletionChunk,
        "id" | "object" | "created" | "model"
      > => ({
        id: chunkId,
        object: "chat.completion.chunk",
        created: createdAt,
        model: params.providerModelId,
      });

      // Async generator: yields ONE canonical chunk at a time as real
      // Connect envelopes decode, stopping ONLY on a genuine `endStream`
      // marker (throwing on abort / protocol error / missing terminal — NEVER
      // synthesizing a finish chunk from a plain closed/cancelled reader).
      // Tear the builder down ONLY on a genuine terminal signal (turn_ended /
      // endStream) — never on the first model token, which would close the
      // duplex inject path before a later real KV control round-trip (or
      // interaction_query) could ever use it.
      const teardownBuilderOnTerminal = (): void => {
        bridge.closeDuplexInject(nonNullCaptureId);
        settleCursorCaptureViaAcpCancel({
          settlement: {
            kind: "suppressed",
            reason: "cursor capture reached a genuine native terminal",
          },
          cancelSession: () => {
            builderAbort.abort();
          },
        });
      };
      async function* stepChunks(): AsyncGenerator<TChatCompletionChunk> {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (params.signal.aborted) {
              throw new DOMException(
                `client aborted (${diagSnapshot()})`,
                "AbortError",
              );
            }
            if (done) {
              if (turnEndedSeen) {
                // A real native turn_ended marker already arrived; the
                // transport closing afterward (no Connect endStream) is
                // benign, not a failure — matches the official client.
                phase = "done";
                teardownBuilderOnTerminal();
                // Genuine turn terminal reached with no authoritative
                // `mcp_args` ever arriving for some buffered call(s) — flush
                // their buffered text once, as a whole, rather than
                // silently dropping them.
                yield* flushPendingMcpToolCalls();
                yield {
                  ...baseChunk(),
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason:
                        toolIndexByCallId.size > 0 ? "tool_calls" : "stop",
                    },
                  ],
                };
                return;
              }
              throw new Error(
                `cursor capture upstream closed without a terminal Connect end-stream marker or turn_ended (${diagSnapshot()})`,
              );
            }
            const next = new Uint8Array(pending.byteLength + value.byteLength);
            next.set(pending, 0);
            next.set(value, pending.byteLength);
            // Strict: `pending` accumulates across repeated live reads, so an
            // oversized declared length must fail the instant its 5-byte
            // header is visible — never be tolerated as "incomplete" while
            // this buffer keeps growing (CodeRabbit round 2).
            const taken = takeConnectEnvelopesStrict(next);
            pending = new Uint8Array(taken.rest);
            for (const env of taken.envelopes) {
              framesSeen += 1;
              if (env.endStream) {
                endStreamFramesSeen += 1;
                const trailerPayload = resolveConnectEnvelopePayload(
                  env,
                  connectContentEncoding,
                );
                const raw = new TextDecoder().decode(trailerPayload);
                if (raw.length > 0 && raw !== "{}") {
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(raw);
                  } catch {
                    throw new CursorCaptureDecodeError(
                      "connect_end_stream_error",
                      `invalid Connect end-stream JSON (${diagSnapshot()})`,
                    );
                  }
                  if (
                    typeof parsed === "object" &&
                    parsed !== null &&
                    "error" in parsed &&
                    (parsed as { error?: unknown }).error != null
                  ) {
                    const errVal = (parsed as { error: unknown }).error;
                    const msg =
                      typeof errVal === "object" &&
                      errVal !== null &&
                      typeof (errVal as { message?: unknown }).message ===
                        "string"
                        ? (errVal as { message: string }).message
                        : JSON.stringify(errVal);
                    throw new CursorCaptureDecodeError(
                      "connect_end_stream_error",
                      msg,
                    );
                  }
                }
                // Genuine native completion marker — finish now. Do not wait
                // for the socket to close; per Connect spec this is always
                // the last message on the stream.
                phase = "done";
                teardownBuilderOnTerminal();
                if (sawModelOutput) {
                  yield* flushPendingMcpToolCalls();
                  yield {
                    ...baseChunk(),
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason:
                          toolIndexByCallId.size > 0 ? "tool_calls" : "stop",
                      },
                    ],
                  };
                }
                return;
              }
              // Inspect a decompressed COPY only; never mutate `env.payload`.
              const inspectPayload = resolveConnectEnvelopePayload(
                env,
                connectContentEncoding,
              );
              const decoded = decodeAgentServerMessage(inspectPayload);
              if (
                decoded.kind === "exec_server" &&
                decoded.subtype === "request_context_args"
              ) {
                execFramesSeen += 1;
                phase = "context_handshake";
                if (contextBridged) {
                  throw new CursorCaptureDecodeError(
                    "requires_duplex_bridge",
                    `unexpected second request_context_args (${diagSnapshot()})`,
                    {
                      execSubtype: decoded.subtype,
                      execClass: decoded.classification,
                    },
                  );
                }
                // Forward the EXACT original envelope (preserve compression
                // flag + bytes) into the builder — never a re-encoded/
                // rewritten copy of the control frame.
                const contextForward =
                  await forwardCursorRequestContextThroughBuilder({
                    captureBridge: bridge,
                    captureId: nonNullCaptureId,
                    http2,
                    serverExecEnvelope: encodeConnectEnvelope(
                      env.payload,
                      env.flags,
                    ),
                    connectContentEncoding,
                    signal: params.signal,
                    // Empty at call time today (request_context is the
                    // first control exchange processed per capture); kept
                    // symmetric with the KV and mcp_state_exec call sites.
                    knownControlExecNumericIds: completedControlExecNumericIds,
                  });
                if (contextForward.contextExecNumericId !== null) {
                  completedControlExecNumericIds.add(
                    contextForward.contextExecNumericId,
                  );
                }
                contextBridged = true;
                phase = "post_context_wait";
                continue;
              }
              if (
                decoded.kind === "exec_server" &&
                decoded.subtype === "mcp_state_exec_args"
              ) {
                // Real benchmark evidence: `mcp_state_exec_args` (field 36,
                // verified native schema `McpStateExecArgs { server_identifiers
                // repeated string, kick_only bool }` → `McpStateExecResult
                // { success | error | rejected }`) was previously rejected
                // outright via the generic protocol_control failure. It is a
                // genuine list/kick MCP-servers control query — never a tool
                // call, never model output — so it is relayed exactly like
                // request_context/KV: inject the EXACT original bytes into
                // the still-live builder, wait for its own authoritative
                // reply, forward those exact bytes upstream. Never decode or
                // report server names/tool schemas/instructions anywhere
                // (opaque relay only), never fabricate a state reply, and —
                // unlike request_context — legitimately repeatable within one
                // turn (e.g. a batch of server queries), so no "already
                // bridged" guard here.
                execFramesSeen += 1;
                mcpStateExecFramesSeen += 1;
                const stateForward =
                  await forwardCursorMcpStateExecThroughBuilder({
                    captureBridge: bridge,
                    captureId: nonNullCaptureId,
                    http2,
                    serverExecEnvelope: encodeConnectEnvelope(
                      env.payload,
                      env.flags,
                    ),
                    connectContentEncoding,
                    signal: params.signal,
                    knownControlExecNumericIds: completedControlExecNumericIds,
                  });
                if (stateForward.completedExecNumericId !== null) {
                  completedControlExecNumericIds.add(
                    stateForward.completedExecNumericId,
                  );
                }
                continue;
              }
              if (decoded.kind === "turn_ended") {
                // The real native turn-completion marker
                // (`InteractionUpdate.turn_ended`, field 14) — authoritative
                // independent of Connect transport `endStream`. Finish now;
                // do not keep waiting on the socket (the official client
                // itself stops here and treats any later transport
                // close/error as benign).
                turnEndedSeen = true;
                phase = "done";
                teardownBuilderOnTerminal();
                yield* flushPendingMcpToolCalls();
                yield {
                  ...baseChunk(),
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason:
                        toolIndexByCallId.size > 0 ? "tool_calls" : "stop",
                    },
                  ],
                  ...(decoded.inputTokens !== null ||
                  decoded.outputTokens !== null
                    ? {
                        usage: {
                          prompt_tokens: decoded.inputTokens ?? 0,
                          completion_tokens: decoded.outputTokens ?? 0,
                          total_tokens:
                            (decoded.inputTokens ?? 0) +
                            (decoded.outputTokens ?? 0),
                        },
                      }
                    : {}),
                };
                return;
              }
              if (decoded.kind === "exec_server") {
                execFramesSeen += 1;
                if (
                  decoded.classification === "caller_mcp_tool" &&
                  decoded.mcp !== null &&
                  registeredToolNames.has(decoded.mcp.name)
                ) {
                  // Verified native schema: `exec_server_message.mcp_args`
                  // handing a tool call to the CALLER is a real, complete
                  // exchange — not an error condition. Emit the tool_calls
                  // delta (with the fully decoded, real arguments — never
                  // fabricated), then a genuine successful `tool_calls`
                  // terminal, and gracefully tear the builder down. Never
                  // forward mcp_args into the builder, never execute the
                  // tool natively — execution is entirely the caller's own
                  // responsibility once it receives this response. Only a
                  // NAME the caller itself registered for this turn may take
                  // this path; anything else still falls through to the
                  // fail-closed `cursorExecServerFailure` below.
                  const intent = decoded.mcp;
                  const callId = intent.callId || `exec-${decoded.id ?? 0}`;
                  // Independent-review fix: this branch used to emit ONLY
                  // this one call id then return immediately — silently
                  // dropping any OTHER tool call already declared in
                  // parallel via `mcp_tool_partial`/`mcp_tool_started`
                  // (buffered in `pendingMcpToolCalls`) that hadn't yet
                  // received its own authoritative exchange. A turn ending
                  // in `finish_reason: "tool_calls"` implies ALL of this
                  // turn's tool calls are included — reporting only a
                  // subset is a silent-loss bug, not a valid partial
                  // success.
                  //
                  // Fix: this authoritative map always overrides this call
                  // id's own buffered entry (never the reverse), then EVERY
                  // still-pending call — this one included — is validated
                  // and emitted together via the same all-or-nothing
                  // `flushPendingMcpToolCalls` path used at the natural
                  // turn terminal: every entry must be a registered name
                  // with complete, valid JSON before ANY of them is
                  // yielded; one incomplete/unregistered OTHER call fails
                  // the whole turn closed rather than reporting a partial
                  // batch success.
                  if (
                    !pendingMcpToolCalls.has(callId) &&
                    pendingMcpToolCalls.size >= MAX_PENDING_MCP_TOOL_CALLS
                  ) {
                    throw new CursorCaptureDecodeError(
                      "invalid_protobuf",
                      `pending MCP tool call count exceeds ${MAX_PENDING_MCP_TOOL_CALLS}`,
                    );
                  }
                  pendingMcpToolCalls.set(callId, {
                    name: intent.name,
                    index: ensureToolIndex(callId),
                    argsText: intent.argumentsText,
                    complete: true,
                  });
                  phase = "done";
                  teardownBuilderOnTerminal();
                  yield* flushPendingMcpToolCalls();
                  yield {
                    ...baseChunk(),
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: "tool_calls",
                      },
                    ],
                  };
                  return;
                }
                throw cursorExecServerFailure({
                  id: decoded.id,
                  execId: decoded.execId,
                  subtype: decoded.subtype,
                  classification: decoded.classification,
                  mcp: decoded.mcp,
                });
              }
              if (decoded.kind === "kv_server") {
                // Independent-reviewer-verified: `AgentServerMessage.kv_server_message`
                // (field 4) is a real human/tool/service-facing native
                // protocol, not inert bookkeeping — a genuine
                // ControlledKvManager get/set round-trip against the live
                // builder's own blobStore. Keep the builder alive across
                // this (never torn down on first model token) and relay ONLY
                // the exact known get/set envelope unchanged; the real reply
                // bytes come back from the builder untouched — the daemon
                // never fabricates a cache miss/write ack, never reads the
                // blob id/data, and never invents/changes the captured model
                // request. `tracing`/`unknown` KV subtypes are not relayed —
                // they fail closed the same as any other unsupported case.
                if (decoded.subtype === "get_blob") {
                  kvGetFramesSeen += 1;
                } else if (decoded.subtype === "set_blob") {
                  kvSetFramesSeen += 1;
                }
                await forwardCursorKvControlThroughBuilder({
                  captureBridge: bridge,
                  captureId: nonNullCaptureId,
                  http2,
                  serverKvEnvelope: encodeConnectEnvelope(
                    env.payload,
                    env.flags,
                  ),
                  connectContentEncoding,
                  signal: params.signal,
                  knownControlExecNumericIds: completedControlExecNumericIds,
                });
                continue;
              }
              if (decoded.kind === "requires_duplex") {
                // Independent-review fix: the H2 duplex path previously had
                // no branch for this case (unlike the HTTP1 decode paths),
                // so an `AgentServerMessage.interaction_query` (field 7) or
                // `exec_server_control_message` (field 5) was silently
                // dropped by falling through the if-chain, leaving the loop
                // to just `read()` again forever — a real message the daemon
                // has no safe response for, hanging until the caller's
                // abort deadline. Fail closed immediately instead, with
                // bounded messageCase/subtype/tag metadata only (never
                // payload) so the exact unhandled case is diagnosable.
                requiresDuplexFramesSeen += 1;
                throw new CursorCaptureDecodeError(
                  "requires_duplex_bridge",
                  `AgentServerMessage.${decoded.messageCase} requires client duplex follow-up; no-execution bridge not active (${decoded.tags}; ${diagSnapshot()})`,
                  {
                    execSubtype: decoded.execSubtype,
                    execClass: decoded.execClass,
                  },
                );
              }
              if (decoded.kind === "text_delta" && decoded.text.length > 0) {
                sawModelOutput = true;
                modelFramesSeen += 1;
                phase = "model_stream";
                yield {
                  ...baseChunk(),
                  choices: [
                    {
                      index: 0,
                      delta: { content: decoded.text },
                      finish_reason: null,
                    },
                  ],
                };
              } else if (
                decoded.kind === "thinking_delta" &&
                decoded.text.length > 0
              ) {
                sawModelOutput = true;
                modelFramesSeen += 1;
                phase = "model_stream";
                yield {
                  ...baseChunk(),
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: decoded.text },
                      finish_reason: null,
                    },
                  ],
                };
              } else if (
                decoded.kind === "mcp_tool_partial" ||
                decoded.kind === "mcp_tool_started"
              ) {
                sawModelOutput = true;
                modelFramesSeen += 1;
                phase = "model_stream";
                const intent = decoded.intent;
                // Round 9 review: `mcp_tool_started` can ALREADY carry a
                // COMPLETE args map (verified schema — see
                // `parseMcpArgs`/`decodeCursorMcpArgs`), not just an empty
                // placeholder. Seed the buffer with that complete map
                // directly (never discard it as `""`) and mark it complete
                // so a later `mcp_tool_partial` fragment for the SAME call
                // id is never concatenated onto it — that would corrupt
                // otherwise-valid JSON. A `started` with NO complete args
                // (the ordinary case) still seeds an empty, non-complete
                // buffer, preserving normal fragment-only accumulation.
                const isCompleteSeed =
                  decoded.kind === "mcp_tool_started" &&
                  intent.argumentsText.length > 0;
                const argsDelta =
                  decoded.kind === "mcp_tool_partial"
                    ? decoded.argsTextDelta
                    : intent.argumentsText;
                // Buffer WITHOUT emitting — never yield a partial/possibly
                // truncated argument fragment to the caller. See
                // `pendingMcpToolCalls` above: an authoritative
                // `exec_server_message.mcp_args` (if one arrives for this
                // call id) replaces this buffered text entirely; otherwise
                // it is flushed once, as a whole, at the genuine turn
                // terminal.
                bufferMcpToolCallUpdate(
                  intent.callId,
                  intent.name,
                  argsDelta,
                  isCompleteSeed,
                );
              } else if (decoded.kind === "heartbeat") {
                heartbeatFramesSeen += 1;
              } else if (decoded.kind === "native_tool") {
                // Metadata-only count — never relabels/forwards the native
                // tool intent; production still fails closed elsewhere if
                // the caller ever needs to act on it.
                nativeToolFramesSeen += 1;
              } else if (decoded.kind === "ignored") {
                ignoredFramesSeen += 1;
                if (
                  ignoredReasonsSeen.length < MAX_TRACKED_IGNORED_REASONS &&
                  !ignoredReasonsSeen.includes(decoded.reason)
                ) {
                  ignoredReasonsSeen.push(decoded.reason);
                }
              }
              // Independent-reviewer-verified fix: the builder used to be
              // cancelled here — as soon as the FIRST model token arrived —
              // which closed the duplex inject path before a later, real KV
              // control round-trip (or interaction_query) could ever use it,
              // producing exactly retest #32/#33's silent gap (frames
              // counted but never answered). The builder now stays alive
              // until a genuine terminal signal: `turn_ended` / Connect
              // `endStream` (below), a thrown error, or the caller
              // cancelling — never on first model output. Model output/tool
              // calls are still never written back into the builder; only
              // known control replies (request_context_result, KV get/set
              // results) are ever forwarded to it.
            }
          }
        } finally {
          params.signal.removeEventListener("abort", onAbortDuringPeel);
        }
      }

      const iterator = stepChunks();
      const precommitMs = params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS;
      let precommitTimer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        iterator.next().then(
          (r) =>
            r.done
              ? ({ kind: "exit" } as const)
              : ({ kind: "meaningful", chunk: r.value } as const),
          (err: unknown) => ({ kind: "error", err }) as const,
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          precommitTimer = setTimeout(
            () => resolve({ kind: "timeout" }),
            precommitMs,
          );
        }),
      ]);
      clearTimeout(precommitTimer);

      if (first.kind !== "meaningful") {
        // Round 9 review: on a precommit TIMEOUT specifically, `stepChunks()`
        // is quite possibly still blocked inside `await reader.read()` on
        // the real H2 socket — that pending read is WHY nothing arrived
        // before the deadline. `iterator.return()` only takes effect the
        // NEXT time the generator actually resumes, which never happens
        // until that pending read itself settles — so the previous
        // `await iterator.return(undefined)` here could hang FOREVER
        // waiting on a read that will never resolve on its own. Fix: close
        // the real H2 session and cancel the reader FIRST — this is what
        // actually unblocks the pending read — then request iterator
        // cleanup fire-and-forget (never awaited; a caught rejection is
        // fine, an unbounded hang here is not). Bridge/builder cleanup and
        // ownership reporting are unchanged.
        http2.close();
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // ignore — reader may already be released/cancelled
        }
        void iterator.return(undefined).catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        bridge.closeDuplexInject(captureId);
        builderAbort.abort();
        await bridge.dispose();
        if (first.kind === "timeout") {
          return {
            kind: "declined",
            reason: `cursor capture produced no output before the pre-commit deadline (${diagSnapshot()})`,
            captureOwnership: ownershipAtAccept,
          };
        }
        if (first.kind === "exit") {
          return {
            kind: "declined",
            reason: contextBridged
              ? "cursor capture completed request_context but produced no model output"
              : "cursor capture produced no output",
            captureOwnership: ownershipAtAccept,
          };
        }
        // first.kind === "error"
        const err = first.err;
        const isAbort =
          params.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        return {
          kind: "declined",
          reason: err instanceof Error ? err.message : String(err),
          captureOwnership: isAbort
            ? ownershipAtAccept === "none"
              ? "accepted"
              : ownershipAtAccept
            : ownershipAtAccept,
        };
      }

      const firstChunk = first.chunk;
      const out = new ReadableStream<TChatCompletionChunk>({
        start(controller) {
          controller.enqueue(firstChunk);
        },
        async pull(controller) {
          let step: IteratorResult<TChatCompletionChunk>;
          try {
            step = await iterator.next();
          } catch (err) {
            controller.error(
              err instanceof Error ? err : new Error(String(err)),
            );
            try {
              reader.releaseLock();
            } catch {
              // ignore
            }
            http2.close();
            builderAbort.abort();
            void bridge.dispose();
            return;
          }
          if (step.done) {
            controller.close();
            try {
              reader.releaseLock();
            } catch {
              // ignore
            }
            http2.close();
            // CodeRabbit round 2: every OTHER terminal path here (iterator
            // error, stream cancel) aborts the builder; this natural-close
            // path did not. In the common case `teardownBuilderOnTerminal()`
            // already aborted it synchronously inside the generator before
            // yielding the final chunk, so this is idempotent — but it is
            // the defensive backstop if a future terminal branch inside
            // `stepChunks()` ever returns without going through that
            // teardown, so the builder process can never be left running.
            builderAbort.abort();
            void bridge.dispose();
            return;
          }
          controller.enqueue(step.value);
        },
        cancel() {
          void iterator.return(undefined).catch(() => undefined);
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
          http2.close();
          builderAbort.abort();
          void bridge.dispose();
        },
      });
      return {
        kind: "committed",
        chunks: out,
        sessionId: () => null,
      };
    }

    // HTTP/1 (and injected sender) path — existing single-shot dispatch.
    // `dispatchStarted` is set immediately before the actual dispatch call —
    // never earlier — for the same reason as the H2 branch above: anything
    // that could still throw before this point (id/shape validation) is a
    // pure local failure with zero upstream contact and must report
    // ownership "none", not "uncertain".
    dispatchStarted = true;
    const sender = params.sender ?? defaultCursorCaptureSender;
    const dispatched = await runCursorCapturedTransaction({
      session: bridge.session,
      transaction: tx,
      sender,
      signal: params.signal,
    });
    bridge.settleChild({
      kind: "suppressed",
      reason:
        "original AgentService + BidiAppend sends suppressed; daemon owns the transaction",
    });
    settleCursorCaptureViaAcpCancel({
      settlement: {
        kind: "suppressed",
        reason: `captured ${tx.primary.method} ${tx.primary.externalUrl}`,
      },
      cancelSession: () => {
        builderAbort.abort();
      },
    });

    if (!dispatched.response.ok) {
      try {
        return await declinedForNonOkCapturedResponse(
          dispatched.response,
          params.signal,
          CURSOR_CAPTURE_ERROR_OPTIONS,
        );
      } finally {
        await bridge.dispose();
      }
    }
    if (dispatched.response.body === null) {
      const ownership = captureOwnershipFromSession(bridge.session);
      await bridge.dispose();
      return {
        kind: "declined",
        reason: "cursor capture upstream returned an empty body",
        captureOwnership: ownership,
      };
    }

    ownershipAtAccept = captureOwnershipFromSession(bridge.session);
    const decodeStream = chunksStreamFromCursorConnectResponseBody(
      dispatched.response.body,
      { providerModelId: params.providerModelId, signal: params.signal },
    );
    const reader = decodeStream.getReader();
    let first: TChatCompletionChunk | null = null;
    try {
      const { value, done } = await reader.read();
      if (!done && value !== undefined) first = value;
    } catch (err) {
      builderAbort.abort();
      await bridge.dispose();
      if (
        err instanceof CursorCaptureDecodeError &&
        (err.code === "requires_duplex_bridge" ||
          err.code === "requires_request_context_duplex" ||
          err.code === "unsupported_native_tool_intent" ||
          err.code === "unsupported_native_exec" ||
          err.code === "caller_mcp_tool_cancel")
      ) {
        return {
          kind: "declined",
          reason: err.message,
          // Upstream already accepted — never fall through to another provider.
          captureOwnership:
            ownershipAtAccept === "none" ? "accepted" : ownershipAtAccept,
        };
      }
      return {
        kind: "declined",
        reason: err instanceof Error ? err.message : String(err),
        captureOwnership: ownershipAtAccept,
      };
    }
    if (first === null) {
      builderAbort.abort();
      await bridge.dispose();
      return {
        kind: "declined",
        reason: "cursor capture produced no output",
        captureOwnership: ownershipAtAccept,
      };
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      builderAbort.abort();
      void bridge.dispose();
    };

    const out = new ReadableStream<TChatCompletionChunk>({
      start(controller) {
        controller.enqueue(first);
      },
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            release();
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          release();
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      },
      cancel() {
        void reader.cancel();
        release();
      },
    });

    return {
      kind: "committed",
      chunks: out,
      sessionId: () => null,
    };
  } catch (err) {
    builderAbort.abort();
    const ownership = captureOwnershipFromSession(bridge.session);
    try {
      await bridge.dispose();
    } catch {
      // ignore
    }
    void acpPromise;
    if (dispatchStarted && ownership === "none") {
      return {
        kind: "declined",
        reason: err instanceof Error ? err.message : String(err),
        captureOwnership: "uncertain",
      };
    }
    return {
      kind: "declined",
      reason: err instanceof Error ? err.message : String(err),
      captureOwnership: ownership === "none" ? undefined : ownership,
    };
  }
};

/**
 * Manual `listModels` only: a short-lived ACP session whose
 * `cursor/list_available_models` request returns `{ models: [{ value, name }] }`
 * (VERIFIED LIVE). Auto `discoverModels` must not call this — it reads native
 * observations captured on an already-authorized inference session. Null on
 * ANY failure (not installed / not logged in / protocol drift).
 */
export const listCursorModelsViaAcp = async (params: {
  readonly bin: string;
  readonly env: Record<string, string>;
}): Promise<ReadonlyArray<{ value: string; name: string | null }> | null> => {
  if (!existsSync(params.bin)) return null;
  const client = new AcpClient(params.bin, params.env, () => {
    // notifications are irrelevant to the model-list probe
  });
  try {
    await handshake(client);
    const opened = await client.request("session/new", {
      cwd: spawnCwd(params.env),
      mcpServers: [],
    });
    const sid = (opened as { readonly sessionId?: unknown }).sessionId;
    if (typeof sid !== "string") return null;
    const listed = await client.request("cursor/list_available_models", {
      sessionId: sid,
    });
    return parseCursorListAvailableModels(listed);
  } catch {
    return null;
  } finally {
    client.dispose();
  }
};

export type { TCursorNativeImageAsset } from "./cursor-image-assets";

export type TCursorNativeImageInput = {
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly precommitMs?: number;
  readonly idleMs?: number;
  readonly turnTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
};

export type TCursorNativeImageUsageEstimate = {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
};

export type TCursorNativeImageResult =
  | {
      readonly kind: "ok";
      readonly assets: ReadonlyArray<TCursorNativeImageAsset>;
      readonly stopReason: string | null;
      /** chars/4 estimate — ACP reports no token usage. */
      readonly estimatedUsage: TCursorNativeImageUsageEstimate;
    }
  | {
      readonly kind: "declined";
      readonly reason: string;
      readonly cooldownReason?: "auth";
    }
  | { readonly kind: "failed"; readonly reason: string };

const IMAGE_PROMPT_PREFIX =
  "Use the native Generate Image tool once. Do not write code, SVG, or other files. Do not run shell commands.\n\n";

const updateKind = (update: unknown): string | null => {
  if (typeof update !== "object" || update === null) return null;
  const u = update as { readonly sessionUpdate?: unknown };
  return typeof u.sessionUpdate === "string" ? u.sessionUpdate : null;
};

/** The `toolCallId` correlating a `tool_call`/`tool_call_update` payload to
 *  its earlier sibling, or null when absent/malformed. Per the ACP spec
 *  (`ToolCallUpdate`), `toolCallId` is the ONLY field a `tool_call_update`
 *  is guaranteed to carry — title/kind/name are "only the ones being
 *  changed" and are routinely omitted on a progress/completion update for a
 *  tool call already announced by an earlier `tool_call`. */
const toolCallIdOf = (update: unknown): string | null => {
  if (typeof update !== "object" || update === null) return null;
  const id = (update as { readonly toolCallId?: unknown }).toolCallId;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/**
 * Native Cursor image generation via ACP session/prompt. Does not call
 * `cursor/generate_image` as a client RPC. Installed cursor-agent
 * (2026.07.23) emits Generate Image `tool_call` updates and typically does
 * NOT send `session/request_permission` for that tool — ACP also has no
 * session-level allowlist (`--allowed-tools` is print-mode only). Image-mode
 * therefore: isolated empty workspace, fs/terminal client caps off, no MCP,
 * deny any identifiable non-image permission ask, cancel if a non-image
 * native tool_call is observed, and collect only provenance paths through a
 * realpath jail. Auto-run of other native tools before we observe an update
 * is an unavoidable runtime limitation, not claimed isolation.
 */
export const runCursorNativeImage = async (
  params: TCursorNativeImageInput,
): Promise<TCursorNativeImageResult> => {
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "cursor-agent CLI not installed" };
  }
  if (params.signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }

  const homeDir = spawnCwd(params.env);
  const workspaceDir = await mkdtemp(join(homeDir, "cursor-img-"));
  const jail = cursorImageJailOf({ workspaceDir, homeDir });
  const promptText = `${IMAGE_PROMPT_PREFIX}${params.prompt}`;
  const estimatedUsage = (): TCursorNativeImageUsageEstimate => {
    const prompt_tokens = estimateBodyTokens(promptText);
    const completion_tokens = Math.ceil(outputChars / 4);
    return {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
    };
  };

  const provenance: string[] = [];
  let sawGenerateImage = false;
  let foreignTool = false;
  let outputChars = 0;
  let sessionId: string | null = null;
  let promptSettled = false;
  let stopReason: string | null = null;
  let lastActivityAt = Date.now();
  let sawActivity = false;
  // The toolCallIds of every Generate Image tool_call already accepted by
  // name (`isCursorGenerateImageTool`) in this turn — lets a later
  // `tool_call_update` for any of THOSE ids be recognized as its
  // continuation even when that update omits every identifying field (see
  // `toolCallIdOf`). A `Set`, not a single last-accepted id: ACP's own spec
  // allows several tool calls to be in flight/interleaved within one turn
  // (a `tool_call` announcement for a second call can arrive before the
  // first one's own completion `tool_call_update`), and the prompt's "use
  // it once" instruction is advisory, not enforced by the protocol. A
  // single-id variable would be overwritten by the SECOND Generate Image
  // announcement, so the FIRST call's later bare completion update (no
  // toolCallId match, no name) would fall through to "foreign tool" and
  // fail the whole run on what is actually a legitimate continuation.
  const acceptedImageToolCallIds = new Set<string>();

  const noteUpdate = (update: unknown): void => {
    lastActivityAt = Date.now();
    const kind = updateKind(update);
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = updateText(
        (update as { readonly content?: unknown }).content,
      );
      if (text !== null) {
        outputChars += text.length;
        sawActivity = true;
      }
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      sawActivity = true;
      const id = toolCallIdOf(update);
      const namedAsImage = isCursorGenerateImageTool(update);
      const isAcceptedContinuation =
        !namedAsImage && id !== null && acceptedImageToolCallIds.has(id);
      if (namedAsImage || isAcceptedContinuation) {
        sawGenerateImage = true;
        if (namedAsImage && id !== null) acceptedImageToolCallIds.add(id);
        provenance.push(...provenancePathsOf(update));
      } else {
        // Fails closed: an update that neither names the Generate Image
        // tool nor correlates by id to an already-accepted one — including
        // one with no toolCallId at all — is treated as foreign, same as
        // before this correlation was added.
        foreignTool = true;
      }
    }
  };

  const client = new AcpClient(
    params.bin,
    params.env,
    (method, p) => {
      if (method === "cursor/generate_image") {
        // Agent→client notification variant (documented; not observed on the
        // installed CLI). Collect provenance; never send this as a client RPC.
        sawGenerateImage = true;
        sawActivity = true;
        lastActivityAt = Date.now();
        provenance.push(...provenancePathsOf(p));
        return;
      }
      if (method !== "session/update") return;
      const notif = p as
        | { readonly sessionId?: unknown; readonly update?: unknown }
        | undefined;
      if (sessionId === null || notif?.sessionId !== sessionId) return;
      noteUpdate(notif.update);
    },
    handleCursorImageServerRequest,
  );

  /** Cancel-then-kill grace: `dispose()` sends SIGTERM immediately, which can
   *  race the child's own event loop reading the just-flushed `session/cancel`
   *  notification off stdin and kill it before it ever sees the message —
   *  silently defeating the one cancellation this path relies on. A short
   *  delay before the kill does not change the bounded-decline guarantees
   *  (callers never await it), it only gives the notify a real chance to
   *  land. */
  const CANCEL_GRACE_MS = 75;
  const cancelAndDispose = (): void => {
    if (sessionId !== null) client.notify("session/cancel", { sessionId });
    setTimeout(() => client.dispose(), CANCEL_GRACE_MS);
  };

  const abort = (): void => {
    cancelAndDispose();
  };
  params.signal.addEventListener("abort", abort, { once: true });

  const rpcTimeoutMs = params.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  const cleanupWorkspace = async (): Promise<void> => {
    params.signal.removeEventListener("abort", abort);
    try {
      await rm(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    // Cursor writes generated assets under `.cursor/projects/<name>/assets`
    // in the isolated HOME, outside `workspaceDir` — remove that per-run
    // project directory too, best-effort, without touching the shared
    // `.cursor/projects` root other runs live under.
    await cleanupCursorImageProjectDir(jail);
  };

  const failSetup = async (
    error: unknown,
  ): Promise<TCursorNativeImageResult> => {
    client.dispose();
    await cleanupWorkspace();
    if (params.signal.aborted) {
      return { kind: "declined", reason: "client aborted" };
    }
    return {
      kind: "declined",
      reason: acpFailureMessage(error),
      ...(isExplicitAuthenticateRejection(error)
        ? { cooldownReason: "auth" as const }
        : {}),
    };
  };

  try {
    await handshake(client, rpcTimeoutMs);
  } catch (error) {
    return failSetup(error);
  }

  let opened: unknown;
  try {
    opened = await client.request(
      "session/new",
      {
        cwd: workspaceDir,
        mcpServers: [],
      },
      rpcTimeoutMs,
    );
  } catch (error) {
    return failSetup(error);
  }
  const sid = (opened as { readonly sessionId?: unknown }).sessionId;
  if (typeof sid !== "string" || sid.length === 0) {
    client.dispose();
    await cleanupWorkspace();
    return { kind: "declined", reason: "session/new returned no sessionId" };
  }
  sessionId = sid;
  try {
    if (params.signal.aborted)
      throw new DOMException("client aborted", "AbortError");
    await ensureCursorModel(
      client,
      sid,
      params.providerModelId,
      opened,
      rpcTimeoutMs,
    );
    if (params.signal.aborted)
      throw new DOMException("client aborted", "AbortError");
  } catch (error) {
    return failSetup(error);
  }

  const turnBudget = params.turnTimeoutMs ?? CURSOR_TURN_TIMEOUT_MS;
  const idleBudget = params.idleMs ?? CURSOR_IDLE_TIMEOUT_MS;
  const precommitMs = params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS;

  const promptDone = client
    .request(
      "session/prompt",
      {
        sessionId,
        prompt: acpPromptBlocks(promptText, []),
      },
      turnBudget,
    )
    .then((result) => {
      const stop = (result as { readonly stopReason?: unknown }).stopReason;
      stopReason = typeof stop === "string" ? stop : null;
      promptSettled = true;
    })
    .catch(() => {
      promptSettled = true;
    });

  const started = Date.now();
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        if (idleTimer !== undefined) clearInterval(idleTimer);
        resolve();
      };
      idleTimer = setInterval(() => {
        if (params.signal.aborted || foreignTool) {
          cancelAndDispose();
          finish();
          return;
        }
        if (promptSettled) {
          finish();
          return;
        }
        if (!sawActivity && Date.now() - started > precommitMs) {
          cancelAndDispose();
          finish();
          return;
        }
        if (sawActivity && Date.now() - lastActivityAt > idleBudget) {
          cancelAndDispose();
          finish();
          return;
        }
      }, 50);
      void promptDone.then(() => finish());
    });
  } finally {
    if (idleTimer !== undefined) clearInterval(idleTimer);
  }

  if (params.signal.aborted) {
    cancelAndDispose();
    await cleanupWorkspace();
    return { kind: "declined", reason: "client aborted" };
  }

  if (foreignTool) {
    cancelAndDispose();
    await cleanupWorkspace();
    return {
      kind: "failed",
      reason: `cursor image mode observed a non-image native tool_call; session cancelled after the fact, not prevented (${cursorImageToolEnforcement.reason})`,
    };
  }

  if (!sawActivity && !promptSettled) {
    cancelAndDispose();
    await cleanupWorkspace();
    return {
      kind: "declined",
      reason: "cursor ACP produced no output before the pre-commit deadline",
    };
  }

  const assets = await collectJailedCursorImages(provenance, jail);
  cancelAndDispose();
  await cleanupWorkspace();

  if (assets.length === 0) {
    return {
      kind: "failed",
      reason: sawGenerateImage
        ? "generate image completed but no jailed image bytes were collected"
        : "cursor image mode did not complete a Generate Image tool",
    };
  }

  return {
    kind: "ok",
    assets,
    stopReason,
    estimatedUsage: estimatedUsage(),
  };
};
