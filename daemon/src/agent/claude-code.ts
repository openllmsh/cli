/**
 * Claude Code engine adapter for agent sessions.
 *
 * Launch: the engine starts exactly the way `openllm claude` does — the daemon
 * runs the installed `openllm` CLI (`resolveOpenllmCli`), which resolves the
 * gateway, writes the run-local overlay (settings, `apiKeyHelper`, MCP), maps
 * the model tiers and execs `claude`. Nothing about the launch is duplicated
 * here: the adapter only appends Claude's own headless flags after the client
 * name, which `openllm` forwards verbatim:
 *
 *   openllm [-d] claude -p --input-format stream-json
 *     --output-format stream-json --verbose --include-partial-messages
 *     [--permission-prompt-tool stdio] (--session-id <uuid> | --resume <id>)
 *     [--model <gateway model>]
 *
 * A non-TTY stdin makes `openllm claude` launch directly (never the durable
 * PTY host), with inherited stdio — so the pipes below reach `claude` itself.
 *
 * Driving: user turns are written as stream-json `user` lines; Claude's
 * NDJSON output (`system` / `stream_event` / `assistant` / `user` tool
 * results / `result` / `control_request`) is mapped onto the trimmed agent
 * event vocabulary. Permissions: default mode passes
 * `--permission-prompt-tool stdio`, so every approval arrives as a
 * `can_use_tool` control request → `request.opened` (or
 * `user-input.requested` for `AskUserQuestion`) and is answered by a
 * `respond` command. `skip_permissions` maps to `openllm -d` (Claude's
 * `--dangerously-skip-permissions`) and no prompt tool.
 */
import type {
  TAgentEvent,
  TAgentItem,
  TAgentRequestDecision,
  TAgentRequestKind,
  TAgentRespondCommand,
  TAgentTokenUsage,
  TAgentUserInputAnswers,
  TAgentUserInputQuestion,
} from "@openllmsh/protocol";
import { resolveOpenllmCli } from "../cli-path";
import { sessionEnv } from "../cli-paths";
import { mergeSpawnEnv } from "../delegation/spawn";
import {
  openllmClientIdOf,
  pushDeviceCliResumeArgs,
} from "../local-sessions/types";
import { logError } from "../logger";
import { createStderrTail, spawnAgentEngineProcess } from "./engine-process";
import type {
  TAgentEngineAdapter,
  TAgentEngineEmit,
  TAgentEngineProcess,
  TAgentEngineSession,
  TAgentEngineSpawn,
  TAgentEngineStartOptions,
  TAgentSendInput,
  TAgentSendResult,
} from "./types";

/** Tool output kept on an item (the full result stays in the engine). */
export const AGENT_TOOL_OUTPUT_MAX_CHARS = 64 * 1024;
/** Grace between closing stdin and SIGTERM on `close`. */
const CLOSE_GRACE_MS = 3_000;

const DETAIL_MAX = 16 * 1024;
const SHORT_MAX = 256;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

type TJson = Record<string, unknown>;

const isRecord = (value: unknown): value is TJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

/** The `openllm` client argv for one engine session (bin first). */
export const buildClaudeAgentArgv = (
  bin: string,
  options: TAgentEngineStartOptions,
): string[] => {
  const clientId = openllmClientIdOf("claude_code") ?? "claude";
  const args: string[] = [bin];
  // `-d` is openllm's flag (before the client name) for the client's own
  // skip-permissions flag — the same mapping `openllm -d claude` uses.
  if (options.skipPermissions) args.push("-d");
  args.push(
    clientId,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  );
  if (!options.skipPermissions) {
    args.push("--permission-prompt-tool", "stdio");
  }
  if (options.resume) {
    pushDeviceCliResumeArgs(args, "claude_code", options.sessionId);
  } else {
    args.push("--session-id", options.sessionId);
  }
  if (options.model !== undefined) args.push("--model", options.model);
  return args;
};

/** What an approval for `toolName` asks permission for. */
export const requestKindOfTool = (toolName: string): TAgentRequestKind => {
  if (toolName === "Bash" || toolName === "BashOutput") return "command";
  if (
    toolName === "Edit" ||
    toolName === "MultiEdit" ||
    toolName === "Write" ||
    toolName === "NotebookEdit"
  )
    return "file_change";
  return "tool";
};

