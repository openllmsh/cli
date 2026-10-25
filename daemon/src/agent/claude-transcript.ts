/**
 * Claude Code's own session transcript (`~/.claude/projects/<slug>/<id>.jsonl`)
 * as agent events — the structured view of a TUI session.
 *
 * Claude appends one JSON line per message as the session runs: the user's
 * prompt, each assistant content block (text / thinking / tool_use, with
 * `stop_reason`), and `tool_result`s. The tail reads new bytes; the parser
 * turns complete lines into `turn.*` / `item.*` / usage events. The same
 * parser replays an existing transcript first (resume, or attaching to a
 * session started in the terminal), so history and live share one mapping.
 * Granularity is per message: there are no partial-token deltas.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type {
  TAgentAttachmentMeta,
  TAgentEvent,
  TAgentItem,
} from "@openllmsh/protocol";
import {
  AGENT_DETAIL_TEXT_MAX_LENGTH,
  AGENT_TOOL_NAME_MAX_LENGTH,
  normalizeUserPromptText,
} from "@openllmsh/protocol";
import { claudeConfigDir } from "../local-sessions/paths";

/** Bytes read per poll at most (a burst is drained over several polls). */
const READ_CHUNK_BYTES = 1024 * 1024;
/** Re-scan the projects tree for a missing transcript at most this often. */
const SCAN_INTERVAL_MS = 2_000;

/**
 * End index of the last complete UTF-8 sequence in `buf[0, end)`. Incomplete
 * trailing bytes (a multi-byte character split by a chunk boundary) are left
 * out so the next read can consume them with their continuation.
 */
const utf8CompleteEnd = (buf: Buffer, end: number): number => {
  if (end <= 0) return 0;
  let i = end;
  while (i > 0 && (buf[i - 1]! & 0xc0) === 0x80) i -= 1;
  if (i === 0) return 0;
  const lead = buf[i - 1]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i - 1 + need <= end ? end : i - 1;
};

const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

const claudeProjectsDir = (): string => join(claudeConfigDir(), "projects");

/** Claude's project slug for a cwd (every non-alphanumeric → `-`). */
export const claudeProjectSlug = (cwd: string): string =>
  cwd.replace(/[^A-Za-z0-9]/g, "-");

/** `<projects>/<slug>/<id>.jsonl` for the session, or null. */
export const findClaudeTranscript = (
  sessionId: string,
  projectsDir: string = claudeProjectsDir(),
  cwd?: string,
): string | null => {
  if (!SESSION_ID.test(sessionId) || !existsSync(projectsDir)) return null;
  if (cwd !== undefined) {
    const direct = join(
      projectsDir,
      claudeProjectSlug(cwd),
      `${sessionId}.jsonl`,
    );
    if (existsSync(direct)) return direct;
  }
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const path = join(projectsDir, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
};

/** Incremental reader of one session's transcript. */
export type TClaudeTranscriptTail = {
  /** New text since the last read (complete or partial lines), or null. */
  readonly read: () => string | null;
  /** The transcript file being followed, once found (history, subagents). */
  readonly path?: () => string | null;
};

/**
 * Tail a session's transcript FROM ITS START (attach and resume replay the
 * whole conversation, then follow appends).
 *
 * `currentId` names the Claude session the TUI is on right now. It differs
 * from `sessionId` for a terminal `openllm claude` run (the host id is not
 * Claude's id) and changes on `/clear` or `/resume` inside the TUI; the tail
 * then moves to that id's transcript, from its start, and calls `onSwitch`.
 */
export const createClaudeTranscriptTail = (
  sessionId: string,
  options: {
    readonly projectsDir?: string;
    readonly cwd?: string;
    readonly now?: () => number;
    /** Re-resolve / re-scan cadence (tests). */
    readonly scanIntervalMs?: number;
    readonly currentId?: () => string | null;
    readonly onSwitch?: (claudeSessionId: string) => void;
  } = {},
): TClaudeTranscriptTail => {
  const now = options.now ?? Date.now;
  const scanMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
  let readingId: string | null = null;
  let path: string | null = null;
  let offset = 0;
  let lastScan = Number.NEGATIVE_INFINITY;
  let lastResolve = Number.NEGATIVE_INFINITY;
  const follow = (): void => {
    if (readingId !== null && now() - lastResolve < scanMs) return;
    lastResolve = now();
    const target = options.currentId?.() ?? sessionId;
    if (target === readingId) return;
    const switched = readingId !== null;
    readingId = target;
    path = null;
    offset = 0;
    lastScan = Number.NEGATIVE_INFINITY;
    if (switched) options.onSwitch?.(target);
  };
  return {
    path: () => path,
    read: () => {
      follow();
      if (readingId === null) return null;
      if (path === null) {
        if (now() - lastScan < scanMs) return null;
        lastScan = now();
        path = findClaudeTranscript(
          readingId,
          options.projectsDir ?? claudeProjectsDir(),
          options.cwd,
        );
        if (path === null) return null;
      }
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch {
        return null;
      }
      try {
        const size = fstatSync(fd).size;
        if (size < offset) offset = 0; // truncated / rewritten
        const length = Math.min(size - offset, READ_CHUNK_BYTES);
        if (length <= 0) return null;
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const n = readSync(fd, buffer, read, length - read, offset + read);
          if (n === 0) break;
          read += n;
        }
        // Prefer whole lines; otherwise stop on a complete UTF-8 boundary so a
        // multi-byte character straddling the chunk is not decoded as �.
        let usable = read;
        const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
        if (lastNewline >= 0) usable = lastNewline + 1;
        else usable = utf8CompleteEnd(buffer, read);
        if (usable <= 0) return null;
        offset += usable;
        return buffer.subarray(0, usable).toString("utf8");
      } finally {
        closeSync(fd);
      }
    },
  };
};

