/**
 * Hermes home / profile-id helpers shared by the persist client and the
 * --no-persist session overlay. Kept out of `hermes.ts` so `session.ts` can
 * resolve the sticky profile config path without a cycle (hermes.ts execs
 * through session).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TDirLockRelease } from "../../../tunnel/session/dir-lock";
import {
  acquireDirLock,
  acquireDirLockSync,
  envDirLockCodec,
} from "../../../tunnel/session/dir-lock";
import { openllmDir, userHome } from "../env";

export const hermesRoot = (): string =>
  process.env.OPENLLM_HERMES_HOME !== undefined &&
  process.env.OPENLLM_HERMES_HOME.length > 0
    ? process.env.OPENLLM_HERMES_HOME
    : join(userHome(), ".hermes");

// Both profile names share one ledger and one active pointer.
// Use OpenLLM state for the lock. Do not create the Hermes home here.
const profileLockPath = (): string =>
  join(openllmDir(), ".hermes-profile.lock.d");

export const hermesProfileLockExists = (): boolean =>
  existsSync(profileLockPath());

const prepareProfileLock = (): string => {
  mkdirSync(openllmDir(), { recursive: true, mode: 0o700 });
  return profileLockPath();
};

const profileLockOptions = { waitMs: 5_000, reclaimMs: 30_000, pollMs: 50 };

const requireProfileLock = (
  release: TDirLockRelease | null,
): TDirLockRelease => {
  if (release === null) {
    throw new Error(
      "Timed out waiting for the Hermes profile lock. Another install or uninstall may be running. Retry after it finishes.",
    );
  }
  return release;
};

export const acquireHermesProfileLock = async (): Promise<TDirLockRelease> =>
  requireProfileLock(
    await acquireDirLock(
      prepareProfileLock(),
      envDirLockCodec,
      profileLockOptions,
    ),
  );

export const acquireHermesProfileLockSync = (): TDirLockRelease =>
  requireProfileLock(
    acquireDirLockSync(
      prepareProfileLock(),
      envDirLockCodec,
      profileLockOptions,
    ),
  );

/** Hermes profile ids: `default` or the same charset as `hermes profile create`. */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const isHermesProfileName = (name: string): boolean =>
  name === "default" || PROFILE_ID_RE.test(name);

export const hermesProfileDir = (name: string): string => {
  if (!isHermesProfileName(name)) {
    throw new Error(`refusing unsafe Hermes profile name: ${name}`);
  }
  return name === "default"
    ? hermesRoot()
    : join(hermesRoot(), "profiles", name);
};

export const hermesActiveProfilePath = (): string =>
  join(hermesRoot(), "active_profile");

export const readActiveProfile = (): string => {
  try {
    const name = readFileSync(hermesActiveProfilePath(), "utf-8").trim();
    if (name.length === 0 || !isHermesProfileName(name)) return "default";
    return name;
  } catch {
    return "default";
  }
};

/** Config.yaml of the sticky profile (default → `~/.hermes/config.yaml`). */
export const hermesProfileConfigPath = (): string =>
  join(hermesProfileDir(readActiveProfile()), "config.yaml");

export const hermesLedgerPath = (): string =>
  join(openllmDir(), "clients", "hermes.json");

/**
 * Profile name written by `openllm hermes install`, or null when there is no
 * valid ledger / the profile dir is gone. Session overlay reads this so a
 * launch after install does not pin `active_profile` to `default`.
 */
export const readHermesStickyProfile = (): string | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(hermesLedgerPath(), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const name = (parsed as { profileName?: unknown }).profileName;
    if (typeof name !== "string" || !isHermesProfileName(name)) return null;
    if (name === "default") return null;
    if (!existsSync(hermesProfileDir(name))) return null;
    return name;
  } catch {
    return null;
  }
};

/**
 * Directory to export as `HERMES_TUI_DIR`. Native Hermes only skips
 * `npm install` when `<dir>/dist/entry.js` exists (`hermes_cli/main.py`
 * `_make_tui_argv`). Curl installs keep that bundle at `ui-tui/dist/`;
 * a wheel's `tui_dist/entry.js` is a different layout and is picked up
 * by native `_find_bundled_tui` without this env.
 */
export const hermesBundledTuiDir = (bin: string): string | undefined => {
  const roots: string[] = [];
  const push = (dir: string): void => {
    if (!roots.includes(dir)) roots.push(dir);
  };
  push(join(dirname(bin), ".."));
  try {
    push(join(dirname(realpathSync(bin)), ".."));
  } catch {
    // bin missing or not resolvable
  }
  push(hermesRoot());
  for (const root of roots) {
    const ui = join(root, "ui-tui");
    if (existsSync(join(ui, "dist", "entry.js"))) return ui;
  }
  return undefined;
};
