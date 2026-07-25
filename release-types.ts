/**
 * Shape of the committed CLI-release manifest (`./manifest.ts`) — the
 * `openllm` twin of `packages/daemon/release-types.ts`. The data module is
 * rewritten by the release CLI after each GitHub release; this type stays
 * hand-written so the manifest is type-checked.
 *
 * `CLI_TARGETS` is the SINGLE source of truth for the buildable targets —
 * `packages/release` imports it (rather than re-declaring the list), and the
 * union + the sha256 map key derive from it, so a missing or unknown-target
 * checksum is a compile error instead of silent drift.
 */

export const CLI_TARGETS = [
  "darwin-arm64",
  "darwin-x64-baseline",
  "linux-x64-baseline",
  "linux-arm64",
] as const;

export type TCliTarget = (typeof CLI_TARGETS)[number];

export type TCliRelease = {
  /** GitHub `owner/repo` the binaries are released to. */
  readonly repo: string;
  /** Release tag, e.g. `v1.6.0`. Empty string until first publish. */
  readonly tag: string;
  /** Every buildable target — stable, independent of what's published yet. */
  readonly targets: readonly TCliTarget[];
  /** sha256 (hex) of each published asset's DECOMPRESSED binary, keyed by
   *  target. `Partial` so the pre-publish (`{}`) state is representable, but
   *  the `TCliTarget` key type rejects unknown/misspelled targets so the map
   *  can't silently drift from the supported set. */
  readonly sha256: Readonly<Partial<Record<TCliTarget, string>>>;
};