type TJson = Record<string, unknown>;

/** Claude's reply to `/model <id>` in the transcript. */
const MODEL_SET = /^<local-command-stdout>Set model to `([^`\n]{1,256})`/;

/** The output row a local slash command (`/cost`, `/model x`) writes when done. */
const LOCAL_COMMAND_OUTPUT = /^<local-command-(?:stdout|stderr)\b/i;

/**
 * Slash commands that run long without writing a row until they finish
 * (`/compact` summarises the conversation first): never completed on quiet.
 */
const SLOW_LOCAL_COMMANDS: ReadonlySet<string> = new Set(["/compact"]);

/** `turn.completed.stop_reason` of a turn a local slash command answered. */
export const LOCAL_COMMAND_STOP_REASON = "local_command";

/** Claude control wrappers recorded as user rows, never user-authored prompts. */
const CLAUDE_CONTROL_WRAPPER =
  /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b/i;

const isRecord = (value: unknown): value is TJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * A tool name as the schema accepts it (1..{@link AGENT_TOOL_NAME_MAX_LENGTH}):
 * an MCP tool's name can run longer, and an event with an over-long or empty
 * one would fail to decode and be dropped by every consumer.
 */
export const toolNameOf = (value: unknown): string => {
  const name = typeof value === "string" ? value.trim() : "";
  return name === "" ? "tool" : clip(name, AGENT_TOOL_NAME_MAX_LENGTH);
};

/** Flatten a `tool_result` content (string or blocks) to text. */
export const toolResultText = (content: unknown): string => {
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

/** The prompt text of a user line, or null (tool results / wrappers). */
const promptOf = (content: unknown): string | null => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(
      (block): block is TJson =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text as string);
  return texts.length === 0 ? null : texts.join("\n");
};

const INTERRUPTED = "[Request interrupted by user";

/** Claude's tool names for a subagent call (renamed Task → Agent). */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Task",
  "Agent",
]);

/** The launch ack Claude writes as a background subagent's tool_result. */
const ASYNC_LAUNCH_TEXT = /^Async agent launched successfully\b/;

/**
 * A subagent call's tool_result that is only the background launch ack:
 * `toolUseResult` says so structurally; the text is the fallback for rows
 * written without it.
 */
const isAsyncLaunchAck = (row: TJson, output: string): boolean => {
  const meta = row.toolUseResult;
  if (isRecord(meta) && ("isAsync" in meta || "status" in meta))
    return meta.isAsync === true || meta.status === "async_launched";
  return ASYNC_LAUNCH_TEXT.test(output.trimStart());
};

/** A `<task-notification>` Claude injects when a background task stops. */
export type TTaskNotification = {
  readonly toolUseId: string;
  readonly status: string;
  readonly summary: string | undefined;
  readonly result: string | undefined;
};

const tagOf = (text: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  const value = match?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

export const parseTaskNotification = (
  text: string,
): TTaskNotification | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<task-notification>")) return null;
  const toolUseId = tagOf(trimmed, "tool-use-id");
  if (toolUseId === undefined) return null;
  return {
    toolUseId,
    status: tagOf(trimmed, "status") ?? "completed",
    summary: tagOf(trimmed, "summary"),
    result: tagOf(trimmed, "result"),
  };
};

/** A shell result's leading `Exit code N`. */
const EXIT_CODE = /^Exit code (-?\d+)/;
/** Tool results Claude writes when the user (or a rule) refused the call. */
const DENIED =
  /doesn't want to proceed with this tool use|tool use was rejected|Permission to use [^\n]{1,128} has been denied/i;

const timestampOf = (row: TJson): number | null => {
  const raw = str(row.timestamp);
  if (raw === undefined) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
};

export type TTranscriptParser = {
  /** Feed transcript text (any split; partial lines are buffered). */
  readonly push: (text: string) => void;
  /** A turn opened by this daemon (its prompt line is then not a new turn). */
  readonly startTurn: (
    prompt: string,
    attachments?: readonly TAgentAttachmentMeta[],
  ) => string;
  readonly completeTurn: (stopReason?: string) => void;
  readonly abortTurn: (
    reason: "interrupted" | "failed" | "cancelled",
    message?: string,
  ) => void;
  readonly turnActive: () => boolean;
  /**
   * True while the open turn is a slash command sent by this daemon that has
   * shown no sign of running the model (no prompt expansion, no assistant
   * row): a local command that may finish without writing anything.
   */
  readonly quietLocalCommand: () => boolean;
  readonly turnField: () => { turn_id?: string };
  /** Turns opened so far (the ordinal of the latest `t<n>`). */
  readonly turnCount: () => number;
};

export type TTranscriptParserOptions = {
  readonly emit: (event: TAgentEvent) => void;
  readonly toolOutputMax: number;
  /**
   * Turns already counted before the text this parser sees (a history page
   * parsed from the middle of a transcript keeps the live `t<n>` ids).
   */
  readonly firstTurn?: number;
  /**
   * A subagent's own transcript (`subagents/agent-<id>.jsonl`): every row is
   * the subagent's, nested under this tool call; it opens no turns and
   * reports no usage.
   */
  readonly parentItemId?: string;
  /** The turn id a subagent parser stamps on its items. */
  readonly turnId?: () => string | undefined;
  /** Every tool_use seen (the subagent follower tracks Task / Agent calls). */
  readonly onToolUse?: (
    toolUseId: string,
    toolName: string,
    input: unknown,
  ) => void;
  /**
   * The background call this subagent file belongs to: the file's final
   * assistant message (`end_turn`) completes the call with that text.
   */
  readonly backgroundCall?: {
    readonly toolName: string;
    readonly input: unknown;
    /** The call's own parent (a subagent nested in a subagent). */
    readonly parentItemId?: string;
  };
};

export const createTranscriptParser = (
  args: TTranscriptParserOptions,
): TTranscriptParser => {
  const { emit } = args;
  let buffer = "";
  let turnCounter = args.firstTurn ?? 0;
  let turn: {
    id: string;
    awaitingPromptLine: boolean;
    /** The daemon typed a slash command (`/cost`, `/model x`, `/init`). */
    readonly command: string | null;
    /** The model runs for it (a prompt or an expanded command was recorded). */
    modelRun: boolean;
    /** An assistant row answered in this turn. */
    answered: boolean;
  } | null = null;
  const tools = new Map<
    string,
    { toolName: string; input: unknown; at: number | null; parent?: string }
  >();
  let lastTitle: string | null = null;
  /** Per-turn usage: the last request's context, the summed output. */
  let turnUsage: { input: number; cached: number; output: number } | null =
    null;
  /**
   * Inline sidechains (older Claude builds wrote subagent rows into the main
   * transcript): row uuid → the Task call it belongs to. A sidechain's first
   * row is the subagent prompt, matched to the open Task call carrying it.
   */
  const sidechainParent = new Map<string, string>();
  const taskPrompts = new Map<string, string>();
  /** Background subagent calls whose launch ack was seen, until they finish. */
  const background = new Map<
    string,
    { toolName: string; input: unknown; parent?: string }
  >();
  /** A subagent file's latest assistant text (its result on `end_turn`). */
  let lastText: string | null = null;

  const turnField = (): { turn_id?: string } => {
    if (args.turnId !== undefined) {
      const id = args.turnId();
      return id === undefined ? {} : { turn_id: id };
    }
    return turn === null ? {} : { turn_id: turn.id };
  };

  const item = (
    type: "item.started" | "item.updated" | "item.completed",
    itemId: string,
    value: TAgentItem,
    parent: string | undefined,
  ): void => {
    emit({
      type,
      item_id: itemId,
      item: value,
      ...turnField(),
      ...(parent === undefined ? {} : { parent_item_id: parent }),
    });
  };

  const notice = (
    itemId: string,
    kind: "compacted" | "interrupted" | "model_changed" | "error",
    text?: string,
  ): void => {
    item(
      "item.completed",
      itemId,
      {
        kind: "notice",
        notice: kind,
        ...(text === undefined
          ? {}
          : { text: clip(text, AGENT_DETAIL_TEXT_MAX_LENGTH) }),
      },
      args.parentItemId,
    );
  };

  const openTurn = (
    prompt: string | undefined,
    awaitingPromptLine: boolean,
    attachments?: readonly TAgentAttachmentMeta[],
  ): string => {
    turnCounter += 1;
    // Only a prompt this daemon typed can be a slash command: Claude records
    // a terminal one as wrapper rows, which never open a turn.
    const command =
      awaitingPromptLine && prompt !== undefined
        ? (/^\/[^\s/]+(?=\s|$)/.exec(prompt.trimStart())?.[0] ?? null)
        : null;
    turn = {
      id: `t${turnCounter}`,
      awaitingPromptLine,
      command,
      modelRun: false,
      answered: false,
    };
    turnUsage = null;
    const cleaned =
      prompt === undefined ? undefined : normalizeUserPromptText(prompt);
    emit({
      type: "turn.started",
      turn_id: turn.id,
      ...(cleaned === undefined || cleaned === "" ? {} : { prompt: cleaned }),
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments: [...attachments] }
        : {}),
    });
    return turn.id;
  };

  const completeTurn = (stopReason?: string): void => {
    if (turn === null) return;
    const usage = turnUsage;
    emit({
      type: "turn.completed",
      turn_id: turn.id,
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      ...(usage === null
        ? {}
        : {
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              ...(usage.cached > 0
                ? { cached_input_tokens: usage.cached }
                : {}),
            },
          }),
    });
    turn = null;
    turnUsage = null;
  };

  const abortTurn = (
    reason: "interrupted" | "failed" | "cancelled",
    message?: string,
  ): void => {
    if (turn === null) return;
    emit({
      type: "turn.aborted",
      turn_id: turn.id,
      reason,
      ...(message === undefined ? {} : { message: clip(message, 256) }),
    });
    turn = null;
    turnUsage = null;
  };

  const onUser = (
    row: TJson,
    content: unknown,
    parent: string | undefined,
  ): void => {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        if (id === undefined) continue;
        const tool = tools.get(id);
        tools.delete(id);
        taskPrompts.delete(id);
        const output = toolResultText(block.content);
        const failed = block.is_error === true;
        // A background subagent's result is only its launch ack: the call
        // stays in progress (marked background) until the subagent finishes.
        if (
          !failed &&
          tool !== undefined &&
          SUBAGENT_TOOL_NAMES.has(tool.toolName) &&
          isAsyncLaunchAck(row, output)
        ) {
          const owner = tool.parent ?? parent;
          background.set(id, {
            toolName: tool.toolName,
            input: tool.input,
            ...(owner === undefined ? {} : { parent: owner }),
          });
          item(
            "item.updated",
            id,
            {
              kind: "tool_call",
              tool_name: tool.toolName,
              input: tool.input,
              status: "in_progress",
              background: true,
            },
            owner,
          );
          continue;
        }
        const at = timestampOf(row);
        const exit = EXIT_CODE.exec(output);
        const denied = failed && DENIED.test(output);
        item(
          "item.completed",
          id,
          {
            kind: "tool_call",
            tool_name: tool?.toolName ?? "tool",
            ...(tool === undefined ? {} : { input: tool.input }),
            status: failed ? "failed" : "completed",
            output: clip(output, args.toolOutputMax),
            ...(failed ? { is_error: true } : {}),
            ...(denied ? { denied: true } : {}),
            ...(tool !== undefined &&
            tool.at !== null &&
            at !== null &&
            at >= tool.at
              ? { duration_ms: at - tool.at }
              : {}),
            ...(exit?.[1] !== undefined
              ? { exit_code: Number(exit[1]) }
              : tool?.toolName === "Bash" && !failed
                ? { exit_code: 0 }
                : {}),
          },
          tool?.parent ?? parent,
        );
      }
    }
    // A subagent's own prompt and its user rows are not turns.
    if (parent !== undefined) return;
    const raw = promptOf(content);
    if (raw === null) return;
    const notification = parseTaskNotification(raw);
    if (notification !== null) {
      onTaskNotification(row, notification);
      return;
    }
    if (raw.trimStart().startsWith(INTERRUPTED)) {
      if (turn !== null)
        notice(`${str(row.uuid) ?? turn.id}:interrupted`, "interrupted");
      abortTurn("interrupted");
      return;
    }
    // `/model` (from the web's set_model or typed in the terminal) answers
    // with "Set model to `<id>`": the session's model, from Claude's record.
    // Match before normalize — the wrapper tags are the signal.
    const switched = MODEL_SET.exec(raw.trim());
    if (switched?.[1] !== undefined) {
      emit({ type: "session.configured", model: switched[1] });
      notice(
        `${str(row.uuid) ?? `m${turnCounter}`}:model`,
        "model_changed",
        switched[1],
      );
      onLocalCommandDone();
      return;
    }
    // Known slash-command / hook / system-reminder wrappers are not prompts.
    // A real prompt may legitimately start with markup, so do not treat every
    // `<...>` row as a wrapper. `pasted_content` is unwrapped by normalize.
    const trimmedRaw = raw.trim();
    if (LOCAL_COMMAND_OUTPUT.test(trimmedRaw)) {
      onLocalCommandDone();
      return;
    }
    if (
      row.isCompactSummary === true ||
      CLAUDE_CONTROL_WRAPPER.test(trimmedRaw)
    )
      return;
    const prompt = normalizeUserPromptText(raw);
    if (prompt === "") return;
    if (turn?.awaitingPromptLine === true) {
      // Recorded as a prompt: the model answers it (a `/path` too).
      turn.awaitingPromptLine = false;
      turn.modelRun = true;
      return;
    }
    // A new prompt (terminal input, or the next turn of a replayed history)
    // closes whatever turn is still open.
    completeTurn();
    openTurn(prompt, false);
  };

  /**
   * A local slash command wrote its output: the turn it opened is over (no
   * Stop hook runs for a command the model never saw).
   */
  const onLocalCommandDone = (): void => {
    if (turn === null || turn.command === null || turn.answered) return;
    completeTurn(LOCAL_COMMAND_STOP_REASON);
  };

  /** A background task stopped: finish its call, mark the transcript. */
  const onTaskNotification = (row: TJson, note: TTaskNotification): void => {
    const call = background.get(note.toolUseId);
    // Not a subagent this parser saw launch (a shell task, or a call cut
    // away by a history page): nothing to link the marker to.
    if (call === undefined) return;
    background.delete(note.toolUseId);
    const failed = note.status !== "completed";
    item(
      "item.completed",
      note.toolUseId,
      {
        kind: "tool_call",
        tool_name: call.toolName,
        input: call.input,
        status: failed ? "failed" : "completed",
        background: true,
        ...(note.result === undefined
          ? {}
          : { output: clip(note.result, args.toolOutputMax) }),
        ...(failed ? { is_error: true } : {}),
      },
      call.parent,
    );
    item(
      "item.completed",
      `${str(row.uuid) ?? note.toolUseId}:subagent-finished`,
      {
        kind: "notice",
        notice: "subagent_finished",
        ref_item_id: note.toolUseId,
        ...(failed ? { text: note.status } : {}),
      },
      call.parent,
    );
  };

  const onAssistant = (
    row: TJson,
    message: TJson,
    parent: string | undefined,
  ): void => {
    const content = message.content;
    const base = str(row.uuid) ?? str(message.id) ?? `m${turnCounter}`;
    if (parent === undefined && turn !== null) {
      turn.modelRun = true;
      turn.answered = true;
    }
    // An API failure Claude records as an assistant message is an error
    // marker, not the model's speech.
    if (row.isApiErrorMessage === true) {
      const text = Array.isArray(content)
        ? content
            .map((block) => (isRecord(block) ? (str(block.text) ?? "") : ""))
            .join("\n")
        : (str(content) ?? "");
      notice(`${base}:error`, "error", text.trim() || undefined);
      return;
    }
    if (Array.isArray(content)) {
      content.forEach((block, index) => {
        if (!isRecord(block)) return;
        const id = `${base}:${index}`;
        if (block.type === "text") {
          const text = str(block.text) ?? "";
          if (text.trim() !== "") lastText = text;
          if (text.trim() !== "")
            item(
              "item.completed",
              id,
              { kind: "assistant_message", text },
              parent,
            );
        } else if (block.type === "thinking") {
          const text = str(block.thinking) ?? "";
          if (text.trim() !== "")
            item("item.completed", id, { kind: "reasoning", text }, parent);
        } else if (block.type === "tool_use") {
          const toolId = str(block.id) ?? id;
          const toolName = toolNameOf(block.name);
          tools.set(toolId, {
            toolName,
            input: block.input,
            at: timestampOf(row),
            ...(parent === undefined ? {} : { parent }),
          });
          if (SUBAGENT_TOOL_NAMES.has(toolName) && isRecord(block.input)) {
            const prompt = str(block.input.prompt);
            if (prompt !== undefined) taskPrompts.set(toolId, prompt.trim());
          }
          item(
            "item.started",
            toolId,
            {
              kind: "tool_call",
              tool_name: toolName,
              input: block.input,
              status: "in_progress",
            },
            parent,
          );
          args.onToolUse?.(toolId, toolName, block.input);
        }
      });
    } else if (typeof content === "string" && content.trim() !== "") {
      item(
        "item.completed",
        base,
        { kind: "assistant_message", text: content },
        parent,
      );
    }
    if (parent !== undefined) {
      // A background subagent's own file ends: its final message is the
      // call's result (the parent's tool_result was only the launch ack).
      const call = args.backgroundCall;
      if (
        call !== undefined &&
        args.parentItemId !== undefined &&
        message.stop_reason === "end_turn" &&
        lastText !== null
      )
        emit({
          type: "item.completed",
          item_id: args.parentItemId,
          item: {
            kind: "tool_call",
            tool_name: call.toolName,
            input: call.input,
            status: "completed",
            background: true,
            output: clip(lastText, args.toolOutputMax),
          },
          ...turnField(),
          ...(call.parentItemId === undefined
            ? {}
            : { parent_item_id: call.parentItemId }),
        });
      return;
    }
    const usage = message.usage;
    if (isRecord(usage)) {
      const cached =
        num(usage.cache_read_input_tokens) +
        num(usage.cache_creation_input_tokens);
      const input = num(usage.input_tokens) + cached;
      const output = num(usage.output_tokens);
      emit({
        type: "thread.token-usage.updated",
        usage: {
          input_tokens: input,
          output_tokens: output,
          ...(cached > 0 ? { cached_input_tokens: cached } : {}),
        },
      });
      if (turn !== null) {
        turnUsage = {
          input,
          cached,
          output: (turnUsage?.output ?? 0) + output,
        };
      }
    }
    if (message.stop_reason === "end_turn") completeTurn();
  };

  /** The Task call an inline sidechain row belongs to, or null. */
  const sidechainOf = (row: TJson, message: TJson): string | null => {
    const uuid = str(row.uuid);
    const parentUuid = str(row.parentUuid);
    let owner =
      parentUuid === undefined ? undefined : sidechainParent.get(parentUuid);
    if (owner === undefined && row.type === "user") {
      const prompt = promptOf(message.content)?.trim();
      if (prompt !== undefined) {
        for (const [toolId, taskPrompt] of taskPrompts) {
          if (taskPrompt !== prompt) continue;
          owner = toolId;
          taskPrompts.delete(toolId);
          break;
        }
      }
    }
    if (owner === undefined) return null;
    if (uuid !== undefined) sidechainParent.set(uuid, owner);
    return owner;
  };

  const onLine = (line: string): void => {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(row)) return;
    if (row.isMeta === true) {
      // A prompt-type slash command (`/init`, a skill) expands into a meta
      // prompt row: the model runs for it, and its Stop ends the turn.
      if (row.type === "user" && turn !== null && turn.command !== null)
        turn.modelRun = true;
      return;
    }
    if (args.parentItemId === undefined) {
      // A local command's output can also be a system row
      // (`/context`, a forked skill's launch).
      if (row.type === "system" && row.subtype === "local_command") {
        onLocalCommandDone();
        return;
      }
      // Claude names the conversation with an `ai-title` row (rewritten as
      // it learns more): the title every viewer shows for this session.
      if (row.type === "ai-title" && typeof row.aiTitle === "string") {
        const title = row.aiTitle.trim().slice(0, 256);
        if (title !== "" && title !== lastTitle) {
          lastTitle = title;
          emit({ type: "session.configured", title });
        }
        return;
      }
      if (row.type === "system" && row.subtype === "compact_boundary") {
        const trigger = isRecord(row.compactMetadata)
          ? str(row.compactMetadata.trigger)
          : undefined;
        notice(
          `${str(row.uuid) ?? `c${turnCounter}`}:compacted`,
          "compacted",
          trigger === "auto" ? "automatically" : undefined,
        );
        return;
      }
    }
    // A message delivered mid-turn (Claude's queue, or the web's Send now) is
    // recorded as a `queued_command` attachment, not a user row: the model
    // takes it up now, so it opens the next turn the way a prompt does.
    if (
      row.type === "attachment" &&
      args.parentItemId === undefined &&
      row.isSidechain !== true &&
      isRecord(row.attachment) &&
      row.attachment.type === "queued_command" &&
      row.attachment.isMeta !== true
    ) {
      const raw = promptOf(row.attachment.prompt);
      const prompt = raw === null ? "" : normalizeUserPromptText(raw);
      if (prompt === "") return;
      completeTurn();
      openTurn(prompt, false);
      return;
    }
    const message = row.message;
    if (!isRecord(message)) return;
    let parent = args.parentItemId;
    if (parent === undefined && row.isSidechain === true) {
      const owner = sidechainOf(row, message);
      // A sidechain whose Task call is not in view (cut by a page) is dropped.
      if (owner === null) return;
      parent = owner;
    }
    if (row.type === "user") onUser(row, message.content, parent);
    else if (row.type === "assistant") onAssistant(row, message, parent);
  };

  return {
    push: (text) => {
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") onLine(line);
        newline = buffer.indexOf("\n");
      }
    },
    startTurn: (prompt, attachments) => openTurn(prompt, true, attachments),
    completeTurn,
    abortTurn,
    turnActive: () => turn !== null,
    quietLocalCommand: () =>
      turn !== null &&
      turn.command !== null &&
      !turn.modelRun &&
      !SLOW_LOCAL_COMMANDS.has(turn.command),
    turnField,
    turnCount: () => turnCounter,
  };
};

/** Events for a whole transcript text (tests, one-shot replays). */
export const claudeTranscriptEvents = (raw: string): TAgentEvent[] => {
  const events: TAgentEvent[] = [];
  const parser = createTranscriptParser({
    emit: (event) => events.push(event),
    toolOutputMax: 64 * 1024,
  });
  parser.push(raw.endsWith("\n") ? raw : `${raw}\n`);
  return events;
};
