/**
 * Exponential backoff for unhealthy cloud bootstrap refreshes.
 *
 * While `cloud_state !== "ok"` the daemon used to retry every 5s forever
 * (docs/audit/cli-daemon-performance/04-daemon-lifecycle.md §2). That burned
 * hundreds of HTTP attempts/hour during outages or a wrong origin. Healthy
 * refreshes stay on the long TTL; `no_key` keeps a fast retry so a just-set
 * key is picked up quickly.
 */

export type TBootstrapBackoffDeps = {
  /** First unhealthy retry delay. */
  readonly baseMs: number;
  /** Ceiling for the doubling. */
  readonly maxMs: number;
  /** Healthy refresh interval. */
  readonly healthyTtlMs: number;
  /**
   * Fast poll while waiting for a local key write (`cloud_state === "no_key"`).
   * Distinct from unhealthy backoff so onboarding stays snappy.
   */
  readonly noKeyMs: number;
  readonly random?: () => number;
};

export const bootstrapBackoffConfig: Omit<TBootstrapBackoffDeps, "random"> = {
  baseMs: 5_000,
  maxMs: 5 * 60 * 1000,
  healthyTtlMs: 5 * 60 * 1000,
  noKeyMs: 5_000,
};

export type TCloudStateForBackoff =
  | "ok"
  | "no_key"
  | "unreachable"
  | "invalid_key"
  | string;

export type TBootstrapBackoff = {
  /** Record an unhealthy bootstrap outcome (`unreachable` / `invalid_key` / …). */
  readonly noteFailure: () => void;
  /** Record a healthy (`ok`) bootstrap — clears the streak. */
  readonly noteSuccess: () => void;
  /** Consecutive unhealthy outcomes; 0 after success. */
  readonly streak: () => number;
  /**
   * Delay before the next bootstrap attempt for `cloudState`.
   * Jittered for unhealthy states; fixed for `ok` / `no_key`.
   */
  readonly nextDelayMs: (cloudState: TCloudStateForBackoff) => number;
};

export const createBootstrapBackoff = (
  deps: TBootstrapBackoffDeps,
): TBootstrapBackoff => {
  const random = deps.random ?? Math.random;
  let streak = 0;

  return {
    noteFailure: () => {
      streak += 1;
    },
    noteSuccess: () => {
      streak = 0;
    },
    streak: () => streak,
    nextDelayMs: (cloudState) => {
      if (cloudState === "ok") return deps.healthyTtlMs;
      if (cloudState === "no_key") return deps.noKeyMs;
      // Callers increment streak via noteFailure before asking for the delay.
      // streak 0 (defensive) and streak 1 both land near baseMs.
      const shift = Math.max(streak - 1, 0);
      const standDown = Math.min(
        deps.maxMs,
        deps.baseMs * 2 ** Math.min(shift, 30),
      );
      // Half fixed + half random (same shape as device-limit backoff).
      return standDown / 2 + random() * (standDown / 2);
    },
  };
};
