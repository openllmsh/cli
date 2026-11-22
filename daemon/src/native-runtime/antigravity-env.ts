/**
 * The spawn env of every `agy` process the daemon starts (headless
 * stream-json, `agy acp`, login, `agy models`, `/usage`): the shared native
 * clean env minus every Google key / project override, with the isolated
 * `cliEnv("antigravity")` overlay (HOME = the account slot's isolated home)
 * on top so the profile pins always win.
 */
import { cleanNativeSpawnEnv } from "./types";

/**
 * Env keys that would make `agy` use a metered key / another project or
 * redirect its data dir away from the isolated HOME. List from t3code
 * `removedEnvironmentKeys`.
 */
const ANTIGRAVITY_POISON_KEYS: ReadonlySet<string> = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GEMINI_HOME",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
]);
const ANTIGRAVITY_POISON_PREFIX = /^(GOOGLE_CLOUD_|AGY_ACP_)/;

/**
 * The desktop keyring (Secret Service over the session D-Bus) is reached
 * through the inherited session bus, not HOME: an isolated HOME alone would
 * still let `agy` read or write the USER's keyring on a Linux desktop. The
 * bus address is replaced with D-Bus's own "disabled" transport (so libsecret
 * can't autolaunch one either) and the keyring control socket dropped, so
 * `agy` keeps its sign-in in the isolated HOME's file store.
 */
const ANTIGRAVITY_KEYRING_KEYS: ReadonlySet<string> = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
]);

export const antigravitySpawnEnv = (
  isolated: Record<string, string>,
): Record<string, string> => {
  const base = cleanNativeSpawnEnv({});
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (ANTIGRAVITY_POISON_KEYS.has(upper)) continue;
    if (ANTIGRAVITY_POISON_PREFIX.test(upper)) continue;
    if (ANTIGRAVITY_KEYRING_KEYS.has(upper)) continue;
    out[key] = value;
  }
  return {
    ...out,
    ...isolated,
    // Last, so nothing can re-open the user's session bus.
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
  };
};
