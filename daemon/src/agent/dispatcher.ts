/**
 * The agent dispatcher — ONE session registry with two front doors (the mux
 * `kind:"agent"` stream handler and the loopback WebSocket), feeding the same
 * engine adapters (plan "Agent protocol" → Transports → Daemon).
 *
 * A session outlives its consumer: a dropped stream / socket only detaches,
 * and a later `attach` (from either front door) rejoins it with a replay of
 * the session's recent events followed by `replay_done`. An `attach` to an id
 * the daemon is not running resumes the engine's own persisted session
 * (`--resume`) — or joins the durable terminal session of that id. Detached
 * sessions are released after an idle window: the daemon stops driving them,
 * but the engine (a durable session-host PTY) keeps running for the terminal.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
  TAgentCommand,
  TAgentEngine,
  TAgentEvent,
  TAgentItem,
} from "@openllmsh/protocol";
import {
  AGENT_SESSION_ID_PATTERN,
  AGENT_SWITCH_MODEL_PATTERN,
  encodeAgentLine,
  parseAgentEvent,
  SESSION_ID_PATTERN,
} from "@openllmsh/protocol";
import { logError, logInfo } from "../logger";
import {
  AGENT_TOOL_OUTPUT_MAX_CHARS,
  chunkAgentAttachment,
  resolveAgentAttachment,
} from "./claude-code";
import {
  AGENT_HISTORY_DEFAULT_TURNS,
  boundHistoryPage,
  historyCursorOf,
  latestReplayWindow,
  logHistoryPage,
  shrinkAgentItem,
  turnIdOfCursor,
} from "./history-window";
import type {
  TAgentConnection,
  TAgentConsumer,
  TAgentEngineAdapter,
  TAgentEngineSession,
} from "./types";

/** Live engine sessions per daemon. */
export const AGENT_MAX_SESSIONS = 8;
/** Events kept per session for attach replay. */
export const AGENT_REPLAY_LOG_EVENTS = 2_000;
/** A detached, idle session is closed after this long with no consumer. */
export const AGENT_DETACHED_IDLE_MS = 30 * 60 * 1000;
/** Undelivered events per consumer before it is dropped as `lagging`. */
export const AGENT_CONSUMER_MAX_QUEUED = 4_096;

