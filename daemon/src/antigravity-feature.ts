/**
 * Antigravity kill switch. The provider shipped in v2.7.24 but is not yet
 * reliable, so it is OFF by default: the daemon registers no delegate for it
 * (no auth, status, usage or model report) and the installer skips the agent.
 *
 * Turn it on with EITHER:
 *   - `OPENLLM_ANTIGRAVITY=1` in the daemon's environment, or
 *   - the marker file `~/.openllm/antigravity-enabled` (survives the
 *     launchd/systemd service, which does not inherit a shell env). The
 *     installer writes it when run with `OPENLLM_ANTIGRAVITY=1`.
 * `OPENLLM_ANTIGRAVITY=0` forces it off even with the marker present.
 * Restart the daemon after toggling.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

export const ANTIGRAVITY_ENABLED_MARKER = "antigravity-enabled";

export const antigravityEnabled = (): boolean => {
  const env = process.env.OPENLLM_ANTIGRAVITY;
  if (env === "1") return true;
  if (env === "0") return false;
  return existsSync(join(stateDir(), ANTIGRAVITY_ENABLED_MARKER));
};
