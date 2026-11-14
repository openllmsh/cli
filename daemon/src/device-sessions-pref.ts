/**
 * Device-sessions on/off preference — stored in the shared env file
 * (`~/.openllm/.env`) as `OPENLLM_DEVICE_SESSIONS` (`1`/`0`), beside the
 * trust anchor. Default ON (absent = on). A routing box is always off,
 * whatever the file says — same lock shape as {@link autoUpdateEnabled}
 * (always on there).
 *
 * Disable is reachable from the CLI, local control, and the signed remote
 * disable; enable is local/install only. The anchor is never removed when
 * sessions turn off — WebRTC still needs the anchored control pin.
 */
import {
  envFilePath,
  envFileValue,
  loadEnvFile,
  writeEnvFileVars,
} from "./env";
import { isRoutingBox } from "./routing-box";

/** The env-file key the preference lives under. */
export const DEVICE_SESSIONS_ENV = "OPENLLM_DEVICE_SESSIONS";

/** Parse a sessions flag; null when unrecognized/absent. */
const parseSessionsFlag = (raw: string | null | undefined): boolean | null => {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off") return false;
  return null;
};

/**
 * Whether the sessions preference is on. Default TRUE when absent.
 * Always FALSE on a routing box, whatever the env file says.
 */
export const deviceSessionsPrefEnabled = (): boolean => {
  if (isRoutingBox()) return false;
  loadEnvFile();
  const fromProcess = parseSessionsFlag(process.env[DEVICE_SESSIONS_ENV]);
  if (fromProcess !== null) return fromProcess;
  const fromFile = parseSessionsFlag(
    envFileValue(envFilePath(), DEVICE_SESSIONS_ENV),
  );
  if (fromFile !== null) return fromFile;
  return true;
};

export type TSetDeviceSessionsResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: "persist_failed" | "routing_box" };

/**
 * Persist the device-sessions flag and sync the in-process env. Enable is
 * refused on a routing box (sessions stay locked off there).
 */
export const setDeviceSessionsEnabled = (
  enabled: boolean,
): TSetDeviceSessionsResult => {
  if (enabled && isRoutingBox()) {
    return { ok: false, reason: "routing_box" };
  }
  const next = enabled ? "1" : "0";
  const prev = (() => {
    // Read the raw preference without the routing-box lock, so a disable on a
    // box is still idempotent against the file value.
    loadEnvFile();
    const fromProcess = parseSessionsFlag(process.env[DEVICE_SESSIONS_ENV]);
    if (fromProcess !== null) return fromProcess;
    const fromFile = parseSessionsFlag(
      envFileValue(envFilePath(), DEVICE_SESSIONS_ENV),
    );
    if (fromFile !== null) return fromFile;
    return true;
  })();
  if (prev === enabled) {
    process.env[DEVICE_SESSIONS_ENV] = next;
    return { ok: true, changed: false };
  }
  if (!writeEnvFileVars({ [DEVICE_SESSIONS_ENV]: next }, envFilePath())) {
    return { ok: false, reason: "persist_failed" };
  }
  process.env[DEVICE_SESSIONS_ENV] = next;
  const confirmed = parseSessionsFlag(process.env[DEVICE_SESSIONS_ENV]);
  if (confirmed !== enabled) {
    return { ok: false, reason: "persist_failed" };
  }
  return { ok: true, changed: true };
};
