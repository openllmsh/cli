/**
 * Version-probe identity for a resolved executable.
 *
 * Distinct from {@link binarySignature}: this stamp MUST NOT include ctime.
 * chmod / xattr / other metadata-only updates must not force another
 * `--version` spawn. Security/auth consumers of `bin-signature.ts` stay
 * unchanged.
 *
 * Follows symlinks (`realpath` + `stat`) so the identity is the file that
 * actually runs.
 */
import { realpathSync, statSync } from "node:fs";

/** High-res mtime as nanoseconds. Request bigint stats so `mtimeNs` is present. */
const highResMtimeNs = (s: {
  readonly mtimeMs: number | bigint;
  readonly mtimeNs?: number | bigint;
}): string => {
  const ns = s.mtimeNs;
  if (typeof ns === "bigint") return ns.toString();
  if (typeof ns === "number" && Number.isFinite(ns)) {
    return Math.round(ns).toString();
  }
  const ms = s.mtimeMs;
  if (typeof ms === "bigint") return (ms * 1_000_000n).toString();
  return Math.round(ms * 1e6).toString();
};

/** Canonical path of `bin`, or `null` when it cannot be resolved. */
export const resolveVersionBinary = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Compact `dev:ino:size:mtimeNs` identity of the resolved binary, or `null`
 * when it is missing / unstatable. High-resolution mtime (nanoseconds when
 * the runtime exposes `mtimeNs`) — never ctime.
 */
export const versionBinaryStamp = (path: string): string | null => {
  const resolved = resolveVersionBinary(path);
  if (resolved === null) return null;
  try {
    const s = statSync(resolved, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${highResMtimeNs(s)}`;
  } catch {
    return null;
  }
};
