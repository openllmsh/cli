/**
 * Graceful stop when the cloud refuses this daemon's identity
 * (`409 identity_conflict`): another device now holds the API key.
 *
 * Mirrors {@link guardCrashLoop} / `openllm stop`: disable supervisor
 * KeepAlive via {@link serviceStop}, then exit 0 so launchd/systemd/
 * detached self-restore do not relaunch us into the same conflict.
 */
import { logWarn, safeDiagnosticMessage } from "./logger";
import { serviceStop } from "./service";

export type TStopForIdentityConflictOptions = {
  /**
   * When true, tear down the control channel / relay before stopping the
   * service so this process does not stay painted online after the conflict.
   */
  readonly stopChannel?: boolean;
};

/**
 * Disable self-restore and exit cleanly. Never returns.
 * Tests mock `serviceStop` + `process.exit`; never touches real launchd.
 */
export const stopForIdentityConflict = async (
  options?: TStopForIdentityConflictOptions,
): Promise<never> => {
  // publishIdentity already logged the conflict; repeat here so a caller that
  // reaches this path without going through publish still leaves a clear trail.
  logWarn(
    "identity",
    safeDiagnosticMessage`this key is now used by another device; stopping`,
    {},
  );
  if (options?.stopChannel === true) {
    try {
      const { stopControlChannel } = await import("./control-channel");
      await stopControlChannel();
    } catch {
      // best-effort — exit still clears this process
    }
  }
  try {
    serviceStop();
  } catch {
    // best-effort — even if disabling fails, exiting still clears this churn
  }
  // Same shape as boot-guard: exit 0 so the supervisor does not relaunch.
  // Tests mock `process.exit`; the `as never` keeps the return contract.
  return process.exit(0) as never;
};
