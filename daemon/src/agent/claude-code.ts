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
 * host's detach / idle reap):
 *   - input: prompts are bracketed-pasted into the PTY then submitted with CR,
 *     exactly like a keystroke; interrupt is Esc; attachments are written to
 *     the host's 0700 session dir and referenced as `@<path>`;
 *   - output: structured items come from Claude's own transcript
 *     (`~/.claude/projects/<slug>/<id>.jsonl`, appended per message), tailed;
 *   - busy/idle + approvals: Claude hooks (`openllm exec agent hook`) post to
 *     the daemon loopback (`/local/agent-hook`, local control capability).
 *     A PermissionRequest waits for a web decision; with no viewer, or after
 *     {@link AGENT_APPROVAL_WAIT_MS}, it returns NO decision and Claude shows
 *     its native dialog in the terminal. A timeout never allows.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  TAgentEvent,
  TAgentItem,
  TAgentRequestKind,
  TAgentRespondCommand,
  TAgentUserInputAnswers,
  TAgentUserInputQuestion,
} from "@openllmsh/protocol";
import { SESSION_ID_PATTERN } from "@openllmsh/protocol";
import { stateDir } from "../env";
import { logError } from "../logger";
import { defaultSessionHostClient } from "../session-host-proc";
import type { TClaudeTranscriptTail } from "./claude-transcript";
import {
  createClaudeTranscriptTail,
  createTranscriptParser,
} from "./claude-transcript";
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
/** Max wait for the TUI to settle before the first paste. */
const READY_MAX_MS = 10_000;
/** Output-quiet window that marks the TUI ready for input. */
const READY_QUIET_MS = 400;
/** Gap between the bracketed paste and the submitting CR. */
const SUBMIT_DELAY_MS = 80;
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

/** The daemon's observer connection to a session-host PTY. */
export type TPtyLink = {
  /** The session-host id (its Claude hooks report it as the session). */
  readonly hostId: string;
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
  const live = hosts.find(
    (host) =>
      host.cli === "claude_code" &&
      (host.id === request.sessionId ||
        host.vendorSessionId === request.sessionId),
  );
  if (live !== undefined) return dialObserver(live.socketPath, live.id);
  const socketPath = await defaultSessionHostClient.spawnSessionHostProc({
    id: request.sessionId,
    cli: "claude_code",
    cols: OBSERVER_COLS,
    rows: OBSERVER_ROWS,
    cwd: request.cwd,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.skipPermissions ? { dangerous: true } : {}),
    ...(request.resume ? { resume: request.sessionId } : {}),
    ...(request.model === undefined
      ? {}
      : { vendorArgs: ["--model", request.model] }),
  });
  return socketPath === null
    ? null
    : dialObserver(socketPath, request.sessionId);
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

/** Write attachments; return their absolute paths. */
export const writeAgentAttachments = (
  dir: string,
  attachments: TAgentSendInput["attachments"],
  counter: { value: number },
): string[] => {
  if (attachments.length === 0) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return attachments.map((attachment) => {
    counter.value += 1;
    let name = sanitizeAttachmentName(attachment.name);
    if (!name.includes(".")) name += extensionOf(attachment.media_type);
    const path = join(dir, `${counter.value}-${name}`);
    writeFileSync(path, Buffer.from(attachment.data, "base64"), {
      mode: 0o600,
    });
    return path;
  });
};

