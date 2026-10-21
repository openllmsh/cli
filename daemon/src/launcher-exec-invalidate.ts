/**
 * Phase 4 / L1: when exec of a resolved launcher fails with ENOENT/EACCES,
 * drop the cached resolution so the next demand call re-resolves (self-heal
 * after `mise use -g`, `volta install`, `nix profile upgrade`, …).
 */
import { realpathSync } from "node:fs";
import type { TLauncherResolver } from "./launcher-resolution";
import { defaultLauncherResolver } from "./launcher-resolution";

const isErrno = (
  err: unknown,
): err is NodeJS.ErrnoException & { readonly code: string } =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  typeof (err as { code: unknown }).code === "string";

/**
 * Unwrap `sandboxSpawnArgs` wrapping to recover the real exec target.
 * Forms:
 *   - `[target, ...args]` (unwrapped / probe)
 *   - `[execPath, "--sandbox-exec", ..., "--", target, ...args]`
 *   - `[execPath, entry, "--sandbox-exec", ..., "--", target, ...args]` (dev)
 */
export const resolvedSpawnTarget = (
  argv: readonly string[],
): string | undefined => {
  if (argv.length === 0) return undefined;
  const dd = argv.indexOf("--");
  if (dd >= 0 && argv.includes("--sandbox-exec")) {
    const target = argv[dd + 1];
    return target !== undefined && target.length > 0 ? target : undefined;
  }
  const target = argv[0];
  return target !== undefined && target.length > 0 ? target : undefined;
};

export const isLauncherExecFailure = (err: unknown): boolean => {
  if (!isErrno(err)) return false;
  return err.code === "ENOENT" || err.code === "EACCES";
};

/**
 * Invalidate the cached resolution for the argv's exec target when `err` is
 * ENOENT/EACCES. No-op otherwise. `resolver` defaults to the process-wide
 * production resolver (overridable in tests).
 */
const invalidateTarget = (
  target: string,
  resolver: TLauncherResolver,
): void => {
  resolver.invalidateLauncherResolution(target);
  try {
    const real = realpathSync(target);
    if (real !== target) resolver.invalidateLauncherResolution(real);
  } catch {
    // Target already gone — the candidate key drop above is enough.
  }
};

export const maybeInvalidateLauncherOnExecFailure = (
  argv: readonly string[],
  err: unknown,
  resolver: TLauncherResolver = defaultLauncherResolver,
): void => {
  if (!isLauncherExecFailure(err)) return;
  const target = resolvedSpawnTarget(argv);
  if (target === undefined) return;
  invalidateTarget(target, resolver);
};

/**
 * Exit 127 is the sandbox-exec shim's convention for an inner ENOENT (see
 * `sandbox/exec.ts`). Treat it like an exec failure for the unwrapped target.
 */
export const maybeInvalidateLauncherOnExitCode = (
  argv: readonly string[],
  exitCode: number | null,
  resolver: TLauncherResolver = defaultLauncherResolver,
): void => {
  if (exitCode !== 127) return;
  const target = resolvedSpawnTarget(argv);
  if (target === undefined) return;
  invalidateTarget(target, resolver);
};
