/**
 * Antigravity is part of the product — there is no switch. Older installers
 * wrote `<state dir>/antigravity-disabled` to turn it off; the daemon deletes
 * that leftover on start so no user has to (install.sh does the same).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

export const LEGACY_ANTIGRAVITY_DISABLED_MARKER = "antigravity-disabled";

export const removeLegacyAntigravityMarker = (
  dir: string = stateDir(),
): void => {
  try {
    rmSync(join(dir, LEGACY_ANTIGRAVITY_DISABLED_MARKER), { force: true });
  } catch {
    // Best effort: a stale marker no longer changes anything.
  }
};
