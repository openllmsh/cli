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
 *     the session's own 0700 `agent-attachments/<id>/` dir (outside the
 *     host's registry dir, which the host removes on exit) and referenced
 *     as `@<path>`;
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
  AGENT_DETAIL_TEXT_MAX_LENGTH,
  AGENT_MAX_ATTACHMENT_BASE64_LENGTH,
  AGENT_MAX_ATTACHMENT_BYTES,
  AGENT_MAX_LINE_BYTES,
  AGENT_MAX_QUEUED_PROMPTS,
  AGENT_MODEL_SWITCH_DECLINED_CODE,
  AGENT_MODEL_SWITCH_FAILED_CODE,
  AGENT_SHORT_TEXT_MAX_LENGTH,
  AGENT_SWITCH_MODEL_PATTERN,
  MEDIA_TYPES,
  MIME_BY_MEDIA_EXT,
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
  LOCAL_COMMAND_STOP_REASON,
  SUBAGENT_TOOL_NAMES,
  toolNameOf,
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
/**
 * Mid-conversation, Claude asks "Switch model?" (cache re-read) before a
 * `/model` applies. The dialog is read off the screen and asked on the web;
 * the answer is typed back. Its arrival is never guessed at with blind keys.
 */
const MODEL_DIALOG = /switchmodel\?/i;
/**
 * A `/model` with no transcript confirmation, no answer from the command and
 * no dialog by then failed: the web is told instead of waiting forever.
 */
const MODEL_SWITCH_TIMEOUT_MS = 20_000;
/** After Stop, how long before typing `/model` (other Stop hooks still run). */
const STOP_SETTLE_MS = 500;
/**
 * A slash command typed from the web that the model never sees (`/help`,
 * `/cost`) runs no Stop hook, and some write nothing at all. With no sign of
 * the model running for it by then (an expanded prompt, an assistant row),
 * its turn is complete.
 */
const LOCAL_COMMAND_SETTLE_MS = 3_000;
/** Why a replayed turn the resumed TUI is not continuing was closed. */
const REPLAY_OPEN_TURN_MESSAGE =
  "The session stopped before this turn finished.";
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

const DETAIL_MAX = AGENT_DETAIL_TEXT_MAX_LENGTH;
const SHORT_MAX = AGENT_SHORT_TEXT_MAX_LENGTH;

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

/** An approval's title: the tool and what it acts on, within the schema cap. */
export const requestTitleOf = (toolName: string, input: unknown): string => {
  const title = toolTitleOf(toolName, input);
  return clip(
    title === undefined ? toolName : `${toolName}: ${title}`,
    SHORT_MAX,
  );
};

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
  /** Browser device-session gained/lost focus; observer controls only. */
  readonly focus: () => void;
  readonly blur: () => void;
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
      focus: () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: "ctrl", p: { t: "focus" } }));
      },
      blur: () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: "ctrl", p: { t: "blur" } }));
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

/**
 * True when this live host is the Claude session `sessionId` names. Matches
 * host id, vendor session id, or the id Claude's TUI is on right now under
 * that pid — same fallback attach and delete use so a terminal
 * `openllm claude --resume` host whose meta id differs is still found.
 */
export const isClaudeSessionHostFor = (
  host: {
    readonly cli: string;
    readonly id: string;
    readonly vendorSessionId: string | null;
    readonly pid: number;
  },
  sessionId: string,
  readLiveId: (pid: number) => string | null = readClaudeSessionIdUnderPid,
): boolean =>
  host.cli === "claude_code" &&
  (host.id === sessionId ||
    host.vendorSessionId === sessionId ||
    readLiveId(host.pid) === sessionId);

/**
 * Prefer an exact host / vendor id match over a live-PID match. Another host
 * can briefly claim the same Claude id via its pid file; attaching or killing
 * that one would miss the real session.
 */
