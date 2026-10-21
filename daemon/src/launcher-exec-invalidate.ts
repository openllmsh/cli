/**
 * Phase 4 / L1: when exec of a resolved launcher fails with ENOENT/EACCES,
 * drop the cached resolution so the next demand call re-resolves (self-heal
 * after `mise use -g`, `volta install`, `nix profile upgrade`, …).
 *
 * Does NOT import `launcher-resolution` — that would re-create the init cycle
 * through manager-resolution → spawn. Production uses the leaf hook registered
 * by the resolver; tests pass an explicit target.
 */
import { realpathSync } from "node:fs";
import { registeredLauncherResolutionInvalidator } from "./launcher-invalidate-hook";

export type TLauncherInvalidateTarget = {
  readonly invalidateLauncherResolution: (candidate: string) => void;
};

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

const resolveInvalidator = (
  resolver: TLauncherInvalidateTarget | undefined,
): ((candidate: string) => void) | undefined => {
  if (resolver !== undefined) {
    return (candidate) => resolver.invalidateLauncherResolution(candidate);
  }
  return registeredLauncherResolutionInvalidator();
};

/**
 * Invalidate the cached resolution for the argv's exec target when `err` is
 * ENOENT/EACCES. No-op otherwise. When `resolver` is omitted, uses the
 * production invalidator registered by `launcher-resolution`.
 */
const invalidateTarget = (
  target: string,
  invalidate: (candidate: string) => void,
): void => {
  invalidate(target);
  try {
    const real = realpathSync(target);
    if (real !== target) invalidate(real);
  } catch {
    // Target already gone — the candidate key drop above is enough.
  }
};

export const maybeInvalidateLauncherOnExecFailure = (
  argv: readonly string[],
  err: unknown,
  resolver?: TLauncherInvalidateTarget,
): void => {
  if (!isLauncherExecFailure(err)) return;
  const target = resolvedSpawnTarget(argv);
  if (target === undefined) return;
  const invalidate = resolveInvalidator(resolver);
  if (invalidate === undefined) return;
  invalidateTarget(target, invalidate);
};

/**
 * Exit 127 is the sandbox-exec shim's convention for an inner ENOENT (see
 * `sandbox/exec.ts`). Treat it like an exec failure for the unwrapped target.
 */
export const maybeInvalidateLauncherOnExitCode = (
  argv: readonly string[],
  exitCode: number | null,
  resolver?: TLauncherInvalidateTarget,
): void => {
  if (exitCode !== 127) return;
  const target = resolvedSpawnTarget(argv);
  if (target === undefined) return;
  const invalidate = resolveInvalidator(resolver);
  if (invalidate === undefined) return;
  invalidateTarget(target, invalidate);
};
