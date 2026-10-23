/**
 * Metadata-keyed determinate observation cache for Claude/Cursor idle status.
 *
 * Reuse is keyed by store identity (path + inode + mtime + size), not a clock.
 * Unknown/indeterminate results are never stored. A producer started before
 * invalidate must not overwrite a newer generation. This is presence metadata
 * only — never unlock-state or vendor-validity proof, and never a substitute
 * for live `credentialForUpstream` / `readToken`.
 */

import type { FSWatcher } from "node:fs";
import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { AccountKeyedMap } from "../account-scope";
import { currentAccountIndex } from "../op-context";

export type TFileStoreIdentity = {
  readonly path: string;
  readonly present: boolean;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly ino: number | null;
  /** False when stat failed for a reason other than ENOENT (EACCES/EIO). */
  readonly statOk: boolean;
};

export const classifyStatError = (err: unknown): "absent" | "unreadable" => {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { readonly code?: unknown }).code;
    if (code === "ENOENT") return "absent";
  }
  return "unreadable";
};

export const fileStoreIdentity = (path: string): TFileStoreIdentity => {
  try {
    const st = statSync(path);
    return {
      path,
      present: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: Number(st.ino),
      statOk: true,
    };
  } catch (err) {
    const absent = classifyStatError(err) === "absent";
    return {
      path,
      present: false,
      mtimeMs: null,
      size: null,
      ino: null,
      statOk: absent,
    };
  }
};

/**
 * Poll cadence for {@link waitFileStoreHint}. `fs.watch` is the fast path;
 * under load (esp. Darwin FSEvents + atomic rename) events can be coalesced
 * or dropped, so identity is also re-checked on this interval until abort.
 * Not a wall-clock deadline — the caller's verify watchdog owns that.
 */
const FILE_STORE_HINT_POLL_MS = 100;

/**
 * File-store lifecycle hint for login verify. Resolves when inode/mtime/size
 * identity changes (create, write, or atomic replace). A watcher event is never
 * truth — callers must re-read and validate identity. Watchers are the fast
 * path; a short poll re-checks identity so a missed rename/create still
 * resolves. Cancellation closes watchers and the poll. Platforms that cannot
 * watch (or Darwin keychain stores) should omit this and keep the finite
 * verify watchdog.
 */
export const waitFileStoreHint = (
  path: string,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const start = fingerprintStoreIdentity(fileStoreIdentity(path));
    const name = basename(path);
    const watchers: FSWatcher[] = [];
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (poll !== undefined) clearInterval(poll);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // already closed
        }
      }
      resolve();
    };
    const onAbort = (): void => {
      finish();
    };
    const check = (): void => {
      const next = fingerprintStoreIdentity(fileStoreIdentity(path));
      if (next !== start) finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const attach = (target: string, filterName?: string): void => {
      try {
        const watcher = watch(target, (_event, filename) => {
          if (
            filterName !== undefined &&
            typeof filename === "string" &&
            filename !== filterName
          ) {
            return;
          }
          check();
        });
        watcher.on("error", () => {
          // Keep waiting for abort/poll/watchdog; do not treat watch errors as persist.
        });
        watchers.push(watcher);
      } catch {
        // Unsupported target — poll + caller watchdog cover the miss.
      }
    };
    attach(dirname(path), name);
    attach(path);
    // Reliability net: missed watch events (atomic replace under load) still
    // surface via identity re-check. Cleared in finish().
    poll = setInterval(check, FILE_STORE_HINT_POLL_MS);
    check();
  });

export const fingerprintStoreIdentity = (id: TFileStoreIdentity): string => {
  if (!id.statOk) return `${id.path}\0unreadable`;
  if (
    !id.present ||
    id.mtimeMs === null ||
    id.size === null ||
    id.ino === null
  ) {
    return `${id.path}\0absent`;
  }
  return `${id.path}\0${id.ino}\0${id.mtimeMs}\0${id.size}`;
};

export type TPassiveObservationCache<T> = {
  readonly generation: () => number;
  readonly get: (fingerprint: string) => T | undefined;
  readonly set: (
    fingerprint: string,
    value: T,
    observedGeneration: number,
  ) => void;
  readonly invalidate: () => void;
};

const storeIdentityEpochs = new AccountKeyedMap<number>();

export const storeIdentityEpoch = (slug: string): number =>
  storeIdentityEpochs.get(slug) ?? 0;

export const bumpStoreIdentityEpoch = (slug: string): void => {
  storeIdentityEpochs.set(slug, storeIdentityEpoch(slug) + 1);
};

export const createPassiveObservationCache = <
  T,
>(): TPassiveObservationCache<T> => {
  // One generation + entry per ambient account, so two account homes of the
  // same provider never evict each other's observation.
  type TSlot = {
    generation: number;
    entry: { readonly fingerprint: string; readonly value: T } | null;
  };
  const slots = new Map<number, TSlot>();
  const slot = (): TSlot => {
    const index = currentAccountIndex();
    const existing = slots.get(index);
    if (existing !== undefined) return existing;
    const next: TSlot = { generation: 0, entry: null };
    slots.set(index, next);
    return next;
  };
  return {
    generation: () => slot().generation,
    get: (fingerprint) => {
      const { entry } = slot();
      return entry !== null && entry.fingerprint === fingerprint
        ? entry.value
        : undefined;
    },
    set: (fingerprint, value, observedGeneration) => {
      const s = slot();
      if (observedGeneration !== s.generation) return;
      s.entry = { fingerprint, value };
    },
    invalidate: () => {
      const s = slot();
      s.generation += 1;
      s.entry = null;
    },
  };
};

/** Cache only when the store identity did not change during the probe. */
export const rememberIfFingerprintStable = <T>(
  cache: TPassiveObservationCache<T>,
  startFingerprint: string,
  endFingerprint: string,
  value: T,
  observedGeneration: number,
): void => {
  if (startFingerprint !== endFingerprint) return;
  cache.set(startFingerprint, value, observedGeneration);
};
