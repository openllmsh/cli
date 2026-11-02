/**
 * Persisted product setup mode — full (default) or minimal.
 *
 * Distinct from `OPENLLM_INSTALL_MODE=install|update` (first-run vs update).
 * This mode survives updates and later client launches: minimal keeps client
 * launches cloud-directed and daemon-free unless the user explicitly starts
 * the daemon; full is ordinary vendor provisioning + daemon startup.
 *
 * Stored in the shared env file as `OPENLLM_SETUP_MODE=full|minimal`, same
 * pattern as `OPENLLM_DAEMON_AUTO_UPDATE` for the daemon auto-update pref.
 */

import { sharedFileConfig } from "./env";
import { saveEnvVars } from "./onboarding";

/** Env-file / process-env key for the product setup mode. */
export const SETUP_MODE_ENV = "OPENLLM_SETUP_MODE";

export const SETUP_MODES = ["full", "minimal"] as const;
export type TSetupMode = (typeof SETUP_MODES)[number];

/** Fresh-install default when nothing is configured. */
export const DEFAULT_SETUP_MODE: TSetupMode = "full";

/** Accept only the documented values; reject anything else (incl. install/update). */
export const parseSetupMode = (raw: string | undefined): TSetupMode | null => {
  const value = raw?.trim();
  if (value === "full" || value === "minimal") return value;
  return null;
};

/**
 * Resolved setup mode. Precedence: process env → env file → `full`.
 * An unrecognized value is ignored so a typo cannot wedge launches.
 */
export const readSetupMode = (): TSetupMode => {
  const fromEnv = parseSetupMode(process.env[SETUP_MODE_ENV]);
  if (fromEnv !== null) return fromEnv;
  const fromFile = parseSetupMode(sharedFileConfig()[SETUP_MODE_ENV]);
  if (fromFile !== null) return fromFile;
  return DEFAULT_SETUP_MODE;
};

/** Persist the mode into the env file and mirror it into process.env. */
export const setSetupMode = (mode: TSetupMode): boolean => {
  if (!saveEnvVars({ [SETUP_MODE_ENV]: mode })) return false;
  process.env[SETUP_MODE_ENV] = mode;
  return true;
};

/** True when client launches must stay cloud-directed and not start a daemon. */
export const isMinimalSetupMode = (): boolean => readSetupMode() === "minimal";
