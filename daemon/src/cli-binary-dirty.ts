/**
 * Cheap CLI-binary dirtiness for the status watcher.
 *
 * Heartbeat-only watcher ticks skip provider probes, so a vendor CLI updated
 * out of band (`codex update`) kept reporting its old `cli_version` until the
 * next full probe. The version cache is already keyed by the binary's stamp
 * (`cli-version-cache.ts`); this only `stat`s the binaries it was asked about
 * — never spawns — and marks status dirty when one changed, the same way
 * {@link markCredentialStoresDirtyIfChanged} does for credential files.
 */

import { versionProbedBinaries } from "./cli-version-cache";
import { versionBinaryStamp } from "./cli-version-stamp";
import { markStatusDirty } from "./status-dirty";

/** Stat-only identity of every version-probed CLI binary. */
export const cliBinaryStamps = (): ReadonlyMap<string, string | null> =>
  new Map(versionProbedBinaries().map((bin) => [bin, versionBinaryStamp(bin)]));

let lastStamps: ReadonlyMap<string, string | null> | null = null;

/**
 * If any version-probed CLI binary changed since the last check, mark status
 * dirty so the next watcher tick runs a full probe (which re-reads the
 * version under the new stamp). A binary seen for the first time is not a
 * change — the probe that added it already published its version. Always
 * refreshes the baseline. Returns whether dirtiness was marked.
 */
export const markCliBinariesDirtyIfChanged = (): boolean => {
  const next = cliBinaryStamps();
  const previous = lastStamps;
  lastStamps = next;
  if (previous === null) return false;
  for (const [bin, stamp] of next) {
    if (previous.has(bin) && previous.get(bin) !== stamp) {
      markStatusDirty("cli-binary");
      return true;
    }
  }
  return false;
};

/** Drop the baseline so the next check re-baselines (watcher stop). */
export const resetCliBinaryFingerprint = (): void => {
  lastStamps = null;
};
