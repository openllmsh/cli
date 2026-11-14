/**
 * Daemon auto-update opt-out preference — stored in the single config file
 * the shared env file (`~/.openllm/.env`) as `OPENLLM_DAEMON_AUTO_UPDATE` (`1`/`0`), alongside every other
 * daemon config (no separate flag file).
 *
 * Self-update is OPT-OUT (on by default): a freshly installed daemon keeps
 * itself current automatically, and the user can DISABLE it (from the
 * dashboard's daemon section, `openllmd auto-update off`, or
 * `OPENLLM_DAEMON_AUTO_UPDATE=0`) to pin the installed version. The value is
 * read fresh on every self-update check + status push — `setAutoUpdate` keeps
 * both the env file and the in-process env in sync, so a toggle takes effect on
 * the next tick without a restart.
 *
 * Precedence: an explicit `OPENLLM_DAEMON_AUTO_UPDATE` (set in the environment,
 * or loaded from the env file by `loadEnvFile`) decides; absent it, ON.
 */
import { loadEnvFile, writeEnvFileVars } from "./env";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { isRoutebox } from "./routebox";

/** The env-file key the preference lives under. */
const AUTO_UPDATE_KEY = "OPENLLM_DAEMON_AUTO_UPDATE";

/** Parse a flag value to bool; null when unrecognized/absent. */
const parseFlag = (raw: string | undefined): boolean | null => {
  const v = raw?.trim();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
};

/**
 * Whether automatic daemon self-update is enabled. Default TRUE (opt-out).
 * Always TRUE on a Routebox, whatever the env file says.
 */
export const autoUpdateEnabled = (): boolean => {
  if (isRoutebox()) return true;
  // In dev, `.dev.env` overrides non-selector process env defaults; in prod, an
  // explicitly-set env value remains authoritative.
  loadEnvFile();
  const fromEnv = parseFlag(process.env[AUTO_UPDATE_KEY]);
  if (fromEnv !== null) return fromEnv;
  return true; // default ON until explicitly opted out
};

/** Why turning auto-update off was refused. */
export const AUTO_UPDATE_LOCKED_MESSAGE =
  "auto-update is always on for a Routebox";

/**
 * Persist the auto-update opt-in into the env file (`0600`, merge) and update
 * the in-process env so the next check sees it immediately. Returns false —
 * and leaves `process.env` alone — when the request is to turn it off on a
 * Routebox, or when the env-file write fails (same posture as
 * {@link setDeviceSessionsEnabled}).
 */
export const setAutoUpdate = (enabled: boolean): boolean => {
  if (!enabled && isRoutebox()) return false;
  const value = enabled ? "1" : "0";
  if (!writeEnvFileVars({ [AUTO_UPDATE_KEY]: value })) {
    logWarn(
      "auto-update",
      safeDiagnosticMessage`failed to persist preference to the env file`,
    );
    return false;
  }
  process.env[AUTO_UPDATE_KEY] = value;
  return true;
};
