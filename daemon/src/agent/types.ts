/**
 * Engine-adapter contract for agent sessions
 * (docs/plan/2026-10-23-agent-sessions-replace-remote-pty.md, "Agent
 * protocol"). One adapter per engine; every adapter emits the same
 * `@openllmsh/protocol` agent event stream, so the dispatcher and the UI never
 * see engine-specific shapes.
 */
import type {
  TAgentAttachment,
  TAgentCommand,
  TAgentEngine,
  TAgentEvent,
  TAgentRespondCommand,
} from "@openllmsh/protocol";

/** How an engine session is started. */
export type TAgentEngineStartOptions = {
  /** The session id, minted by the dispatcher (new) or the vendor id (resume). */
  readonly sessionId: string;
  /** True: resume the engine's own persisted session `sessionId`. */
  readonly resume: boolean;
  /** Gateway model id; undefined keeps the engine's openllm default. */
  readonly model?: string;
  /** Validated absolute directory the engine runs in. */
  readonly cwd: string;
  /** Per-session opt-in to the engine's skip-permissions mode. */
  readonly skipPermissions: boolean;
  /** Optional human title (indexed by the local session list). */
  readonly title?: string;
  /** True while a consumer (web / desktop) is attached to the session. */
  readonly observed?: () => boolean;
};

/**
 * Adapter → dispatcher. The dispatcher stamps `session_id` / `seq` / `at` /
 * `command_id`, keeps the attach replay log and fans the event out.
 */
export type TAgentEngineEmit = (event: TAgentEvent) => void;

export type TAgentSendInput = {
  readonly prompt: string;
  readonly attachments: readonly TAgentAttachment[];
};

export type TAgentSendResult =
  | { readonly ok: true; readonly turnId: string }
  /** Held behind the running turn; it goes out as that turn ends. */
  | { readonly ok: true; readonly queued: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A running engine session. Every method is safe after exit (no-op / false). */
export type TAgentEngineSession = {
  /** Start a turn with one user message. */
  readonly send: (input: TAgentSendInput) => TAgentSendResult;
  /**
   * Deliver the queued prompts now, mid-turn (absent → the engine cannot).
   * False when nothing is queued.
   */
  readonly sendNow?: () => boolean;
  /** Resume automatic delivery after an interrupt held the queue. */
  readonly resumeQueue?: () => boolean;
  /** Cancel one queued prompt by its daemon-minted id. */
  readonly cancelQueued?: (queueId: string) => boolean;
  /** Interrupt the active turn; false when no turn is active. */
  readonly interrupt: () => boolean;
  /** Answer a pending approval / user-input request; false when unknown. */
  readonly respond: (command: TAgentRespondCommand) => boolean;
  /** True while a turn runs (sends are queued meanwhile). */
  readonly turnActive: () => boolean;
  /**
   * Switch the model (absent → the engine cannot). Applied when idle, queued
   * while a turn runs; `session.configured` confirms it.
   */
  readonly setModel?: (model: string) => TAgentSendResult;
  /**
   * End the session. `reason` lands on the `session.exited` the adapter emits
   * once the engine process is gone.
   */
  readonly close: (reason: "closed" | "killed") => void;
  /**
   * Stop driving the engine but leave it running (idle reap, daemon
   * shutdown): a durable terminal session must outlive the daemon's interest.
   * Emits `session.exited{closed}`. Absent → {@link close} is used.
   */
  readonly release?: () => void;
  /**
   * Older history from the engine's own record: the whole turns strictly
   * before `beforeTurnId`, newest `limit` of them. Absent, or null for a turn
   * it does not know → the dispatcher pages its in-memory log instead.
   */
  readonly history?: (
    beforeTurnId: string,
    limit: number,
  ) => {
    readonly events: readonly TAgentEvent[];
    readonly firstTurnId: string | null;
    readonly hasMore: boolean;
  } | null;
};

export type TAgentEngineAdapter = {
  readonly engine: TAgentEngine;
  /** Spawn the engine. Failures surface as `runtime.error` + `session.exited`. */
  readonly start: (
    options: TAgentEngineStartOptions,
    emit: TAgentEngineEmit,
  ) => TAgentEngineSession;
};

/** One consumer of a dispatcher connection (a mux stream or a loopback socket). */
export type TAgentConsumer = {
  /** Deliver one event; false when it could not be written (consumer gone). */
  readonly send: (event: TAgentEvent) => Promise<boolean>;
  /** Attach replay finished. */
  readonly replayDone: () => void;
  /** End the transport; a code means abnormal (reset / close code). */
  readonly end: (code?: "lagging" | "protocol_error") => void;
};

/** The dispatcher side of one consumer connection. */
export type TAgentConnection = {
  /** A validated command line. */
  readonly command: (command: TAgentCommand) => void;
  /** A line that did not validate as a command. */
  readonly invalid: (value: unknown) => void;
  /** The transport went away: leave the session running for a later attach. */
  readonly detach: () => void;
};
