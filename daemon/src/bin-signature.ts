/**
 * A cheap change-detector for an on-disk binary, so a `--version` probe only
 * spawns when the binary ACTUALLY changed (a self-update, reinstall, or — for an
 * isolated run-view symlink — a repointed target). A vendor CLI's version is
 * stable between updates, so statting is far cheaper than re-spawning `--version`
 * every status tick; the spawn (which is confined, ~300ms through the sandbox
 * shim) then runs only on the rare change.
 *
 * The signature follows symlinks (`statSync`, not `lstatSync`): the isolated
 * `cli/<provider>/bin/<tool>` path is a symlink to the host binary, and we want
 * the identity of what actually RUNS — so a host self-update (target mtime/size
 * changes) OR a repointed symlink (different target inode → different mtime/size)
 * both invalidate the cache and force a fresh probe. `mtimeMs` + `size` is enough
 * to catch every real update; we deliberately don't hash (that would defeat the
 * point of avoiding I/O on the hot path).
 */
import { statSync } from "node:fs";

/**
 * A compact `dev:ino:size:mtime:ctime` signature of the RESOLVED binary at
 * `path`, or `null` when it can't be statted (missing / broken symlink). Two
 * calls returning the same non-null string mean the binary is unchanged; any
 * difference (or a null↔non-null transition) means re-probe.
 */
export const binarySignature = (path: string): string | null => {
  try {
    const s = statSync(path); // follows symlinks — see module doc
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs.toString(36)}:${s.ctimeMs.toString(36)}`;
  } catch {
    return null; // missing / unresolvable — caller treats as "changed"
  }
};
