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
  "win32-x64",
] as const;

export type TCliTarget = (typeof CLI_TARGETS)[number];

/**
 * The targets this release actually builds, hashes, and publishes — the ONE
 * switch every release/compile/hash/publish/manifest path iterates.
 * `CLI_TARGETS` stays the buildable superset so the Windows code still
 * typechecks, but Windows is off for 2.8.0-beta.1: add "win32-x64" back here
 * (or iterate CLI_TARGETS) to re-enable it.
 */
export const CLI_RELEASE_TARGETS = CLI_TARGETS.filter(
  (target): target is Exclude<TCliTarget, "win32-x64"> =>
    target !== "win32-x64",
);

/** Bun compiler spelling for each release target. */
export const CLI_COMPILE_TARGET: Readonly<Record<TCliTarget, string>> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64-baseline": "bun-darwin-x64-baseline",
  "linux-x64-baseline": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "win32-x64": "bun-windows-x64-baseline",
};

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
