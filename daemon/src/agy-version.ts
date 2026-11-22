/**
 * The `agy` build the daemon requires, and how a binary's version is read.
 * One rule for the runtime resolver (`native-runtime/antigravity-headless.ts`)
 * and the CLI's provisioning presence check (`packages/cli/src/vendor-provision.ts`).
 */

import { statSync } from "node:fs";
import { tmpdir } from "node:os";

/** The oldest `agy` with the built-in ACP server (`agy acp`, 1.5.0) — the
 *  daemon's image / tool / fallback transport. An older build is unusable. */
export const AGY_MIN_VERSION: readonly [number, number, number] = [1, 5, 0];

/** `x.y.z` at or above `min`; anything unparseable is not. */
export const versionAtLeast = (
  version: string | null,
  min: readonly [number, number, number],
): boolean => {
  const m = version === null ? null : /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
};

/** `<bin> --version` (local, no sign-in, 5 s cap), or null. Run with a
 *  throwaway HOME so it never reads or writes any `agy` profile. */
export const readCliVersion = (path: string): string | null => {
  try {
    const out = Bun.spawnSync([path, "--version"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() },
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    return out.exitCode === 0 ? out.stdout.toString().trim() : null;
  } catch {
    return null;
  }
};

/** Version answers per binary stamp (path + size + mtime): a binary is
 *  asked once until it is replaced. */
const versionCache = new Map<string, string | null>();

/** {@link readCliVersion}, cached per binary stamp. */
export const cachedCliVersion = (path: string): string | null => {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${path}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return null;
  }
  if (versionCache.has(stamp)) return versionCache.get(stamp) ?? null;
  const version = readCliVersion(path);
  versionCache.set(stamp, version);
  return version;
};

/** An `agy` the daemon can use (at or above {@link AGY_MIN_VERSION}). */
export const agyVersionUsable = (
  path: string,
  versionOf: (path: string) => string | null = cachedCliVersion,
): boolean => versionAtLeast(versionOf(path), AGY_MIN_VERSION);
