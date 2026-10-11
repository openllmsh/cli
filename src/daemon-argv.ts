/**
 * Which argv belongs to the daemon half of the single `openllm` binary.
 * Kept import-free so `main.ts` can decide before loading either half.
 */

/** Re-exec flags the daemon spawns ITSELF with (`[execPath, flag, …]`). They
 *  stay top-level so those spawn sites need no `daemon` token. */
const INTERNAL_DAEMON_FLAGS: ReadonlySet<string> = new Set([
  "--sandbox-exec",
  "__child-supervisor-pdeathsig",
  "__session-host",
]);

/** The pre-merge daemon binary name. Installs keep `openllmd` as a symlink to
 *  `openllm`, so existing service units, scripts, and old CLIs still run the
 *  daemon unchanged. */
export const LEGACY_DAEMON_NAME = "openllmd";

/**
 * The args to hand the daemon, or null when the argv is a CLI command.
 *  - invoked as `openllmd …` → all args (legacy busybox name; a leading
 *    `daemon` token is tolerated)
 *  - `openllm daemon …`      → the args after `daemon` (bare → boot)
 *  - an internal re-exec flag → the argv unchanged
 */
export const daemonArgs = (
  invokedAs: string,
  argv: readonly string[],
): readonly string[] | null => {
  const first = argv[0];
  if (invokedAs === LEGACY_DAEMON_NAME)
    return first === "daemon" ? argv.slice(1) : argv;
  if (first === "daemon") return argv.slice(1);
  if (first !== undefined && INTERNAL_DAEMON_FLAGS.has(first)) return argv;
  return null;
};
