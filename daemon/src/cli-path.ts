/**
 * Where the daemon finds the `openllm` CLI it spawns (durable session hosts,
 * session attach, the device-state probe). In the single binary this is the
 * managed install — the same file the daemon runs from — with a dev override
 * so browser-triggered sessions run the working-tree CLI.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

/** Where the install script places the CLI (`~/.openllm/bin/openllm`). */
export const cliBinaryPath = (): string => join(stateDir(), "bin", "openllm");

/** Pre-rename install location (`~/.openllm/bin/openllmc`) — resolved so a
 *  machine that never re-installed after the openllmc → openllm rename still
 *  has a CLI to spawn. */
export const legacyCliBinaryPath = (): string =>
  join(stateDir(), "bin", "openllmc");

/**
 * DEV-ONLY override: an absolute path to a runnable `openllm` the daemon should
 * spawn/probe INSTEAD of the installed binary. Set by `scripts/dev.ts` (a shim
 * that execs the working-tree CLI source) so browser-triggered sessions run
 * this repo's CLI, not the shipped `~/.openllm/bin/openllm`. Unset in
 * production — `resolveOpenllmCli` then falls back to the installed paths, so
 * prod behaviour is unchanged. The updater deliberately does NOT consult this
 * (it must always converge the real installed binary).
 */
export const cliBinaryOverride = (): string | null => {
  const p = process.env.OPENLLM_CLI_PATH;
  return p !== undefined && p.length > 0 && existsSync(p) ? p : null;
};

/**
 * Resolve the `openllm` CLI the daemon should run: the dev override first (when
 * present + existing), then the installed binary (current name, then legacy).
 * Null when none exist. This is the ONE resolver every spawn/attach/probe site
 * shares so dev and prod never drift.
 */
export const resolveOpenllmCli = (): string | null =>
  cliBinaryOverride() ??
  [cliBinaryPath(), legacyCliBinaryPath()].find(existsSync) ??
  null;
