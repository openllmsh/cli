/**
 * Claude Code engine adapter for agent sessions: ONE runtime, two views.
 *
 * The engine is the interactive Claude TUI running under the durable
 * session-host (`openllm __session-host`), the same PTY host a terminal
 * `openllm claude` gets. So a web-started session is attachable from the
 * terminal (`openllm sessions attach`), and a terminal-started session is
 * attachable from the web: the session id IS the host id IS Claude's session
 * id (the host pins `--session-id` on a new Claude session).
 *
 * The daemon drives it as a hidden OBSERVER consumer of the host's ctl.sock
 * (never a viewer: no resize, no primacy, never counts as attached for the
 * host's detach / idle reap). The PTY carries input; the screen is read for
 * ONE thing only, Claude's folder-trust dialog (below). Content, readiness and
 * turn state never come from the screen.
 *   - input: prompts are bracketed-pasted into the PTY then submitted with CR,
 *     exactly like a keystroke; interrupt is Esc; attachments are written to
 *     the host's 0700 session dir and referenced as `@<path>`;
 *   - output: structured items come from Claude's own transcript
 *     (`~/.claude/projects/<slug>/<id>.jsonl`, appended per message), tailed;
 *   - readiness, busy/idle + approvals: Claude hooks (`openllm exec agent
 *     hook`) post to the daemon loopback (`/local/agent-hook`, local control
 *     capability). A freshly spawned TUI takes input only after its
 *     `SessionStart` hook (plus a short settle); an attached, already-running
 *     TUI is ready at once;
 *   - folder trust: the one screen read. Claude asks before its first run in a
 *     folder; the dialog becomes a web approval and the answer is typed back.
 *     A PermissionRequest waits for a web decision; with no viewer, or after
 *     {@link AGENT_APPROVAL_WAIT_MS}, it returns NO decision and Claude shows
 *     its native dialog in the terminal. A timeout never allows.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type {
  TAgentAttachmentMeta,
  TAgentEvent,
  TAgentRequestKind,
  TAgentRespondCommand,
  TAgentUserInputAnswers,
  TAgentUserInputQuestion,
} from "@openllmsh/protocol";
import {
  AGENT_MAX_ATTACHMENT_BASE64_LENGTH,
  AGENT_MAX_ATTACHMENT_BYTES,
  AGENT_MAX_LINE_BYTES,
  AGENT_SWITCH_MODEL_PATTERN,
  SESSION_ID_PATTERN,
} from "@openllmsh/protocol";
import { stateDir } from "../env";
import { readClaudeSessionIdUnderPid } from "../local-sessions/claude";
import { logError } from "../logger";
import { defaultSessionHostClient } from "../session-host-proc";
import { createClaudeHistory } from "./claude-history";
import {
  createSubagentFollower,
  subagentDirOf,
  subagentEvents,
} from "./claude-subagents";
import type { TClaudeTranscriptTail } from "./claude-transcript";
import {
  createClaudeTranscriptTail,
  createTranscriptParser,
  findClaudeTranscript,
  SUBAGENT_TOOL_NAMES,
} from "./claude-transcript";
import { historyCursorOf, latestReplayWindow } from "./history-window";
import type {
  TAgentEngineAdapter,
  TAgentEngineEmit,
  TAgentEngineSession,
  TAgentEngineStartOptions,
  TAgentSendInput,
  TAgentSendResult,
} from "./types";

/** Tool output kept on an item (the full result stays in the engine). */
export const AGENT_TOOL_OUTPUT_MAX_CHARS = 64 * 1024;
/** How long a PermissionRequest waits for a web decision before the TUI asks. */
export const AGENT_APPROVAL_WAIT_MS = 90_000;
/**
 * How long a fresh TUI may take to report `SessionStart` before the web is
 * told it is waiting in the terminal. The queued prompt is NOT pasted then:
 * an unanswered dialog would take the keystrokes.
 */
const READY_MAX_MS = 30_000;
/** Settle after `SessionStart` before the first paste (the input box mounts). */
const READY_SETTLE_MS = 300;
/**
 * Claude runs the Stop hook BEFORE the turn's last assistant line reaches the
 * transcript. The transcript's own `end_turn` completes the turn; Stop only
 * completes it if the transcript has not within this grace.
 */
const STOP_GRACE_MS = 3_000;
/** After Stop, how long before typing `/model` (other Stop hooks still run). */
/**
 * Mid-conversation, Claude asks "Switch model?" (cache re-read) with "Yes"
 * preselected. If the switch is not confirmed in the transcript by then, one
 * more Enter confirms it; with no dialog an Enter on the empty prompt is a
 * no-op. Decided from the transcript, never from the screen.
 */
const MODEL_CONFIRM_MS = 1_500;
const STOP_SETTLE_MS = 500;
/** Gap between the bracketed paste and the submitting CR. */
const SUBMIT_DELAY_MS = 80;
/**
 * Events one transcript drain emits at most. Attach replays a terminal
 * session's WHOLE transcript; a long one is cut at a turn boundary so it fits
 * the dispatcher's replay log and never floods a consumer into `lagging`.
 */
const REPLAY_MAX_EVENTS = 1_500;
/** Transcript chunks one drain reads at most (1 MiB each). */
const DRAIN_MAX_CHUNKS = 512;
const TRANSCRIPT_POLL_MS = 250;

const DETAIL_MAX = 16 * 1024;
const SHORT_MAX = 256;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

type TJson = Record<string, unknown>;

const isRecord = (value: unknown): value is TJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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

