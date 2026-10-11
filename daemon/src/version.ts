/**
 * Daemon version. Injected at compile time by `packages/cli/scripts/compile.ts` (the same release tag as the CLI) via
 * `--define __OPENLLM_DAEMON_VERSION__`. Declared as a global (not
 * `process.env`) so the bundler substitutes the identifier cleanly;
 * falls back to a dev sentinel when run from source.
 */
declare const __OPENLLM_DAEMON_VERSION__: string | undefined;

export const DAEMON_VERSION: string = (() => {
  try {
    return typeof __OPENLLM_DAEMON_VERSION__ === "string"
      ? __OPENLLM_DAEMON_VERSION__
      : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();

/**
 * The daemon half's code fingerprint (`scripts/daemon-fingerprint.ts`), baked
 * at compile time. After the single binary is swapped, the running daemon reads
 * the NEW file's value (`openllm daemon --fingerprint`) and restarts only when
 * it differs — a CLI-only release never bounces the daemon.
 */
declare const __OPENLLM_DAEMON_FINGERPRINT__: string | undefined;

export const DAEMON_FINGERPRINT: string = (() => {
  try {
    return typeof __OPENLLM_DAEMON_FINGERPRINT__ === "string"
      ? __OPENLLM_DAEMON_FINGERPRINT__
      : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();
