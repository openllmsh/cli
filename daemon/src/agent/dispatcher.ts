/**
 * The agent dispatcher — ONE session registry with two front doors (the mux
 * `kind:"agent"` stream handler and the loopback WebSocket), feeding the same
 * engine adapters (plan "Agent protocol" → Transports → Daemon).
 *
 * A session outlives its consumer: a dropped stream / socket only detaches,
 * and a later `attach` (from either front door) rejoins it with a replay of
 * the session's recent events followed by `replay_done`. An `attach` to an id
 * the daemon is not running resumes the engine's own persisted session
 * (`--resume`). Detached sessions are reaped after an idle window.
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
import { AGENT_SESSION_ID_PATTERN, encodeAgentLine } from "@openllmsh/protocol";
import { logError, logInfo } from "../logger";
import { AGENT_TOOL_OUTPUT_MAX_CHARS } from "./claude-code";
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
};

export type TAgentDispatcher = {
  /** Register one consumer (a mux stream or a loopback socket). */
  readonly connect: (consumer: TAgentConsumer) => TAgentConnection;
  /** Live session ids (diagnostics, tests). */
  readonly sessionIds: () => readonly string[];
  /** Kill every session (daemon shutdown, tests). */
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
  /** Command id stamped on events the engine emits while it handles one. */
  activeCommandId: string | undefined;
  /** Run once `session.exited` was published. */
  readonly exitWatchers: (() => void)[];
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Shrink an event's bulky fields so it fits one NDJSON line. */
const shrinkItem = (item: TAgentItem): TAgentItem => {
  if (item.kind !== "tool_call")
    return { ...item, text: clip(item.text, 512 * 1024) };
  const { input: _input, ...rest } = item;
  return {
    ...rest,
    ...(rest.output === undefined
      ? {}
      : { output: clip(rest.output, AGENT_TOOL_OUTPUT_MAX_CHARS / 4) }),
  };
};

/**
 * The event, or a truncated copy that fits {@link encodeAgentLine}'s bound,
 * or a `runtime.warning` standing in for it when nothing fits.
 */
export const fitAgentEvent = (event: TAgentEvent): TAgentEvent => {
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
  if (encodeAgentLine(shrunk) !== null) return shrunk;
  return {
    type: "runtime.warning",
    code: "event_too_large",
    message: `An ${event.type} event was too large to deliver.`,
    ...(event.session_id === undefined ? {} : { session_id: event.session_id }),
    ...(event.seq === undefined ? {} : { seq: event.seq }),
    ...(event.at === undefined ? {} : { at: event.at }),
  };
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

  const scheduleIdle = (session: TSession): void => {
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    if (session.exited || session.consumers.size > 0) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      if (session.consumers.size > 0 || session.exited) return;
      if (session.engineSession?.turnActive() === true) {
        scheduleIdle(session);
        return;
      }
      logInfo("agent", "closing idle detached agent session", {
        id: session.id,
      });
      session.engineSession?.close("closed");
    }, detachedIdleMs);
    session.idleTimer.unref?.();
  };

  /** Stamp + log + fan out one session event. */
  const publish = (
    session: TSession,
    event: TAgentEvent,
    commandId?: string,
  ): void => {
    session.seq += 1;
    const id = commandId ?? session.activeCommandId;
    const stamped: TAgentEvent = {
      ...event,
      session_id: session.id,
      seq: session.seq,
      at: now(),
      ...(id === undefined ? {} : { command_id: id }),
    };
    session.log.push(stamped);
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
            bound = startSession({
              id: crypto.randomUUID(),
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
              for (const event of replayOf(live.log))
                deliver(live, state, event);
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
            // The consumer ends once `session.exited` was delivered to it.
            session.exitWatchers.push(endAfterDrain);
            withCommand(session, commandId, () =>
              engineSession.close("closed"),
            );
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
      for (const session of sessions.values())
        session.engineSession?.close("killed");
    },
  };
};
