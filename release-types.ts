/**
 * Shape of the committed release manifest (`./manifest.ts`) for the single
 * `openllm` binary (CLI + daemon half). The data module is
 * rewritten by the release CLI after each GitHub release; this type stays
 * hand-written so the manifest is type-checked.
 *
 * `CLI_TARGETS` is the SINGLE source of truth for the buildable targets —
 * `packages/release` imports it (rather than re-declaring the list), and the
 * union + the sha256 map key derive from it, so a missing or unknown-target
 * checksum is a compile error instead of silent drift.
 *
 * Prereleases skip the Intel Mac target (`darwin-x64-baseline`) — same idea
 * as the desktop app's Apple-Silicon-only prerelease — so a prerelease
 * compiles, signs and notarizes one fewer binary. Stable keeps the full set.
 * {@link cliTargetsForRelease} is the channel → target-list pick; the
 * committed manifest's `targets` lists only what that release published.
 */

export const CLI_TARGETS = [
  "darwin-arm64",
  "darwin-x64-baseline",
  "linux-x64-baseline",
  "linux-arm64",
] as const;

export type TCliTarget = (typeof CLI_TARGETS)[number];

/** The one buildable target a prerelease deliberately skips (Intel macOS). */
export const CLI_PRERELEASE_OMITTED_TARGET = "darwin-x64-baseline" as const;

export type TCliPrereleaseTarget = Exclude<
  TCliTarget,
  typeof CLI_PRERELEASE_OMITTED_TARGET
>;

/**
 * Targets a prerelease publishes — every {@link CLI_TARGETS} entry except
 * {@link CLI_PRERELEASE_OMITTED_TARGET}. Derived by filter so the omit set
 * can't drift from the buildable list. Stable still publishes every
 * {@link CLI_TARGETS} entry.
 */
export const CLI_PRERELEASE_TARGETS: readonly TCliPrereleaseTarget[] =
  CLI_TARGETS.filter(
    (t): t is TCliPrereleaseTarget => t !== CLI_PRERELEASE_OMITTED_TARGET,
  );

/**
 * Which targets a release of this channel publishes. `isPre` matches the
 * publisher's prerelease test (`version.includes("-")` / a non-`full`
 * channel): true → {@link CLI_PRERELEASE_TARGETS}, false → all
 * {@link CLI_TARGETS}.
 */
export const cliTargetsForRelease = (isPre: boolean): readonly TCliTarget[] =>
  isPre ? CLI_PRERELEASE_TARGETS : CLI_TARGETS;

/** True when `t` is one of the buildable {@link CLI_TARGETS}. */
export const isCliTargetName = (t: string): t is TCliTarget =>
  (CLI_TARGETS as readonly string[]).includes(t);

/**
 * True when the pin's `targets` list is present and does not include this
 * host. Shared by CLI self-update and the daemon updater — soft-skip signal
 * for a prerelease (or any pin) that omitted this arch.
 */
export const pinOmitsHostTarget = (
  targets: unknown,
  hostTarget: string,
): boolean =>
  Array.isArray(targets) &&
  targets.every((t): t is string => typeof t === "string") &&
  !targets.includes(hostTarget);

/** Prefix of the binary-route 404 when a pin omits a target — single wording. */
const NO_BINARY_FOR_TARGET_PREFIX = 'This release has no binary for "';

/** The binary-route 404 body when a pin omits `target`. */
export const noBinaryForTargetMessage = (target: string): string =>
  `${NO_BINARY_FOR_TARGET_PREFIX}${target}"`;

/** True when the binary route's JSON body is the explicit skipped-arch 404. */
export const isNoBinaryForTargetMessage = (message: string): boolean =>
  message.includes(NO_BINARY_FOR_TARGET_PREFIX);

/**
 * Thrown when `/api/cli/binary/<target>.sha256` returns the explicit
 * skipped-arch 404. Soft-skip signal for deploy skew (bootstrap still lists
 * the target, newer pin omits it) — not a download failure.
 */
export class NoBinaryForTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoBinaryForTargetError";
  }
}

export const isNoBinaryForTargetError = (
  err: unknown,
): err is NoBinaryForTargetError => err instanceof NoBinaryForTargetError;

export type TCliRelease = {
  /** GitHub `owner/repo` the binaries are released to. */
  readonly repo: string;
  /** Release tag, e.g. `v1.6.0`. Empty string until first publish. */
  readonly tag: string;
  /**
   * Targets THIS published release carries — not the full buildable set.
   * A prerelease omits `darwin-x64-baseline`; consumers (install, self-update,
   * `/api/cli/binary`) treat a host target absent from this list as "no
   * binary for this release" rather than an unknown target.
   */
  readonly targets: readonly TCliTarget[];
  /** sha256 (hex) of each published asset's DECOMPRESSED binary, keyed by
   *  target. `Partial` so the pre-publish (`{}`) state is representable, but
   *  the `TCliTarget` key type rejects unknown/misspelled targets so the map
   *  can't silently drift from the supported set. */
  readonly sha256: Readonly<Partial<Record<TCliTarget, string>>>;
};