/** Protocol answers → the AskUserQuestion input Claude accepts (`answers`). */
export const claudeAnswersInputOf = (
  input: unknown,
  answers: TAgentUserInputAnswers,
): TJson => ({
  ...(isRecord(input) ? input : {}),
  answers: claudeAnswersOf(input, answers),
});

export { requestDetailOf, toolTitleOf };

// ─── PTY link ────────────────────────────────────────────────────────────

/**
 * The daemon's observer connection to a session-host PTY. Output is consumed
 * only by the folder-trust detector.
 */
export type TPtyLink = {
  /** The session-host id (its Claude hooks report it as the session). */
  readonly hostId: string;
  /**
   * True when this link spawned the TUI (it still has to boot and report
   * `SessionStart`); false when it joined one that is already running.
   */
  readonly fresh: boolean;
  readonly write: (bytes: Uint8Array) => void;
  /** End the session (kill the PTY). */
  readonly kill: () => void;
  /** Drop the observer; the PTY keeps running. */
  readonly release: () => void;
  readonly onOutput: (handler: (bytes: Uint8Array) => void) => void;
  /** The PTY or the host went away (not fired after `release`). */
  readonly onExit: (handler: (code: number | null) => void) => void;
};

export type TPtyLinkRequest = {
  readonly sessionId: string;
  readonly resume: boolean;
  readonly cwd: string;
  readonly skipPermissions: boolean;
  readonly model?: string;
  readonly title?: string;
};

/** Attach (or spawn, then attach) the session's host. Null → unavailable. */
export type TOpenPtyLink = (
  request: TPtyLinkRequest,
) => Promise<TPtyLink | null>;

const textEncoder = new TextEncoder();
const OBSERVER_COLS = 120;
const OBSERVER_ROWS = 40;

/** Dial a host's ctl.sock as a structured observer. */
export const dialObserver = (
  socketPath: string,
  sessionId: string,
  fresh: boolean,
): Promise<TPtyLink | null> =>
  new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws+unix://${socketPath}`);
    } catch {
      resolve(null);
      return;
    }
    ws.binaryType = "arraybuffer";
    const outputHandlers: ((bytes: Uint8Array) => void)[] = [];
    const exitHandlers: ((code: number | null) => void)[] = [];
    let opened = false;
    let released = false;
    let exitCode: number | null = null;
    const settleTimer = setTimeout(() => {
      if (!opened) {
        try {
          ws.close();
        } catch {}
        resolve(null);
      }
    }, 5_000);
    const link: TPtyLink = {
      hostId: sessionId,
      fresh,
      write: (bytes) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(bytes));
      },
      kill: () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({ t: "ctrl", p: { t: "close", intent: "kill" } }),
          );
      },
      release: () => {
        released = true;
        try {
          ws.close();
        } catch {}
      },
      onOutput: (handler) => {
        outputHandlers.push(handler);
      },
      onExit: (handler) => {
        exitHandlers.push(handler);
      },
    };
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: "open",
          open: {
            session_id: sessionId,
            cli: "claude_code",
            cols: OBSERVER_COLS,
            rows: OBSERVER_ROWS,
            mode: "attach",
            observer: true,
          },
        }),
      );
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        for (const handler of outputHandlers) handler(bytes);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.t === "exit" && typeof message.code === "number")
        exitCode = message.code;
      if (message.t === "ctrl" && isRecord(message.p)) {
        if (message.p.t === "open_ack" && !opened) {
          clearTimeout(settleTimer);
          if (message.p.ok === true) {
            opened = true;
            resolve(link);
          } else {
            resolve(null);
          }
        }
      }
    };
    ws.onclose = () => {
      clearTimeout(settleTimer);
      if (!opened) {
        resolve(null);
        return;
      }
      if (released) return;
      for (const handler of exitHandlers) handler(exitCode);
    };
    ws.onerror = () => {};
  });

/** Production link: join the live host for this id, else spawn one. */
const defaultOpenPtyLink: TOpenPtyLink = async (request) => {
  if (!SESSION_ID_PATTERN.test(request.sessionId)) return null;
  const hosts = await defaultSessionHostClient.discoverSessionHosts();
  // A terminal `openllm claude --resume X` runs under its own host id with
  // Claude session X: match either, so the web never forks a second process.
  const claudeHosts = hosts.filter((host) => host.cli === "claude_code");
  // A terminal run whose live meta has no (or a stale) Claude id is matched
  // by the id its TUI is on right now (`~/.claude/sessions/<pid>.json`).
  const live =
    claudeHosts.find(
      (host) =>
        host.id === request.sessionId ||
        host.vendorSessionId === request.sessionId,
    ) ??
    claudeHosts.find(
      (host) => readClaudeSessionIdUnderPid(host.pid) === request.sessionId,
    );
  if (live !== undefined) return dialObserver(live.socketPath, live.id, false);
  // Not running and nothing on disk to resume (a web start that never reached
  // Claude, or an id this device never ran): `claude --resume` would exit at
  // once with "No conversation found". Start that id fresh instead (the host
  // pins `--session-id`), so the attach has a defined outcome.
  const resumable =
    request.resume &&
    findClaudeTranscript(request.sessionId, undefined, request.cwd) !== null;
  const socketPath = await defaultSessionHostClient.spawnSessionHostProc({
    id: request.sessionId,
    cli: "claude_code",
    cols: OBSERVER_COLS,
    rows: OBSERVER_ROWS,
    cwd: request.cwd,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.skipPermissions ? { dangerous: true } : {}),
    ...(resumable ? { resume: request.sessionId } : {}),
    ...(request.model === undefined
      ? {}
      : { vendorArgs: ["--model", request.model] }),
  });
  return socketPath === null
    ? null
    : dialObserver(socketPath, request.sessionId, true);
};

