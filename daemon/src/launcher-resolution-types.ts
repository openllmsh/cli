/**
 * Shared launcher-resolution types + pure helpers. No I/O, no imports of
 * spawn/manager/cli-paths — safe for `cli-paths` / profile-state to consume
 * without creating an init cycle.
 */

/** Wire / telemetry kind — shim carries its adapter id in the string. */
export type TLauncherKind = "binary" | "script" | "wrapper" | `shim:${string}`;

/**
 * Privacy-safe launcher profile for doctor / PostHog. No raw paths — kind is
 * collapsed (`shim:mise` → `shim` + `adapter_id`), and `under_manager_root`
 * is a boolean only.
 */
export type TLauncherProfile = {
  readonly kind: "binary" | "script" | "shim" | "wrapper";
  readonly adapter_id: string | null;
  readonly under_manager_root: boolean;
};

export type TLauncherResolution = {
  readonly kind: TLauncherKind;
  /** Absolute path to exec (resolved binary / script / wrapper). */
  readonly path: string;
  /** Absolute interpreter path when `kind === "script"`. */
  readonly interpreter?: string;
  /** Adapter name when `kind` is `shim:<id>`. */
  readonly adapterId?: string;
  /** `mtimeMs:size` of the classified path (or shim, pre-resolve). */
  readonly fingerprint: string;
  readonly underManagerRoot: boolean;
};

export const launcherProfileOf = (
  resolution: TLauncherResolution,
): TLauncherProfile => {
  if (resolution.kind.startsWith("shim:")) {
    return {
      kind: "shim",
      adapter_id: resolution.adapterId ?? resolution.kind.slice("shim:".length),
      under_manager_root: resolution.underManagerRoot,
    };
  }
  return {
    kind: resolution.kind as "binary" | "script" | "wrapper",
    adapter_id: resolution.adapterId ?? null,
    under_manager_root: resolution.underManagerRoot,
  };
};
