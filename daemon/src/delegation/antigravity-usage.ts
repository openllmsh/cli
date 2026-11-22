/**
 * Google Antigravity quota windows: the mapping from the quota summary that
 * `agy -p "/usage"` prints (`./antigravity-cli.ts`, same field names as
 * Google's `retrieveUserQuotaSummary`) to the provider's usage snapshot.
 * Pure — no token is read and nothing is fetched here.
 */
import type {
  TProviderUsageSnapshot,
  TProviderUsageWindow,
} from "@openllmsh/sdk/protocol";
import {
  QUOTA_REJECT_PERCENT,
  QUOTA_WARN_PERCENT,
} from "@openllmsh/sdk/protocol";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const ANTIGRAVITY_PLANS_URL = "https://antigravity.google/docs/plans";

type TQuota = {
  readonly remainingFraction?: unknown;
  readonly resetTime?: unknown;
};

type TBucket = TQuota & {
  readonly bucketId?: unknown;
  readonly window?: unknown;
  readonly displayName?: unknown;
  readonly disabled?: unknown;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const resetMs = (value: unknown): number | null => {
  if (!nonEmpty(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const toWindow = (
  label: string,
  meterId: string,
  quota: TQuota,
  windowMs: number | undefined,
): TProviderUsageWindow | null => {
  const remaining = quota.remainingFraction;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  return {
    label,
    meter_id: meterId,
    percent_used: (1 - Math.max(0, Math.min(1, remaining))) * 100,
    reset_at_ms: resetMs(quota.resetTime),
    ...(windowMs !== undefined ? { window_ms: windowMs } : {}),
  };
};

/** `retrieveUserQuotaSummary` → windows (Claude + GPT share one allowance). */
export const summaryWindows = (summary: unknown): TProviderUsageWindow[] => {
  const s = summary as {
    readonly groups?: ReadonlyArray<{
      readonly displayName?: unknown;
      readonly buckets?: ReadonlyArray<TBucket>;
    }>;
    readonly buckets?: ReadonlyArray<TBucket>;
  } | null;
  const groups = s?.groups?.some((g) => (g.buckets?.length ?? 0) > 0)
    ? s.groups
    : [{ displayName: undefined, buckets: s?.buckets }];
  const out = new Map<string, TProviderUsageWindow>();
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled === true || !nonEmpty(bucket.bucketId)) continue;
      const family = bucket.bucketId.startsWith("gemini-")
        ? "Gemini"
        : bucket.bucketId.startsWith("3p-")
          ? "Claude & GPT"
          : nonEmpty(group.displayName)
            ? group.displayName.trim()
            : bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const window = toWindow(
        `${family} ${weekly ? "7-day" : session ? "5-hour" : nonEmpty(bucket.displayName) ? bucket.displayName.trim() : "quota"}`,
        bucket.bucketId,
        bucket,
        weekly ? WEEK_MS : session ? FIVE_HOURS_MS : undefined,
      );
      if (window !== null) out.set(bucket.bucketId, window);
    }
  }
  return [...out.values()];
};

/**
 * Windows → the provider's usage snapshot. Built from the `agy` CLI's
 * own `/usage` (`./antigravity-cli.ts`).
 */
export const antigravityQuotaSnapshot = (
  windows: ReadonlyArray<TProviderUsageWindow>,
): TProviderUsageSnapshot => {
  if (windows.length === 0) {
    return {
      kind: "unavailable",
      reason: "Antigravity did not return usable quota information.",
      link: ANTIGRAVITY_PLANS_URL,
    };
  }
  // Gemini and Claude/GPT are SEPARATE allowances: one exhausted family must
  // not mark the whole provider rejected (the quota gate would then skip
  // Gemini hops that still have room). Reject only when every window is out.
  const percents = windows.map((w) => w.percent_used);
  return {
    kind: "quota",
    status: percents.every((p) => p >= QUOTA_REJECT_PERCENT)
      ? "rejected"
      : percents.some((p) => p >= QUOTA_WARN_PERCENT)
        ? "allowed_warning"
        : "allowed",
    windows: [...windows],
    note: "Google Antigravity — includes usage outside OpenLLM",
  };
};
