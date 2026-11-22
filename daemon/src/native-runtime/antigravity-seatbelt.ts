/**
 * Kernel confinement for the inference `agy` (headless chat and `agy acp`) on
 * macOS: a per-spawn Seatbelt profile run through `/usr/bin/sandbox-exec`.
 *
 * Why its own profile: `agy`'s `read_file` is what opens image attachments
 * (`antigravity-attachments.ts`), and `agy`'s own deny rules can't confine it
 * — they are case-sensitive path prefixes on a case-insensitive filesystem
 * (`…/Secret` denied, `…/secret` read; probed 2026-11-22, agy 1.5.14). The
 * daemon's shared profile (`sandbox/seatbelt.ts`) can't be used either: it
 * grants the whole daemon working set, other providers' sign-ins included.
 *
 * The profile: everything outside `$HOME` stays as the OS needs it; inside
 * `$HOME` only the account slot's directory (its HOME, keychain and sign-in),
 * the resolved `agy` binary and the daemon's `agy-*` temp dirs (turn cwds and
 * the attachment store) can be read or written, plus metadata of their
 * ancestors for path resolution. The kernel resolves the real file, so case
 * variants and `..` are refused ("operation not permitted"). Verified live
 * 2026-11-22: sign-in through the slot keychain, a text turn and an
 * attachment read work confined; an outside file is refused as `…/.openllm`,
 * `…/.OPENLLM` and `/users/…`.
 *
 * Login, `models` and `/usage` spawns keep their existing (unconfined) spawn.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { daemonTempDir } from "../sandbox/working-set/base";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** SBPL string literal. */
const lit = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** SBPL regex literal matching `value` verbatim. */
const rx = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");

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

export type TAgySeatbeltPaths = {
  /** The daemon's real `$HOME` (the child's HOME is the isolated slot). */
  readonly realHome: string;
  /** The account slot's isolated HOME (`cliEnv("antigravity").HOME`). */
  readonly slotHome: string;
  /** The `agy` binary as spawned. */
  readonly bin: string;
  /** The daemon temp dir holding `agy-*` cwds and `agy-attachments`. */
  readonly tempDir: string;
};

/** The SBPL profile for one inference `agy` spawn. Pure. */
export const agySeatbeltProfile = (paths: TAgySeatbeltPaths): string => {
  const home = real(paths.realHome);
  // The slot's directory (`…/cli/antigravity`): its HOME, keychain and the
  // other account slots of this same provider.
  const slotRoot = dirname(real(paths.slotHome));
  const bin = real(paths.bin);
  const tempDir = real(paths.tempDir);
  const agyTemp = `^${rx(tempDir)}/agy-[^/]*(/.*)?$`;
  const metadata = new Set<string>([home]);
  for (const p of [slotRoot, bin, paths.bin, `${tempDir}/agy-`]) {
    if (inside(home, p)) for (const a of ancestors(home, p)) metadata.add(a);
  }
  const binRules = [...new Set([bin, paths.bin])]
    .filter((p) => inside(home, p))
    .map((p) => `(literal ${lit(p)})`);
  return `(version 1)
(allow default)
(deny file-read* (subpath ${lit(home)}))
(deny file-write* (subpath ${lit(home)}))
(allow file-read-metadata ${[...metadata].map((p) => `(literal ${lit(p)})`).join(" ")})
(allow file-read* (subpath ${lit(slotRoot)}) (regex #"${agyTemp}")${binRules.length > 0 ? ` ${binRules.join(" ")}` : ""})
(allow file-write* (subpath ${lit(slotRoot)}) (regex #"${agyTemp}"))
`;
};

/**
 * `argv` wrapped in the inference `agy` Seatbelt profile on macOS; unchanged
 * elsewhere (callers keep their own confinement there).
 */
export const agySeatbeltArgv = (
  argv: ReadonlyArray<string>,
  slotHome: string,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const bin = argv[0];
  if (platform !== "darwin" || bin === undefined) return [...argv];
  return [
    SANDBOX_EXEC,
    "-p",
    agySeatbeltProfile({
      realHome: homedir(),
      slotHome,
      bin,
      tempDir: daemonTempDir(),
    }),
    ...argv,
  ];
};
