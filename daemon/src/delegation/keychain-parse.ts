/**
 * Pure parsers for macOS `security` keychain output. Kept free of process
 * state so production and tests share one implementation.
 */

/**
 * Parse `security show-keychain-info`. The grammar is POSITIONAL, not
 * `name: value` — verified against macOS 15 (`security` writes this line to
 * **stderr**, so pass both streams):
 *
 *     Keychain "x.keychain-db" no-timeout                 → auto-lock OFF
 *     Keychain "x.keychain-db" lock-on-sleep no-timeout   → locks on sleep
 *     Keychain "x.keychain-db" timeout=900s               → idle auto-lock
 *     Keychain "x.keychain-db" lock-on-sleep timeout=300s → both (the default)
 *
 * Auto-lock is off IFF `no-timeout` is present AND `lock-on-sleep` is not.
 * Our own chains are created with a bare `set-keychain-settings`, which yields
 * the first form. Returns `null` when the output is not recognisable at all,
 * so an inconclusive probe is never cached as a verdict.
 */
export const parseAutoLockOff = (out: string): boolean | null => {
  const lower = out.toLowerCase();
  const noTimeout = lower.includes("no-timeout");
  const hasTimeout = /timeout=\d+s/.test(lower);
  // Neither token ⇒ this is not show-keychain-info output (empty, an error, a
  // future format). Unknown is NOT "auto-lock on".
  if (!noTimeout && !hasTimeout) return null;
  return noTimeout && !lower.includes("lock-on-sleep");
};

/** Second classifier beside `matchUnlockFailureToken`. `-25308` stays
 *  TRANSIENT for recreate (must not nuke a good credential); it DOES
 *  invalidate a skip because the chain may have relocked under us. */
export const isInteractionNotAllowed = (stderr: string): boolean => {
  const s = stderr.toLowerCase();
  // The literal message, verified with `security error -25308`, is "User
  // interaction is not allowed." — note the "is". `security` reports the text
  // WITHOUT the numeric code (e.g. "security: SecKeychainSearchCopyNext: User
  // interaction is not allowed."), so a numeric-only match never fires on a
  // real host; the `-25308` arm is kept only for callers that do surface codes.
  return (
    s.includes("-25308") || /interaction\s+(?:is\s+)?not\s+allowed/.test(s)
  );
};
