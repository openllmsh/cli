/**
 * Remote PTY session opt-in preference — stored in the shared env file
 * (`~/.openllm/.env`) as `OPENLLM_DAEMON_PTY_SESSIONS` (`1`/`0`), alongside
 * every other daemon config (no separate flag file).
 *
 * Remote terminal sessions are OPT-IN (off by default): a freshly installed
 * daemon refuses remote browser / relay session opens until the device owner
 * enables them locally with `openllmd sessions on` or
 * `OPENLLM_DAEMON_PTY_SESSIONS=1`. The value is read fresh for every remote
 * open; `setPtySessions` keeps both the env file and in-process env in sync, so
 * a toggle takes effect without a restart.
 *
 * Precedence: an explicit `OPENLLM_DAEMON_PTY_SESSIONS` (set in the environment,
 * or loaded from the env file by `loadEnvFile`) decides; absent it, OFF.
 */
import { loadEnvFile, writeEnvFileVars } from "./env";
import { logWarn, safeDiagnosticMessage } from "./logger";

/** The env-file key the preference lives under. */
const PTY_SESSIONS_KEY = "OPENLLM_DAEMON_PTY_SESSIONS";

/** Parse a flag value to bool; null when unrecognized/absent. */
const parseFlag = (raw: string | undefined): boolean | null => {
  const v = raw?.trim();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
};

/** Whether remote daemon terminal sessions are enabled. Default FALSE (opt-in). */
export const ptySessionsEnabled = (): boolean => {
  loadEnvFile();
  // In dev mode, `.dev.env` values can override non-selector process env defaults.
  // In production, existing process env values still win.
  const fromEnv = parseFlag(process.env[PTY_SESSIONS_KEY]);
  if (fromEnv !== null) return fromEnv;
  return false; // default OFF until explicitly opted in
};

/**
 * Persist the remote PTY-session opt-in into the env file (`0600`, merge) and
 * update the in-process env so the next remote open sees it immediately.
 * Returns whether the preference was persisted successfully.
 */
export const setPtySessions = (enabled: boolean): boolean => {
  const value = enabled ? "1" : "0";
  const written = writeEnvFileVars({ [PTY_SESSIONS_KEY]: value });
  if (!written) {
    logWarn(
      "session",
      safeDiagnosticMessage`failed to persist remote PTY session preference to the env file`,
    );
  }
  process.env[PTY_SESSIONS_KEY] = value;
  return written;
};
