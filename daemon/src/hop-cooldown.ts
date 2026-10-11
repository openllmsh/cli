import type {
  TAuthRefreshCooldownReason,
  TCooldownReason,
} from "@openllmsh/protocol";
import { cooldownPolicyFor } from "@openllmsh/protocol";

/**
 * The daemon's LOCAL, synchronous hop cooldown table.
 *
 * The cloud already cools a failed model (daemon-record → `publishCooldownMark`)
 * and the daemon drops its signed-plan cache so the next request re-resolves.
 * That loop is best-effort and cross-process: the Runtime Cache mark is
 * regional, published off the response path, and the re-resolve may land on a
 * different function instance — so an exhausted subscription kept being
 * re-dialled request after request ("Grok Build usage balance exhausted" ×84
 * within one session, an Anthropic 429 storm right behind it).
 *
 * This table is the backstop on the box that actually places the call: once a
 * hop fails with a reason the shared policy says cools, the SAME daemon refuses
 * to dial it again until the policy TTL expires. The policy is the protocol's
 * (`cooldownPolicyFor`) so daemon and cloud can't disagree about what cools.
 *
 * Deliberately NOT applied to the final hop — never-drop-all: the caller gets a
 * real upstream error rather than a synthetic one the gateway invented.
 */
/**
 * The subset of cooling reasons that reflect a TRANSIENT upstream condition —
 * a blip a direct vendor connection would simply retry through (a burst 429, a
 * momentary 5xx, a timeout). A cooldown carrying one of these reasons is ADVISORY:
 * a later recovery pass may bypass it once the authoritative usage floor confirms
 * the account still has quota. Non-transient reasons (`quota_exhausted`, `auth`,
 * `payment`, …) are hard — never bypassed.
 */
export const TRANSIENT_COOLDOWN_REASONS = new Set<TCooldownReason>([
  "rate_limit",
]);

/** A single cooldown table entry with provenance + an optional authoritative
 *  recover time parsed from the upstream `Retry-After`. */
export type THopCooldownEntry = {
  readonly untilMs: number;
  readonly reason: TCooldownReason;
  readonly setterSessionKey: string | undefined;
  readonly setAtMs: number;
  readonly recoverAtMs: number | undefined;
  /** Set when reason is `auth` and the mark came from a native-refresh miss. */
  readonly authReasonCode?: TAuthRefreshCooldownReason;
};

const marks = new Map<string, THopCooldownEntry>();

const key = (provider: string, modelId: string): string =>
  `${provider}|${modelId}`;

/**
 * Record a hop failure. A non-cooling reason (`network`, `context_overflow`,
 * `content_filter`) is ignored; an existing later expiry is never shortened, so
 * a long quota cooldown survives a subsequent short-TTL failure.
 *
 * Provenance: `setterSessionKey` identifies the walk that set the mark (so a
 * recovery pass can tell "a sibling cooled this" from "I cooled this"), and
 * `recoverAtMs` carries the vendor's `Retry-After` as an authoritative floor.
 * On a re-mark at equal-or-greater expiry where the NEW reason is non-transient
 * but the existing one is transient, the stored reason/recover time is UPGRADED
 * to the stricter (non-transient) provenance.
 */
/**
 * Merge a stored recover floor with an incoming one: keep the LATER of the two
 * (the vendor's authoritative `Retry-After` should only ever move forward), but
 * only while it is still in the future — a floor already in the past is inert,
 * so it collapses to `undefined`. A re-mark that omits `recoverAtMs` therefore
 * preserves an existing future floor instead of clobbering it.
 */
const mergeRecoverAt = (
  existing: number | undefined,
  incoming: number | undefined,
  now: number,
): number | undefined => {
  const later =
    existing !== undefined && incoming !== undefined
      ? Math.max(existing, incoming)
      : (existing ?? incoming);
  return later !== undefined && later > now ? later : undefined;
};

/**
 * Record a hop failure. Returns `true` when the table actually changed
 * (new mark, later expiry, or a reason upgrade) so callers can fire a
 * one-shot side effect without re-arming on a repeated identical mark.
 */
