/**
 * Stand-down backoff when the cloud refuses a channel ticket because the
 * plan's concurrent-device cap is full (`403 device_limit_exceeded`).
 *
 * Extracted from `control-channel.ts` so the escalation is pure and
 * unit-testable (no partysocket, no module singletons) — same shape as
 * `supersede-backoff.ts` / `heartbeat.ts`.
 *
 * Why it exists: device-cap enforcement is deny-newest at
 * `GET /api/daemon/channel` (see `docs/audit/device-cap-mechanism.md` §2,
 * §4, §7 item 5 "Retry storm", §8 item 3). A denied daemon keeps running
 * (local `/v1`, catalog, self-update) and partysocket re-dials the URL
 * provider forever. Without a targeted stand-down that loop is the generic
 * 1–30s reconnect — steady background load and log noise against a gate
 * that only frees when an incumbent disconnects or ages out of the 90s
 * presence window.
 *
 * Distinct from `supersede-backoff.ts`: that one handles same-key eviction
 * wars (WS close `4000 superseded` AFTER a successful open). This one
 * handles multi-device plan caps — the HTTP 403 that arrives BEFORE any
 * socket opens. The two cannot both be active on the same dial path
 * (device-limit never opens; supersede only fires after an open).
 *
 * The process must NOT exit. Only the channel reconnect cadence slows.
 * After the stand-down, a retry may be admitted once a slot frees.
 */

export type TDeviceLimitBackoffDeps = {
  /** Stand-down after the first denial; doubles per consecutive denial. */
  readonly baseMs: number;
  /** Ceiling for the doubling. */
  readonly maxMs: number;
  /**
   * Injected RNG for jitter. Defaults to `Math.random`. Tests pass a fixed
   * source so delays are deterministic.
   */
  readonly random?: () => number;
};

/**
 * Production stand-down pair for device-cap denials. Base sits at the order of
 * the 90s presence window; max caps escalation under sustained over-cap. Shared
 * by `control-channel.ts` and the pure-module unit tests so the values cannot
 * drift.
 */
export const deviceLimitBackoffConfig: Pick<
  TDeviceLimitBackoffDeps,
  "baseMs" | "maxMs"
> = {
  baseMs: 60_000,
  maxMs: 300_000,
};

export type TDeviceLimitBackoff = {
  /** Record a `DeviceLimitExceededError` from the channel handshake. */
  readonly noteDenied: () => void;
  /**
   * Record a successful channel fetch — clears any stand-down so a later
   * unrelated denial starts fresh at the base delay.
   */
  readonly noteSuccess: () => void;
  /** Consecutive denials; 0 when the last fetch was not a device-limit deny. */
  readonly streak: () => number;
  /** Deterministic stand-down ceiling for the current streak (0 when none). */
  readonly standDownMs: () => number;
  /**
   * How long to wait before the next channel fetch, jittered. 0 when no
   * stand-down is active (normal reconnect path owns its own jitter via
   * supersede-backoff / RECONNECT_JITTER_MS).
   */
  readonly nextDelayMs: () => number;
};

export const createDeviceLimitBackoff = (
  deps: TDeviceLimitBackoffDeps,
): TDeviceLimitBackoff => {
  const random = deps.random ?? Math.random;
  let streak = 0;

  const standDownMs = (): number =>
    streak === 0
      ? 0
      : Math.min(deps.maxMs, deps.baseMs * 2 ** Math.min(streak - 1, 30));

  return {
    noteDenied: () => {
      streak += 1;
    },
    noteSuccess: () => {
      streak = 0;
    },
    streak: () => streak,
    standDownMs,
    nextDelayMs: () => {
      const standDown = standDownMs();
      if (standDown === 0) return 0;
      // Half fixed + half random: the fixed half guarantees a real quiet
      // window (full jitter could redraw ~0 and re-thrash the gate), the
      // random half de-correlates multiple over-cap daemons denied together.
      return standDown / 2 + random() * (standDown / 2);
    },
  };
};