/** A one-line human label for a tool call, from its input. */
const toolTitleOf = (toolName: string, input: unknown): string | undefined => {
  if (!isRecord(input)) return undefined;
  const pick =
    toolName === "Bash"
      ? (str(input.description) ?? str(input.command))
      : (str(input.file_path) ??
        str(input.notebook_path) ??
        str(input.path) ??
        str(input.pattern) ??
        str(input.url) ??
        str(input.query) ??
        str(input.description));
  return pick === undefined ? undefined : clip(pick, SHORT_MAX);
};

const requestDetailOf = (toolName: string, input: unknown): string => {
  if (isRecord(input)) {
    if (toolName === "Bash" && typeof input.command === "string")
      return clip(input.command, DETAIL_MAX);
    if (typeof input.file_path === "string")
      return clip(input.file_path, DETAIL_MAX);
  }
  try {
    return clip(JSON.stringify(input) ?? "", DETAIL_MAX);
  } catch {
    return "";
  }
};

/** Flatten a `tool_result` content (string or blocks) to text. */
const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return str(block.text) ?? "";
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
};

/** `AskUserQuestion` input → protocol questions (ids `q0`, `q1`, …). */
export const askUserQuestionsOf = (
  input: unknown,
): TAgentUserInputQuestion[] | null => {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const questions: TAgentUserInputQuestion[] = [];
  input.questions.slice(0, 16).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const question = str(raw.question);
    if (question === undefined) return;
    const header = str(raw.header);
    const options = Array.isArray(raw.options)
      ? raw.options
          .filter(isRecord)
          .slice(0, 64)
          .map((option) => {
            const description = str(option.description);
            return {
              label: clip(str(option.label) ?? "", SHORT_MAX),
              ...(description === undefined
                ? {}
                : { description: clip(description, 1024) }),
            };
          })
      : undefined;
    questions.push({
      id: `q${index}`,
      question: clip(question, DETAIL_MAX),
      ...(header === undefined ? {} : { header: clip(header, SHORT_MAX) }),
      ...(options === undefined ? {} : { options }),
      ...(raw.multiSelect === true ? { multi_select: true } : {}),
    });
  });
  return questions.length > 0 ? questions : null;
};

/** Protocol answers (keyed `q<i>`) → Claude's `answers` (keyed by question text). */
const claudeAnswersOf = (
  input: unknown,
  answers: TAgentUserInputAnswers,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isRecord(input) || !Array.isArray(input.questions)) return out;
  input.questions.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const question = str(raw.question);
    const answer = answers[`q${index}`];
    if (question === undefined || answer === undefined) return;
    out[question] = typeof answer === "string" ? answer : answer.join(", ");
  });
  return out;
};

type TPendingRequest = {
  readonly kind: "approval" | "user-input";
  readonly cliRequestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly suggestions: unknown;
};

type TStreamItem = {
  readonly itemId: string;
  readonly kind: "assistant_message" | "reasoning" | "tool_call";
  text: string;
  toolName: string;
  inputJson: string;
};

type TTurn = {
  readonly id: string;
  interruptRequested: boolean;
};

/**
 * Drive one Claude Code engine process: map its stream-json output onto
 * agent events and turn agent commands into stream-json input. Exported for
 * tests, which hand it a fake {@link TAgentEngineProcess}.
 */
