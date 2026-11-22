/**
 * Kernel confinement for the inference `agy` (headless chat and `agy acp`):
 *   - macOS: a per-spawn Seatbelt profile run through `/usr/bin/sandbox-exec`
 *     ({@link agySeatbeltProfile});
 *   - Linux: the daemon's `--sandbox-exec` shim with the inference `agy`
 *     Landlock set (`sandbox/landlock.ts` `agyWorkingSet`).
 *
 * Why its own profile: `agy`'s `read_file` is what opens image attachments
 * (`antigravity-attachments.ts`), and `agy`'s own deny rules can't confine it
 * — they are case-sensitive path prefixes on a case-insensitive filesystem
 * (`…/Secret` denied, `…/secret` read; probed 2026-11-22, agy 1.5.14). The
 * daemon's shared profile can't be used either: it grants the whole daemon
 * working set, other providers' sign-ins included.
 *
 * What `agy` can reach in `$HOME` and the state dir: the account slot's
 * directory (its HOME, keychain and sign-in), the `agy` binary (and its
 * folder, when that is not `$HOME` or inside the state dir) and the ONE `agy`
 * temp root (`agyTempRoot`: turn cwds and the attachment store). The kernel
 * resolves the real file, so case variants and `..` are refused. Within the
 * temp root `agy` could open another turn's stored image at the OS level;
 * the step guard (`antigravity-headless.ts`) cancels any read but this turn's
 * own images before the model answers, so nothing reaches the requester, and
 * store names are SHA-256 hashes of the bytes.
 *
 * Verified live 2026-11-22 (macOS): sign-in through the slot keychain, a text
 * turn and an attachment read work confined; an outside file is refused as
 * `…/.openllm`, `…/.OPENLLM` and `/users/…`.
 *
 * Login, `models` and `/usage` spawns keep their existing spawn.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { stateDir } from "../env";
import { sandboxSpawnArgs, sandboxWrapsSpawns } from "../sandbox/exec";
import { probeLandlockSupport } from "../sandbox/landlock";
import { agyTempRoot } from "../sandbox/working-set/base";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** SBPL string literal. */
const lit = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);

/** Every directory from `path`'s parent up to and including `root`. */
const ancestors = (root: string, path: string): string[] => {
  const out: string[] = [];
  let cur = dirname(path);
  while (inside(root, cur)) {
    out.push(cur);
    if (cur === root) break;
    cur = dirname(cur);
  }
  return out;
};

/** Every directory above `path` up to `/` (excluded). */
const parentsToRoot = (path: string): string[] => {
  const out: string[] = [];
  let cur = dirname(path);
  while (cur !== dirname(cur)) {
    out.push(cur);
    cur = dirname(cur);
  }
  return out;
};

export type TAgySeatbeltPaths = {
  /** The daemon's real `$HOME` (the child's HOME is the isolated slot). */
  readonly realHome: string;
  /** The account slot's isolated HOME (`cliEnv("antigravity").HOME`). */
  readonly slotHome: string;
  /** The `agy` binary as spawned. */
  readonly bin: string;
  /** The `agy` temp root (`agyTempRoot()`). */
  readonly agyTemp: string;
  /** The daemon state dir (every provider's sign-in lives under it). Denied
   *  too, so a state dir relocated outside `$HOME` stays covered. */
  readonly stateDir: string;
};

