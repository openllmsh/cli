/**
 * Pure vendor-payload → canonical-usage reducers.
 *
 * The daemon's resilience contract: every provider's usage read reduces
 * into the ONE canonical `TProviderUsageSnapshot` struct
 * (`packages/protocol/provider-usage.ts`) at this boundary — no fetch, no
 * fs, no spawn — so a vendor payload reshape is absorbed inside a pure,
 * unit-testable function and never leaks a format change downstream
 * (relay persistence, the calibration estimator, the UI all consume only
 * the canonical struct).
 */

import type { TProviderUsageWindow } from "@openllmsh/protocol";
import { QUOTA_REJECT_PERCENT, QUOTA_WARN_PERCENT } from "@openllmsh/protocol";

/**
 * Duration label for a vendor-stated quota window — "5-hour", "7-day",
 * "30-minute" — matching claude-code's label convention. The label is the
 * window's IDENTITY downstream (the calibration series key), so stating
 * the duration means a vendor window reshape (e.g. Codex's 5h primary
 * becoming a weekly primary) automatically re-keys the series instead of
 * silently changing what a positional name means.
 */
export const windowLabelFromSeconds = (seconds: number): string => {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
};

/** Prettified positional fallback: "primary_window" → "Primary". */
const positionalLabel = (key: string): string => {
  const stem = key.replace(/_window$/, "").replace(/_/g, " ");
  return stem.length === 0 ? key : stem.charAt(0).toUpperCase() + stem.slice(1);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const toEpochMs = (raw: unknown): number | null => {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

/**
 * Reduce Anthropic's OAuth usage payload into the same windows /
 * extra_pools split ChatGPT uses for main meters vs. per-feature pools.
 *
 *   - `windows` — the shared plan meters (`five_hour` + `seven_day`).
 *     These alone drive overall status, the card's tightest-window
 *     face, and calibration. Hitting them means the whole subscription
 *     is constrained.
 *   - `extra_pools` — model-scoped 7-day caps (Opus / Sonnet / Fable /
 *     whatever ships next). Same contract as Codex's Spark pool: they
 *     meter DIFFERENT usage, so a 100% Fable pool must NOT flip status
 *     to `rejected` or become the tightest window while the shared
 *     7-day is still open.
 *
 * Model-scoped meters come from TWO shapes Anthropic has shipped:
 *   1. Legacy top-level keys (`seven_day_opus` / `seven_day_sonnet` /
 *      `seven_day_fable`) — kept as a fallback for older payloads.
 *   2. The 2026 `limits[]` array — `kind: "weekly_scoped"` entries with
 *      `scope.model.display_name` (captured live: Fable is only here;
 *      the top-level `seven_day_*` keys for new families are null /
 *      absent). Walking `limits` means a new model family surfaces
 *      without another hardcode.
 *
 * Experimental top-level codenames (`seven_day_cowork`, `tangelo`, …)
 * are still deliberately ignored so they can't pollute calibration.
 */
export type TClaudeUsageReduced = {
  readonly windows: TProviderUsageWindow[];
  readonly extra_pools: TProviderUsageWindow[];
};

export const reduceClaudeUsage = (payload: unknown): TClaudeUsageReduced => {
  const data = isRecord(payload) ? payload : {};
  const reduceWindow = (
    label: string,
    raw: unknown,
    windowMs: number,
  ): TProviderUsageWindow => {
    const value = isRecord(raw) ? raw : {};
    return {
      label,
      percent_used:
        typeof value.utilization === "number" ? value.utilization : 0,
      reset_at_ms: toEpochMs(value.resets_at),
      window_ms: windowMs,
    };
  };

  // Shared plan meters only — status + calibration read these.
  const windows: TProviderUsageWindow[] = [
    reduceWindow("5-hour", data.five_hour, FIVE_HOURS_MS),
    reduceWindow("7-day", data.seven_day, SEVEN_DAYS_MS),
  ];

  // Per-model caps — display-only, like Codex Spark.
  const scopedClaudePool = ({
    meterId,
    displayName,
    percent,
    resetsAt,
  }: {
    readonly meterId: string;
    readonly displayName: string;
    readonly percent: number;
    readonly resetsAt: unknown;
  }): TProviderUsageWindow => ({
    meter_id: meterId,
    label: `7-day · ${displayName}`,
    percent_used: percent,
    reset_at_ms: toEpochMs(resetsAt),
    window_ms: SEVEN_DAYS_MS,
  });
  const extraPools: TProviderUsageWindow[] = [];
  const seen = new Set<string>();
  // Dedupe by DISPLAY label: the legacy `seven_day_*` keys and the
  // `limits[]` weekly_scoped entries are two vendor encodings of the SAME
  // logical pool, and `scopedClaudePool` gives both the identical
  // `7-day · <family>` label. Keying on label collapses a payload that
  // (rarely) carries both, exactly as before meter_id existed. `meter_id`
  // rides along on the surviving pool for the catalog-meter gate; it is
  // deliberately NOT the dedupe key (the two encodings differ there).
  const pushPool = (pool: TProviderUsageWindow): void => {
    if (seen.has(pool.label)) return;
    seen.add(pool.label);
    extraPools.push(pool);
  };

  const scoped: ReadonlyArray<readonly [string, string]> = [
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
    ["seven_day_fable", "Fable"],
  ];
  for (const [meterId, displayName] of scoped) {
    const raw = data[meterId];
    if (isRecord(raw) && typeof raw.utilization === "number") {
      pushPool(
        scopedClaudePool({
          meterId,
          displayName,
          percent: raw.utilization,
          resetsAt: raw.resets_at,
        }),
      );
    }
  }

  if (Array.isArray(data.limits)) {
    for (const entry of data.limits) {
      if (!isRecord(entry) || entry.kind !== "weekly_scoped") continue;
      if (typeof entry.percent !== "number") continue;
      const scope = isRecord(entry.scope) ? entry.scope : null;
      const model =
        scope !== null && isRecord(scope.model) ? scope.model : null;
      const name =
        model !== null &&
        typeof model.display_name === "string" &&
        model.display_name.length > 0
          ? model.display_name
          : null;
      if (name === null) continue;
      pushPool(
        scopedClaudePool({
          meterId: name,
          displayName: name,
          percent: entry.percent,
          resetsAt: entry.resets_at,
        }),
      );
    }
  }
  return { windows, extra_pools: extraPools };
};

/**
 * Reduce Codex's `rate_limit` object to canonical windows GENERICALLY:
 * any object value carrying a numeric `used_percent` is a window
 * (`primary_window`, `secondary_window`, whatever ships next) — a
 * renamed, added, or nulled-out key needs no code change here. OpenAI has
 * already reshaped this once (5h primary + weekly secondary → a single
 * weekly primary), so window identity comes from the STATED duration
 * (`limit_window_seconds`) when present; positional names are only the
 * fallback for windows that don't state one.
 *
 * `additional_rate_limits` (per-feature pools, e.g. model promos) are
 * deliberately NOT reduced: they meter DIFFERENT usage, and everything
 * downstream (representative selection, cross-window K transfer) assumes
 * one provider's windows all meter the SAME usage.
 */
export const reduceChatgptWindows = (
  rateLimit: unknown,
): TProviderUsageWindow[] => {
  if (!isRecord(rateLimit)) return [];
  const windows: TProviderUsageWindow[] = [];
  for (const [key, value] of Object.entries(rateLimit)) {
    if (!isRecord(value) || typeof value.used_percent !== "number") continue;
    const seconds =
      typeof value.limit_window_seconds === "number" &&
      value.limit_window_seconds > 0
        ? value.limit_window_seconds
        : null;
    const base =
      seconds !== null ? windowLabelFromSeconds(seconds) : positionalLabel(key);
    // Two windows can state the SAME duration — disambiguate with the
    // positional name so their series stay distinct.
    const label = windows.some((w) => w.label === base)
      ? `${base} · ${positionalLabel(key)}`
      : base;
    windows.push({
      label,
      percent_used: value.used_percent,
      reset_at_ms:
        typeof value.reset_at === "number" ? value.reset_at * 1000 : null,
      ...(seconds !== null ? { window_ms: seconds * 1000 } : {}),
    });
  }
  return windows;
};

/**
 * Reduce Codex's `additional_rate_limits` — per-feature pools (e.g. the
 * GPT-5.3-Codex-Spark promo pool) that meter DIFFERENT usage than the
 * main windows — into display-only `extra_pools`. Each entry's nested
 * `rate_limit` reduces through the same generic window walk; the pool's
 * `limit_name` becomes (or prefixes) the label. These must never join
 * `windows`: calibration and the card's tightest-window meter both
 * assume one provider's windows meter the SAME usage.
 */
export const reduceChatgptPools = (
  additionalRateLimits: unknown,
): TProviderUsageWindow[] => {
  if (!Array.isArray(additionalRateLimits)) return [];
  const pools: TProviderUsageWindow[] = [];
  for (const entry of additionalRateLimits as ReadonlyArray<unknown>) {
    if (!isRecord(entry)) continue;
    const name =
      typeof entry.limit_name === "string" && entry.limit_name.length > 0
        ? entry.limit_name
        : typeof entry.metered_feature === "string"
          ? entry.metered_feature
          : "Feature pool";
    const windows = reduceChatgptWindows(entry.rate_limit);
    for (const w of windows) {
      pools.push({
        ...w,
        meter_id: name,
        label: windows.length === 1 ? name : `${name} · ${w.label}`,
      });
    }
  }
  return pools;
};

/** Credit state carried on the canonical quota snapshot, when reported. */
export type TReducedCredits = {
  readonly balance: string;
  readonly unlimited?: boolean;
  readonly reset_credits?: number;
};

/**
 * Reduce Codex's `credits` + `rate_limit_reset_credits` into the
 * canonical credit state — capacity that exists OUTSIDE the quota
 * windows (a purchasable balance; limit-reset credits that lift a hit
 * limit). Returns undefined when the payload reports neither.
 */
export const reduceChatgptCredits = (
  payload: unknown,
): TReducedCredits | undefined => {
  if (!isRecord(payload)) return undefined;
  const credits = isRecord(payload.credits) ? payload.credits : null;
  const resets = isRecord(payload.rate_limit_reset_credits)
    ? payload.rate_limit_reset_credits
    : null;
  if (credits === null && resets === null) return undefined;
  const resetCount =
    resets !== null && typeof resets.available_count === "number"
      ? resets.available_count
      : undefined;
  return {
    balance: typeof credits?.balance === "string" ? credits.balance : "0",
    ...(credits?.unlimited === true ? { unlimited: true } : {}),
    ...(resetCount !== undefined ? { reset_credits: resetCount } : {}),
  };
};

/**
 * Overall quota status. The vendor's own verdict (`limit_reached` /
 * `allowed`) wins when it ships one — percent thresholds are only the
 * fallback, since a vendor can reject before any meter reads QUOTA_REJECT_PERCENT.
 */
export const reduceQuotaStatus = (
  rateLimit: unknown,
  windows: ReadonlyArray<TProviderUsageWindow>,
): "allowed" | "allowed_warning" | "rejected" => {
  const maxPct = windows.reduce((a, w) => Math.max(a, w.percent_used), 0);
  const verdict = isRecord(rateLimit) ? rateLimit : {};
  const rejected =
    verdict.limit_reached === true ||
    verdict.allowed === false ||
    maxPct >= QUOTA_REJECT_PERCENT;
  return rejected
    ? "rejected"
    : maxPct >= QUOTA_WARN_PERCENT
      ? "allowed_warning"
      : "allowed";
};

/** Peak `percent_used` across windows → overall status (no vendor verdict). */
export const statusForWindows = (
  windows: ReadonlyArray<TProviderUsageWindow>,
): "allowed" | "allowed_warning" | "rejected" => {
  const peak = windows.reduce(
    (max, window) => Math.max(max, window.percent_used),
    0,
  );
  return peak >= QUOTA_REJECT_PERCENT
    ? "rejected"
    : peak >= QUOTA_WARN_PERCENT
      ? "allowed_warning"
      : "allowed";
};
