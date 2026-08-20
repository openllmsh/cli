/**
 * Hermes home / profile-id helpers shared by the persist client and the
 * --no-persist session overlay. Kept out of `hermes.ts` so `session.ts` can
 * resolve the sticky profile config path without a cycle (hermes.ts execs
 * through session).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../env";

export const hermesRoot = (): string =>
  process.env.OPENLLM_HERMES_HOME !== undefined &&
  process.env.OPENLLM_HERMES_HOME.length > 0
    ? process.env.OPENLLM_HERMES_HOME
    : join(userHome(), ".hermes");

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