export const createClaudeCodeSession = (
  child: TAgentEngineProcess,
  options: TAgentEngineStartOptions,
  emit: TAgentEngineEmit,
): TAgentEngineSession => {
  let turn: TTurn | null = null;
  let turnCounter = 0;
  let requestCounter = 0;
  let controlCounter = 0;
  let messageCounter = 0;
  let exited = false;
  let closeReason: "closed" | "killed" | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let contextWindow: number | undefined;
  let lastUsage: TAgentTokenUsage | undefined;
  const stderr = createStderrTail();

  /** Content blocks of the message currently streaming, by block index. */
  let blocks = new Map<number, TStreamItem>();
  let currentMessageId: string | null = null;
  let messageUsage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  /** Message ids whose blocks arrived as stream events (skip their full copy). */
  const streamedMessages = new Set<string>();
  /** Tool calls by `tool_use` id (= item id), for result completion. */
  const toolItems = new Map<
    string,
    { readonly toolName: string; title?: string; input?: unknown }
  >();
  const pending = new Map<string, TPendingRequest>();

  const turnField = (): { turn_id?: string } =>
    turn === null ? {} : { turn_id: turn.id };

  const emitItem = (
    type: "item.started" | "item.updated" | "item.completed",
    itemId: string,
    item: TAgentItem,
  ): void => {
    emit({ type, item_id: itemId, item, ...turnField() });
  };

  const emitUsage = (): void => {
    if (lastUsage === undefined) return;
    emit({
      type: "thread.token-usage.updated",
      usage: {
        ...lastUsage,
        ...(contextWindow === undefined
          ? {}
          : { context_window: contextWindow }),
      },
    });
  };

  const writeControlResponse = (
    cliRequestId: string,
    response: TJson,
  ): void => {
    child.writeLine(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: cliRequestId, response },
      }),
    );
  };

  const writeControlError = (cliRequestId: string, error: string): void => {
    child.writeLine(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "error", request_id: cliRequestId, error },
      }),
    );
  };

  const toolItemOf = (
    itemId: string,
    status: "in_progress" | "completed" | "failed",
    extra: { output?: string; is_error?: boolean } = {},
  ): TAgentItem => {
    const tool = toolItems.get(itemId);
    return {
      kind: "tool_call",
      tool_name: clip(tool?.toolName ?? "tool", 128) || "tool",
      ...(tool?.title === undefined ? {} : { title: tool.title }),
      ...(tool?.input === undefined ? {} : { input: tool.input }),
      status,
      ...extra,
    };
  };

  const startToolItem = (
    itemId: string,
    toolName: string,
    input?: unknown,
  ): void => {
    const title =
      input === undefined ? undefined : toolTitleOf(toolName, input);
    toolItems.set(itemId, {
      toolName,
      ...(title === undefined ? {} : { title }),
      ...(input === undefined ? {} : { input }),
    });
    emitItem("item.started", itemId, toolItemOf(itemId, "in_progress"));
  };

  // ── stream events (partial messages) ─────────────────────────────────

  const onStreamEvent = (event: TJson): void => {
    const type = str(event.type);
    if (type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      messageCounter += 1;
      currentMessageId = str(message.id) ?? `m${messageCounter}`;
      streamedMessages.add(currentMessageId);
      blocks = new Map();
      const usage = isRecord(message.usage) ? message.usage : {};
      messageUsage = {
        input: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
        output: num(usage.output_tokens),
      };
      return;
    }
    if (type === "content_block_start") {
      const index = num(event.index);
      const block = isRecord(event.content_block) ? event.content_block : {};
      const messageId = currentMessageId ?? `m${messageCounter}`;
      if (block.type === "text" || block.type === "thinking") {
        const kind = block.type === "text" ? "assistant_message" : "reasoning";
        const item: TStreamItem = {
          itemId: clip(`${messageId}:${index}`, 128),
          kind,
          text: "",
          toolName: "",
          inputJson: "",
        };
        blocks.set(index, item);
        emitItem("item.started", item.itemId, { kind, text: "" });
        return;
      }
      if (block.type === "tool_use") {
        const toolUseId = str(block.id);
        const toolName = str(block.name);
        if (toolUseId === undefined || toolName === undefined) return;
        const item: TStreamItem = {
          itemId: clip(toolUseId, 128),
          kind: "tool_call",
          text: "",
          toolName,
          inputJson: "",
        };
        blocks.set(index, item);
        startToolItem(item.itemId, toolName);
      }
      return;
    }
    if (type === "content_block_delta") {
      const item = blocks.get(num(event.index));
      const delta = isRecord(event.delta) ? event.delta : {};
      if (item === undefined) return;
      if (delta.type === "text_delta" && item.kind === "assistant_message") {
        const text = str(delta.text) ?? "";
        item.text += text;
        if (text.length > 0)
          emit({
            type: "content.delta",
            item_id: item.itemId,
            stream: "assistant_text",
            delta: text,
            ...turnField(),
          });
        return;
      }
      if (delta.type === "thinking_delta" && item.kind === "reasoning") {
        const text = str(delta.thinking) ?? "";
        item.text += text;
        if (text.length > 0)
          emit({
            type: "content.delta",
            item_id: item.itemId,
            stream: "reasoning_text",
            delta: text,
            ...turnField(),
          });
        return;
      }
      if (delta.type === "input_json_delta" && item.kind === "tool_call") {
        item.inputJson += str(delta.partial_json) ?? "";
      }
      return;
    }
    if (type === "content_block_stop") {
      const index = num(event.index);
      const item = blocks.get(index);
      if (item === undefined) return;
      blocks.delete(index);
      if (item.kind === "tool_call") {
        let input: unknown = {};
        if (item.inputJson.length > 0) {
          try {
            input = JSON.parse(item.inputJson) as unknown;
          } catch {
            input = undefined;
          }
        }
        const tool = toolItems.get(item.itemId);
        if (tool !== undefined && input !== undefined) {
          tool.input = input;
          const title = toolTitleOf(item.toolName, input);
          if (title !== undefined) tool.title = title;
        }
        emitItem(
          "item.updated",
          item.itemId,
          toolItemOf(item.itemId, "in_progress"),
        );
        return;
      }
      emitItem("item.completed", item.itemId, {
        kind: item.kind,
        text: item.text,
      });
      return;
    }
    if (type === "message_delta") {
      const usage = isRecord(event.usage) ? event.usage : {};
      if (typeof usage.output_tokens === "number")
        messageUsage.output = num(usage.output_tokens);
      if (typeof usage.input_tokens === "number")
        messageUsage.input = num(usage.input_tokens);
      if (typeof usage.cache_read_input_tokens === "number")
        messageUsage.cacheRead = num(usage.cache_read_input_tokens);
      if (typeof usage.cache_creation_input_tokens === "number")
        messageUsage.cacheCreation = num(usage.cache_creation_input_tokens);
      return;
    }
    if (type === "message_stop") {
      const input =
        messageUsage.input +
        messageUsage.cacheRead +
        messageUsage.cacheCreation;
      lastUsage = {
        input_tokens: input,
        output_tokens: messageUsage.output,
        ...(messageUsage.cacheRead > 0
          ? { cached_input_tokens: messageUsage.cacheRead }
          : {}),
        total_tokens: input + messageUsage.output,
      };
      emitUsage();
    }
  };

  // ── full messages (fallback when a block was not streamed) ───────────

  const onAssistant = (message: TJson): void => {
    messageCounter += 1;
    const messageId = str(message.id) ?? `m${messageCounter}`;
    const streamed = streamedMessages.has(messageId);
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, index) => {
      if (!isRecord(block)) return;
      if (block.type === "tool_use") {
        const toolUseId = str(block.id);
        const toolName = str(block.name);
        if (toolUseId === undefined || toolName === undefined) return;
        const itemId = clip(toolUseId, 128);
        if (toolItems.has(itemId)) return;
        startToolItem(itemId, toolName, block.input);
        return;
      }
      if (streamed) return;
      if (block.type === "text" || block.type === "thinking") {
        const kind = block.type === "text" ? "assistant_message" : "reasoning";
        const text =
          str(block.type === "text" ? block.text : block.thinking) ?? "";
        const itemId = clip(`${messageId}:${index}`, 128);
        emitItem("item.started", itemId, { kind, text: "" });
        emitItem("item.completed", itemId, { kind, text });
      }
    });
  };

  const onUserLine = (message: TJson): void => {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const toolUseId = str(block.tool_use_id);
      if (toolUseId === undefined) continue;
      const itemId = clip(toolUseId, 128);
      if (!toolItems.has(itemId)) continue;
      const isError = block.is_error === true;
      emitItem(
        "item.completed",
        itemId,
        toolItemOf(itemId, isError ? "failed" : "completed", {
          output: clip(
            toolResultText(block.content),
            AGENT_TOOL_OUTPUT_MAX_CHARS,
          ),
          ...(isError ? { is_error: true } : {}),
        }),
      );
      toolItems.delete(itemId);
    }
  };

  const dropPendingRequests = (): void => {
    for (const [requestId, request] of pending) {
      if (request.kind === "approval")
        emit({
          type: "request.resolved",
          request_id: requestId,
          decision: "cancel",
        });
      else
        emit({
          type: "user-input.resolved",
          request_id: requestId,
          answers: {},
        });
    }
    pending.clear();
  };

  const onResult = (result: TJson): void => {
    const modelUsage = isRecord(result.modelUsage) ? result.modelUsage : {};
    for (const entry of Object.values(modelUsage)) {
      if (isRecord(entry) && typeof entry.contextWindow === "number") {
        contextWindow = num(entry.contextWindow);
        emitUsage();
        break;
      }
    }
    const active = turn;
    turn = null;
    dropPendingRequests();
    if (active === null) return;
    const subtype = str(result.subtype) ?? "success";
    const failed = result.is_error === true || subtype !== "success";
    if (active.interruptRequested) {
      emit({ type: "turn.aborted", turn_id: active.id, reason: "interrupted" });
      return;
    }
    if (failed) {
      const message = str(result.result) ?? subtype;
      emit({
        type: "turn.aborted",
        turn_id: active.id,
        reason: "failed",
        message: clip(message, SHORT_MAX),
      });
      return;
    }
    const stopReason = str(result.stop_reason);
    emit({
      type: "turn.completed",
      turn_id: active.id,
      ...(stopReason === undefined
        ? {}
        : { stop_reason: clip(stopReason, 64) }),
    });
  };

  const onControlRequest = (line: TJson): void => {
    const cliRequestId = str(line.request_id);
    const request = isRecord(line.request) ? line.request : {};
    if (cliRequestId === undefined) return;
    if (request.subtype !== "can_use_tool") {
      writeControlError(cliRequestId, "unsupported control request");
      return;
    }
    const toolName = str(request.tool_name) ?? "tool";
    const input = request.input;
    requestCounter += 1;
    const requestId = `r${requestCounter}`;
    if (toolName === "AskUserQuestion") {
      const questions = askUserQuestionsOf(input);
      if (questions !== null) {
        pending.set(requestId, {
          kind: "user-input",
          cliRequestId,
          toolName,
          input,
          suggestions: undefined,
        });
        emit({
          type: "user-input.requested",
          request_id: requestId,
          questions,
          ...turnField(),
        });
        return;
      }
    }
    pending.set(requestId, {
      kind: "approval",
      cliRequestId,
      toolName,
      input,
      suggestions: request.permission_suggestions,
    });
    const toolUseId = str(request.tool_use_id);
    const title = toolTitleOf(toolName, input);
    emit({
      type: "request.opened",
      request_id: requestId,
      request_kind: requestKindOfTool(toolName),
      title: clip(
        title === undefined ? toolName : `${toolName}: ${title}`,
        SHORT_MAX,
      ),
      detail: requestDetailOf(toolName, input),
      ...(input === undefined ? {} : { input }),
      ...(toolUseId === undefined ? {} : { item_id: clip(toolUseId, 128) }),
      ...turnField(),
    });
  };

  const onControlCancel = (line: TJson): void => {
    const cliRequestId = str(line.request_id);
    for (const [requestId, request] of pending) {
      if (request.cliRequestId !== cliRequestId) continue;
      pending.delete(requestId);
      if (request.kind === "approval")
        emit({
          type: "request.resolved",
          request_id: requestId,
          decision: "cancel",
        });
      else
        emit({
          type: "user-input.resolved",
          request_id: requestId,
          answers: {},
        });
    }
  };

  const onLine = (raw: string): void => {
    let line: unknown;
    try {
      line = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRecord(line)) return;
    // Sub-agent traffic (Task tool) stays inside its parent tool call.
    if (
      line.parent_tool_use_id !== undefined &&
      line.parent_tool_use_id !== null
    )
      return;
    switch (line.type) {
      case "stream_event":
        if (isRecord(line.event)) onStreamEvent(line.event);
        return;
      case "assistant":
        if (isRecord(line.message)) onAssistant(line.message);
        return;
      case "user":
        if (isRecord(line.message)) onUserLine(line.message);
        return;
      case "result":
        onResult(line);
        return;
      case "control_request":
        onControlRequest(line);
        return;
      case "control_cancel_request":
        onControlCancel(line);
        return;
      default:
        return;
    }
  };

  child.onLine((raw) => {
    try {
      onLine(raw);
    } catch (err) {
      logError("agent", err);
    }
  });
  child.onStderr((text) => stderr.push(text));
  child.onExit((code, signal) => {
    exited = true;
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    const active = turn;
    turn = null;
    dropPendingRequests();
    if (active !== null)
      emit({
        type: "turn.aborted",
        turn_id: active.id,
        reason: closeReason === null ? "failed" : "cancelled",
      });
    if (closeReason === null && code !== 0) {
      const tail = stderr.text();
      emit({
        type: "runtime.error",
        code: "engine_exited",
        message: clip(
          tail.length > 0
            ? tail
            : `Claude Code exited (${signal ?? `code ${String(code)}`})`,
          DETAIL_MAX,
        ),
        fatal: true,
      });
    }
    emit({
      type: "session.exited",
      session_id: options.sessionId,
      reason: closeReason ?? (code === 0 ? "completed" : "error"),
    });
  });

  const userContentOf = (
    input: TAgentSendInput,
  ): { blocks: TJson[]; skipped: string[] } => {
    const blocksOut: TJson[] = [];
    const skipped: string[] = [];
    if (input.prompt.length > 0)
      blocksOut.push({ type: "text", text: input.prompt });
    for (const attachment of input.attachments) {
      const mediaType = attachment.media_type.toLowerCase();
      if (attachment.kind === "image" || mediaType.startsWith("image/")) {
        blocksOut.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: attachment.data,
          },
        });
        continue;
      }
      if (mediaType === "application/pdf") {
        blocksOut.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaType,
            data: attachment.data,
          },
        });
        continue;
      }
      if (mediaType.startsWith("text/") || mediaType === "application/json") {
        const text = Buffer.from(attachment.data, "base64").toString("utf8");
        const name = attachment.name ?? "attachment";
        blocksOut.push({
          type: "text",
          text: `<file name="${name}">\n${text}\n</file>`,
        });
        continue;
      }
      skipped.push(attachment.name ?? attachment.media_type);
    }
    return { blocks: blocksOut, skipped };
  };

  return {
    send: (input): TAgentSendResult => {
      if (exited || closeReason !== null)
        return {
          ok: false,
          code: "session_exited",
          message: "the session has ended",
        };
      if (turn !== null)
        return {
          ok: false,
          code: "turn_in_progress",
          message: "a turn is already running; interrupt it or wait",
        };
      const content = userContentOf(input);
      if (content.blocks.length === 0)
        return { ok: false, code: "empty_prompt", message: "nothing to send" };
      const written = child.writeLine(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: content.blocks },
          parent_tool_use_id: null,
          session_id: options.sessionId,
        }),
      );
      if (!written)
        return {
          ok: false,
          code: "session_exited",
          message: "the engine is gone",
        };
      turnCounter += 1;
      turn = { id: `t${turnCounter}`, interruptRequested: false };
      emit({
        type: "turn.started",
        turn_id: turn.id,
        ...(options.model === undefined ? {} : { model: options.model }),
      });
      if (content.skipped.length > 0)
        emit({
          type: "runtime.warning",
          code: "attachment_unsupported",
          message: clip(
            `Skipped unsupported attachments: ${content.skipped.join(", ")}`,
            DETAIL_MAX,
          ),
        });
      return { ok: true, turnId: turn.id };
    },
    interrupt: () => {
      if (turn === null || exited) return false;
      turn.interruptRequested = true;
      controlCounter += 1;
      child.writeLine(
        JSON.stringify({
          type: "control_request",
          request_id: `openllm-interrupt-${controlCounter}`,
          request: { subtype: "interrupt" },
        }),
      );
      return true;
    },
    respond: (command: TAgentRespondCommand): boolean => {
      const request = pending.get(command.request_id);
      if (request === undefined || exited) return false;
      if (request.kind === "approval") {
        const decision: TAgentRequestDecision | undefined = command.decision;
        if (decision === undefined) return false;
        pending.delete(command.request_id);
        if (decision === "accept" || decision === "accept_for_session") {
          writeControlResponse(request.cliRequestId, {
            behavior: "allow",
            updatedInput: isRecord(request.input) ? request.input : {},
            ...(decision === "accept_for_session" &&
            Array.isArray(request.suggestions)
              ? { updatedPermissions: request.suggestions }
              : {}),
          });
        } else {
          writeControlResponse(request.cliRequestId, {
            behavior: "deny",
            message:
              decision === "cancel"
                ? "The user cancelled this turn."
                : "The user declined this action.",
            ...(decision === "cancel" ? { interrupt: true } : {}),
          });
          if (decision === "cancel" && turn !== null)
            turn.interruptRequested = true;
        }
        emit({
          type: "request.resolved",
          request_id: command.request_id,
          decision,
        });
        return true;
      }
      // user-input (AskUserQuestion)
      if (command.answers !== undefined) {
        pending.delete(command.request_id);
        writeControlResponse(request.cliRequestId, {
          behavior: "allow",
          updatedInput: {
            ...(isRecord(request.input) ? request.input : {}),
            answers: claudeAnswersOf(request.input, command.answers),
          },
        });
        emit({
          type: "user-input.resolved",
          request_id: command.request_id,
          answers: command.answers,
        });
        return true;
      }
      if (command.decision === "decline" || command.decision === "cancel") {
        pending.delete(command.request_id);
        writeControlResponse(request.cliRequestId, {
          behavior: "deny",
          message: "The user declined to answer.",
          ...(command.decision === "cancel" ? { interrupt: true } : {}),
        });
        emit({
          type: "user-input.resolved",
          request_id: command.request_id,
          answers: {},
        });
        return true;
      }
      return false;
    },
    turnActive: () => turn !== null,
    close: (reason) => {
      if (exited) return;
      if (closeReason === null) closeReason = reason;
      if (reason === "killed") {
        child.kill("SIGKILL");
        return;
      }
      child.endInput();
      if (closeTimer === undefined) {
        closeTimer = setTimeout(() => child.kill("SIGTERM"), CLOSE_GRACE_MS);
        closeTimer.unref?.();
      }
    },
  };
};

