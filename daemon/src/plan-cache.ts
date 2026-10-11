/**
 * Signed-plan cache — the efficiency rider of
 * `docs/proposals/sub-method-simplified-execution.md` §4, gated by the
 * cloud-published `plan_cache` bootstrap flag (cloud default ON;
 * `DAEMON_PLAN_CACHE=0` on the cloud disables it fleet-wide).
 *
 * The audit's largest remaining latency item is the per-request WAN round
 * trip (client → cloud plan resolution → 307). Within one interactive burst
 * the cloud resolves the SAME alias to the same signed tuple over and over;
 * this cache lets a request that reaches the daemon DIRECTLY (no `?__plan=`)
 * reuse the most recent cloud-signed tuple for its model alias within a
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
 */

/** How long a signed tuple may be replayed. One interactive burst — long
 *  enough to absorb an agent's rapid-fire turns, short enough that cooldown
 *  drift stays irrelevant (the quota windows are hours, not seconds). */
export const PLAN_CACHE_TTL_MS = 45_000;

import type { TContextOverflowStrategy } from "@openllmsh/protocol";

export type TCachedPlan = {
  readonly planParam: string;
  readonly pmidsParam: string | null;
  readonly originParam: string | null;
  /** Signed 307 context-overflow policy; null preserves bootstrap/default hop. */
  readonly contextOverflowStrategy: TContextOverflowStrategy | null;
  readonly sigParam: string | null;
  readonly storedAtMs: number;
};

const cache = new Map<string, TCachedPlan>();

/** Remember the signed tuple that served `alias` (called on every 307-borne
 *  request while the flag is on — the newest tuple wins). */
export const storePlan = (
  alias: string,
  tuple: Omit<TCachedPlan, "storedAtMs">,
): void => {
  cache.set(alias, { ...tuple, storedAtMs: Date.now() });
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

/** Drop everything (bootstrap refresh / tests). */
export const clearPlanCache = (): void => {
  cache.clear();
};
