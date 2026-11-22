/**
 * The `agy` build the daemon requires, and how a binary's version is read.
 * One rule for the runtime resolver (`native-runtime/antigravity-headless.ts`)
 * and the CLI's provisioning presence check (`packages/cli/src/vendor-provision.ts`).
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The oldest `agy` with the built-in ACP server (`agy acp`, 1.5.0) — the
 *  daemon's image / tool / fallback transport. An older build is unusable. */
export const AGY_MIN_VERSION: readonly [number, number, number] = [1, 5, 0];

/** The whole `agy --version` output: one version, optionally prefixed. */
const VERSION_SHAPE =
  /^(?:agy\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Output that is a version at all (whatever its value). */
const isVersionOutput = (version: string | null): boolean =>
  version !== null && VERSION_SHAPE.test(version.trim());

/**
 * `agy --version` output (`1.5.13`, `agy 1.5.13`, `v1.5.13`, optionally with
 * a `-prerelease` / `+build` suffix) at or above the stable `min`. A
 * prerelease of `min` itself sorts below it (semver); anything that is not
 * that whole shape is not a version.
 */
export const versionAtLeast = (
  version: string | null,
  min: readonly [number, number, number],
): boolean => {
  const m = version === null ? null : VERSION_SHAPE.exec(version.trim());
  if (m === null) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  // Same core as the stable minimum: a prerelease of it is older.
  return m[4] === undefined;
};

/** `<bin> --version` (local, no sign-in, 5 s cap), or null. Run with a
 *  throwaway HOME so it never reads or writes any `agy` profile. */
export const readCliVersion = (path: string): string | null => {
  let home: string | null = null;
  try {
    // A private HOME per probe, removed after: nothing a probe writes is
    // ever seen by the next one.
    home = mkdtempSync(join(tmpdir(), "agy-version-"));
    const out = Bun.spawnSync([path, "--version"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
      // Uncatchable: a binary that ignores SIGTERM must not hold the daemon
      // (or this probe's HOME cleanup) past the cap.
      killSignal: "SIGKILL",
    });
    return out.exitCode === 0 ? out.stdout.toString().trim() : null;
  } catch {
    return null;
  } finally {
    if (home !== null) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // A leftover empty temp dir is harmless.
      }
    }
  }
};

/** How long a FAILED version read is remembered before it is retried (a
 *  binary that timed out once may answer next time). */
export const AGY_VERSION_RETRY_MS = 60_000;

/** Version answers per binary stamp (path + size + mtime): a read that is a
 *  version lasts until the binary is replaced; a failed one — no output, or
 *  output that is no version (a warning line) — only
 *  {@link AGY_VERSION_RETRY_MS}. */
const versionCache = new Map<
  string,
  { readonly version: string | null; readonly atMs: number }
>();

/** {@link readCliVersion}, cached per binary stamp. */
export const cachedCliVersion = (path: string): string | null => {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${path}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = versionCache.get(stamp);
  if (
    cached !== undefined &&
    (isVersionOutput(cached.version) ||
      Date.now() - cached.atMs < AGY_VERSION_RETRY_MS)
  ) {
    return cached.version;
  }
  const version = readCliVersion(path);
  versionCache.set(stamp, { version, atMs: Date.now() });
  return version;
};

/** An `agy` the daemon can use (at or above {@link AGY_MIN_VERSION}). */
export const agyVersionUsable = (
  path: string,
  versionOf: (path: string) => string | null = cachedCliVersion,
): boolean => versionAtLeast(versionOf(path), AGY_MIN_VERSION);
