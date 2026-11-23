/** Grace between SIGTERM and SIGKILL for an `agy` child. */
export const AGY_KILL_GRACE_MS = 2_000;

/** SIGTERM now, SIGKILL if it is still running after the grace. */
export const killHard = (proc: {
  readonly kill: (signal?: number | NodeJS.Signals) => void;
  readonly exitCode: number | null;
  readonly signalCode?: string | number | null;
}): void => {
  try {
    proc.kill();
  } catch {
    return; // already gone
  }
  const timer = setTimeout(() => {
    if (proc.exitCode !== null || (proc.signalCode ?? null) !== null) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, AGY_KILL_GRACE_MS);
  timer.unref?.();
};
