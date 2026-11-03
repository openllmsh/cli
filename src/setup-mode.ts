/**
 * Persisted product setup mode — full (default) or minimal.
 *
 * Distinct from `OPENLLM_INSTALL_MODE=install|update` (first-run vs update).
 * This mode survives updates and later client launches: minimal sends every
 * client launch cloud-direct and never probes, starts or brokers through the
 * local daemon — even one that is running. To use the local daemon, switch to
 * full: `openllm login --start` (the desktop app's pairing call) saves it, or
 * set `OPENLLM_SETUP_MODE=full`. `openllm daemon start` alone does not change
 * the mode. Full is ordinary vendor provisioning + daemon startup.
 *
 * Stored in the shared env file as `OPENLLM_SETUP_MODE=full|minimal`, same
 * pattern as `OPENLLM_DAEMON_AUTO_UPDATE` for the daemon auto-update pref.
 */

import { sharedFileConfig } from "./env";
import { saveEnvVars } from "./onboarding";
import type { TSetupMode } from "./setup-mode-contract";
import {
  DEFAULT_SETUP_MODE,
  parseSetupMode,
  SETUP_MODE_ENV,
} from "./setup-mode-contract";

export type { TSetupMode } from "./setup-mode-contract";
export {
  DEFAULT_SETUP_MODE,
  parseSetupMode,
  SETUP_MODE_ENV,
  SETUP_MODES,
} from "./setup-mode-contract";

/** The mode saved in this environment's env file; null when absent or
 *  unrecognized. */
export const savedSetupMode = (): TSetupMode | null =>
  parseSetupMode(sharedFileConfig()[SETUP_MODE_ENV]);

/** The mode exported in the process env; null when absent or unrecognized. */
export const exportedSetupMode = (): TSetupMode | null =>
  parseSetupMode(process.env[SETUP_MODE_ENV]);

/**
 * Resolved setup mode. Precedence: process env → env file → `full`.
 * An unrecognized value is ignored so a typo cannot wedge launches.
 */
export const readSetupMode = (): TSetupMode =>
  exportedSetupMode() ?? savedSetupMode() ?? DEFAULT_SETUP_MODE;

/** True when client launches must stay cloud-direct and leave the daemon alone. */
export const isMinimalSetupMode = (): boolean => readSetupMode() === "minimal";

/** Persist `mode` with the same locked, atomic, 0600 env-file writer the API
 *  key uses. False when the file could not be written. */
export const saveSetupMode = (mode: TSetupMode): boolean =>
  saveEnvVars({ [SETUP_MODE_ENV]: mode });
