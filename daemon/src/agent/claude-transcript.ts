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
import { normalizeUserPromptText } from "@openllmsh/protocol";
import { claudeConfigDir } from "../local-sessions/paths";

/** Bytes read per poll at most (a burst is drained over several polls). */
const READ_CHUNK_BYTES = 1024 * 1024;
/** Re-scan the projects tree for a missing transcript at most this often. */
const SCAN_INTERVAL_MS = 2_000;

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
        // Never split a UTF-8 sequence: stop at the last newline when possible.
        let usable = read;
        const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
        if (lastNewline >= 0) usable = lastNewline + 1;
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
  readonly completeTurn: () => void;
  readonly abortTurn: (reason: "interrupted" | "failed" | "cancelled") => void;
  readonly turnActive: () => boolean;
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
  readonly onToolUse?: (toolUseId: string, toolName: string) => void;
};

export const createTranscriptParser = (
  args: TTranscriptParserOptions,
): TTranscriptParser => {
  const { emit } = args;
  let buffer = "";
  let turnCounter = args.firstTurn ?? 0;
  let turn: { id: string; awaitingPromptLine: boolean } | null = null;
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

  const turnField = (): { turn_id?: string } => {
    if (args.turnId !== undefined) {
      const id = args.turnId();
      return id === undefined ? {} : { turn_id: id };
    }
    return turn === null ? {} : { turn_id: turn.id };
  };

  const item = (
    type: "item.started" | "item.completed",
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
        ...(text === undefined ? {} : { text: clip(text, 16 * 1024) }),
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
    turn = { id: `t${turnCounter}`, awaitingPromptLine };
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

  const completeTurn = (): void => {
    if (turn === null) return;
    const usage = turnUsage;
    emit({
      type: "turn.completed",
      turn_id: turn.id,
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

  const abortTurn = (reason: "interrupted" | "failed" | "cancelled"): void => {
    if (turn === null) return;
    emit({ type: "turn.aborted", turn_id: turn.id, reason });
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
      return;
    }
    // Slash-command / hook / system-reminder wrappers are not prompts.
    // Check the trimmed raw form so a leading newline before `<command-…>`
    // still drops the row; `pasted_content` is unwrapped by normalize.
    const trimmedRaw = raw.trim();
    if (trimmedRaw.startsWith("<") || row.isCompactSummary === true) {
      // `<pasted_content>` is a real prompt — fall through after normalize.
      if (!/^<pasted_content\b/i.test(trimmedRaw)) return;
    }
    const prompt = normalizeUserPromptText(raw);
    if (prompt === "") return;
    if (turn?.awaitingPromptLine === true) {
      turn.awaitingPromptLine = false;
      return;
    }
    // A new prompt (terminal input, or the next turn of a replayed history)
    // closes whatever turn is still open.
    completeTurn();
    openTurn(prompt, false);
  };

  const onAssistant = (
    row: TJson,
    message: TJson,
    parent: string | undefined,
  ): void => {
    const content = message.content;
    const base = str(row.uuid) ?? str(message.id) ?? `m${turnCounter}`;
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
          const toolName = str(block.name) ?? "tool";
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
          args.onToolUse?.(toolId, toolName);
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
    if (parent !== undefined) return;
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
    if (!isRecord(row) || row.isMeta === true) return;
    if (args.parentItemId === undefined) {
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