/** The SBPL profile for one inference `agy` spawn. Pure. */
export const agySeatbeltProfile = (paths: TAgySeatbeltPaths): string => {
  const home = real(paths.realHome);
  // The slot's directory (`…/cli/antigravity`): its HOME, keychain and the
  // other account slots of this same provider.
  const slotRoot = dirname(real(paths.slotHome));
  const bin = real(paths.bin);
  const agyTemp = real(paths.agyTemp);
  const state = real(paths.stateDir);
  const relocated = !inside(home, state);
  // `$HOME`, plus the state dir when it lives elsewhere.
  const denyRoots = relocated ? [home, state] : [home];
  const underDeny = (p: string): boolean =>
    denyRoots.some((root) => inside(root, p));
  const metadata = new Set<string>(denyRoots);
  for (const p of [slotRoot, bin, paths.bin, agyTemp]) {
    for (const root of denyRoots) {
      if (inside(root, p)) for (const a of ancestors(root, p)) metadata.add(a);
    }
  }
  // The binary's own folder too (a versioned install or an
  // `OPENLLM_AGY_BIN` launcher may load files beside it) — unless that
  // folder is `$HOME` itself or inside the state dir.
  const binDir = dirname(bin);
  const binDirGrant =
    underDeny(binDir) && binDir !== home && !inside(state, binDir);
  const binRules = [
    ...[...new Set([bin, paths.bin])]
      .filter(underDeny)
      .map((p) => `(literal ${lit(p)})`),
    ...(binDirGrant ? [`(subpath ${lit(binDir)})`] : []),
  ];
  const roots = denyRoots.map((r) => `(subpath ${lit(r)})`).join(" ");
  // A relocated state dir is denied by path: its parents must not be
  // renamed or replaced, or the dir would move out from under the rule.
  const pinned = relocated
    ? `(deny file-write* ${parentsToRoot(state)
        .map((p) => `(literal ${lit(p)})`)
        .join(" ")} (literal ${lit(state)}))\n`
    : "";
  return `(version 1)
(allow default)
(deny file-read* ${roots})
(deny file-write* ${roots})
(allow file-read-metadata ${[...metadata].map((p) => `(literal ${lit(p)})`).join(" ")})
(allow file-read* (subpath ${lit(slotRoot)}) (subpath ${lit(agyTemp)})${binRules.length > 0 ? ` ${binRules.join(" ")}` : ""})
(allow file-write* (subpath ${lit(slotRoot)}) (subpath ${lit(agyTemp)}))
${pinned}`;
};

/** Cached Linux Landlock support (`probeLandlockSupport`), probed once. */
let landlock: "pending" | "enforced" | "no" = "pending";
let landlockProbe: Promise<void> | null = null;
const probeLandlockOnce = (): void => {
  landlockProbe ??= probeLandlockSupport()
    .then((state) => {
      landlock = state === "enforced" ? "enforced" : "no";
    })
    .catch(() => {
      landlock = "no";
    });
};

/**
 * Whether the inference `agy`'s file reads are kernel-confined here, so its
 * `read_file` may open image attachments: always on macOS (the Seatbelt
 * profile), and on Linux only while the daemon sandbox wraps spawns and the
 * kernel supports Landlock (the shim fails OPEN). False while the Linux probe
 * is still pending.
 */
export const agyFileReadsConfined = (
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (platform === "darwin") return true;
  if (platform !== "linux" || !sandboxWrapsSpawns()) return false;
  probeLandlockOnce();
  return landlock === "enforced";
};

// Warm at load: the first image turn must not decline (or start `agy` with
// reads still denied) only because the probe hadn't answered yet.
if (process.platform === "linux") probeLandlockOnce();

/** Settle the Linux Landlock probe (tests). */
export const settleAgyConfinementProbe = async (): Promise<void> => {
  probeLandlockOnce();
  await landlockProbe;
};

/**
 * `argv` confined for an inference `agy` spawn: the Seatbelt profile on
 * macOS, the shim's `agy` Landlock set on Linux (unchanged where neither
 * applies). The result is final — callers spawn it as is.
 */
export const confineAgyArgv = (
  argv: ReadonlyArray<string>,
  slotHome: string,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const bin = argv[0];
  if (bin === undefined) return [...argv];
  if (platform === "darwin") {
    return [
      SANDBOX_EXEC,
      "-p",
      agySeatbeltProfile({
        realHome: homedir(),
        slotHome,
        bin,
        agyTemp: agyTempRoot(),
        stateDir: stateDir(),
      }),
      ...argv,
    ];
  }
  // Linux: the `agy` Landlock set only where reads count as confined (the
  // shim refuses to run without it); otherwise the plain daemon sandbox, with
  // `read_file(*)` still denied and image turns declining.
  return agyFileReadsConfined(platform)
    ? sandboxSpawnArgs(argv, { agy: { slotHome, bin } })
    : sandboxSpawnArgs(argv);
};
