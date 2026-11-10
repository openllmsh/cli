/**
 * Change signal for `auth status` long-polls (`since` + `wait_ms`).
 *
 * Two wake reasons, kept apart so a waiter never spins: an auth event (login
 * progress, prompt, cancel, a status push request) means "recompute"; a
 * freshly computed status means "the snapshot is already current". A waiter
 * that recomputes on an event triggers a `status` wake, which it then reads
 * without recomputing again.
 *
 * Nothing here starts provider work: waiters exist only while a caller is
 * asking, and they read the same `computeStatus` every other surface reads.
 */
import type { TDaemonStatus } from "@openllmsh/sdk/protocol";

export type TAuthWake = "event" | "status";

const waiters = new Set<(reason: TAuthWake) => void>();
let latest: TDaemonStatus | null = null;
/** Bumps on every notify so a waiter can detect a lost wakeup between its
 *  snapshot and registration (register-then-recheck). */
let generation = 0;

/** The most recent snapshot any producer computed (control tick, command, local call). */
export const latestAuthStatus = (): TDaemonStatus | null => latest;

/** Generation counter for lost-wakeup detection; record before a snapshot. */
export const authGeneration = (): number => generation;

/** Something auth-relevant happened; waiters recompute. */
export const notifyAuthChange = (): void => {
  // Drop the cached snapshot first. A long-poll that samples generation after
  // this notify (local-auth `baseline = authGeneration()` then `body(false)`)
  // must not reuse a pre-event `latest` and sleep until wait_ms — see the
  // baseline-vs-stale-latest gap in tests/daemon/local-auth-watch.test.ts.
  latest = null;
  generation += 1;
  for (const wake of [...waiters]) wake("event");
};

/** A fresh snapshot was computed; waiters read it as-is. */
export const notifyAuthStatus = (status: TDaemonStatus): void => {
  latest = status;
  generation += 1;
  for (const wake of [...waiters]) wake("status");
};

/**
 * Resolve with the first wake reason, or `"timeout"` after `ms`.
 * Pass `sinceGeneration` from {@link authGeneration} taken before the caller's
 * snapshot: if a notify landed in the gap, resolve `"event"` immediately
 * instead of sitting until `ms`.
 */
export const waitForAuthChange = (
  ms: number,
  signal?: AbortSignal,
  sinceGeneration?: number,
): Promise<TAuthWake | "timeout"> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (value: TAuthWake | "timeout"): void => {
      waiters.delete(done);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => done("timeout");
    if (signal?.aborted === true) return resolve("timeout");
    waiters.add(done);
    // Lost wakeup: a notify arrived between the caller's snapshot and this
    // registration — wake now so they recheck instead of waiting out `ms`.
    if (sinceGeneration !== undefined && generation !== sinceGeneration) {
      done("event");
      return;
    }
    signal?.addEventListener("abort", onAbort);
    timer = setTimeout(() => done("timeout"), ms);
  });

/** Stable digest of a reply body: the `revision` a caller hands back as `since`. */
export const authRevision = (body: unknown): string =>
  new Bun.CryptoHasher("sha256")
    .update(stableJson(body))
    .digest("hex")
    .slice(0, 32);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