/**
 * The events of one transcript drain to emit: all of them, or for a long
 * history the newest whole turns that fit `max` (cut at a `turn.started`),
 * keeping the latest title / model the cut part configured.
 */
export const replayWindow = (
  events: readonly TAgentEvent[],
  max: number = REPLAY_MAX_EVENTS,
): TAgentEvent[] => {
  if (events.length <= max) return [...events];
  let start = events.length - max;
  while (start < events.length && events[start]?.type !== "turn.started")
    start += 1;
  if (start === events.length) start = events.length - max;
  const carried: TAgentEvent[] = [];
  let title: TAgentEvent | null = null;
  let model: TAgentEvent | null = null;
  for (const event of events.slice(0, start)) {
    if (event.type !== "session.configured") continue;
    if (event.title !== undefined) title = event;
    if (event.model !== undefined) model = event;
  }
  if (title !== null) carried.push(title);
  if (model !== null && model !== title) carried.push(model);
  return [...carried, ...events.slice(start)];
};

/**
 * The Claude session id the TUI behind agent session `sessionId` is on now.
 * For a host this daemon spawned it is the host id; for a terminal
 * `openllm claude` run it is NOT (the host id is the launcher's own), and a
 * `/clear` or `/resume` moves it. Read from the host's meta (pid) and Claude's
 * own per-process record. Null → no live host: `sessionId` is Claude's id.
 */
export const currentClaudeSessionIdOf = (sessionId: string): string | null => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(
      readFileSync(
        join(stateDir(), "sessions", sessionId, "meta.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
  if (!isRecord(meta) || typeof meta.pid !== "number") return null;
  const vendor =
    typeof meta.vendorSessionId === "string" ? meta.vendorSessionId : null;
  return readClaudeSessionIdUnderPid(meta.pid) ?? vendor;
};

/**
 * Kill the session-host running this Claude session (web- or terminal-
 * started), then wait briefly for it to go away so Claude does not write its
 * transcript again after a delete. True when nothing is left running.
 */
export const killClaudeSessionHost = async (
  sessionId: string,
  waitMs = 3_000,
): Promise<boolean> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  const find = async (): Promise<
    | Awaited<
        ReturnType<typeof defaultSessionHostClient.discoverSessionHosts>
      >[number]
    | undefined
  > =>
    (await defaultSessionHostClient.discoverSessionHosts()).find(
      (host) =>
        host.cli === "claude_code" &&
        (host.id === sessionId || host.vendorSessionId === sessionId),
    );
  const live = await find();
  if (live === undefined) return true;
  const link = await dialObserver(live.socketPath, live.id, false);
  if (link === null) return false;
  link.kill();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if ((await find()) === undefined) {
      link.release();
      return true;
    }
  }
  link.release();
  return false;
};

// ─── hooks → sessions ──────────────────────────────────────────────────────

/** What a hook asked; the reply is Claude's hook stdout JSON (or none). */
type THookHandler = (event: string, payload: TJson) => Promise<TJson | null>;

const hookHandlers = new Map<string, THookHandler>();

/**
 * Route one Claude hook call to its agent session. Null = no decision / no
 * output (the hook prints nothing and Claude carries on natively).
 */
export const handleAgentHook = async (
  sessionId: string,
  event: string,
  payload: TJson,
): Promise<TJson | null> => {
  const handler = hookHandlers.get(sessionId);
  if (handler === undefined) return null;
  try {
    return await handler(event, payload);
  } catch (err) {
    logError("agent", err);
    return null;
  }
};

// ─── attachments ─────────────────────────────────────────────────────────

/** The per-session attachment dir (inside the host's 0700 session dir). */
export const agentAttachmentsDir = (sessionId: string): string =>
  join(stateDir(), "sessions", sessionId, "attachments");

/** Parent of every per-session attachments dir. */
export const agentSessionsDir = (): string => join(stateDir(), "sessions");

/** A filename safe to place in the attachment dir and to `@`-reference. */
export const sanitizeAttachmentName = (name: string | undefined): string => {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[.]+/, "")
    .slice(0, 100);
  return cleaned.length === 0 ? "attachment" : cleaned;
};

const extensionOf = (mediaType: string): string => {
  const sub = mediaType.split("/")[1] ?? "";
  if (sub === "jpeg") return ".jpg";
  if (sub === "plain") return ".txt";
  return /^[a-z0-9]{1,8}$/.test(sub) ? `.${sub}` : "";
};

export type TWrittenAgentAttachment = {
  readonly path: string;
  readonly meta: TAgentAttachmentMeta;
};

/** Write attachments; return their absolute paths + metadata for turn events. */
export const writeAgentAttachments = (
  dir: string,
  attachments: TAgentSendInput["attachments"],
  counter: { value: number },
): TWrittenAgentAttachment[] => {
  if (attachments.length === 0) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return attachments.map((attachment) => {
    counter.value += 1;
    let name = sanitizeAttachmentName(attachment.name);
    if (!name.includes(".")) name += extensionOf(attachment.media_type);
    const storedName = `${counter.value}-${name}`;
    const path = join(dir, storedName);
    const bytes = Buffer.from(attachment.data, "base64");
    writeFileSync(path, bytes, { mode: 0o600 });
    return {
      path,
      meta: {
        name: storedName,
        mime: attachment.media_type,
        size: bytes.byteLength,
      },
    };
  });
};