export const findClaudeSessionHost = <
  THost extends {
    readonly cli: string;
    readonly id: string;
    readonly vendorSessionId: string | null;
    readonly pid: number;
  },
>(
  hosts: readonly THost[],
  sessionId: string,
  readLiveId: (pid: number) => string | null = readClaudeSessionIdUnderPid,
): THost | undefined => {
  const claude = hosts.filter((host) => host.cli === "claude_code");
  // 1. The host's own id is authoritative.
  const byHostId = claude.find((host) => host.id === sessionId);
  if (byHostId !== undefined) return byHostId;
  // 2. A host whose TUI is confirmed on this id right now — preferring one
  //    that also recorded it. A stored vendor id alone is stale after a
  //    `/resume` or `/clear` moved the TUI on.
  const live = claude.map((host) => ({ host, id: readLiveId(host.pid) }));
  const confirmed = live.filter((entry) => entry.id === sessionId);
  const confirmedVendor = confirmed.find(
    (entry) => entry.host.vendorSessionId === sessionId,
  );
  if (confirmedVendor !== undefined) return confirmedVendor.host;
  if (confirmed[0] !== undefined) return confirmed[0].host;
  // 3. Last resort: a recorded vendor id whose live id can't be read.
  return live.find(
    (entry) => entry.id === null && entry.host.vendorSessionId === sessionId,
  )?.host;
};

/** Production link: join the live host for this id, else spawn one. */
const defaultOpenPtyLink: TOpenPtyLink = async (request) => {
  if (!SESSION_ID_PATTERN.test(request.sessionId)) return null;
  const hosts = await defaultSessionHostClient.discoverSessionHosts();
  // A terminal `openllm claude --resume X` runs under its own host id with
  // Claude session X: match either, so the web never forks a second process.
  // A terminal run whose live meta has no (or a stale) Claude id is matched
  // by the id its TUI is on right now (`~/.claude/sessions/<pid>.json`).
  // Exact host / vendor id wins over a PID claim from another host.
  const live = findClaudeSessionHost(hosts, request.sessionId);
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
  // An open still spawning this session's host is not discoverable yet:
  // wait for it (a closed session kills what it opened), or the host would
  // start after the delete and write the transcript back.
  await settleClaudeSessionOpen(sessionId);
  const find = async (): Promise<
    | Awaited<
        ReturnType<typeof defaultSessionHostClient.discoverSessionHosts>
      >[number]
    | undefined
  > => {
    const hosts = await defaultSessionHostClient.discoverSessionHosts();
    return findClaudeSessionHost(hosts, sessionId);
  };
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

/** Link opens in flight, per session id (a spawn takes a while to publish). */
const pendingLinkOpens = new Map<string, Promise<void>>();

/**
 * Resolves once no link open is pending for `sessionId`. An open that a
 * close / delete overtook has by then killed the host it started.
 */
export const settleClaudeSessionOpen = async (
  sessionId: string,
): Promise<void> => {
  await pendingLinkOpens.get(sessionId);
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

/**
 * Parent of every per-session attachments dir. Deliberately NOT the
 * session-host registry (`sessions/<id>/`): a host removes its dir when it
 * exits, discovery deletes any dir there without a `meta.json`, and a host
 * refuses to start when its dir already exists.
 */
export const agentAttachmentsRoot = (): string =>
  join(stateDir(), "agent-attachments");

/** One session's attachments dir (0700, files 0600). */
export const agentAttachmentsDir = (sessionId: string): string =>
  join(agentAttachmentsRoot(), sessionId);

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
  if (Object.hasOwn(MEDIA_TYPES, mediaType)) {
    const ext = MEDIA_TYPES[mediaType]?.ext;
    if (ext !== undefined) return `.${ext}`;
  }
  const sub = mediaType.split("/")[1] ?? "";
  return /^[a-z0-9]{1,8}$/.test(sub) ? `.${sub}` : "";
};

export type TWrittenAgentAttachment = {
  readonly path: string;
  readonly meta: TAgentAttachmentMeta;
};

/** Continue attachment names after files retained by a resumed session. */
const attachmentCounterOf = (dir: string): { value: number } => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { value: 0 };
  }
  let value = 0;
  for (const name of names) {
    const match = /^(\d+)-/.exec(name);
    if (match?.[1] === undefined) continue;
    const prefix = Number(match[1]);
    if (Number.isSafeInteger(prefix) && prefix > value) value = prefix;
  }
  return { value };
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
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
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

