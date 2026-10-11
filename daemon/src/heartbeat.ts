/**
 * The daemon's liveness heartbeat — extracted from `control-channel.ts` so the
 * timer logic is pure and unit-testable (no partysocket, no module singletons).
 *
 * The daemon owns a ping/pong round-trip. Only its matching `pong` proves that
 * the daemon→relay direction works; arbitrary inbound traffic must never reset
 * the watchdog, or a half-open connection can stay alive forever.
 */

const DEFAULT_MAX_MISSED_PONGS = 3;
const PHI_WINDOW_SIZE = 200;
const PHI_MIN_SAMPLES = 8;
const PHI_THRESHOLD = 8;

export type THeartbeatDeps = {
  /** Send one heartbeat `ping` frame to the relay. */
  readonly sendPing: () => void;
  /** Called after the configured consecutive missed-pong grace. */
  readonly onSilent: () => void;
  /** First `pong` after `start()` — the new socket completed a round-trip. */
  readonly onFirstPong?: () => void;
  /** How often the daemon sends its heartbeat ping. */
  readonly heartbeatMs: number;
  /** Consecutive missed-pong grace before reaping. Defaults to three. */
  readonly maxMissedPongs?: number;
  /** Monotonic clock used only by the optional Φ-accrual detector. */
  readonly now?: () => number;
  /**
   * Keep Φ accrual disabled by default. A delayed event loop can make a healthy
   * link look arbitrarily late at the next tick, so Stage 1's bounded
   * consecutive-miss policy remains the production default until stall testing
   * demonstrates that the distribution-based policy is safer.
   */
  readonly usePhiAccrual?: boolean;
};

export type THeartbeat = {
  /** Begin pinging. Idempotent while running. */
  readonly start: () => void;
  /** Record a relay `pong`; this is the sole positive liveness signal. */
  readonly notePong: () => void;
  /** Stop pinging and discard this connection's liveness history. */
  readonly stop: () => void;
};

const defaultNow = (): number => performance.now();

const mean = (samples: readonly number[]): number =>
  samples.reduce((total, sample) => total + sample, 0) / samples.length;

const standardDeviation = (
  samples: readonly number[],
  average: number,
): number =>
  Math.sqrt(
    samples.reduce((total, sample) => total + (sample - average) ** 2, 0) /
      samples.length,
  );

/** Normal-distribution Φ, with a minimum variance to avoid a zero-jitter cliff. */
const phiOf = (
  elapsedMs: number,
  samples: readonly number[],
  minimumDeviationMs: number,
): number => {
  const average = mean(samples);
  const deviation = Math.max(
    standardDeviation(samples, average),
    minimumDeviationMs,
  );
  const z = (elapsedMs - average) / deviation;
  // Abramowitz-Stegun's normal-CDF approximation, expressed as the upper tail.
  // Clamp away from zero so the logarithm remains finite for unusually long gaps.
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const density = Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
  const upperTail =
    density *
    (0.31938153 * t -
      0.356563782 * t ** 2 +
      1.781477937 * t ** 3 -
      1.821255978 * t ** 4 +
      1.330274429 * t ** 5);
  const survival = Math.max(
    z >= 0 ? upperTail : 1 - upperTail,
    Number.MIN_VALUE,
  );
  return -Math.log10(survival);
};

export const createHeartbeat = (deps: THeartbeatDeps): THeartbeat => {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let awaitingFirstPong = false;
  let missedPongs = 0;
  let reaping = false;
  let lastPongAt: number | null = null;
  let pongIntervals: number[] = [];

  const now = deps.now ?? defaultNow;
  const maxMissedPongs = deps.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS;

  const canUsePhi = (): boolean =>
    deps.usePhiAccrual === true &&
    lastPongAt !== null &&
    pongIntervals.length >= PHI_MIN_SAMPLES;

  const isPhiSilent = (): boolean => {
    if (!canUsePhi() || lastPongAt === null) return true;
    return (
      phiOf(now() - lastPongAt, pongIntervals, deps.heartbeatMs / 4) >=
      PHI_THRESHOLD
    );
  };

  const tick = (): void => {
    if (reaping) return;
    // Check before incrementing, exactly like the relay's keepalive reaper.
    // Until Φ is explicitly enabled and has enough local samples, this is the
    // complete liveness policy.
    if (missedPongs >= maxMissedPongs && isPhiSilent()) {
      reaping = true;
      awaitingFirstPong = false;
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      // A reconnect starts with a fresh liveness sample window.
      lastPongAt = null;
      pongIntervals = [];
      deps.onSilent();
      return;
    }
    missedPongs += 1;
    deps.sendPing();
  };

  const start = (): void => {
    if (pingTimer !== null) return;
    awaitingFirstPong = true;
    missedPongs = 0;
    reaping = false;
    lastPongAt = null;
    pongIntervals = [];
    // Install the timer before the immediate ping, so a synchronous pong is
    // accepted as belonging to this connection.
    const timer = setInterval(tick, deps.heartbeatMs);
    pingTimer = timer;
    timer.unref?.();
    // Ping now (not only after `heartbeatMs`) so a reconnect/foreground return
    // can confirm its socket with one round-trip rather than waiting 20 seconds.
    try {
      deps.sendPing();
    } catch (error) {
      clearInterval(timer);
      if (pingTimer === timer) pingTimer = null;
      throw error;
    }
  };

  const notePong = (): void => {
    // A late pong from a stopped socket must not resurrect its state.
    if (pingTimer === null) return;
    // This is deliberately the only positive liveness reset. Do not call it for
    // welcome, relay-ping, status, mux, or RTC frames.
    missedPongs = 0;
    const arrivedAt = now();
    if (lastPongAt !== null) {
      pongIntervals.push(arrivedAt - lastPongAt);
      if (pongIntervals.length > PHI_WINDOW_SIZE) pongIntervals.shift();
    }
    lastPongAt = arrivedAt;
    if (awaitingFirstPong) {
      awaitingFirstPong = false;
      deps.onFirstPong?.();
    }
  };

  const stop = (): void => {
    awaitingFirstPong = false;
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    // A reconnect is a new connection: history cannot bias its bootstrap.
    lastPongAt = null;
    pongIntervals = [];
  };

  return { start, notePong, stop };
};
