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

export const antigravitySpawnEnv = (
  isolated: Record<string, string>,
): Record<string, string> => {
  const base = cleanNativeSpawnEnv({});
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (ANTIGRAVITY_POISON_KEYS.has(upper)) continue;
    if (ANTIGRAVITY_POISON_PREFIX.test(upper)) continue;
    out[key] = value;
  }
  return { ...out, ...isolated };
};