export type TAgentDispatcherOptions = {
  readonly adapters: readonly TAgentEngineAdapter[];
  /** Overrides (tests). */
  readonly now?: () => number;
  readonly detachedIdleMs?: number;
  readonly maxSessions?: number;
  /**
   * The directory a persisted engine session ran in, for `attach` → resume
   * (Claude resolves `--resume <id>` within its project directory).
   */
  readonly resumeCwdOf?: (
    engine: TAgentEngine,
    sessionId: string,
  ) => string | undefined;
  /**
   * Remove one session from the device after its dispatcher process (if
   * any) was killed: stop a terminal host, drop attachments, transcript and
   * history lines. Absent → `delete_session` is refused as unsupported.
   */
  readonly deleteSession?: (
    sessionId: string,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
};

export type TAgentDispatcher = {
  /** Register one consumer (a mux stream or a loopback socket). */
  readonly connect: (consumer: TAgentConsumer) => TAgentConnection;
  /** Live session ids (diagnostics, tests). */
  readonly sessionIds: () => readonly string[];
  /** Release every session (daemon shutdown, tests); engines keep running. */
  readonly closeAll: () => void;
};

type TConsumerState = {
  readonly consumer: TAgentConsumer;
  queued: number;
  chain: Promise<void>;
  gone: boolean;
};

type TSession = {
  readonly id: string;
  readonly engine: TAgentEngine;
  engineSession: TAgentEngineSession | null;
  readonly consumers: Set<TConsumerState>;
  readonly log: TAgentEvent[];
  seq: number;
  exited: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the session last published an event (idle reap of a busy turn). */
  lastActivityAt: number;
  /** Command id stamped on events the engine emits while it handles one. */
  activeCommandId: string | undefined;
  /** Run once `session.exited` was published. */
  readonly exitWatchers: (() => void)[];
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Shrink an event's bulky fields so it fits one NDJSON line. */
const shrinkItem = (item: TAgentItem): TAgentItem =>
  shrinkAgentItem(item, {
    text: 512 * 1024,
    output: AGENT_TOOL_OUTPUT_MAX_CHARS / 4,
    input: 0,
  });

/**
 * A `runtime.warning` standing in for an event that cannot be delivered. It
 * keeps the event's framing (session, seq, time, command id), so a command
 * waiting on that event is still answered.
 */
const undeliverable = (
  event: TAgentEvent,
  code: string,
  message: string,
): TAgentEvent => ({
  type: "runtime.warning",
  code,
  message,
  ...(event.session_id === undefined ? {} : { session_id: event.session_id }),
  ...(event.seq === undefined ? {} : { seq: event.seq }),
  ...(event.at === undefined ? {} : { at: event.at }),
  ...(event.command_id === undefined ? {} : { command_id: event.command_id }),
});

/**
 * The event, or a truncated copy that fits {@link encodeAgentLine}'s bound,
 * or a `runtime.warning` standing in for it when nothing fits — or when it
 * would not decode on the consumer (which drops such an event silently: an
 * approval would just never show).
 */
export const fitAgentEvent = (event: TAgentEvent): TAgentEvent => {
  const fitted = fitAgentEventSize(event);
  if (fitted === null)
    return undeliverable(
      event,
      "event_too_large",
      `An ${event.type} event was too large to deliver.`,
    );
  if (parseAgentEvent(fitted) === null) {
    logInfo("agent", "dropping an agent event the protocol rejects", {
      type: event.type,
    });
    return undeliverable(
      event,
      "invalid_event",
      `An ${event.type} event did not match the agent protocol.`,
    );
  }
  return fitted;
};

/** The event, or a truncated copy within the line bound, or null. */
const fitAgentEventSize = (event: TAgentEvent): TAgentEvent | null => {
  if (encodeAgentLine(event) !== null) return event;
  let shrunk: TAgentEvent = event;
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    shrunk = { ...event, item: shrinkItem(event.item) };
  } else if (event.type === "content.delta") {
    shrunk = { ...event, delta: clip(event.delta, 512 * 1024) };
  } else if (event.type === "request.opened") {
    const { input: _input, ...rest } = event;
    shrunk = rest;
  }
  return encodeAgentLine(shrunk) === null ? null : shrunk;
};

/**
 * Replay view of a session log: `content.delta`s of items that have since
 * completed are dropped — the `item.completed` carries the full text.
 */
const replayOf = (log: readonly TAgentEvent[]): TAgentEvent[] => {
  const completed = new Set<string>();
  for (const event of log)
    if (event.type === "item.completed") completed.add(event.item_id);
  return log.filter(
    (event) => event.type !== "content.delta" || !completed.has(event.item_id),
  );
};

/** Strict cwd validation: absolute, existing directory (realpath'd). */
const validateCwd = (requested: string | undefined): string | null => {
  if (requested === undefined) return homedir();
  if (!isAbsolute(requested)) return null;
  try {
    const real = realpathSync(resolve(requested));
    return existsSync(real) && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
};

export const createAgentDispatcher = (
  options: TAgentDispatcherOptions,
): TAgentDispatcher => {
  const now = options.now ?? Date.now;
  const detachedIdleMs = options.detachedIdleMs ?? AGENT_DETACHED_IDLE_MS;
  const maxSessions = options.maxSessions ?? AGENT_MAX_SESSIONS;
  const adapters = new Map<TAgentEngine, TAgentEngineAdapter>(
    options.adapters.map((adapter) => [adapter.engine, adapter] as const),
  );
  const sessions = new Map<string, TSession>();

  // ── delivery ─────────────────────────────────────────────────────────

  const dropConsumer = (
    session: TSession | null,
    state: TConsumerState,
    code?: "lagging",
  ): void => {
    if (state.gone) return;
    state.gone = true;
    session?.consumers.delete(state);
    if (session !== null) scheduleIdle(session);
    if (code !== undefined) state.consumer.end(code);
  };

  /** Queue one event on a consumer, in order, with backpressure. */
  const deliver = (
    session: TSession | null,
    state: TConsumerState,
    event: TAgentEvent,
  ): void => {
    if (state.gone) return;
    if (state.queued >= AGENT_CONSUMER_MAX_QUEUED) {
      dropConsumer(session, state, "lagging");
      return;
    }
    state.queued += 1;
    const fitted = fitAgentEvent(event);
    state.chain = state.chain.then(async () => {
      if (state.gone) return;
      const ok = await state.consumer.send(fitted).catch(() => false);
      state.queued -= 1;
      // The event fits a line (fitted above), so a false is a dead transport.
      if (!ok) dropConsumer(session, state);
    });
  };

  /** Stop driving the engine, leaving it running when the adapter can. */
  const releaseEngine = (session: TSession): void => {
    const engineSession = session.engineSession;
    if (engineSession === null) return;
    if (engineSession.release !== undefined) engineSession.release();
    else engineSession.close("closed");
  };

  const scheduleIdle = (
    session: TSession,
    delayMs: number = detachedIdleMs,
  ): void => {
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    if (session.exited || session.consumers.size > 0) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      if (session.consumers.size > 0 || session.exited) return;
      // A running turn keeps its session while it shows signs of life. One
      // that went silent for a whole window (wedged: no end ever came) is
      // released like any idle session, so it cannot hold a session slot
      // until restart; the engine keeps running for a later attach.
      const quietMs = now() - session.lastActivityAt;
      if (
        session.engineSession?.turnActive() === true &&
        quietMs < detachedIdleMs
      ) {
        scheduleIdle(session, Math.max(1, detachedIdleMs - quietMs));
        return;
      }
      logInfo("agent", "releasing idle detached agent session", {
        id: session.id,
      });
      releaseEngine(session);
    }, delayMs);
    session.idleTimer.unref?.();
  };

  /** Stamp + log + fan out one session event. */
  const publish = (
    session: TSession,
    event: TAgentEvent,
    commandId?: string,
  ): void => {
    session.seq += 1;
    session.lastActivityAt = now();
    const id = commandId ?? session.activeCommandId;
    const stamped: TAgentEvent = {
      ...event,
      session_id: session.id,
      seq: session.seq,
      at: now(),
      ...(id === undefined ? {} : { command_id: id }),
    };
    // A history marker is per-consumer framing, never part of the replay.
    if (event.type !== "history.page") session.log.push(stamped);
    if (session.log.length > AGENT_REPLAY_LOG_EVENTS)
      session.log.splice(0, session.log.length - AGENT_REPLAY_LOG_EVENTS);
    for (const state of session.consumers) deliver(session, state, stamped);
    if (event.type === "session.exited") {
      session.exited = true;
      sessions.delete(session.id);
      if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
      for (const watcher of session.exitWatchers.splice(0)) watcher();
    }
  };

  /** One event to a single consumer, outside any session (errors). */
  const reply = (
    state: TConsumerState,
    session: TSession | null,
    event: TAgentEvent,
    commandId: string | undefined,
  ): void => {
    deliver(session, state, {
      ...event,
      ...(session === null ? {} : { session_id: session.id }),
      at: now(),
      ...(commandId === undefined ? {} : { command_id: commandId }),
    });
  };

  const error = (
    state: TConsumerState,
    session: TSession | null,
    code: string,
    message: string,
    commandId: string | undefined,
  ): void => {
    reply(state, session, { type: "runtime.error", code, message }, commandId);
  };

  const startSession = (args: {
    readonly id: string;
    readonly engine: TAgentEngine;
    readonly resume: boolean;
    readonly model?: string;
    readonly cwd: string;
    readonly skipPermissions: boolean;
    readonly title?: string;
    readonly state: TConsumerState;
    readonly commandId: string | undefined;
  }): TSession | null => {
    const adapter = adapters.get(args.engine);
    if (adapter === undefined) {
      error(
        args.state,
        null,
        "engine_unavailable",
        `${args.engine} agent sessions are not supported by this daemon yet.`,
        args.commandId,
      );
      return null;
    }
    if (sessions.size >= maxSessions) {
      error(
        args.state,
        null,
        "agent_busy",
        "Too many agent sessions are running on this device.",
        args.commandId,
      );
      return null;
    }
    const session: TSession = {
      id: args.id,
      engine: args.engine,
      engineSession: null,
      consumers: new Set([args.state]),
      log: [],
      seq: 0,
      exited: false,
      idleTimer: undefined,
      lastActivityAt: now(),
      activeCommandId: undefined,
      exitWatchers: [],
    };
    sessions.set(session.id, session);
    publish(
      session,
      {
        type: "session.started",
        session_id: session.id,
        engine: args.engine,
        ...(args.model === undefined ? {} : { model: args.model }),
        cwd: args.cwd,
        ...(args.resume ? { resumed: true } : {}),
        ...(args.skipPermissions ? { skip_permissions: true } : {}),
      },
      args.commandId,
    );
    session.engineSession = adapter.start(
      {
        sessionId: session.id,
        resume: args.resume,
        ...(args.model === undefined ? {} : { model: args.model }),
        cwd: args.cwd,
        skipPermissions: args.skipPermissions,
        ...(args.title === undefined ? {} : { title: args.title }),
        observed: () => session.consumers.size > 0,
      },
      (event) => {
        if (!session.exited) publish(session, event);
      },
    );
    logInfo("agent", "agent session started", {
      id: session.id,
      engine: args.engine,
      resumed: args.resume,
      skipPermissions: args.skipPermissions,
    });
    return session;
  };

  /** Run `fn` with `commandId` stamped on the events it synchronously emits. */
  const withCommand = <T>(
    session: TSession,
    commandId: string | undefined,
    fn: () => T,
  ): T => {
    const previous = session.activeCommandId;
    session.activeCommandId = commandId;
    try {
      return fn();
    } finally {
      session.activeCommandId = previous;
    }
  };

  return {
    connect: (consumer) => {
      const state: TConsumerState = {
        consumer,
        queued: 0,
        chain: Promise.resolve(),
        gone: false,
      };
      let bound: TSession | null = null;
      let closing = false;

      const endAfterDrain = (): void => {
        closing = true;
        void state.chain.then(() => {
          if (!state.gone) {
            state.gone = true;
            consumer.end();
          }
        });
      };

      const handle = (command: TAgentCommand): void => {
        const commandId = command.id;
        if (closing || state.gone) return;
        if (bound?.exited === true) bound = null;
        switch (command.type) {
          case "start": {
            if (bound !== null) {
              error(
                state,
                bound,
                "already_bound",
                "This stream already drives a session.",
                commandId,
              );
              return;
            }
            const cwd = validateCwd(command.cwd);
            if (cwd === null) {
              error(
                state,
                null,
                "invalid_cwd",
                "cwd must be an existing absolute directory.",
                commandId,
              );
              return;
            }
            // The model becomes the engine's `--model` argument: hold it to
            // the same ids `set_model` accepts (no leading `-`, no spaces or
            // control characters).
            if (
              command.model !== undefined &&
              !AGENT_SWITCH_MODEL_PATTERN.test(command.model)
            ) {
              error(
                state,
                null,
                "invalid_model",
                "invalid model id",
                commandId,
              );
              return;
            }
            const requestedId = command.session_id;
            if (requestedId !== undefined) {
              // The consumer names the session (its own record id). A host
              // or Claude session pinned to it must be NEW: an id already in
              // use would join or fork someone else's conversation.
              const existing = sessions.get(requestedId);
              if (
                !SESSION_ID_PATTERN.test(requestedId) ||
                (existing !== undefined && !existing.exited)
              ) {
                error(
                  state,
                  null,
                  "invalid_session",
                  "That session id cannot start a new session.",
                  commandId,
                );
                return;
              }
            }
            bound = startSession({
              id: requestedId ?? crypto.randomUUID(),
              engine: command.engine,
              resume: false,
              ...(command.model === undefined ? {} : { model: command.model }),
              cwd,
              skipPermissions: command.skip_permissions === true,
              ...(command.title === undefined ? {} : { title: command.title }),
              state,
              commandId,
            });
            return;
          }
          case "attach": {
            if (bound !== null) {
              error(
                state,
                bound,
                "already_bound",
                "This stream already drives a session.",
                commandId,
              );
              return;
            }
            if (!AGENT_SESSION_ID_PATTERN.test(command.session_id)) {
              error(
                state,
                null,
                "invalid_session",
                "Invalid session id.",
                commandId,
              );
              return;
            }
            const live = sessions.get(command.session_id);
            if (live !== undefined && !live.exited) {
              if (
                command.engine !== undefined &&
                command.engine !== live.engine
              ) {
                error(
                  state,
                  null,
                  "engine_mismatch",
                  "That session runs a different engine.",
                  commandId,
                );
                return;
              }
              bound = live;
              if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
              live.idleTimer = undefined;
              // The latest window only; older turns page in on demand.
              const window = latestReplayWindow(replayOf(live.log));
              reply(
                state,
                live,
                {
                  type: "history.page",
                  has_more: window.hasMore,
                  ...(window.firstTurnId === null
                    ? {}
                    : { before_cursor: historyCursorOf(window.firstTurnId) }),
                },
                commandId,
              );
              for (const event of window.events) deliver(live, state, event);
              live.consumers.add(state);
              void state.chain.then(() => {
                if (!state.gone) consumer.replayDone();
              });
              return;
            }
            // Not running here: resume the engine's own persisted session.
            const engine = command.engine ?? "claude";
            bound = startSession({
              id: command.session_id,
              engine,
              resume: true,
              cwd:
                validateCwd(
                  options.resumeCwdOf?.(engine, command.session_id) ??
                    homedir(),
                ) ?? homedir(),
              skipPermissions: false,
              state,
              commandId,
            });
            void state.chain.then(() => {
              if (!state.gone) consumer.replayDone();
            });
            return;
          }
          case "send": {
            const session = bound;
            if (session === null || session.engineSession === null) {
              error(
                state,
                null,
                "no_session",
                "Start or attach a session first.",
                commandId,
              );
              return;
            }
            const engineSession = session.engineSession;
            const result = withCommand(session, commandId, () =>
              engineSession.send({
                prompt: command.prompt,
                attachments: command.attachments ?? [],
              }),
            );
            if (!result.ok)
              error(state, session, result.code, result.message, commandId);
            return;
          }
          case "set_model": {
            const session = bound;
            if (session === null || session.engineSession === null) {
              error(
                state,
                null,
                "no_session",
                "Start or attach a session first.",
                commandId,
              );
              return;
            }
            const engineSession = session.engineSession;
            const setModel = engineSession.setModel;
            if (setModel === undefined) {
              error(
                state,
                session,
                "unsupported",
                "This engine cannot switch models.",
                commandId,
              );
              return;
            }
            const result = withCommand(session, commandId, () =>
              setModel(command.model),
            );
            if (!result.ok)
              error(state, session, result.code, result.message, commandId);
            return;
          }
          case "interrupt": {
            const session = bound;
            if (session === null || session.engineSession === null) {
              error(
                state,
                null,
                "no_session",
                "Start or attach a session first.",
                commandId,
              );
              return;
            }
            const engineSession = session.engineSession;
            if (
              !withCommand(session, commandId, () => engineSession.interrupt())
            )
              error(
                state,
                session,
                "no_active_turn",
                "No turn is running.",
                commandId,
              );
            return;
          }
          case "respond": {
            const session = bound;
            if (session === null || session.engineSession === null) {
              error(
                state,
                null,
                "no_session",
                "Start or attach a session first.",
                commandId,
              );
              return;
            }
            const engineSession = session.engineSession;
            if (
              !withCommand(session, commandId, () =>
                engineSession.respond(command),
              )
            )
              error(
                state,
                session,
                "unknown_request",
                "No such pending request.",
                commandId,
              );
            return;
          }
          case "close": {
            const session = bound;
            if (session === null || session.engineSession === null) {
              endAfterDrain();
              return;
            }
            const engineSession = session.engineSession;
            // Stop: kill the process, keep its history (attachments too) so
            // the row resumes. `delete_session` is the destructive path.
            // The consumer ends once `session.exited` was delivered to it.
            session.exitWatchers.push(endAfterDrain);
            withCommand(session, commandId, () =>
              engineSession.close("closed"),
            );
            return;
          }
          case "delete_session": {
            const deleteSession = options.deleteSession;
            if (deleteSession === undefined) {
              error(
                state,
                null,
                "unsupported",
                "This device cannot delete sessions.",
                commandId,
              );
              return;
            }
            const targetId = command.session_id;
            const live = sessions.get(targetId);
            if (live !== undefined && !live.exited) {
              const engineSession = live.engineSession;
              if (engineSession !== null) engineSession.close("killed");
            }
            if (bound?.id === targetId) bound = null;
            state.chain = state.chain
              .then(() => deleteSession(targetId))
              .then(
                (result) => {
                  if (result.ok)
                    reply(
                      state,
                      null,
                      { type: "session.deleted", session_id: targetId },
                      commandId,
                    );
                  else
                    error(state, null, result.code, result.message, commandId);
                },
                (err: unknown) => {
                  logError("agent", err);
                  error(
                    state,
                    null,
                    "internal",
                    "The session could not be deleted on this device.",
                    commandId,
                  );
                },
              );
            return;
          }
          case "history_get": {
            const session = bound;
            if (session === null) {
              error(
                state,
                null,
                "no_session",
                "Start or attach a session first.",
                commandId,
              );
              return;
            }
            const beforeTurnId = turnIdOfCursor(command.before);
            if (beforeTurnId === null) {
              error(
                state,
                session,
                "invalid_cursor",
                "Unrecognized history cursor.",
                commandId,
              );
              return;
            }
            const limit = command.limit ?? AGENT_HISTORY_DEFAULT_TURNS;
            const page =
              session.engineSession?.history?.(beforeTurnId, limit) ??
              logHistoryPage(session.log, beforeTurnId, limit);
            if (page === null) {
              // Nothing older is known for that cursor: the start.
              reply(
                state,
                session,
                { type: "history.page", has_more: false, events: [] },
                commandId,
              );
              return;
            }
            const bounded = boundHistoryPage({
              events: [...page.events],
              firstTurnId: page.firstTurnId,
              hasMore: page.hasMore,
            });
            const pageEvent: TAgentEvent = {
              type: "history.page",
              has_more: bounded.hasMore,
              ...(bounded.firstTurnId === null
                ? {}
                : { before_cursor: historyCursorOf(bounded.firstTurnId) }),
              events: bounded.events.map((event) => ({
                ...fitAgentEvent(event),
                session_id: session.id,
              })),
            };
            // A page that still cannot travel as one line must answer the
            // command anyway: the consumer stops paging on this error rather
            // than wait forever for a page that was swapped for a warning.
            if (
              encodeAgentLine({
                ...pageEvent,
                session_id: session.id,
                at: now(),
                ...(commandId === undefined ? {} : { command_id: commandId }),
              }) === null
            ) {
              error(
                state,
                session,
                "history_page_too_large",
                "This part of the session's history is too large to load.",
                commandId,
              );
              return;
            }
            reply(state, session, pageEvent, commandId);
            return;
          }
          case "attachment_get": {
            const session = bound;
            if (session === null) {
              error(
                state,
                null,
                "no_session",
                "Start or attach a session first.",
                commandId,
              );
              return;
            }
            const resolved = resolveAgentAttachment(session.id, command.name);
            if (!resolved.ok) {
              error(state, session, resolved.code, resolved.message, commandId);
              return;
            }
            for (const chunk of chunkAgentAttachment(
              command.name,
              resolved.mime,
              resolved.bytes,
            )) {
              reply(
                state,
                session,
                {
                  type: "attachment.data",
                  name: chunk.name,
                  mime: chunk.mime,
                  size: chunk.size,
                  offset: chunk.offset,
                  data: chunk.data,
                  done: chunk.done,
                },
                commandId,
              );
            }
            return;
          }
        }
      };

      return {
        command: (command) => {
          try {
            handle(command);
          } catch (err) {
            logError("agent", err);
            error(
              state,
              bound,
              "internal",
              "The command failed on this device.",
              command.id,
            );
          }
        },
        invalid: () => {
          error(
            state,
            bound,
            "invalid_command",
            "Unrecognized or invalid agent command.",
            undefined,
          );
        },
        detach: () => {
          if (state.gone) return;
          state.gone = true;
          if (bound !== null) {
            bound.consumers.delete(state);
            scheduleIdle(bound);
          }
        },
      };
    },
    sessionIds: () => [...sessions.keys()],
    closeAll: () => {
      // Daemon shutdown: never kill durable terminal sessions.
      for (const session of [...sessions.values()]) releaseEngine(session);
    },
  };
};
