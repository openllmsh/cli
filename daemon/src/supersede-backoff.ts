/**
 * Stand-down backoff for a control channel evicted by ANOTHER daemon holding
 * the same API key — extracted from `control-channel.ts` so the escalation is
 * pure and unit-testable (no partysocket, no module singletons), matching
 * `heartbeat.ts`.
 *
 * Why it exists: the relay registers exactly ONE daemon socket per `key_id`, so
 * a newer `hello` evicts the incumbent with close `4000 superseded`
 * (`daemon-registry.ts#registerDaemon`). Two daemons sharing a key therefore
 * take turns evicting each other — and partysocket turns that into a permanent,
 * never-backing-off war: it resets its retry counter on every OPEN
 * (`ws.js#_handleOpen`), and in a supersede war every dial DOES open (the
 * eviction lands ~150ms later), so the delay never grows past
 * `minReconnectionDelay`. Both sides re-dial in ~1s, forever.
 *
 * That flap is not cosmetic. Every `onopen` runs `resetRelayScopedState()` →
 * browser attachment transport, so each cycle drops every attached viewer.
 * mux stream: the browser terminal drops every few seconds and settles on
 * "Couldn't open this session".
 *
 * So a supersede close must ESCALATE a stand-down instead of resetting like a
 * healthy reconnect. Only ONE side has to yield for the war to end, and the
 * yielding side keeps retrying (the winner may be a zombie that later dies).
 *
 * A delivered `4000 superseded` always means a FOREIGN daemon took the key —
 * our own reconnects cannot produce one here, because partysocket detaches the
 * old socket's listeners before dialing (`_disconnect` → `_removeListeners`),
 * so an eviction aimed at our own stale socket is never seen by this handler.
 */

export const SUPERSEDE_CLOSE_CODE = 4000;
export const SUPERSEDE_CLOSE_REASON = "superseded";

/** Whether a close event is the relay evicting us for a same-key daemon. */
export const isSupersededClose = (code: number, reason: string): boolean =>
  code === SUPERSEDE_CLOSE_CODE &&
  reason.toLowerCase().includes(SUPERSEDE_CLOSE_REASON);

export type TSupersedeBackoffDeps = {
  /** Stand-down after the first eviction; doubles per consecutive eviction. */
  readonly baseMs: number;
  /** Ceiling for the doubling. */
  readonly maxMs: number;
  /**
   * A connection that lived at least this long before being evicted starts a
   * FRESH conflict rather than continuing the previous escalation — otherwise a
   * daemon that was briefly displaced hours ago would still be standing down
   * for minutes on its next (unrelated) eviction.
   */
  readonly stableAfterMs: number;
  /** Jitter for a NORMAL re-dial (no active conflict) — fleet de-sync only. */
  readonly jitterMs: number;
  readonly random?: () => number;
};

export type TSupersedeBackoff = {
  /** Record this connection opening (starts the stability clock). */
  readonly noteOpen: (atMs: number) => void;
  /** Record this connection closing — escalates only on a supersede. */
  readonly noteClose: (code: number, reason: string, atMs: number) => void;
  /** Consecutive evictions; 0 when the last close was not a supersede. */
  readonly streak: () => number;
  /** Deterministic stand-down ceiling for the current streak (0 when none). */
  readonly standDownMs: () => number;
  /** How long to wait before the next dial, jittered. */
  readonly nextDelayMs: () => number;
};

export const createSupersedeBackoff = (
  deps: TSupersedeBackoffDeps,
): TSupersedeBackoff => {
  const random = deps.random ?? Math.random;
  let streak = 0;
  let openedAtMs: number | null = null;

  const standDownMs = (): number =>
    streak === 0
      ? 0
      : Math.min(deps.maxMs, deps.baseMs * 2 ** Math.min(streak - 1, 30));

  return {
    noteOpen: (atMs) => {
      openedAtMs = atMs;
    },
    noteClose: (code, reason, atMs) => {
      const lived = openedAtMs === null ? 0 : atMs - openedAtMs;
      openedAtMs = null;
      // Any other close (1006 unreachable, 1000/1001 relay cycling, our own
      // stop) is a normal reconnect — drop back to plain jitter.
      if (!isSupersededClose(code, reason)) {
        streak = 0;
        return;
      }
      streak = lived >= deps.stableAfterMs ? 1 : streak + 1;
    },
    streak: () => streak,
    standDownMs,
    nextDelayMs: () => {
      const standDown = standDownMs();
      // No conflict: keep the existing fleet de-sync jitter.
      if (standDown === 0) return random() * deps.jitterMs;
      // Half fixed + half random: the fixed half guarantees the incumbent an
      // actually-quiet window (full jitter could redraw ~0 and re-thrash), the
      // random half de-correlates two contenders evicted at the same instant.
      return standDown / 2 + random() * (standDown / 2);
    },
  };
};
