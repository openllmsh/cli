/**
 * Quota-status POST-rate optimizer (LEAF module).
 *
 * The cloud is authoritative for de-escalation suppression and reset-flap
 * filtering. This Map only skips an identical `(status, resetEpoch)` repeat
 * so periodic status observers do not POST the same transition over and
 * over. It has no delivery policy: callers decide how and where to send
 * returned transitions.
 */

import type {
  TDaemonProviderConnection,
  TDaemonQuotaStatusReached,
  TProviderUsageWindow,
} from "@openllmsh/protocol";
import { QUOTA_REJECT_PERCENT, QUOTA_WARN_PERCENT } from "@openllmsh/protocol";

type TQuotaStatus = "allowed" | "allowed_warning" | "rejected";

type TQuotaBaseline = {
  readonly status: TQuotaStatus;
  readonly resetEpoch: number | undefined;
};

/** Last `(status, resetEpoch)` actually emitted for each provider account. */
const lastQuotaStatus = new Map<string, TQuotaBaseline>();

const quotaKey = (slug: string, accountHash: string | undefined): string =>
  `${slug}\0${accountHash ?? "-"}`;

const isSubscriptionProviderSlug = (
  slug: string,
): slug is TDaemonQuotaStatusReached["slug"] =>
  slug === "claude_code" ||
  slug === "chatgpt" ||
  slug === "kimi_code" ||
  slug === "grok" ||
  slug === "cursor" ||
  slug === "muse";

const farthestFiniteReset = (
  windows: ReadonlyArray<TProviderUsageWindow>,
  minPercentUsed: number | undefined,
): number | undefined => {
  let farthest: number | undefined;
  for (const window of windows) {
    if (minPercentUsed !== undefined && window.percent_used < minPercentUsed) {
      continue;
    }
    const resetAt = window.reset_at_ms;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) continue;
    farthest = farthest === undefined ? resetAt : Math.max(farthest, resetAt);
  }
  return farthest;
};

/**
 * Reset epoch of the window that is still holding the current status.
 * Matches `reduceQuotaStatus` thresholds: ≥QUOTA_REJECT_PERCENT rejected,
 * ≥QUOTA_WARN_PERCENT warning. Vendor `limit_reached` / `allowed === false`
 * can reject with no window at cap — then use the farthest finite reset
 * among all `windows`.
 */
const sustainingWindowResetAtMs = (
  status: TQuotaStatus,
  windows: ReadonlyArray<TProviderUsageWindow>,
): number | undefined => {
  if (status === "rejected") {
    const atCap = farthestFiniteReset(windows, QUOTA_REJECT_PERCENT);
    if (atCap !== undefined) return atCap;
    return farthestFiniteReset(windows, undefined);
  }
  if (status === "allowed_warning") {
    return farthestFiniteReset(windows, QUOTA_WARN_PERCENT);
  }
  return undefined;
};

const samePostedPair = (
  previous: TQuotaBaseline | undefined,
  next: TQuotaStatus,
  resetEpoch: number | undefined,
): boolean =>
  previous !== undefined &&
  previous.status === next &&
  previous.resetEpoch === resetEpoch;

/**
 * Observe quota snapshots and return states that should POST.
 *
 * Cold-start warning/rejected snapshots intentionally emit: without a prior
 * baseline the user may already be affected, and cloud deduplication protects
 * against duplicate devices. De-escalation (`rejected → allowed_warning`)
 * and epoch flap are NOT filtered here — the cloud owns those policies.
 */
export const noteConnectionsForQuota = (
  connections: ReadonlyArray<TDaemonProviderConnection>,
): ReadonlyArray<TDaemonQuotaStatusReached> => {
  const transitions: TDaemonQuotaStatusReached[] = [];

  for (const connection of connections) {
    const usage = connection.usage;
    if (
      !isSubscriptionProviderSlug(connection.provider) ||
      usage?.kind !== "quota" ||
      usage.stale === true
    )
      continue;

    const next = usage.status;
    const resetEpoch = sustainingWindowResetAtMs(next, usage.windows);
    const key = quotaKey(connection.provider, connection.account_hash);
    const previous = lastQuotaStatus.get(key);
    if (next === "allowed") {
      lastQuotaStatus.set(key, { status: next, resetEpoch });
      continue;
    }
    if (
      (next === "allowed_warning" || next === "rejected") &&
      !samePostedPair(previous, next, resetEpoch)
    ) {
      transitions.push({
        slug: connection.provider,
        status: next,
        ...(connection.account_hash === undefined
          ? {}
          : { account_hash: connection.account_hash }),
        ...(usage.plan === undefined ? {} : { plan: usage.plan }),
        ...(resetEpoch === undefined ? {} : { reset_at_ms: resetEpoch }),
        // The snapshot this transition was computed from, so the email can
        // list every limit. The relay already stores the same object from
        // the status frame, so this sends nothing new off the machine.
        usage,
      });
      lastQuotaStatus.set(key, { status: next, resetEpoch });
    }
  }

  return transitions;
};

/** Test-only: process-global baselines must not leak across suites. */
export const resetQuotaStatusTrackerForTests = (): void => {
  lastQuotaStatus.clear();
};