export const markHopCooldown = (
  provider: string,
  modelId: string,
  reason: TCooldownReason,
  setterSessionKey?: string,
  recoverAtMs?: number,
  now: number = Date.now(),
  authReasonCode?: TAuthRefreshCooldownReason,
): boolean => {
  const policy = cooldownPolicyFor(reason);
  if (policy.action !== "cool_and_advance") return false;
  const k = key(provider, modelId);
  const until = now + policy.ttlMs;
  const existing = marks.get(k);
  const storedAuthReason =
    reason === "auth" ? authReasonCode : existing?.authReasonCode;
  if (existing !== undefined && existing.untilMs > until) {
    // The existing mark expires later — never shorten it. But if the incoming
    // reason is non-transient and the stored one is transient, upgrade the
    // stored provenance to the stricter reason (keep the later expiry).
    if (
      !TRANSIENT_COOLDOWN_REASONS.has(reason) &&
      TRANSIENT_COOLDOWN_REASONS.has(existing.reason)
    ) {
      marks.set(k, {
        untilMs: existing.untilMs,
        reason,
        setterSessionKey,
        setAtMs: now,
        recoverAtMs: mergeRecoverAt(existing.recoverAtMs, recoverAtMs, now),
        ...(storedAuthReason !== undefined
          ? { authReasonCode: storedAuthReason }
          : {}),
      });
      return true;
    }
    return false;
  }
  if (
    existing !== undefined &&
    !TRANSIENT_COOLDOWN_REASONS.has(existing.reason) &&
    TRANSIENT_COOLDOWN_REASONS.has(reason)
  ) {
    // The incoming expiry is equal-or-greater, but the incoming reason is
    // transient while the stored one is non-transient (stricter). Extend the
    // expiry to the later of the two but preserve the stricter provenance.
    const changed = until !== existing.untilMs;
    marks.set(k, {
      untilMs: until,
      reason: existing.reason,
      setterSessionKey: existing.setterSessionKey,
      setAtMs: existing.setAtMs,
      recoverAtMs: mergeRecoverAt(existing.recoverAtMs, recoverAtMs, now),
      ...(existing.authReasonCode !== undefined
        ? { authReasonCode: existing.authReasonCode }
        : {}),
    });
    return changed;
  }
  const unchanged =
    existing !== undefined &&
    existing.untilMs === until &&
    existing.reason === reason &&
    existing.authReasonCode === storedAuthReason;
  marks.set(k, {
    untilMs: until,
    reason,
    setterSessionKey,
    setAtMs: now,
    recoverAtMs: mergeRecoverAt(existing?.recoverAtMs, recoverAtMs, now),
    ...(storedAuthReason !== undefined
      ? { authReasonCode: storedAuthReason }
      : {}),
  });
  return !unchanged;
};

/** Is this (provider, model) still cooling on THIS box? Expired marks are
 *  dropped on read — the table only ever holds live entries. */
export const isHopCoolingDown = (
  provider: string,
  modelId: string,
  now: number = Date.now(),
): boolean => {
  const k = key(provider, modelId);
  const entry = marks.get(k);
  if (entry === undefined) return false;
  if (entry.untilMs <= now) {
    marks.delete(k);
    return false;
  }
  return true;
};

/** Read the full cooldown entry for a (provider, model), or `undefined` when
 *  none is live. Expired marks are dropped on read (same discipline as
 *  {@link isHopCoolingDown}) so the table only ever exposes live entries. */
export const peekHopCooldown = (
  provider: string,
  modelId: string,
  now: number = Date.now(),
): THopCooldownEntry | undefined => {
  const k = key(provider, modelId);
  const entry = marks.get(k);
  if (entry === undefined) return undefined;
  if (entry.untilMs <= now) {
    marks.delete(k);
    return undefined;
  }
  return entry;
};

/**
 * Drop the cooldown sign for ONE (provider, model). Called the moment a hop
 * actually serves a successful (HTTP 2xx) committed response: a working dial
 * PROVES the hop is healthy, so its stale cooldown must go immediately — sibling
 * walks and the next request then skip the whole exhaust-then-recover detour
 * instead of re-earning quota for the full TTL. (Cf. {@link clearHopCooldowns},
 * the all-clear.)
 */
export const clearHopCooldown = (provider: string, modelId: string): void => {
  marks.delete(key(provider, modelId));
};

/** Drop every mark (tests; a credential reconnect that may restore quota). */
export const clearHopCooldowns = (): void => {
  marks.clear();
};

/** Latest-expiring live `auth` cooldown for any model of `provider`. */
export type TAuthCooldownForProvider = {
  readonly until_ms: number;
  readonly model_id: string;
  readonly reason_code?: TAuthRefreshCooldownReason;
};

/**
 * Read-only: the latest-expiring ACTIVE cooldown with reason `auth` for
 * this provider (any model). The provider-level overlay must persist while
 * ANY model still has an auth cooldown. Equal `until_ms` ties break on
 * `model_id` (lexicographically smaller wins). Expired marks are dropped
 * on read. Other reasons (`rate_limit`, `quota_exhausted`, …) are ignored.
 */
export const authCooldownForProvider = (
  provider: string,
  now: number = Date.now(),
): TAuthCooldownForProvider | null => {
  const prefix = `${provider}|`;
  let latest: TAuthCooldownForProvider | null = null;
  for (const [k, entry] of marks) {
    if (!k.startsWith(prefix)) continue;
    if (entry.untilMs <= now) {
      marks.delete(k);
      continue;
    }
    if (entry.reason !== "auth") continue;
    const model_id = k.slice(prefix.length);
    if (
      latest === null ||
      entry.untilMs > latest.until_ms ||
      (entry.untilMs === latest.until_ms && model_id < latest.model_id)
    ) {
      latest = {
        until_ms: entry.untilMs,
        model_id,
        ...(entry.authReasonCode !== undefined
          ? { reason_code: entry.authReasonCode }
          : {}),
      };
    }
  }
  return latest;
};