/** Delete one session's attachments dir (history delete / kill path). */
export const deleteAgentAttachments = (sessionId: string): void => {
  try {
    rmSync(agentAttachmentsDir(sessionId), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
};

/**
 * True when `name` is a bare basename with no traversal / absolute / separator
 * characters. The on-disk resolve still double-checks with realpath.
 */
export const isSafeAttachmentBasename = (name: string): boolean => {
  if (name.length === 0 || name.length > 256) return false;
  if (name === "." || name === "..") return false;
  if (isAbsolute(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0"))
    return false;
  if (name.includes("..")) return false;
  return basename(name) === name;
};

export type TResolvedAgentAttachment =
  | {
      readonly ok: true;
      readonly path: string;
      readonly mime: string;
      readonly size: number;
      readonly bytes: Buffer;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

const mimeOfStoredName = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  return "application/octet-stream";
};

/**
 * Resolve `name` inside `sessionId`'s attachments dir. Refuses path separators,
 * `..`, absolute paths, missing files, oversize files, and symlinks that escape
 * the dir (realpath must stay under the attachments dir).
 */
export const resolveAgentAttachment = (
  sessionId: string,
  name: string,
  options: { readonly attachmentsDir?: string } = {},
): TResolvedAgentAttachment => {
  if (!isSafeAttachmentBasename(name)) {
    return {
      ok: false,
      code: "attachment_forbidden",
      message: "attachment name is not allowed",
    };
  }
  const dir = options.attachmentsDir ?? agentAttachmentsDir(sessionId);
  let dirReal: string;
  try {
    if (!existsSync(dir)) {
      return {
        ok: false,
        code: "attachment_not_found",
        message: "attachment not found",
      };
    }
    dirReal = realpathSync(dir);
  } catch {
    return {
      ok: false,
      code: "attachment_not_found",
      message: "attachment not found",
    };
  }
  const candidate = resolve(dirReal, name);
  if (!candidate.startsWith(`${dirReal}${sep}`) && candidate !== dirReal) {
    return {
      ok: false,
      code: "attachment_forbidden",
      message: "attachment name is not allowed",
    };
  }
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(candidate);
      if (!target.startsWith(`${dirReal}${sep}`)) {
        return {
          ok: false,
          code: "attachment_forbidden",
          message: "attachment name is not allowed",
        };
      }
    } else if (!stat.isFile()) {
      return {
        ok: false,
        code: "attachment_not_found",
        message: "attachment not found",
      };
    }
    if (stat.size > AGENT_MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        code: "attachment_too_large",
        message: "attachment exceeds the size cap",
      };
    }
    const path = realpathSync(candidate);
    if (!path.startsWith(`${dirReal}${sep}`)) {
      return {
        ok: false,
        code: "attachment_forbidden",
        message: "attachment name is not allowed",
      };
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength > AGENT_MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        code: "attachment_too_large",
        message: "attachment exceeds the size cap",
      };
    }
    return {
      ok: true,
      path,
      mime: mimeOfStoredName(name),
      size: bytes.byteLength,
      bytes,
    };
  } catch {
    return {
      ok: false,
      code: "attachment_not_found",
      message: "attachment not found",
    };
  }
};

/**
 * Base64 payload budget per `attachment.data` line: leave headroom under
 * {@link AGENT_MAX_LINE_BYTES} for JSON framing around the chunk.
 */
export const AGENT_ATTACHMENT_CHUNK_BASE64_CHARS = Math.min(
  AGENT_MAX_ATTACHMENT_BASE64_LENGTH,
  Math.max(64 * 1024, AGENT_MAX_LINE_BYTES - 512),
);

export type TAgentAttachmentChunk = {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly offset: number;
  readonly data: string;
  readonly done: boolean;
};

/** Split a resolved attachment into NDJSON-safe base64 chunks. */
export const chunkAgentAttachment = (
  name: string,
  mime: string,
  bytes: Buffer,
  maxBase64Chars: number = AGENT_ATTACHMENT_CHUNK_BASE64_CHARS,
): readonly TAgentAttachmentChunk[] => {
  const size = bytes.byteLength;
  // 3 raw bytes → 4 base64 chars; keep chunks aligned.
  const rawPerChunk = Math.max(3, Math.floor(maxBase64Chars / 4) * 3);
  if (size === 0) {
    return [{ name, mime, size, offset: 0, data: "", done: true }];
  }
  const chunks: TAgentAttachmentChunk[] = [];
  for (let offset = 0; offset < size; offset += rawPerChunk) {
    const end = Math.min(size, offset + rawPerChunk);
    chunks.push({
      name,
      mime,
      size,
      offset,
      data: bytes.subarray(offset, end).toString("base64"),
      done: end >= size,
    });
  }
  return chunks;
};

/**
 * Delete attachment dirs whose Claude transcript no longer exists. Live
 * sessions keep their dirs even if the transcript is briefly missing.
 */
export const reapOrphanAgentAttachments = (
  options: {
    readonly sessionsDir?: string;
    readonly liveSessionIds?: ReadonlySet<string>;
    readonly transcriptExists?: (sessionId: string) => boolean;
  } = {},
): readonly string[] => {
  const root = options.sessionsDir ?? agentSessionsDir();
  const live = options.liveSessionIds ?? new Set<string>();
  const transcriptExists =
    options.transcriptExists ??
    ((sessionId: string): boolean => findClaudeTranscript(sessionId) !== null);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const sessionId of entries) {
    if (live.has(sessionId)) continue;
    const attachments = join(root, sessionId, "attachments");
    if (!existsSync(attachments)) continue;
    if (transcriptExists(sessionId)) continue;
    try {
      rmSync(attachments, { recursive: true, force: true });
      deleted.push(sessionId);
    } catch {
      /* best-effort */
    }
  }
  return deleted;
};