/** Stored-name extension → MIME, for serving an attachment back. */
const mimeOfStoredName = (name: string): string => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpeg") return "image/jpeg";
  return Object.hasOwn(MIME_BY_MEDIA_EXT, ext)
    ? (MIME_BY_MEDIA_EXT[ext] ?? "application/octet-stream")
    : "application/octet-stream";
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
    readonly attachmentsRoot?: string;
    readonly liveSessionIds?: ReadonlySet<string>;
    readonly transcriptExists?: (sessionId: string) => boolean;
  } = {},
): readonly string[] => {
  const root = options.attachmentsRoot ?? agentAttachmentsRoot();
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
    if (live.has(sessionId) || !SESSION_ID_PATTERN.test(sessionId)) continue;
    const attachments = join(root, sessionId);
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
/** Not a C0 control (tab and newline aside), DEL, or a C1 control. */
const isPasteSafe = (code: number): boolean =>
  code === 0x09 ||
  code === 0x0a ||
  (code >= 0x20 && code < 0x7f) ||
  code > 0x9f;

/**
 * Prompt text safe to bracketed-paste into the TUI. A web prompt is typed into
 * a terminal: an ESC in it could end the paste (`ESC[201~`) and turn the rest
 * into keystrokes (`ESC[Z` toggles the permission mode, CR submits). Only tab
 * and newline survive among the controls; CR / CRLF become newlines.
 */
export const pasteSafeText = (text: string): string => {
  const normalized = text.replace(/\r\n?/g, "\n");
  let out = "";
  let start = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    if (isPasteSafe(normalized.charCodeAt(i))) continue;
    out += normalized.slice(start, i);
    start = i + 1;
  }
  return out + normalized.slice(start);
};
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
 * Claude Code's `chat:queueSubmit` (ctrl+x enter) and `chat:sendNow`
 * (ctrl+x ctrl+s, the byte-safe alias of ctrl+enter): queue what's in the
 * input behind the running turn, then hand the queue to the model now.
 * Plain Enter would interrupt instead under Claude's responsive mode.
 */
