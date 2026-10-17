/**
 * Dirty-gated status publication.
 *
 * The relay watcher used to re-run every provider `status()` on a fixed 15s
 * cadence even when nothing had changed (docs/audit/cli-daemon-performance/
 * 04-daemon-lifecycle.md §1 / §6). That paid keychain / CLI observe work on
 * idle hosts and violated demand-only auth policy.
 *
 * Rules:
 *   - Event paths (auth, local scan, bootstrap, command, welcome, presence)
 *     mark dirty and may push immediately.
 *   - Watcher ticks are cheap: compute only when dirty, or on a slow
 *     heartbeat so UI freshness cannot stall forever if an event is missed.
 *   - On-demand refresh (dashboard / CLI) stays immediate via the existing
 *     command / auth-sink / pushStatus paths — those never consult this gate.
 */

export type TStatusDirtyReason =
  | "auth"
  | "local-servers"
  | "bootstrap"
  | "command"
  | "manual"
  | "presence"
  | "unknown";

/** Cheap watcher poll — only checks the dirty bit / heartbeat due. */
export const STATUS_WATCH_POLL_MS = 30_000;

/**
 * Full recompute cadence when nothing has marked dirty. Long enough that an
 * idle laptop is not probing providers every few seconds; short enough that a
 * missed fs/auth event still surfaces within ~2 minutes.
 */
export const STATUS_WATCH_HEARTBEAT_MS = 120_000;

export type TStatusWatcherGate = {
  readonly markDirty: (reason?: TStatusDirtyReason) => void;
  readonly isDirty: () => boolean;
  /** Reason of the current dirty bit, or null when clean. */
  readonly dirtyReason: () => TStatusDirtyReason | null;
  /**
   * Clear the dirty bit without consulting the heartbeat. Use when a compute
   * is starting for any trigger so the next watcher tick does not redo work
   * already covered; marks that arrive during the compute stay queued.
   */
  readonly clearDirty: () => void;
  /**
   * Whether a watcher tick should run `computeStatusFresh`. Consumes the dirty
   * bit when returning true for a dirty tick (heartbeat ticks leave it clear).
   */
  readonly consumeWatcherCompute: (nowMs?: number) => {
    readonly run: boolean;
    /** True when running only because the slow heartbeat elapsed. */
    readonly heartbeatOnly: boolean;
  };
  /** Record that a fresh compute finished (any trigger). */
  readonly noteComputed: (nowMs?: number) => void;
  /** Test / shutdown helper. */
  readonly reset: () => void;
};

export type TStatusWatcherGateDeps = {
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly now?: () => number;
};

export const createStatusWatcherGate = (
  deps: TStatusWatcherGateDeps = {},
): TStatusWatcherGate => {
  const heartbeatMs = deps.heartbeatMs ?? STATUS_WATCH_HEARTBEAT_MS;
  const now = deps.now ?? Date.now;
  let dirty: TStatusDirtyReason | null = null;
  let lastComputedAtMs = 0;

  return {
    markDirty: (reason = "unknown") => {
      dirty = reason;
    },
    isDirty: () => dirty !== null,
    dirtyReason: () => dirty,
    clearDirty: () => {
      dirty = null;
    },
    consumeWatcherCompute: (nowMs = now()) => {
      if (dirty !== null) {
        dirty = null;
        return { run: true, heartbeatOnly: false };
      }
      if (lastComputedAtMs === 0 || nowMs - lastComputedAtMs >= heartbeatMs) {
        return { run: true, heartbeatOnly: lastComputedAtMs !== 0 };
      }
      return { run: false, heartbeatOnly: false };
    },
    noteComputed: (nowMs = now()) => {
      lastComputedAtMs = nowMs;
    },
    reset: () => {
      dirty = null;
      lastComputedAtMs = 0;
    },
  };
};

/** Process-wide gate used by the control-channel watcher + event sinks. */
export const statusWatcherGate = createStatusWatcherGate();

export const markStatusDirty = (reason?: TStatusDirtyReason): void => {
  statusWatcherGate.markDirty(reason);
};