// ─── the session ─────────────────────────────────────────────────────────

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC = "\x1b";
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*\u0007|${ESC}[()][A-Za-z0-9]`,
  "g",
);
const TRUST_PROMPT =
  /trust\s*the\s*files\s*in\s*this\s*folder|Do\s*you\s*trust/i;

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
  readonly approvalWaitMs?: number;
  readonly readyMaxMs?: number;
  readonly readyQuietMs?: number;
  readonly submitDelayMs?: number;
  readonly pollMs?: number;
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
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const queued: (() => void)[] = [];
  let recentOutput = "";
  let requestCounter = 0;
  const pending = new Map<string, TPending>();
  let trustRequestId: string | null = null;

  const parser = createTranscriptParser({
    emit,
    toolOutputMax: AGENT_TOOL_OUTPUT_MAX_CHARS,
  });
  const tail =
    deps.transcript?.(options.sessionId) ??
    createClaudeTranscriptTail(options.sessionId, { cwd: options.cwd });

  const pump = (): void => {
    const chunk = tail.read();
    if (chunk !== null && chunk.length > 0) parser.push(chunk);
  };

  const cleanupAttachments = (): void => {
    try {
      rmSync(attachmentsDir, { recursive: true, force: true });
    } catch {}
  };

  const finish = (
    reason: "closed" | "killed" | "completed" | "error",
    message?: string,
  ): void => {
    if (ended) return;
    ended = true;
    for (const key of hookKeys) hookHandlers.delete(key);
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    if (pollTimer !== undefined) clearInterval(pollTimer);
    try {
      pump();
    } catch {}
    for (const [id, request] of pending) {
      if (request.kind !== "trust") request.resolve(null);
      emit({ type: "request.resolved", request_id: id, decision: "cancel" });
    }
    pending.clear();
    parser.abortTurn("cancelled");
    cleanupAttachments();
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
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    for (const run of queued.splice(0)) run();
  };

  const armReady = (): void => {
    if (ready) return;
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = setTimeout(markReady, deps.readyQuietMs ?? READY_QUIET_MS);
  };

  const whenReady = (run: () => void): void => {
    if (ready) run();
    else queued.push(run);
  };

  const writeText = (text: string): void => {
    link?.write(textEncoder.encode(text));
  };

  const onOutput = (bytes: Uint8Array): void => {
    armReady();
    recentOutput = (
      recentOutput + new TextDecoder().decode(bytes).replace(ANSI, "")
    ).slice(-4096);
    if (trustRequestId === null && TRUST_PROMPT.test(recentOutput)) {
      requestCounter += 1;
      trustRequestId = `trust${requestCounter}`;
      recentOutput = "";
      ready = false; // hold queued prompts until the dialog is answered
      pending.set(trustRequestId, { kind: "trust" });
      emit({
        type: "request.opened",
        request_id: trustRequestId,
        request_kind: "other",
        title: "Trust this folder?",
        detail: `Claude Code asks whether to trust the files in ${clip(options.cwd, 1024)}.`,
      });
    }
  };

  // Hooks from this session's Claude process (keyed by its host id).
  const hookKeys = new Set<string>([options.sessionId]);
  const onHook: THookHandler = async (event, payload) => {
    pump();
    if (event === "Stop") {
      parser.completeTurn();
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
      // An already-running TUI (re-attach) may be idle and silent.
      readyTimer = setTimeout(markReady, deps.readyMaxMs ?? READY_MAX_MS);
      armReady();
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
      let paths: string[];
      try {
        paths = writeAgentAttachments(
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
      const text = [input.prompt, ...paths.map((path) => `@${path}`)]
        .filter((part) => part.trim() !== "")
        .join(input.prompt.includes("\n") ? "\n" : " ");
      if (text.trim() === "")
        return { ok: false, code: "empty_prompt", message: "nothing to send" };
      const turnId = parser.startTurn(input.prompt);
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
        trustRequestId = null;
        const accept =
          command.decision === "accept" ||
          command.decision === "accept_for_session";
        // Option 1 is "Yes, proceed"; Esc declines (and Claude exits).
        writeText(accept ? "\r" : ESC);
        armReady();
        emit({
          type: "request.resolved",
          request_id: command.request_id,
          decision: accept ? "accept" : "decline",
        });
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
    close: (reason) => {
      if (ended) return;
      const current = link;
      link = null;
      current?.kill();
      current?.release();
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