const QUEUE_SUBMIT = "\x18\r";
const SEND_NOW = "\x18\x13";
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
  | { readonly kind: "trust" }
  | { readonly kind: "model"; readonly model: string };

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
  readonly modelSwitchTimeoutMs?: number;
  readonly localCommandSettleMs?: number;
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
  const attachmentCounter = attachmentCounterOf(attachmentsDir);
  let link: TPtyLink | null = null;
  /** Latest observer presence while the PTY link is still opening. */
  let focused: boolean | null = null;
  let ended = false;
  /**
   * How the session ended, for a link that opens after it did: close /
   * delete kill the host it spawned or joined; release leaves it running.
   */
  let endIntent: "kill" | "release" = "release";
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
  /** Screen text since the last `/model` was typed (its dialog only). */
  let modelScreen = "";
  /** The open "Switch model?" request, while it waits for the web. */
  let modelRequestId: string | null = null;
  let modelTimer: ReturnType<typeof setTimeout> | undefined;

  /** Events of the drain in progress (emitted, possibly cut, at its end). */
  let drained: TAgentEvent[] | null = null;
  /** Tool rows the PreToolUse hook already surfaced before the transcript. */
  const preToolUseIds = new Set<string>();
  const parser = createTranscriptParser({
    // `/model` answered with anything but "Set model to": it was refused.
    onLocalCommandOutput: (text) => {
      if (modelInFlight) failModelSwitch(text);
    },
    emit: (event) => {
      // The transcript supplies the full input for a live hook row. Preserve
      // its id but make it an update, so raw event consumers do not receive a
      // second start for the same tool use.
      const reconciled =
        event.type === "item.started" && preToolUseIds.delete(event.item_id)
          ? { ...event, type: "item.updated" as const }
          : event;
      if (
        reconciled.type === "session.configured" &&
        reconciled.model !== undefined
      )
        endModelSwitch();
      if (
        reconciled.type === "turn.completed" &&
        reconciled.stop_reason === LOCAL_COMMAND_STOP_REASON
      )
        // No Stop hook follows a local command: the prompt is idle again.
        settleAfterTurn();
      else if (
        (reconciled.type === "turn.completed" ||
          reconciled.type === "turn.aborted") &&
        promptQueue.length > 0
      )
        // The transcript can close the turn after the Stop hook settled;
        // try the queue again once it has.
        setTimeout(() => {
          if (!ended) flushQueue();
        }, deps.stopSettleMs ?? STOP_SETTLE_MS);
      if (drained !== null) drained.push(reconciled);
      else emit(reconciled);
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
      // `/new`, `/clear` or `/resume` in the TUI: the old conversation is
      // over. Tell the dispatcher as well as resetting the parser, so it
      // discards its replay log and every attached browser clears before any
      // row from the new transcript is delivered.
      onSwitch: () => {
        parser.completeTurn();
        const reset: TAgentEvent = { type: "session.reset" };
        if (drained !== null) drained.push(reset);
        else emit(reset);
      },
    });

  /** A `/model` waiting for the session to be ready and idle. */
  let pendingModel: string | null = null;
  /** A `/model` typed and not yet confirmed by the transcript. */
  let modelInFlight = false;
  /**
   * `/model` is being typed and confirmed (its paste, Enter and the dialog's
   * fallback Enter). A queued prompt pasted then would land in the same input.
   */
  let modelTyping = false;
  /**
   * A web turn is running until Claude's Stop hook: the transcript's end_turn
   * lands while Stop hooks still run, and keys typed then are lost.
   */
  let awaitingStop = false;
  /** Prompts sent mid-turn, oldest first (`send` → `flushQueue`). */
  const promptQueue: Array<{
    readonly id: string;
    readonly input: TAgentSendInput;
  }> = [];
  let queueCounter = 0;
  /** Interrupt pauses delivery until the user explicitly resumes it. */
  let queueHeld = false;
  /** A send-now awaits readiness; queue entries remain durable until pasted. */
  let sendNowPending = false;
  /** The turn this daemon opened last (its prompt was typed by `send`). */
  let sentTurnId: string | null = null;
  /**
   * The open turn a resume / attach replay ended on (the transcript stops
   * mid-turn: Stop, kill or crash). Settled once the link says whether a
   * running TUI is continuing it.
   */
  let replayedOpenTurn: string | null = null;
  /** The prompt takes input again after a turn ended without a Stop hook. */
  const settleAfterTurn = (): void => {
    awaitingStop = false;
    setTimeout(() => {
      if (ended) return;
      applyModel();
      flushQueue();
    }, deps.stopSettleMs ?? STOP_SETTLE_MS);
  };
  /**
   * A freshly spawned TUI (`claude --resume`) does not continue the turn its
   * transcript ended on, so nothing would ever close it and every `send`
   * would answer `turn_in_progress`: close it. A TUI that was already running
   * may really be mid-turn; its Stop / end_turn closes it.
   */
  const settleReplayedTurn = (): void => {
    if (replayedOpenTurn === null || link === null) return;
    const turnId = replayedOpenTurn;
    replayedOpenTurn = null;
    if (!link.fresh || parser.turnField().turn_id !== turnId) return;
    parser.abortTurn("interrupted", REPLAY_OPEN_TURN_MESSAGE);
  };
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
    modelTyping = true;
    modelScreen = "";
    writeText(`${PASTE_START}/model ${model}${PASTE_END}`);
    setTimeout(() => {
      if (!ended) writeText("\r");
    }, submitDelayMs);
    armModelTimeout(model);
  };
  /** Fail the switch unless confirmed, refused or asked by then. */
  const armModelTimeout = (model: string): void => {
    if (modelTimer !== undefined) clearTimeout(modelTimer);
    modelTimer = setTimeout(() => {
      modelTimer = undefined;
      if (ended || !modelInFlight || modelRequestId !== null) return;
      failModelSwitch(`Claude Code did not switch to ${model}.`);
    }, deps.modelSwitchTimeoutMs ?? MODEL_SWITCH_TIMEOUT_MS);
  };
  /** The switch is over: the input is free for queued prompts again. */
  const endModelSwitch = (): void => {
    modelInFlight = false;
    modelScreen = "";
    if (modelTimer !== undefined) clearTimeout(modelTimer);
    modelTimer = undefined;
    if (modelRequestId !== null) {
      pending.delete(modelRequestId);
      emit({
        type: "request.resolved",
        request_id: modelRequestId,
        decision: "cancel",
      });
      modelRequestId = null;
    }
    if (!modelTyping) return;
    setTimeout(() => {
      modelTyping = false;
      if (!ended) flushQueue();
    }, submitDelayMs);
  };
  const failModelSwitch = (message: string): void => {
    if (!modelInFlight) return;
    // Clear the typed `/model` (or a dialog) so the next prompt starts clean.
    if (!ended) writeText(ESC);
    endModelSwitch();
    emit({
      type: "runtime.error",
      code: AGENT_MODEL_SWITCH_FAILED_CODE,
      message: clip(message, AGENT_DETAIL_TEXT_MAX_LENGTH),
    });
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
        const open = parser.turnField().turn_id;
        if (parser.turnActive() && open !== undefined && open !== sentTurnId) {
          replayedOpenTurn = open;
          settleReplayedTurn();
        }
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
    if (modelTimer !== undefined) clearTimeout(modelTimer);
    try {
      pump();
    } catch {}
    for (const [id, request] of pending) {
      if (request.kind !== "trust" && request.kind !== "model")
        request.resolve(null);
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
    if (modelInFlight && modelRequestId === null && !ended) {
      modelScreen = (
        modelScreen +
        new TextDecoder().decode(bytes).replace(ANSI, "").replace(/\s+/g, "")
      ).slice(-4096);
      if (MODEL_DIALOG.test(modelScreen)) openModelDialog();
    }
    if (trustAnswered || ended || started || !link?.fresh) return;
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

  /** Claude asks before a switch that re-reads the cached history. */
  const openModelDialog = (): void => {
    const model = /\/model(\S+)/.exec(modelScreen)?.[1];
    requestCounter += 1;
    modelRequestId = `model${requestCounter}`;
    trustSeenAt = Date.now();
    pending.set(modelRequestId, { kind: "model", model: model ?? "" });
    if (modelTimer !== undefined) clearTimeout(modelTimer);
    modelTimer = undefined;
    emit({
      type: "request.opened",
      request_id: modelRequestId,
      request_kind: "other",
      title: "Switch model?",
      detail:
        "This conversation is cached for the current model. Switching re-reads the full history, so the next response will be slower and use more tokens.",
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
    if (event === "PreToolUse") {
      // Claude's hook carries the same tool_use_id its transcript later uses.
      // The transcript's full call turns this into item.updated, not another
      // item.started; its eventual tool_result completes the same id.
      const toolUseId = str(payload.tool_use_id);
      if (toolUseId !== undefined) {
        preToolUseIds.add(toolUseId);
        emit({
          type: "item.started",
          ...parser.turnField(),
          item_id: toolUseId,
          item: {
            kind: "tool_call",
            tool_name: toolNameOf(payload.tool_name),
            input: payload.tool_input,
            status: "in_progress",
          },
        });
      }
      return null;
    }
    if (event === "Stop") {
      // Claude's prompt takes input again only after ALL Stop hooks finish
      // (measured: keys typed ~130 ms after ours returned were dropped).
      setTimeout(() => {
        awaitingStop = false;
        applyModel();
        flushQueue();
      }, deps.stopSettleMs ?? STOP_SETTLE_MS);
      // Never block the hook (Claude flushes the transcript after it): the
      // tail keeps polling, and the transcript's end_turn normally lands the
      // final item and completes the turn. Stop is the fallback.
      if (parser.turnActive()) {
        // One fallback per stopped turn: a newer Stop re-arms it for its own
        // turn (the older timer would skip it, as its id no longer matches).
        if (stopTimer !== undefined) clearTimeout(stopTimer);
        // Only the turn this Stop ended: by the grace deadline a queued
        // prompt may already have opened the next one, and closing that
        // hid its progress and its Stop button.
        const stoppedTurn = parser.turnField().turn_id;
        stopTimer = setTimeout(() => {
          stopTimer = undefined;
          if (ended) return;
          try {
            pump();
          } catch (err) {
            logError("agent", err);
          }
          if (parser.turnField().turn_id === stoppedTurn) parser.completeTurn();
        }, deps.stopGraceMs ?? STOP_GRACE_MS);
        stopTimer.unref?.();
      }
      return null;
    }
    if (event !== "PermissionRequest") return null;
    if (options.observed !== undefined && !options.observed()) return null;
    const toolName = toolNameOf(payload.tool_name);
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
      emit({
        type: "request.opened",
        request_id: requestId,
        ...parser.turnField(),
        request_kind: requestKindOfTool(toolName),
        title: requestTitleOf(toolName, input),
        detail: requestDetailOf(toolName, input),
        input,
      });
    });
    const timer = setTimeout(() => {
      const open = pending.get(requestId);
      if (open === undefined || !("resolve" in open)) return;
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
  const opening = openLink({
    sessionId: options.sessionId,
    resume: options.resume,
    cwd: options.cwd,
    skipPermissions: options.skipPermissions,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })
    .then((opened) => {
      if (ended) {
        // Closed / deleted while the host was still starting: nothing had a
        // link to kill then, so kill it now rather than orphan a running TUI.
        if (endIntent === "kill") opened?.kill();
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
      if (focused === true) opened.focus();
      else if (focused === false) opened.blur();
      hookKeys.add(opened.hostId);
      hookHandlers.set(opened.hostId, onHook);
      opened.onOutput(onOutput);
      opened.onExit(() => finish("completed"));
      settleReplayedTurn();
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
  pendingLinkOpens.set(options.sessionId, opening);
  void opening.finally(() => {
    if (pendingLinkOpens.get(options.sessionId) === opening)
      pendingLinkOpens.delete(options.sessionId);
  });

  /** Save a prompt's attachments and build the text to paste for it. */
  const preparePrompt = (
    input: TAgentSendInput,
  ):
    | {
        readonly ok: true;
        readonly text: string;
        readonly written: TWrittenAgentAttachment[];
      }
    | Extract<TAgentSendResult, { readonly ok: false }> => {
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
    const text = pasteSafeText(
      [input.prompt, ...written.map((entry) => `@${entry.path}`)]
        .filter((part) => part.trim() !== "")
        .join(input.prompt.includes("\n") ? "\n" : " "),
    );
    if (text.trim() === "")
      return { ok: false, code: "empty_prompt", message: "nothing to send" };
    return { ok: true, text, written };
  };
  const startTurn = (input: TAgentSendInput): TAgentSendResult => {
    const prepared = preparePrompt(input);
    if (!prepared.ok) return prepared;
    const { text, written } = prepared;
    const turnId = parser.startTurn(
      input.prompt,
      written.map((entry) => entry.meta),
    );
    sentTurnId = turnId;
    awaitingStop = true;
    const localCommand = parser.quietLocalCommand();
    whenReady(() => {
      // An interrupt before readiness aborts this turn; never paste its prompt
      // once the TUI later becomes ready.
      if (ended || parser.turnField().turn_id !== turnId) return;
      writeText(`${PASTE_START}${text}${PASTE_END}`);
      setTimeout(() => writeText("\r"), submitDelayMs);
      if (!localCommand) return;
      const settle = setTimeout(
        () => {
          if (ended || parser.turnField().turn_id !== turnId) return;
          try {
            pump();
          } catch (err) {
            logError("agent", err);
          }
          if (
            parser.turnField().turn_id === turnId &&
            parser.quietLocalCommand()
          )
            parser.completeTurn(LOCAL_COMMAND_STOP_REASON);
        },
        submitDelayMs + (deps.localCommandSettleMs ?? LOCAL_COMMAND_SETTLE_MS),
      );
      settle.unref?.();
    });
    return { ok: true, turnId };
  };
  const emitQueue = (): void => {
    emit({
      type: "queue.updated",
      // Clipped: the strip shows one line each, and the whole queue rides
      // every event (and the replay log), so full prompts would not fit.
      prompts: promptQueue.map(({ id, input }) => ({
        id,
        prompt: input.prompt.slice(0, AGENT_SHORT_TEXT_MAX_LENGTH),
        attachment_count: input.attachments.length,
      })),
      held: queueHeld,
    });
  };
  /** The next queued prompt opens its turn once the session is idle again. */
  const flushQueue = (): void => {
    // Past any prompt that can't be sent, or the rest would wait forever:
    // nothing else re-triggers a flush while no turn runs.
    while (
      !(
        ended ||
        queueHeld ||
        parser.turnActive() ||
        awaitingStop ||
        modelTyping
      )
    ) {
      const next = promptQueue[0];
      if (next === undefined) return;
      const result = startTurn(next.input);
      if (result.ok) {
        // Remove only after the turn has committed its parser state and ready
        // callback. An interrupt before readiness therefore keeps the prompt.
        promptQueue.shift();
        emitQueue();
        return;
      }
      promptQueue.shift();
      emitQueue();
      emit({
        type: "runtime.warning",
        message: `A queued message wasn't sent: ${result.message}`,
      });
    }
  };

  return {
    send: (input): TAgentSendResult => {
      if (ended)
        return {
          ok: false,
          code: "session_exited",
          message: "the session has ended",
        };
      // Mid-turn (or before the Stop hooks settle): hold it here and send it
      // as the turn ends, like Claude's own queue — but daemon-side, so the
      // turn it opens is ours to track and every viewer sees the queue.
      if (
        parser.turnActive() ||
        awaitingStop ||
        modelTyping ||
        promptQueue.length > 0
      ) {
        if (
          input.prompt.trim() === "" &&
          (input.attachments?.length ?? 0) === 0
        )
          return {
            ok: false,
            code: "empty_prompt",
            message: "nothing to send",
          };
        if (promptQueue.length >= AGENT_MAX_QUEUED_PROMPTS)
          return {
            ok: false,
            code: "queue_full",
            message: "too many messages are already queued",
          };
        queueCounter += 1;
        promptQueue.push({ id: `q${queueCounter}`, input });
        emitQueue();
        return { ok: true, queued: true };
      }
      return startTurn(input);
    },
    sendNow: (): boolean => {
      if (ended || promptQueue.length === 0) return false;
      // No turn running: the normal flush, which waits out the Stop settle
      // (keys typed while Stop hooks run are dropped).
      if (!parser.turnActive()) {
        flushQueue();
        return true;
      }
      // Into Claude's own queue, then its send-now. Keep entries durable until
      // their paste is committed: an interrupt before readiness must not lose
      // them.
      if (sendNowPending) return true;
      sendNowPending = true;
      whenReady(() => {
        sendNowPending = false;
        if (ended || queueHeld) return;
        const delivered: string[] = [];
        for (const entry of promptQueue) {
          const prepared = preparePrompt(entry.input);
          if (!prepared.ok) {
            emit({
              type: "runtime.warning",
              message: `A queued message wasn't sent: ${prepared.message}`,
            });
            delivered.push(entry.id);
            continue;
          }
          writeText(`${PASTE_START}${prepared.text}${PASTE_END}`);
          writeText(QUEUE_SUBMIT);
          delivered.push(entry.id);
        }
        if (delivered.length === 0) return;
        const deliveredIds = new Set(delivered);
        promptQueue.splice(
          0,
          promptQueue.length,
          ...promptQueue.filter((entry) => !deliveredIds.has(entry.id)),
        );
        emitQueue();
        setTimeout(() => {
          if (!ended) writeText(SEND_NOW);
        }, submitDelayMs);
      });
      return true;
    },
    resumeQueue: (): boolean => {
      if (ended || !queueHeld) return false;
      queueHeld = false;
      emitQueue();
      flushQueue();
      return true;
    },
    cancelQueued: (queueId: string): boolean => {
      const index = promptQueue.findIndex((entry) => entry.id === queueId);
      if (index < 0) return false;
      promptQueue.splice(index, 1);
      if (promptQueue.length === 0) queueHeld = false;
      emitQueue();
      return true;
    },
    interrupt: () => {
      if (ended || !parser.turnActive()) return false;
      // Before readiness Esc would dismiss a startup dialog. Preserve any
      // queued callbacks and prompts; the queue is explicitly held instead.
      // Hold only real entries; an empty hold would strand later prompts.
      queueHeld = promptQueue.length > 0;
      emitQueue();
      if (ready) writeText(ESC);
      parser.abortTurn("interrupted");
      // Esc can skip Stop. Clear the turn state, but deliberately do not drain
      // the held queue; only `resume_queue` may restart it.
      awaitingStop = false;
      setTimeout(() => {
        if (ended) return;
        applyModel();
      }, deps.stopSettleMs ?? STOP_SETTLE_MS);
      return true;
    },
    respond: (command: TAgentRespondCommand) => {
      const request = pending.get(command.request_id);
      if (request === undefined) return false;
      pending.delete(command.request_id);
      if (request.kind === "model") {
        if (command.decision === undefined) {
          pending.set(command.request_id, request);
          return false;
        }
        modelRequestId = null;
        const accept =
          command.decision === "accept" ||
          command.decision === "accept_for_session";
        // "Yes, switch" is preselected; Esc is "No, go back".
        const key = accept ? "\r" : ESC;
        const wait = Math.max(
          0,
          trustSeenAt +
            (deps.trustAnswerDelayMs ?? TRUST_ANSWER_MIN_DELAY_MS) -
            Date.now(),
        );
        setTimeout(() => {
          if (!ended) writeText(key);
        }, wait);
        emit({
          type: "request.resolved",
          request_id: command.request_id,
          decision: accept ? "accept" : "decline",
        });
        if (accept) {
          // The transcript confirms it; a failure still surfaces.
          modelScreen = "";
          armModelTimeout(request.model);
        } else {
          endModelSwitch();
          emit({
            type: "runtime.warning",
            code: AGENT_MODEL_SWITCH_DECLINED_CODE,
            message: "Model not switched.",
          });
        }
        return true;
      }
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
    focus: () => {
      focused = true;
      link?.focus();
    },
    blur: () => {
      focused = false;
      link?.blur();
    },
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
      endIntent = "kill";
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
