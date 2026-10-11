/**
 * Daemon version. Injected at compile time by scripts/compile.ts via
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