// ─── the session ─────────────────────────────────────────────────────────

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC = "\x1b";
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*\u0007|${ESC}[()][A-Za-z0-9]`,
  "g",
);
/**
 * Claude's folder-trust dialog, matched with whitespace removed: the TUI lays
 * words out with cursor moves, so after ANSI stripping "Yes, I trust this
 * folder" can arrive as "Yes,Itrustthisfolder". Covers the current wording
 * and the older "Do you trust the files in this folder?".
 */
const TRUST_PROMPT = /trustthefilesinthisfolder|doyoutrust|itrustthisfolder/i;
/** Newer Claude lists "No, exit" first, with the cursor on it. */
const TRUST_CURSOR_ON_NO = /❯(?:\d+\.)?No\b/;
const DOWN_ARROW = "\x1b[B";
/**
 * The dialog takes keys only once its input handler is mounted, a beat after
 * the text paints. An instant web answer typed earlier is lost (measured:
 * keys sent with no delay left the dialog up), so answer no sooner than this
 * after detection.
 */
const TRUST_ANSWER_MIN_DELAY_MS = 500;

type TPending =
  | {
      readonly kind: "approval";
      readonly toolName: string;
      readonly input: unknown;
      readonly resolve: (reply: TJson | null) => void;
    }
  | {
      readonly kind: "user-input";
      readonly input: unknown;
      readonly resolve: (reply: TJson | null) => void;
    }
  | { readonly kind: "trust" };

export type TClaudeTuiDeps = {
  readonly openLink?: TOpenPtyLink;
  readonly transcript?: (sessionId: string) => TClaudeTranscriptTail;
  /** Claude's current id for a session (tests); see currentClaudeSessionIdOf. */
  readonly currentClaudeSessionId?: (sessionId: string) => string | null;
  /** `~/.claude/projects` override (tests). */
  readonly projectsDir?: string;
  /** Transcript re-resolve / re-scan cadence (tests). */
  readonly transcriptScanMs?: number;
  readonly approvalWaitMs?: number;
  readonly readyMaxMs?: number;
  readonly readySettleMs?: number;
  readonly submitDelayMs?: number;
  readonly pollMs?: number;
  readonly stopGraceMs?: number;
  readonly stopSettleMs?: number;
  readonly modelConfirmMs?: number;
  readonly trustAnswerDelayMs?: number;
  readonly attachmentsDir?: (sessionId: string) => string;
};

const permissionReply = (decision: TJson): TJson => ({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
});

/** Drive one Claude TUI session. Exported for tests (fake link + transcript). */
export const createClaudeTuiSession = (
  options: TAgentEngineStartOptions,
  emit: TAgentEngineEmit,
  deps: TClaudeTuiDeps = {},
): TAgentEngineSession => {
  const approvalWaitMs = deps.approvalWaitMs ?? AGENT_APPROVAL_WAIT_MS;
  const submitDelayMs = deps.submitDelayMs ?? SUBMIT_DELAY_MS;
  const attachmentsDir = (deps.attachmentsDir ?? agentAttachmentsDir)(
    options.sessionId,
  );
  const attachmentCounter = { value: 0 };
  let link: TPtyLink | null = null;
  let ended = false;
  let ready = false;
  /** Claude reported `SessionStart` (or any hook): the TUI is up. */
  let started = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let readyMaxTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const queued: (() => void)[] = [];
  let requestCounter = 0;
  const pending = new Map<string, TPending>();
  let trustRequestId: string | null = null;
  let trustAnswered = false;
  let trustSeenAt = 0;
  /** Whitespace-free, ANSI-stripped recent screen text (trust detection only). */
  let recentScreen = "";

  /** Events of the drain in progress (emitted, possibly cut, at its end). */
  let drained: TAgentEvent[] | null = null;
  const parser = createTranscriptParser({
    emit: (event) => {
      if (event.type === "session.configured") modelInFlight = false;
      if (drained !== null) drained.push(event);
      else emit(event);
    },
    toolOutputMax: AGENT_TOOL_OUTPUT_MAX_CHARS,
  });
  const currentId = deps.currentClaudeSessionId ?? currentClaudeSessionIdOf;
  const tail =
    deps.transcript?.(options.sessionId) ??
    createClaudeTranscriptTail(options.sessionId, {
      cwd: options.cwd,
      ...(deps.projectsDir === undefined
        ? {}
        : { projectsDir: deps.projectsDir }),
      ...(deps.transcriptScanMs === undefined
        ? {}
        : { scanIntervalMs: deps.transcriptScanMs }),
      // Resolve through the joined host (its pid leads to Claude's record):
      // the web may attach by Claude's id while the host has its own.
      currentId: () =>
        currentId(link?.hostId ?? options.sessionId) ??
        (link === null ? null : currentId(options.sessionId)),
      // `/clear` or `/resume` in the TUI: the old conversation is over.
      onSwitch: () => parser.completeTurn(),
    });

  /** A `/model` waiting for the session to be ready and idle. */
  let pendingModel: string | null = null;
  /** A `/model` typed and not yet confirmed by the transcript. */
  let modelInFlight = false;
  /**
   * A web turn is running until Claude's Stop hook: the transcript's end_turn
   * lands while Stop hooks still run, and keys typed then are lost.
   */
  let awaitingStop = false;
  const applyModel = (): void => {
    if (
      pendingModel === null ||
      !ready ||
      ended ||
      awaitingStop ||
      parser.turnActive()
    )
      return;
    const model = pendingModel;
    pendingModel = null;
    // Claude's own slash command, typed like any prompt (PTY input only).
    modelInFlight = true;
    writeText(`${PASTE_START}/model ${model}${PASTE_END}`);
    setTimeout(() => {
      if (!ended) writeText("\r");
    }, submitDelayMs);
    setTimeout(() => {
      if (!ended && modelInFlight) writeText("\r");
    }, deps.modelConfirmMs ?? MODEL_CONFIRM_MS);
  };

  const transcriptPath = (): string | null => tail.path?.() ?? null;
  /** Subagents (Task / Agent calls) followed live, nested under their call. */
  const subagents = createSubagentFollower({
    transcriptPath,
    emit: (event) => {
      if (drained !== null) drained.push(event);
      else emit(event);
    },
    toolOutputMax: AGENT_TOOL_OUTPUT_MAX_CHARS,
  });
  const history = createClaudeHistory({
    path: transcriptPath,
    toolOutputMax: AGENT_TOOL_OUTPUT_MAX_CHARS,
  });
  /**
   * The first drain of a resumed / attached session is its replay: windowed,
   * behind a history cursor. A new session has no history to page.
   */
  let replayed = !options.resume;

  /** Subagent calls of a drain: snapshot each, follow the unfinished ones. */
  const withSubagents = (events: readonly TAgentEvent[]): TAgentEvent[] => {
    const path = transcriptPath();
    const out: TAgentEvent[] = [];
    for (const event of events) {
      out.push(event);
      if (
        event.type !== "item.started" ||
        event.item.kind !== "tool_call" ||
        event.parent_item_id !== undefined ||
        !SUBAGENT_TOOL_NAMES.has(event.item.tool_name)
      )
        continue;
      const call = {
        toolName: event.item.tool_name,
        input: event.item.input,
      };
      if (path === null) {
        subagents.track(event.item_id, event.turn_id, undefined, call);
        continue;
      }
      const snapshot = subagentEvents({
        dir: subagentDirOf(path),
        toolUseId: event.item_id,
        turnId: event.turn_id,
        toolOutputMax: AGENT_TOOL_OUTPUT_MAX_CHARS,
        call,
      });
      out.push(...snapshot.events);
      if (!snapshot.finished)
        subagents.track(
          event.item_id,
          event.turn_id,
          snapshot.file === null
            ? undefined
            : { file: snapshot.file, offset: snapshot.readTo },
          call,
        );
    }
    return out;
  };

  /** Read everything the transcript has now (history on attach, then appends). */
  const pump = (): void => {
    drained = [];
    try {
      for (let chunk = 0; chunk < DRAIN_MAX_CHUNKS; chunk += 1) {
        const text = tail.read();
        if (text === null || text.length === 0) break;
        parser.push(text);
      }
      subagents.pump();
    } finally {
      const events = drained;
      drained = null;
      if (!replayed && events.length > 0) {
        // Attach / resume: only the latest window, then the cursor before it
        // (`history_get` pages the rest from the transcript index).
        replayed = true;
        const window = latestReplayWindow(events);
        const kept = new Set<string>();
        for (const event of window.events)
          if (event.type === "item.started") kept.add(event.item_id);
        subagents.retain(kept);
        emit({
          type: "history.page",
          has_more: window.hasMore,
          ...(window.firstTurnId === null
            ? {}
            : { before_cursor: historyCursorOf(window.firstTurnId) }),
        });
        for (const event of withSubagents(window.events)) emit(event);
      } else {
        for (const event of withSubagents(replayWindow(events))) emit(event);
      }
    }
    applyModel();
  };

  const finish = (
    reason: "closed" | "killed" | "completed" | "error",
    message?: string,
  ): void => {
    if (ended) return;
    ended = true;
    for (const key of hookKeys) hookHandlers.delete(key);
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    if (readyMaxTimer !== undefined) clearTimeout(readyMaxTimer);
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    try {
      pump();
    } catch {}
    for (const [id, request] of pending) {
      if (request.kind !== "trust") request.resolve(null);
      emit({ type: "request.resolved", request_id: id, decision: "cancel" });
    }
    pending.clear();
    parser.abortTurn("cancelled");
    // Attachments stay on disk across end / idle release so replay and
    // attachment_get still work. History delete (close) and the orphan
    // reaper remove them.
    emit({
      type: "session.exited",
      session_id: options.sessionId,
      reason,
      ...(message === undefined ? {} : { message }),
    });
  };

  const markReady = (): void => {
    if (ready || ended || trustRequestId !== null) return;
    ready = true;
    if (readyMaxTimer !== undefined) clearTimeout(readyMaxTimer);
    for (const run of queued.splice(0)) run();
    applyModel();
  };

  /**
   * Input opens once the link exists AND the TUI is up: an attached TUI is
   * already running; a fresh one has to report `SessionStart` first, then
   * settle for a beat while its input box mounts.
   */
  const maybeReady = (): void => {
    if (ready || ended || link === null || readyTimer !== undefined) return;
    if (!link.fresh) {
      markReady();
      return;
    }
    if (!started) return;
    readyTimer = setTimeout(markReady, deps.readySettleMs ?? READY_SETTLE_MS);
  };

  const whenReady = (run: () => void): void => {
    if (ready) run();
    else queued.push(run);
  };

  const writeText = (text: string): void => {
    link?.write(textEncoder.encode(text));
  };

  // Hooks from this session's Claude process (keyed by its host id).
  const hookKeys = new Set<string>([options.sessionId]);
  // The ONE screen read: Claude's folder-trust dialog. Input stays held (it is
  // asked before SessionStart) until the web answers it.
  const onOutput = (bytes: Uint8Array): void => {
    if (trustAnswered || ended) return;
    recentScreen = (
      recentScreen +
      new TextDecoder().decode(bytes).replace(ANSI, "").replace(/\s+/g, "")
    ).slice(-4096);
    if (trustRequestId !== null || !TRUST_PROMPT.test(recentScreen)) return;
    requestCounter += 1;
    trustRequestId = `trust${requestCounter}`;
    trustSeenAt = Date.now();
    pending.set(trustRequestId, { kind: "trust" });
    emit({
      type: "request.opened",
      request_id: trustRequestId,
      request_kind: "other",
      title: "Trust this folder?",
      detail: `Claude Code asks whether to trust the files in ${clip(options.cwd, 1024)}.`,
    });
  };

  const onHook: THookHandler = async (event, payload) => {
    pump();
    // Any hook means Claude's session is running past its startup dialogs.
    if (!started) {
      started = true;
      maybeReady();
    }
    if (event === "SessionStart") return null;
    if (event === "Stop") {
      // Claude's prompt takes input again only after ALL Stop hooks finish
      // (measured: keys typed ~130 ms after ours returned were dropped).
      setTimeout(() => {
        awaitingStop = false;
        applyModel();
      }, deps.stopSettleMs ?? STOP_SETTLE_MS);
      // Never block the hook (Claude flushes the transcript after it): the
      // tail keeps polling, and the transcript's end_turn normally lands the
      // final item and completes the turn. Stop is the fallback.
      if (parser.turnActive() && stopTimer === undefined) {
        stopTimer = setTimeout(() => {
          stopTimer = undefined;
          if (ended) return;
          try {
            pump();
          } catch (err) {
            logError("agent", err);
          }
          parser.completeTurn();
        }, deps.stopGraceMs ?? STOP_GRACE_MS);
        stopTimer.unref?.();
      }
      return null;
    }
    if (event !== "PermissionRequest") return null;
    if (options.observed !== undefined && !options.observed()) return null;
    const toolName = str(payload.tool_name) ?? "tool";
    const input = payload.tool_input;
    requestCounter += 1;
    const requestId = `r${requestCounter}`;
    const reply = new Promise<TJson | null>((resolve) => {
      if (toolName === "AskUserQuestion") {
        const questions = askUserQuestionsOf(input);
        if (questions === null) {
          resolve(null);
          return;
        }
        pending.set(requestId, { kind: "user-input", input, resolve });
        emit({
          type: "user-input.requested",
          request_id: requestId,
          ...parser.turnField(),
          questions,
        });
        return;
      }
      pending.set(requestId, { kind: "approval", toolName, input, resolve });
      const title = toolTitleOf(toolName, input);
      emit({
        type: "request.opened",
        request_id: requestId,
        ...parser.turnField(),
        request_kind: requestKindOfTool(toolName),
        title: title === undefined ? toolName : `${toolName}: ${title}`,
        detail: requestDetailOf(toolName, input),
        input,
      });
    });
    const timer = setTimeout(() => {
      const open = pending.get(requestId);
      if (open === undefined || open.kind === "trust") return;
      pending.delete(requestId);
      // Never auto-allow: hand the decision to Claude's native dialog.
      open.resolve(null);
      emit({
        type: "request.resolved",
        request_id: requestId,
        decision: "cancel",
      });
    }, approvalWaitMs);
    timer.unref?.();
    const result = await reply;
    clearTimeout(timer);
    return result;
  };
  hookHandlers.set(options.sessionId, onHook);

  const openLink = deps.openLink ?? defaultOpenPtyLink;
  // History first (resume / attach to a live session), then live.
  try {
    pump();
  } catch (err) {
    logError("agent", err);
  }
  void openLink({
    sessionId: options.sessionId,
    resume: options.resume,
    cwd: options.cwd,
    skipPermissions: options.skipPermissions,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })
    .then((opened) => {
      if (ended) {
        opened?.release();
        return;
      }
      if (opened === null) {
        emit({
          type: "runtime.error",
          code: "spawn_failed",
          message: "Claude Code could not be started on this device.",
          fatal: true,
        });
        finish("error");
        return;
      }
      link = opened;
      hookKeys.add(opened.hostId);
      hookHandlers.set(opened.hostId, onHook);
      opened.onOutput(onOutput);
      opened.onExit(() => finish("completed"));
      maybeReady();
      if (!ready && readyTimer === undefined) {
        readyMaxTimer = setTimeout(() => {
          if (ready || ended || started) return;
          // Never paste blind: a dialog would take the keystrokes. Say where
          // the session is waiting; SessionStart still opens input later.
          emit({
            type: "runtime.error",
            code: "engine_not_ready",
            message:
              "Claude Code is waiting for input in its terminal (sign-in or a dialog). Answer it with `openllm sessions attach` on the device; your prompt is sent once it is ready.",
            fatal: false,
          });
        }, deps.readyMaxMs ?? READY_MAX_MS);
        readyMaxTimer.unref?.();
      }
      pollTimer = setInterval(() => {
        try {
          pump();
        } catch (err) {
          logError("agent", err);
        }
      }, deps.pollMs ?? TRANSCRIPT_POLL_MS);
      pollTimer.unref?.();
    })
    .catch((err: unknown) => {
      logError("agent", err);
      finish("error");
    });

  return {
    send: (input): TAgentSendResult => {
      if (ended)
        return {
          ok: false,
          code: "session_exited",
          message: "the session has ended",
        };
      if (parser.turnActive())
        return {
          ok: false,
          code: "turn_in_progress",
          message: "a turn is already running; interrupt it or wait",
        };
      let written: TWrittenAgentAttachment[];
      try {
        written = writeAgentAttachments(
          attachmentsDir,
          input.attachments,
          attachmentCounter,
        );
      } catch (err) {
        logError("agent", err);
        return {
          ok: false,
          code: "attachment_failed",
          message: "an attachment could not be saved on this device",
        };
      }
      const text = [input.prompt, ...written.map((entry) => `@${entry.path}`)]
        .filter((part) => part.trim() !== "")
        .join(input.prompt.includes("\n") ? "\n" : " ");
      if (text.trim() === "")
        return { ok: false, code: "empty_prompt", message: "nothing to send" };
      const turnId = parser.startTurn(
        input.prompt,
        written.map((entry) => entry.meta),
      );
      awaitingStop = true;
      whenReady(() => {
        writeText(`${PASTE_START}${text}${PASTE_END}`);
        setTimeout(() => writeText("\r"), submitDelayMs);
      });
      return { ok: true, turnId };
    },
    interrupt: () => {
      if (ended || !parser.turnActive()) return false;
      writeText(ESC);
      parser.abortTurn("interrupted");
      return true;
    },
    respond: (command: TAgentRespondCommand) => {
      const request = pending.get(command.request_id);
      if (request === undefined) return false;
      pending.delete(command.request_id);
      if (request.kind === "trust") {
        // Match approval: a respond with no decision must not clear the
        // pending trust or type Esc into Claude (answers-only wire frames).
        if (command.decision === undefined) {
          pending.set(command.request_id, request);
          return false;
        }
        trustRequestId = null;
        trustAnswered = true;
        const accept =
          command.decision === "accept" ||
          command.decision === "accept_for_session";
        // Esc declines (Claude exits). Accept confirms "Yes": older Claude
        // lists it first (cursor on it); newer Claude lists "No, exit" first,
        // so step down onto "Yes" before Enter.
        const keys = !accept
          ? [ESC]
          : TRUST_CURSOR_ON_NO.test(recentScreen)
            ? [DOWN_ARROW, "\r"]
            : ["\r"];
        recentScreen = "";
        const typeKeys = (): void => {
          if (ended) return;
          writeText(keys[0] ?? "");
          if (keys[1] !== undefined) {
            const second = keys[1];
            setTimeout(() => {
              if (!ended) writeText(second);
            }, submitDelayMs);
          }
        };
        const wait = Math.max(
          0,
          trustSeenAt +
            (deps.trustAnswerDelayMs ?? TRUST_ANSWER_MIN_DELAY_MS) -
            Date.now(),
        );
        if (wait === 0) typeKeys();
        else setTimeout(typeKeys, wait);
        emit({
          type: "request.resolved",
          request_id: command.request_id,
          decision: accept ? "accept" : "decline",
        });
        maybeReady();
        return true;
      }
      if (request.kind === "user-input") {
        if (command.answers === undefined) {
          request.resolve(
            permissionReply({
              behavior: "deny",
              message: "The user dismissed the question.",
            }),
          );
          emit({
            type: "user-input.resolved",
            request_id: command.request_id,
            answers: {},
          });
          return true;
        }
        request.resolve(
          permissionReply({
            behavior: "allow",
            updatedInput: claudeAnswersInputOf(request.input, command.answers),
          }),
        );
        emit({
          type: "user-input.resolved",
          request_id: command.request_id,
          answers: command.answers,
        });
        return true;
      }
      const decision = command.decision;
      if (decision === undefined) {
        pending.set(command.request_id, request);
        return false;
      }
      if (decision === "accept" || decision === "accept_for_session") {
        request.resolve(permissionReply({ behavior: "allow" }));
      } else {
        request.resolve(
          permissionReply({
            behavior: "deny",
            message:
              decision === "cancel"
                ? "The user cancelled this request."
                : "The user declined this request.",
            ...(decision === "cancel" ? { interrupt: true } : {}),
          }),
        );
        if (decision === "cancel") parser.abortTurn("cancelled");
      }
      emit({
        type: "request.resolved",
        request_id: command.request_id,
        decision,
      });
      return true;
    },
    turnActive: () => parser.turnActive(),
    history: (beforeTurnId, limit) => history.page(beforeTurnId, limit),
    setModel: (model) => {
      if (ended)
        return {
          ok: false,
          code: "session_exited",
          message: "the session has ended",
        };
      if (!AGENT_SWITCH_MODEL_PATTERN.test(model))
        return {
          ok: false,
          code: "invalid_model",
          message: "invalid model id",
        };
      // Latest wins; applied when idle (now, or when the running turn ends).
      pendingModel = model;
      applyModel();
      return { ok: true, turnId: "" };
    },
    close: (reason) => {
      if (ended) return;
      const current = link;
      link = null;
      current?.kill();
      current?.release();
      // Delete (`killed`) drops the on-device attachment files with the
      // session. Stop (`closed`), idle release and natural PTY exit keep them
      // for replay — the history stays resumable.
      if (reason === "killed") {
        try {
          rmSync(attachmentsDir, { recursive: true, force: true });
        } catch {
          /* already gone */
        }
      }
      finish(reason);
    },
    release: () => {
      if (ended) return;
      const current = link;
      link = null;
      current?.release();
      finish("closed");
    },
  };
};

/** Mint the Claude Code adapter (interactive TUI under the session host). */
export const createClaudeCodeAdapter = (
  deps: TClaudeTuiDeps = {},
): TAgentEngineAdapter => ({
  engine: "claude",
  start: (options, emit) => createClaudeTuiSession(options, emit, deps),
});
