/**
 * Device-sessions on/off preference — stored in the shared env file
 * (`~/.openllm/.env`) as `OPENLLM_DEVICE_SESSIONS` (`1`/`0`), beside the
 * trust anchor. Default ON (absent = on). A Routebox is always off,
 * whatever the file says — same lock shape as {@link autoUpdateEnabled}
 * (always on there).
 *
 * Disable is reachable from the CLI, local control, and the signed remote
 * disable; enable is local/install only. The anchor is never removed when
 * sessions turn off — WebRTC still needs the anchored control pin.
 */
import { envFilePath, envFileValue, writeEnvFileVars } from "./env";
import { isRoutebox } from "./routebox";

/** The env-file key the preference lives under. */
export const DEVICE_SESSIONS_ENV = "OPENLLM_DEVICE_SESSIONS";

/**
 * The flag as the env FILE has it, read fresh every time (like the anchor):
 * the CLI's `device enable|disable` runs in another process and only writes
 * the file, so a value cached in this process's env would leave the running
 * daemon on the old setting. Default on when absent or unrecognized.
 */
const fileFlag = (): boolean => {
  const v = envFileValue(envFilePath(), DEVICE_SESSIONS_ENV)
    ?.trim()
    .toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
};

/** Whether sessions are on. Always FALSE on a Routebox. */
export const deviceSessionsPrefEnabled = (): boolean =>
  !isRoutebox() && fileFlag();

export type TSetDeviceSessionsResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: "persist_failed" | "routebox" };

/**
 * Persist the device-sessions flag. Enable is refused on a Routebox
 * (sessions stay locked off there). Disable on a Routebox is a true no-op
 * — no env-file write — because sessions are already locked off there.
 */
export const setDeviceSessionsEnabled = (
  enabled: boolean,
): TSetDeviceSessionsResult => {
  if (isRoutebox()) {
    if (enabled) return { ok: false, reason: "routebox" };
    return { ok: true, changed: false };
  }
  if (fileFlag() === enabled) return { ok: true, changed: false };
  const written = writeEnvFileVars(
    { [DEVICE_SESSIONS_ENV]: enabled ? "1" : "0" },
    envFilePath(),
  );
  if (!written || fileFlag() !== enabled) {
    return { ok: false, reason: "persist_failed" };
  }
  return { ok: true, changed: true };
};
