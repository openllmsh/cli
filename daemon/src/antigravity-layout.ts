/**
 * On-disk layout of the Google Antigravity ACP agent (`agy_acp_server`).
 *
 * Google publishes no install script. `packages/cli/install.sh`
 * (`install_antigravity_release`) resolves the LATEST release from the ACP
 * registry (`antigravity-acp/agent.json`), downloads it from dl.google.com and
 * unpacks the agent + its harness into `versions/<version>/`, then points
 * `current` at it. The daemon resolves its host binary from the same layout
 * (`cli-paths.ts`).
 */
import { join } from "node:path";

/** Agent executable + its sibling harness, as named inside the release zip. */
export const ANTIGRAVITY_EXECUTABLE = "agy_acp_server.par";
export const ANTIGRAVITY_HARNESS = "localharness_external";
/** Completion marker the installer writes last (`{"version":"x.y.z"}`). */
export const ANTIGRAVITY_INSTALL_MARKER = ".install-complete";

/** Managed install root under the REAL user home. */
export const antigravityManagedDir = (home: string): string =>
  join(home, ".openllm", "vendor", "antigravity");

export const antigravityManagedExecutable = (home: string): string =>
  join(antigravityManagedDir(home), "current", ANTIGRAVITY_EXECUTABLE);
