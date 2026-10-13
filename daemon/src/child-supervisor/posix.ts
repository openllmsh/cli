export const DEFAULT_TERMINATE_GRACE_MS = 2_000;
export const DEFAULT_FINAL_REAP_MS = 1_000;

export type TReapOutcome = "exited" | "terminated" | "reap_unconfirmed";

const pause = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