/** An already-failed session: emits the error + exit, ignores everything. */
const failedSession = (
  options: TAgentEngineStartOptions,
  emit: TAgentEngineEmit,
  code: string,
  message: string,
): TAgentEngineSession => {
  const events: TAgentEvent[] = [
    { type: "runtime.error", code, message, fatal: true },
    { type: "session.exited", session_id: options.sessionId, reason: "error" },
  ];
  queueMicrotask(() => {
    for (const event of events) emit(event);
  });
  return {
    send: () => ({ ok: false, code: "session_exited", message }),
    interrupt: () => false,
    respond: () => false,
    turnActive: () => false,
    close: () => {},
  };
};

export type TClaudeCodeAdapterOptions = {
  /** Override the child spawner (tests). */
  readonly spawn?: TAgentEngineSpawn;
  /** Override the `openllm` CLI lookup (tests). */
  readonly resolveCli?: () => string | null;
  /** Override the child env (tests). */
  readonly env?: (options: TAgentEngineStartOptions) => Record<string, string>;
};

/**
 * The env an engine runs with — the device-session env (real HOME, daemon
 * TMPDIR) plus the device-session markers `openllm <client>` indexes into
 * `live.json`, so the session shows up in the local session list.
 */
const defaultEngineEnv = (
  options: TAgentEngineStartOptions,
): Record<string, string> =>
  mergeSpawnEnv(process.env, {
    ...sessionEnv(),
    OPENLLM_DEVICE_SESSION_ID: options.sessionId,
    ...(options.title === undefined || options.title.length === 0
      ? {}
      : { OPENLLM_DEVICE_TITLE: options.title.slice(0, 80) }),
  });

export const createClaudeCodeAdapter = (
  adapterOptions: TClaudeCodeAdapterOptions = {},
): TAgentEngineAdapter => ({
  engine: "claude",
  start: (options, emit) => {
    const bin = (adapterOptions.resolveCli ?? resolveOpenllmCli)();
    if (bin === null)
      return failedSession(
        options,
        emit,
        "cli_missing",
        "The OpenLLM CLI is not installed on this device.",
      );
    let child: TAgentEngineProcess;
    try {
      child = (adapterOptions.spawn ?? spawnAgentEngineProcess)({
        argv: buildClaudeAgentArgv(bin, options),
        cwd: options.cwd,
        env: (adapterOptions.env ?? defaultEngineEnv)(options),
      });
    } catch (err) {
      logError("agent", err);
      return failedSession(
        options,
        emit,
        "spawn_failed",
        "Claude Code could not be started on this device.",
      );
    }
    return createClaudeCodeSession(child, options, emit);
  },
});
