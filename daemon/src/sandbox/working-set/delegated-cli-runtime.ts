/**
 * Phase 4 / L3 — platform-neutral delegated-CLI runtime filesystem set.
 *
 * Defined ONCE and compiled by both backends:
 *   - Landlock (Linux) consumes the shared working set (which unions this
 *     module via the auth-state / tunnel layers);
 *   - Seatbelt (macOS) consumes that shared set ∪
 *     {@link MAC_SEATBELT_RUNTIME_WRITE_EXTRAS}.
 *
 * RW: isolated provider homes (incl. their XDG leaves from L2), state tmp,
 *     provider credential dirs under those homes.
 * RO: launcher data roots (mise/asdf/volta/fnm/nix/linuxbrew) when present.
 *
 * Never RW on the real `~/.config` or `~/.local/state` roots. macOS still
 * needs a small Seatbelt-only set for frameworks that ignore HOME/XDG/TMPDIR
 * ({@link MAC_SEATBELT_RUNTIME_WRITE_EXTRAS}); Landlock must not receive those.
 *
 * Dependency-light: imports `./base` + `cli-paths` / `mise-paths` only — never
 * `./index`, so the working-set composition can pull this in without a cycle.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CLI_PROVIDERS, cliConfigDir, cliHome } from "../../cli-paths";
import { misePaths } from "../../mise-paths";
import type { TWorkingSet } from "./base";
import { daemonTempDir, SENSITIVE_ROOTS } from "./base";

const stripTrailingSlash = (p: string): string =>
  p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;

/**
 * Resolve one `getconf DARWIN_USER_*` dir to its canonical `/private/var/…`
 * path. Returns null off-macOS or when getconf/realpath fails.
 */
const resolveDarwinUserDir = (
  name: "DARWIN_USER_TEMP_DIR" | "DARWIN_USER_CACHE_DIR",
): string | null => {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync("getconf", [name], { encoding: "utf8" }).trim();
    if (raw.length === 0) return null;
    return stripTrailingSlash(realpathSync(stripTrailingSlash(raw)));
  } catch {
    return null;
  }
};

let cachedDarwinUserRuntimeWriteDirs: readonly string[] | undefined;

/**
 * Per-user Darwin temp + cache dirs (`getconf DARWIN_USER_TEMP_DIR` /
 * `DARWIN_USER_CACHE_DIR`, realpath'd). Security.framework, CFNetwork, Bun
 * mmap, and LaunchServices use these regardless of the process `TMPDIR`, so
 * Seatbelt must keep them writable or keychain / auth IPC can wedge or prompt.
 *
 * Narrowed from the prior blanket `/private/var/folders` grant (audit L3).
 * Falls back to that broad prefix only when getconf/realpath is unavailable —
 * never omit the surface and risk a keychain prompt.
 */
export const DARWIN_USER_RUNTIME_WRITE_DIRS = (): readonly string[] => {
  if (cachedDarwinUserRuntimeWriteDirs !== undefined) {
    return cachedDarwinUserRuntimeWriteDirs;
  }
  const resolved = [
    resolveDarwinUserDir("DARWIN_USER_TEMP_DIR"),
    resolveDarwinUserDir("DARWIN_USER_CACHE_DIR"),
  ].filter((p): p is string => p !== null);
  // Dedupe while preserving order (temp then cache).
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const p of resolved) {
    if (seen.has(p)) continue;
    seen.add(p);
    dirs.push(p);
  }
  cachedDarwinUserRuntimeWriteDirs =
    dirs.length > 0 ? dirs : ["/private/var/folders"];
  return cachedDarwinUserRuntimeWriteDirs;
};

/**
 * macOS Seatbelt-only write extras beyond the shared working set. Kept as ONE
 * named constant so the Landlock↔Seatbelt divergence is explicit in tests and
 * review. Do NOT fold these into {@link delegatedCliRuntimeSet} — Landlock must
 * not grant real-home `Library/*` or Darwin per-user temp/cache.
 *
 * Justified members (audit L3):
 * - {@link DARWIN_USER_RUNTIME_WRITE_DIRS} — frameworks/keychain ignore TMPDIR.
 * - `~/Library/Caches` + `~/Library/Preferences` — LaunchServices (`open` for
 *   OAuth browser) + CFPreferences; the LS database lives on the real home and
 *   cannot be relocated into the isolated HOME. Kept (not removed) because
 *   dropping them risks auth/browser-open breakage; a real-Mac smoke must
 *   confirm before any further shrink.
 *
 * Removed vs the prior set: `/tmp` and `/private/tmp`. Spawned CLIs (and the
 * daemon's own children) already get `TMPDIR=<state>/tmp` via `cliEnv` /
 * `isolatedRuntimeEnv`, and that dir is in the shared RW set — global `/tmp`
 * was only lenient ambient surface for wrappers that ignore TMPDIR.
 */
export const MAC_SEATBELT_RUNTIME_WRITE_EXTRAS = (
  home: string,
): readonly string[] => [
  ...DARWIN_USER_RUNTIME_WRITE_DIRS(),
  join(home, "Library", "Caches"),
  join(home, "Library", "Preferences"),
];

/**
 * Read-only launcher data roots a resolved binary may need to *find* installs
 * after XDG redirection (audit L2/L3). Existence-filtered; never climbs onto
 * `$HOME` or a bare {@link SENSITIVE_ROOTS} entry.
 */
export const launcherDataRoots = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] => {
  const nonEmpty = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim().length > 0 ? v.trim() : undefined;
  const mise = misePaths(home, env);
  const candidates: readonly string[] = [
    mise.configDir,
    mise.dataDir,
    mise.stateDir,
    mise.cacheDir,
    nonEmpty(env.ASDF_DATA_DIR) ?? join(home, ".asdf"),
    nonEmpty(env.VOLTA_HOME) ?? join(home, ".volta"),
    nonEmpty(env.FNM_DIR) ?? join(home, ".local", "share", "fnm"),
    join(home, ".nix-profile"),
    "/nix/var/nix/profiles/default",
    "/home/linuxbrew/.linuxbrew",
    join(home, ".linuxbrew"),
  ];
  const forbidden = new Set<string>(["/", home, ...SENSITIVE_ROOTS(home)]);
  for (let a = dirname(home); a !== dirname(a); a = dirname(a)) {
    forbidden.add(a);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of candidates) {
    if (!isAbsolute(d) || forbidden.has(d) || seen.has(d)) continue;
    seen.add(d);
    if (existsSync(d)) out.push(d);
  }
  return out;
};

/**
 * The shared delegated-CLI runtime set both backends consume. Isolated homes
 * nest under `<state>/cli/<provider>/` (already covered by the base state-dir
 * grant); listing them here makes the L3 contract testable and keeps Landlock
 * explicitly aware of the isolated-home write surface a wrapper that honors
 * HOME/XDG/TMPDIR needs.
 */
export const delegatedCliRuntimeSet = (home: string): TWorkingSet => {
  const readWrite = new Set<string>();
  const readOnly = new Set<string>();
  readWrite.add(daemonTempDir(home));
  for (const provider of CLI_PROVIDERS) {
    readWrite.add(cliHome(provider, home));
    readWrite.add(cliConfigDir(provider, home));
  }
  for (const root of launcherDataRoots(home)) {
    readOnly.add(root);
  }
  // RW subsumes RO.
  for (const rw of readWrite) readOnly.delete(rw);
  return {
    readWrite: [...readWrite],
    readOnly: [...readOnly],
  };
};
