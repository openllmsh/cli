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
 * These targets are built and published for a release.
 */
export const CLI_RELEASE_TARGETS: readonly TCliTarget[] = CLI_TARGETS;

/** Windows distribution is limited to prereleases. */
export const CLI_STABLE_TARGETS: readonly TCliTarget[] =
  CLI_RELEASE_TARGETS.filter((target) => target !== "win32-x64");

export const cliReleaseTargets = (version: string): readonly TCliTarget[] =>
  version.includes("-") ? CLI_RELEASE_TARGETS : CLI_STABLE_TARGETS;

/** Bun compiler spelling for each release target. */
export const CLI_COMPILE_TARGET: Readonly<Record<TCliTarget, string>> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64-baseline": "bun-darwin-x64-baseline",
  "linux-x64-baseline": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "win32-x64": "bun-windows-x64-baseline",
};

/** Reverse map: Bun target spelling → release key (for `--target` selection
 *  and the compiler's outfile naming). */
export const BUN_TARGET_TO_CLI_TARGET: Readonly<Record<string, TCliTarget>> =
  Object.fromEntries(
    (Object.entries(CLI_COMPILE_TARGET) as [TCliTarget, string][]).map(
      ([key, bunTarget]) => [bunTarget, key],
    ),
  ) as Record<string, TCliTarget>;

/** The publisher reads this raw file. Windows uses a copy of the PE file. */
export const cliRawFilename = (target: TCliTarget): string =>
  `openllm-${target}`;

/** The gzip distribution asset name for a release key. */
export const cliAssetFilename = (target: TCliTarget): string =>
  `openllm-${target}.gz`;

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
