/**
 * Signed-plan cache — the efficiency rider of
 * `docs/proposals/sub-method-simplified-execution.md` §4, gated by the
 * cloud-published `plan_cache` bootstrap flag (cloud default ON;
 * `DAEMON_PLAN_CACHE=0` on the cloud disables it fleet-wide).
 *
 * The audit's largest remaining latency item is the per-request WAN round
 * trip (daemon → cloud plan resolution). Within one interactive burst
 * the cloud resolves the SAME alias to the same signed tuple over and over;
 * this cache lets a request reuse the most recent cloud-signed tuple for its model alias within a
 * short TTL instead of bouncing through the cloud.
 *
 * Safety properties:
 *   - Only whole SIGNED tuples are cached (`plan` + `pmids` + `origin` +
 *     `sig` exactly as the cloud issued them); the walker still verifies the
 *     HMAC per request, so the cache can never inject an unsigned or edited
 *     plan — it is a replay of what the cloud said, bounded by the TTL.
 *   - Staleness (cooldowns / config changes inside the TTL window) is
 *     bounded to one burst; a bootstrap refresh clears the cache outright
 *     (`config.ts`).
 *   - Memory-only: nothing persists; a daemon restart starts cold.
 *   - Flag off / absent ⇒ callers never consult it (zero behavior change).
 *   - Concurrent misses share one in-flight fetch (`loadPlan`) so a burst
 *     of N identical aliases pays one WAN RTT, not N.
 *   - Soft-refresh: entries older than {@link PLAN_CACHE_SOFT_REFRESH_MS}
 *     are still served, while a single background refresh replaces them
 *     before the hard TTL elapses.
 *   - A periodic sweeper (§7) drops TTL-expired entries so unused aliases
 *     cannot accumulate until the next lookup / bootstrap clear; a soft
 *     max-entries cap drops the oldest when exceeded.
 *   - {@link clearPlanCache} bumps a generation so in-flight loaders that
 *     started before the clear cannot re-store a stale tuple afterward.
 */

/** How long a signed tuple may be replayed. One interactive burst — long
 *  enough to absorb an agent's rapid-fire turns, short enough that cooldown
 *  drift stays irrelevant (the quota windows are hours, not seconds). */
export const PLAN_CACHE_TTL_MS = 45_000;

/** Age at which a still-fresh entry should be refreshed in the background
 *  so the next burst never blocks on a hard-TTL miss. */
export const PLAN_CACHE_SOFT_REFRESH_MS = 30_000;

/** How often the sweeper walks the map. */
export const PLAN_CACHE_SWEEP_MS = PLAN_CACHE_TTL_MS;

/** Soft cap — drop oldest entries when exceeded (session-store uses 500). */
export const PLAN_CACHE_MAX_ENTRIES = 500;

import type { TContextOverflowStrategy } from "@openllmsh/protocol";

export type TCachedPlan = {
  readonly planParam: string;
  readonly pmidsParam: string | null;
  readonly originParam: string | null;
  /** Signed context-overflow policy; null preserves bootstrap/default hop. */
  readonly contextOverflowStrategy: TContextOverflowStrategy | null;
  readonly sigParam: string | null;
  readonly storedAtMs: number;
};

export type TPlanTuple = Omit<TCachedPlan, "storedAtMs">;

const cache = new Map<string, TCachedPlan>();
const inFlight = new Map<string, Promise<TCachedPlan | null>>();
/** Bumped by {@link clearPlanCache}; loaders capture it and refuse to store
 *  when it has moved on (in-flight work started before the clear). */
let cacheGeneration = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Remember the signed tuple that served `alias` (called after every verified
 *  plan fetch while the flag is on — the newest tuple wins). */
