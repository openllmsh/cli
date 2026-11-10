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

/** The most recent snapshot any producer computed (control tick, command, local call). */
export const latestAuthStatus = (): TDaemonStatus | null => latest;

/** Something auth-relevant happened; waiters recompute. */
export const notifyAuthChange = (): void => {
  for (const wake of [...waiters]) wake("event");
};

/** A fresh snapshot was computed; waiters read it as-is. */
export const notifyAuthStatus = (status: TDaemonStatus): void => {
  latest = status;
  for (const wake of [...waiters]) wake("status");
};

/** Resolve with the first wake reason, or `"timeout"` after `ms`. */
export const waitForAuthChange = (
  ms: number,
  signal?: AbortSignal,
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
