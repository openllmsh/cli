import { readFileSync } from "node:fs";

export const DEFAULT_TERMINATE_GRACE_MS = 2_000;
export const DEFAULT_FINAL_REAP_MS = 1_000;

export type TReapOutcome = "exited" | "terminated" | "reap_unconfirmed";

/** Await a short delay between reap polls without busy-waiting. */
const pause = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bound a short wait without spinning the event loop (sync callers only).
 * Uses Atomics.wait on a SharedArrayBuffer — no dependency on a `sleep`
 * binary (containers / minimal images often lack it).
 */
export const sleepSyncMs = (ms: number): void => {
  if (ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
};

/**
 * True when `kill(pid, 0)` succeeds or the pid exists but is unsignallable.
 * On Linux, zombies still answer `kill(0)` — treat state `Z` as gone so
 * process-group cleanup, detached pidfiles, and handoff waits don't stall.
 */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EPERM"
    );
  }
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `comm` may contain spaces/parens — split after the last ')'.
      const closeParen = raw.lastIndexOf(")");
      if (closeParen !== -1) {
        const after = raw.slice(closeParen + 2); // skip ") "
        const state = after.split(" ", 1)[0];
        if (state === "Z") return false;
      }
    } catch {
      // Missing /proc entry — fall through to kill-based truth.
    }
  }
  return true;
};

/**
 * Signal a process and, when it looks like a setsid group leader, its process
 * group. Best-effort — already-gone pids are ignored.
 */
export const signalProcessTree = (
  pid: number,
  signal: NodeJS.Signals,
): void => {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
  if (pid > 1) {
    try {
      process.kill(-pid, signal);
    } catch {
      // not a group leader / already gone
    }
  }
};

/**
 * Sync SIGTERM → grace → SIGKILL → final wait for an identity-checked pid.
 * Used by detached-daemon stop and uninstall session-host reap.
 */
export const terminateOwnedPidSync = (
  pid: number,
  stillOwned: () => boolean,
  graceMs: number = DEFAULT_TERMINATE_GRACE_MS,
  finalReapMs: number = DEFAULT_FINAL_REAP_MS,
): void => {
  if (!stillOwned()) return;
  signalProcessTree(pid, "SIGTERM");
  const termDeadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < termDeadline && processAlive(pid) && stillOwned()) {
    sleepSyncMs(50);
  }
  if (processAlive(pid) && stillOwned()) {
    signalProcessTree(pid, "SIGKILL");
    const killDeadline = Date.now() + Math.max(0, finalReapMs);
    while (Date.now() < killDeadline && processAlive(pid)) {
      sleepSyncMs(50);
    }
  }
};

/**
 * `kill(-pgid)` errno that means "this is not a group we can (or should)
 * signal". ESRCH: gone. EPERM: the pgid was recycled to a process we don't
 * own (macOS also surfaces this on a just-SIGKILL'd detached group while the
 * zombie is unreaped). Neither is a throw.
 */
export const isUnsignallableProcessGroup = (error: unknown): boolean => {
  const code =
    error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  return code === "ESRCH" || code === "EPERM";
};

/** Reject pid/pgid values that must never be signalled (0/1/negative). */
const assertSafePgid = (pgid: number): boolean =>
  Number.isInteger(pgid) && pgid > 1;

/**
 * Ops/safety switch for process-group signal delivery. Dry-run hosts and
 * containment fixtures pass `deliver: false` so `kill(-pgid, 0)` still
 * probes existence while TERM/KILL are withheld. Default is `true`, and
 * production never overrides it — this is a parameter, not global state, so
 * a fixture's choice can never leak into another test or a real supervisor.
 */
export const signalGroup = (
  pgid: number,
  signal: NodeJS.Signals | 0,
  deliver = true,
): boolean => {
  // `kill(-1, sig)` is a broadcast to EVERY signallable process and `kill(0,
  // sig)` targets our OWN group — neither is ever a supervised child, so a
  // bogus pgid must never reach process.kill.
  if (!assertSafePgid(pgid)) return false;
  if (!deliver && signal !== 0) {
    return true;
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (isUnsignallableProcessGroup(error)) return false;
    throw error;
  }
};

/** Existence probe: `kill(-pgid, 0)`. Same ESRCH/EPERM contract as signalGroup. */
export const processGroupExists = (pgid: number): boolean =>
  signalGroup(pgid, 0);

/** Poll until `stillPresent` is false or the budget elapses. */
const waitUntilGone = async (
  stillPresent: () => boolean,
  budgetMs: number,
): Promise<boolean> => {
  const budget = Math.max(0, budgetMs);
  if (!stillPresent()) return true;
  if (budget === 0) return !stillPresent();
  const started = performance.now();
  while (performance.now() - started < budget) {
    await pause(Math.min(25, budget));
    if (!stillPresent()) return true;
  }
  return !stillPresent();
};

/**
 * Process-group SIGTERM, finite grace, SIGKILL, finite final reap. Settles
 * even when the group never disappears (caller logs `reap_unconfirmed`).
 */
export const terminateProcessGroup = async (
  pgid: number,
  graceMs: number = DEFAULT_TERMINATE_GRACE_MS,
  isStillOwned?: () => boolean,
  finalReapMs: number = DEFAULT_FINAL_REAP_MS,
  deliver = true,
): Promise<TReapOutcome> => {
  const stillPresent = (): boolean =>
    isStillOwned !== undefined ? isStillOwned() : processGroupExists(pgid);
  if (!stillPresent()) return "exited";
  const termDelivered = signalGroup(pgid, "SIGTERM", deliver);
  if (termDelivered && (await waitUntilGone(stillPresent, graceMs)))
    return "exited";
  signalGroup(pgid, "SIGKILL", deliver);
  if (await waitUntilGone(stillPresent, finalReapMs)) return "terminated";
  return "reap_unconfirmed";
};
