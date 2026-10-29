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

/** A team supplier keeps recently served surface/model pairs warm for this long. */
export const TEAM_PLAN_WARM_WINDOW_MS = 10 * 60_000;

/** Team traffic refreshes on the cache's existing soft-refresh cadence. */
export const TEAM_PLAN_WARM_REFRESH_MS = PLAN_CACHE_SOFT_REFRESH_MS;

/** One supplier only keeps a small, demand-driven working set warm. */
export const TEAM_PLAN_WARM_MAX_ENTRIES = 16;

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
type TInFlightShared = {
  readonly entry: TCachedPlan | null;
  readonly shared: unknown;
};
const inFlight = new Map<string, Promise<TInFlightShared>>();
/** Bumped by {@link clearPlanCache}; loaders capture it and refuse to store
 *  when it has moved on (in-flight work started before the clear). */
let cacheGeneration = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

type TTeamPlanWarmEntry = {
  readonly lastServedAtMs: number;
  readonly refresh: () => Promise<TPlanTuple | null>;
};
const warmTeamPlans = new Map<string, TTeamPlanWarmEntry>();
let warmTeamPlanTimer: ReturnType<typeof setInterval> | null = null;

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

export type TPlanLoadShared<TShared> = {
  readonly entry: TCachedPlan | null;
  /** Present for hard-miss waiters of this flight; null on warm/soft-stale hits. */
  readonly shared: TShared | null;
};

/**
 * Single-flight plan load that also shares an arbitrary loader `shared` value
 * with every hard-miss waiter. Soft-stale hits return the cached entry
 * immediately (with `shared: null`); hard misses await the loader so concurrent
 * callers see the same response/throw outcome instead of only the first
 * caller's closure.
 *
 * `loader.store` is the signed tuple to cache, or `null` to leave the cache
 * untouched. `loader.shared` is returned to every waiter of this flight.
 */
export const loadPlanWithShared = async <TShared>(
  alias: string,
  loader: () => Promise<{
    readonly store: TPlanTuple | null;
    readonly shared: TShared;
  }>,
): Promise<TPlanLoadShared<TShared>> => {
  const hit = lookupPlan(alias);
  const refresh = hit !== null && planNeedsRefresh(alias);
  if (hit !== null && !refresh) return { entry: hit, shared: null };

  const existing = inFlight.get(alias);
  if (existing !== undefined) {
    if (hit !== null) return { entry: hit, shared: null };
    const joined = await existing;
    return { entry: joined.entry, shared: joined.shared as TShared };
  }

  const generation = cacheGeneration;
  // Register the in-flight promise BEFORE the loader can run/settle so a
  // re-entrant / concurrent miss coalesces onto this op. `Promise.resolve().then`
  // defers the loader to a microtask; a bare async IIFE would invoke `loader()`
  // synchronously up to its first await.
  let op!: Promise<TInFlightShared>;
  op = Promise.resolve().then(async (): Promise<TInFlightShared> => {
    try {
      const { store, shared } = await loader();
      if (store === null) {
        return { entry: lookupPlan(alias), shared };
      }
      if (generation !== cacheGeneration) {
        return { entry: lookupPlan(alias), shared };
      }
      storePlan(alias, store);
      return { entry: lookupPlan(alias), shared };
    } finally {
      if (inFlight.get(alias) === op) inFlight.delete(alias);
    }
  });
  inFlight.set(alias, op);

  if (hit !== null) {
    // Soft-stale: serve the cached tuple; refresh completes in the background.
    // Observe rejection so a failed refresh cannot become an unhandled rejection.
    void op.catch(() => undefined);
    return { entry: hit, shared: null };
  }
  const settled = await op;
  return { entry: settled.entry, shared: settled.shared as TShared };
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
  const { entry } = await loadPlanWithShared(alias, async () => {
    const store = await loader();
    return { store, shared: null };
  });
  return entry;
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

/**
 * Remember a plan key only after this daemon has successfully served it for a
 * team peer. The timer exists exclusively while that demand-driven working set
 * is non-empty; each entry refreshes through the normal cache single-flight.
 */
export const noteTeamPlanServed = (
  key: string,
  refresh: () => Promise<TPlanTuple | null>,
): void => {
  warmTeamPlans.set(key, { lastServedAtMs: Date.now(), refresh });
  if (warmTeamPlans.size > TEAM_PLAN_WARM_MAX_ENTRIES) {
    const oldest = warmTeamPlans.keys().next().value;
    if (oldest !== undefined) warmTeamPlans.delete(oldest);
  }
  startTeamPlanWarmRefresh();
};

/** Refresh and expire the recently served team-plan working set. */
export const refreshWarmTeamPlans = async (
  nowMs: number = Date.now(),
): Promise<void> => {
  const refreshes: Array<Promise<TCachedPlan | null>> = [];
  for (const [key, entry] of warmTeamPlans) {
    if (nowMs - entry.lastServedAtMs >= TEAM_PLAN_WARM_WINDOW_MS) {
      warmTeamPlans.delete(key);
      continue;
    }
    refreshes.push(loadPlan(key, entry.refresh));
  }
  if (warmTeamPlans.size === 0) stopTeamPlanWarmRefresh();
  await Promise.all(refreshes.map((refresh) => refresh.catch(() => null)));
};

/** Start the team-plan warmer only after team traffic establishes demand. */
export const startTeamPlanWarmRefresh = (): void => {
  if (warmTeamPlanTimer !== null) return;
  warmTeamPlanTimer = setInterval(() => {
    void refreshWarmTeamPlans();
  }, TEAM_PLAN_WARM_REFRESH_MS);
  warmTeamPlanTimer.unref?.();
};

/** Stop the team-plan warmer when no recent team traffic remains. */
export const stopTeamPlanWarmRefresh = (): void => {
  if (warmTeamPlanTimer !== null) {
    clearInterval(warmTeamPlanTimer);
    warmTeamPlanTimer = null;
  }
};

/** Current recently served team pair count (tests / diagnostics). */
export const warmTeamPlanSize = (): number => warmTeamPlans.size;

/** Drop every cached plan and the demand-driven team-plan working set. */
export const clearPlanCache = (): void => {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
  warmTeamPlans.clear();
  stopTeamPlanWarmRefresh();
};
