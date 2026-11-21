/**
 * Antigravity switch. ON by default since the provider moved to Google's
 * official `agy` CLI (headless stream-json — it streams; the ACP agent is the
 * fallback): the daemon registers its delegate and the installer provisions
 * both the CLI and the agent.
 *
 * Turn it off with EITHER:
 *   - `OPENLLM_ANTIGRAVITY=0` in the daemon's environment, or
 *   - the marker file `~/.openllm/antigravity-disabled` (survives the
 *     launchd/systemd service, which does not inherit a shell env). The
 *     installer writes it when run with `OPENLLM_ANTIGRAVITY=0` and removes it
 *     with `OPENLLM_ANTIGRAVITY=1`.
 * `OPENLLM_ANTIGRAVITY=1` forces it on even with the marker present.
 * Restart the daemon after toggling.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

export const ANTIGRAVITY_DISABLED_MARKER = "antigravity-disabled";

export const antigravityEnabled = (): boolean => {
  const env = process.env.OPENLLM_ANTIGRAVITY;
  if (env === "1") return true;
  if (env === "0") return false;
  return !existsSync(join(stateDir(), ANTIGRAVITY_DISABLED_MARKER));
};
