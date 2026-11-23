/**
 * Google Antigravity quota windows: the mapping from a NORMALIZED quota
 * summary (`bucketId`, `remainingFraction`, `resetTime`, `displayName`,
 * `disabled`) to the provider's usage snapshot. `agy -p "/usage"` prints
 * other names (`id`, `remaining_fraction`, `reset_time`, `name`);
 * `agyUsageQuota` (`./antigravity-cli.ts`) converts them before calling
 * here — raw CLI buckets map to nothing. Pure — no token is read and
 * nothing is fetched here.
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

/** The shared allowance a bucket id belongs to (`gemini-…`, `3p-…`), or
 *  null for any other bucket (its own allowance). */
const quotaFamilyOf = (bucketId: string): string | null =>
  bucketId.startsWith("gemini-")
    ? "Gemini"
    : bucketId.startsWith("3p-")
      ? "Claude & GPT"
      : null;

/** Mapped quota: the windows, and the allowance (family) each window's
 *  `meter_id` belongs to — keyed by value, so copies group the same. */
export type TAntigravityQuota = {
  readonly windows: TProviderUsageWindow[];
  readonly families: ReadonlyMap<string, string>;
};

/**
 * `retrieveUserQuotaSummary` → windows (Claude + GPT share one allowance)
 * plus each window's allowance family. Takes the
 * NORMALIZED quota shape (`bucketId`, `remainingFraction`, `resetTime`,
 * `displayName`, `disabled`): `agy /usage` emits `id` / `remaining_fraction`
 * / `reset_time` / `name`, which `agyUsageQuota` (`./antigravity-cli.ts`)
 * converts first — raw CLI buckets passed here map to nothing.
 */
export const summaryQuota = (summary: unknown): TAntigravityQuota => {
  const s = summary as {
    readonly groups?: ReadonlyArray<{
      readonly displayName?: unknown;
      readonly buckets?: ReadonlyArray<TBucket>;
    }>;
    readonly buckets?: ReadonlyArray<TBucket>;
  } | null;
  const grouped = s?.groups?.some((g) => (g.buckets?.length ?? 0) > 0) === true;
  const groups = grouped
    ? s?.groups
    : [{ displayName: undefined, buckets: s?.buckets }];
  const out = new Map<string, TProviderUsageWindow>();
  const families = new Map<string, string>();
  for (const [groupIndex, group] of (groups ?? []).entries()) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled === true || !nonEmpty(bucket.bucketId)) continue;
      const family =
        quotaFamilyOf(bucket.bucketId) ??
        (nonEmpty(group.displayName) && group.displayName.trim().length > 0
          ? group.displayName.trim()
          : bucket.bucketId);
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const window = toWindow(
        `${family} ${weekly ? "7-day" : session ? "5-hour" : nonEmpty(bucket.displayName) ? bucket.displayName.trim() : "quota"}`,
        bucket.bucketId,
        bucket,
        weekly ? WEEK_MS : session ? FIVE_HOURS_MS : undefined,
      );
      if (window !== null) {
        // A group's own allowance never shares a key with the reserved
        // bucket-id families (a group named "Gemini" is not `gemini-…`).
        // One allowance per payload GROUP (its weekly and 5-hour windows
        // together), keyed by position — never by name, so two groups that
        // share a name stay apart. Flat (ungrouped) buckets are each their
        // own allowance.
        families.set(
          bucket.bucketId,
          quotaFamilyOf(bucket.bucketId) ??
            (grouped ? `group#${groupIndex}` : `bucket:${bucket.bucketId}`),
        );
        out.set(bucket.bucketId, window);
      }
    }
  }
  return { windows: [...out.values()], families };
};

/**
 * Windows → the provider's usage snapshot. Built from the `agy` CLI's
 * own `/usage` (`./antigravity-cli.ts`).
 */
export const antigravityQuotaSnapshot = (
  windows: ReadonlyArray<TProviderUsageWindow>,
  families: ReadonlyMap<string, string> = new Map(),
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
  // Gemini hops that still have room). A family is out when ANY of its
  // windows is (a full 7-day window blocks however much 5-hour room is
  // left); reject only when every family is out.
  const exhausted = new Map<string, boolean>();
  for (const w of windows) {
    const id = w.meter_id ?? w.label;
    const family =
      (w.meter_id !== undefined ? families.get(w.meter_id) : undefined) ??
      quotaFamilyOf(id) ??
      // A raw meter id never shares a key with a reserved family name.
      `meter:${id}`;
    const out = w.percent_used >= QUOTA_REJECT_PERCENT;
    exhausted.set(family, (exhausted.get(family) ?? false) || out);
  }
  const percents = windows.map((w) => w.percent_used);
  return {
    kind: "quota",
    status: [...exhausted.values()].every((out) => out)
      ? "rejected"
      : percents.some((p) => p >= QUOTA_WARN_PERCENT)
        ? "allowed_warning"
        : "allowed",
    windows: [...windows],
    note: "Google Antigravity — includes usage outside OpenLLM",
  };
};
