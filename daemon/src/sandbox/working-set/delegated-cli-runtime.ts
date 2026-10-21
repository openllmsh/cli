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
 * Never RW on the real `~/.config` or `~/.local/state` roots. The remaining
 * macOS-only real-home grants (`/tmp`, `~/Library/Caches`, …) stay in
 * {@link MAC_SEATBELT_RUNTIME_WRITE_EXTRAS} — tightening those is a separate
 * gated step (audit L3); this module only documents the divergence.
 *
 * Dependency-light: imports `./base` + `cli-paths` / `mise-paths` only — never
 * `./index`, so the working-set composition can pull this in without a cycle.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CLI_PROVIDERS, cliConfigDir, cliHome } from "../../cli-paths";
import { misePaths } from "../../mise-paths";
import type { TWorkingSet } from "./base";
import { daemonTempDir, SENSITIVE_ROOTS } from "./base";

/**
 * macOS Seatbelt-only write extras beyond the shared working set. Kept as ONE
 * named constant so the Landlock↔Seatbelt divergence is explicit in tests and
 * review. Do NOT fold these into {@link delegatedCliRuntimeSet} — Landlock must
 * not grant real `/tmp` or real-home `Library/*`.
 */
export const MAC_SEATBELT_RUNTIME_WRITE_EXTRAS = (
  home: string,
): readonly string[] => [
  "/private/tmp",
  "/tmp",
  "/private/var/folders",
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