export const storePlan = (alias: string, tuple: TPlanTuple): void => {
  cache.set(alias, { ...tuple, storedAtMs: Date.now() });
  if (cache.size > PLAN_CACHE_MAX_ENTRIES) {
    const overflow = cache.size - PLAN_CACHE_MAX_ENTRIES;
    let dropped = 0;
    for (const key of cache.keys()) {
      cache.delete(key);
      dropped += 1;
      if (dropped >= overflow) break;
    }
  }
};

/** The fresh cached tuple for `alias`, or null (absent / TTL-expired —
 *  expired entries are dropped eagerly so the map can't grow stale). */
export const lookupPlan = (alias: string): TCachedPlan | null => {
  const hit = cache.get(alias);
  if (hit === undefined) return null;
  if (Date.now() - hit.storedAtMs >= PLAN_CACHE_TTL_MS) {
    cache.delete(alias);
    return null;
  }
  return hit;
};

/** True when a still-serving entry should be refreshed before hard expiry. */
export const planNeedsRefresh = (alias: string): boolean => {
  const hit = cache.get(alias);
  if (hit === undefined) return false;
  const age = Date.now() - hit.storedAtMs;
  return age >= PLAN_CACHE_SOFT_REFRESH_MS && age < PLAN_CACHE_TTL_MS;
};

/**
 * Single-flight plan load. Concurrent callers for the same `alias` share one
 * `loader` invocation. Soft-stale hits are returned immediately while a
 * background refresh runs; hard misses await the loader.
 *
 * `loader` returns the signed tuple to store, or `null` to leave the cache
 * untouched (failed fetch / passthrough).
 */
export const loadPlan = async (
  alias: string,
  loader: () => Promise<TPlanTuple | null>,
): Promise<TCachedPlan | null> => {
  const hit = lookupPlan(alias);
  const refresh = hit !== null && planNeedsRefresh(alias);
  if (hit !== null && !refresh) return hit;

  const existing = inFlight.get(alias);
  if (existing !== undefined) {
    if (hit !== null) return hit;
    return existing;
  }

  const generation = cacheGeneration;
  // Register the in-flight promise BEFORE the loader can run/settle so a
  // re-entrant / concurrent miss coalesces onto this op. `Promise.resolve().then`
  // defers the loader to a microtask; a bare async IIFE would invoke `loader()`
  // synchronously up to its first await.
  let op!: Promise<TCachedPlan | null>;
  op = Promise.resolve().then(async (): Promise<TCachedPlan | null> => {
    try {
      const tuple = await loader();
      if (tuple === null) return lookupPlan(alias);
      if (generation !== cacheGeneration) return lookupPlan(alias);
      storePlan(alias, tuple);
      return lookupPlan(alias);
    } finally {
      if (inFlight.get(alias) === op) inFlight.delete(alias);
    }
  });
  inFlight.set(alias, op);

  if (hit !== null) {
    // Soft-stale: serve the cached tuple; refresh completes in the background.
    // Observe rejection so a failed refresh cannot become an unhandled rejection.
    void op.catch(() => undefined);
    return hit;
  }
  return op;
};

/** Drop TTL-expired entries. Returns how many were removed. */
export const sweepPlanCache = (nowMs: number = Date.now()): number => {
  let removed = 0;
  for (const [alias, entry] of cache) {
    if (nowMs - entry.storedAtMs >= PLAN_CACHE_TTL_MS) {
      cache.delete(alias);
      removed += 1;
    }
  }
  return removed;
};

/** Start the periodic sweeper (idempotent, unref'd). */
export const startPlanCacheSweeper = (): void => {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    sweepPlanCache();
  }, PLAN_CACHE_SWEEP_MS);
  sweepTimer.unref?.();
};

/** Stop the sweeper (tests / shutdown). */
export const stopPlanCacheSweeper = (): void => {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
};

/** Current entry count (bootstrap metrics / introspection). */
export const planCacheSize = (): number => cache.size;

/** Drop everything (bootstrap refresh / key rotation). */
export const clearPlanCache = (): void => {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
};
