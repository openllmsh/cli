/** Durable local session-host process discovery and launch helpers. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type {
  TProcessIdentity,
  TProcessStartIdentityReader,
} from "../../pty-native/session/local-runtime";
import {
  processIdentityStatus,
  processStartIdentity,
  SESSION_HOST_STARTUP_GRACE_MS,
} from "../../pty-native/session/local-runtime";
import {
  verifyWindowsSessionDirectory,
  verifyWindowsSessionFile,
} from "../../pty-native/session/windows-session-pipe";
import type { TDaemonCli } from "./clients/registry";
import { DAEMON_CLIS } from "./clients/registry";
import { findDaemonBinary as findManagedDaemonBinary } from "./daemon-delegation";
import { daemonStateDir } from "./env";

export type TSessionHostMeta = {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly cwd: string;
  readonly pid: number;
  readonly vendorSessionId: string | null;
  readonly title: string | null;
  readonly startedAtMs: number;
  /** Process start identity, preventing a reused pid from impersonating a host. */
  readonly processStartTime: string;
  readonly generation: number;
};

export type TLiveSessionHost = TSessionHostMeta & {
  readonly socketPath: string;
};

/**
 * A registry directory that blocked a launch: its recorded host could not be
 * verified as alive-and-ours, but could not be proven stale either.
 */
export type TUnknownSessionHost = {
  /** The CLI this entry blocks. Null means it blocks every CLI. */
  readonly cli: TDaemonCli | null;
  /** The on-disk directory responsible, printed in refusal messages. */
  readonly directory: string;
};

export type TSessionHostDiscovery = {
  readonly hosts: readonly TLiveSessionHost[];
  readonly unknownIdentityCli: readonly TDaemonCli[];
  /** The directories behind {@link unknownIdentityCli}, for error reporting. */
  readonly unknown: readonly TUnknownSessionHost[];
};

export const hasUnknownSessionHost = (
  discovery: TSessionHostDiscovery,
  cli: TDaemonCli,
): boolean => discovery.unknownIdentityCli.includes(cli);

export const sessionHostsRoot = (): string =>
  join(daemonStateDir(), "sessions");
export const sessionHostDir = (id: string): string =>
  join(sessionHostsRoot(), id);
export const sessionHostSocketPath = (id: string): string =>
  join(sessionHostDir(id), "ctl.sock");

const isDaemonCli = (value: unknown): value is TDaemonCli =>
  typeof value === "string" &&
  (DAEMON_CLIS as readonly string[]).includes(value);

const validSessionHostSpawnArgs = (args: {
  readonly cwd: string;
  readonly title: string;
  readonly vendorArgs: readonly string[];
}): boolean =>
  isAbsolute(args.cwd) &&
  args.cwd.length >= 1 &&
  args.cwd.length <= 1_024 &&
  !args.cwd.includes("\0") &&
  args.title.length <= 80 &&
  !args.title.includes("\0") &&
  args.vendorArgs.length <= 64 &&
  args.vendorArgs.every(
    (arg) => arg.length >= 1 && arg.length <= 512 && !arg.includes("\0"),
  );

/** Validate metadata before treating an on-disk entry as a live host. */
export const isSessionHostMeta = (
  value: unknown,
): value is TSessionHostMeta => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(meta.id) &&
    isDaemonCli(meta.cli) &&
    typeof meta.cwd === "string" &&
    typeof meta.pid === "number" &&
    Number.isInteger(meta.pid) &&
    meta.pid > 0 &&
    (meta.vendorSessionId === null ||
      typeof meta.vendorSessionId === "string") &&
    (meta.title === null || typeof meta.title === "string") &&
    typeof meta.startedAtMs === "number" &&
    Number.isFinite(meta.startedAtMs) &&
    typeof meta.processStartTime === "string" &&
    meta.processStartTime.length > 0 &&
    typeof meta.generation === "number" &&
    Number.isInteger(meta.generation) &&
    meta.generation >= 1
  );
};

const processStartTime = (pid: number): string | null => {
  return processStartIdentity(pid) ?? null;
};

/** PID liveness only — used for legacy meta that predates processStartTime. */
const pidStatus = (pid: number): TProcessIdentity => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) {
      const code = (error as { readonly code?: unknown }).code;
      if (code === "EPERM") return "alive";
      if (code === "ESRCH") return "dead";
    }
    return "unknown";
  }
};

export const sessionHostProcessStatus = (
  meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
  readIdentity?: TProcessStartIdentityReader,
): TProcessIdentity =>
  processIdentityStatus(meta.pid, meta.processStartTime, readIdentity);

/** Compatibility predicate: unknown is conservatively treated as possibly alive. */
export const sessionHostProcessAlive = (
  meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
): boolean => sessionHostProcessStatus(meta) !== "dead";

export const sessionHostProcessStartTime = (): string | null =>
  processStartTime(process.pid);

/**
 * Pre-processStartTime meta.json shape. Kept only for reap decisions: the host
 * process may still be alive after an upgrade, but attach requires the current
 * identity fields so these records stay non-attachable until the process exits.
 */
type TLegacySessionHostMeta = {
  readonly id: string;
  readonly pid: number;
  readonly cli: TDaemonCli | null;
  readonly startedAtMs: number | null;
};

const readLegacySessionHostMeta = (
  value: unknown,
): TLegacySessionHostMeta | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const meta = value as Record<string, unknown>;
  if (
    typeof meta.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(meta.id) ||
    typeof meta.pid !== "number" ||
    !Number.isInteger(meta.pid) ||
    meta.pid <= 0
  ) {
    return null;
  }
  return {
    id: meta.id,
    pid: meta.pid,
    cli: isDaemonCli(meta.cli) ? meta.cli : null,
    startedAtMs:
      typeof meta.startedAtMs === "number" && Number.isFinite(meta.startedAtMs)
        ? meta.startedAtMs
        : null,
  };
};

const readSessionHostMeta = (
  dir: string,
):
  | { readonly kind: "current"; readonly meta: TSessionHostMeta }
  | { readonly kind: "legacy"; readonly meta: TLegacySessionHostMeta }
  | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "meta.json"), "utf8"),
    );
    if (isSessionHostMeta(parsed)) return { kind: "current", meta: parsed };
    const legacy = readLegacySessionHostMeta(parsed);
    return legacy === null ? null : { kind: "legacy", meta: legacy };
  } catch {
    return null;
  }
};

/** The argv token every OpenLLM session host is spawned with. */
const SESSION_HOST_ARGV_MARKER = "__session-host";

/**
 * Slack when comparing a legacy meta's `startedAtMs` against the probed
 * process start: `ps lstart` resolves to whole seconds and the meta is
 * written moments after spawn, so a genuine host sits within seconds of the
 * recorded time while a recycled pid is typically off by far more.
 */
const LEGACY_HOST_START_TOLERANCE_MS = 60_000;

const CTIME_MONTHS: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** The process's full command line, or undefined when the probe is unavailable. */
const processCommandLine = (pid: number): string | undefined => {
  if (process.platform === "win32") return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_500,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    });
    if (result.error !== undefined || result.status !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Convert a persisted process-start identity to epoch milliseconds. POSIX
 * probes yield `ps lstart` ctime text (UTC, forced by the reader's env);
 * Windows yields a decimal FILETIME (100 ns ticks since 1601-01-01).
 */
export const startIdentityMs = (identity: string): number | null => {
  if (/^\d+$/.test(identity)) {
    const ms = (BigInt(identity) - 11_644_473_600_000_000_000n) / 10_000n;
    return Number(ms);
  }
  const match =
    /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(
      identity,
    );
  if (match === null) return null;
  const month = CTIME_MONTHS[match[1] ?? ""];
  if (month === undefined) return null;
  const ms = Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Decide whether the live pid behind a LEGACY meta is really an OpenLLM
 * session host. `false` is a confirmed mismatch (the pid was recycled by an
 * unrelated process — e.g. a root-owned one `pidStatus` reports EPERM/alive
 * for), `true` is a confirmed session host, and null means no probe could
 * decide.
 */
const legacyPidIsSessionHost = (
  meta: TLegacySessionHostMeta,
  readIdentity?: TProcessStartIdentityReader,
): boolean | null => {
  const commandLine = processCommandLine(meta.pid);
  if (commandLine !== undefined) {
    if (!commandLine.includes(SESSION_HOST_ARGV_MARKER)) return false;
    // A session-host process whose recorded id does not appear in its own
    // argv is not THIS dir's host; leave it undecided rather than stale.
    return commandLine.includes(meta.id) ? true : null;
  }
  if (meta.startedAtMs === null) return null;
  let identity: string | null | undefined;
  try {
    identity = (readIdentity ?? processStartIdentity)(meta.pid);
  } catch {
    return null;
  }
  if (identity === null || identity === undefined) return null;
  const startMs = startIdentityMs(identity);
  if (startMs === null) return null;
  return Math.abs(startMs - meta.startedAtMs) <= LEGACY_HOST_START_TOLERANCE_MS;
};

/**
 * Scan the process-owned registry. An entry is reaped ONLY when its host is
 * confirmed gone (dead pid) or confirmed not ours (recycled pid, argv/start
 * mismatch): age alone never authorizes deletion. Anything unverifiable —
 * an identity probe that cannot run, a legacy record whose host cannot be
 * decided, or a verified-live host whose socket is (temporarily) missing —
 * keeps blocking its CLI so a running session can never be hidden and
 * duplicated; the refusal names the directory and `--new` is the explicit
 * escape hatch. Legacy records (missing processStartTime) are never
 * attachable: they block while their pid is alive, and are reaped as soon as
 * the pid is dead or proves to belong to an unrelated process.
 */

const directoryAgeMs = (directory: string): number => {
  try {
    return Date.now() - statSync(directory).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const fsErrorCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Move `src` to `dest` only when `dest` does not exist — never a silent
 * replace (the same no-replace primitive the approved restore lock uses). A
 * directory is claimed by an exclusive mkdir and its children are moved one
 * by one (rename(2) would overwrite a racing destination); a leaf is moved
 * by hard-link + unlink, falling back to an exclusive-create copy on
 * filesystems without hard links. The source is only removed after the
 * destination landed, so a failed move keeps the source — and its data.
 */
const moveNoReplace = (src: string, dest: string): void => {
  const stat = lstatSync(src);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    mkdirSync(dest, { mode: 0o700 });
    try {
      for (const child of readdirSync(src)) {
        moveNoReplace(join(src, child), join(dest, child));
      }
    } finally {
      // rmdir removes only an EMPTY source: a child that failed to move
      // keeps the source tree — and its data — in place.
      try {
        rmdirSync(src);
      } catch {
        // children remain — left for the next scan to repair
      }
    }
    return;
  }
  try {
    linkSync(src, dest);
  } catch (error) {
    const code = fsErrorCode(error);
    // Exclusive-create copy covers filesystems without hard links. Only a
    // regular file may take this path — copying a fifo or socket could
    // block forever, so those report a failure and keep the source.
    if (
      (code === "EXDEV" || code === "EPERM" || code === "ENOSYS") &&
      stat.isFile()
    ) {
      copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
    } else {
      throw error;
    }
  }
  rmSync(src, { force: true });
};

/**
 * Delete `directory` only while `removable` keeps proving it — and bind the
 * deletion to the verified entry: the dir is first RENAMED to a unique
 * quarantine sibling (only ONE racing reaper's rename can win — the source
 * vanishes under the loser), then re-verified INSIDE the quarantine by
 * re-reading its ownership records (meta.json / owner.json pid + start
 * identity + launch token) exactly as the original judgement did. Only a
 * still-proven-dead entry is removed. A verdict that flips — a fresh host
 * re-published the path between the scan's judgement and this rename —
 * moves the entry back with a NO-REPLACE move, never an overwrite: a live
 * replacement at the registry name is never deleted and never replaced.
 * rmSync runs only on the quarantine path, never on the live name.
 */
export const reapProvenSessionHostDir = (
  directory: string,
  removable: (dir: string) => boolean,
): void => {
  if (!removable(directory)) return;
  const quarantine = `${directory}.reaping-${randomUUID()}`;
  try {
    renameSync(directory, quarantine);
  } catch {
    // The entry vanished or a racing reaper's rename won first.
    return;
  }
  if (removable(quarantine)) {
    try {
      rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // A leftover quarantine entry is inert — it is scanned like any other
      // unrecognized dir and can never be deleted without a fresh proof.
    }
    return;
  }
  try {
    moveNoReplace(quarantine, directory);
  } catch {
    // A fresh entry claimed the name during the repair window, or the move
    // failed partway: leave the quarantine entry — the live replacement at
    // the real name is never touched.
  }
};

/**
 * A session host's private staging directory, `.{id}.{pid}.staging` (and its
 * `.{id}.claim` mutex sibling), lives beside the published `{id}` entry and
 * is renamed into place only after the control socket is bound. The pid the
 * host embedded in the name IS the ownership record: a live pid means a host
 * is still starting (its meta.json does not exist until onSpawn), so the
 * entry is left alone — or, past the startup grace, reported as blocking —
 * and NEVER deleted on age alone. Only a confirmed-dead owner authorizes a
 * reap.
 */
const parseStagingDirectoryName = (
  name: string,
): { readonly id: string; readonly pid: number } | null => {
  const match = /^\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.(\d+)\.staging$/.exec(
    name,
  );
  if (match === null) return null;
  const pid = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { id: match[1] ?? "", pid };
};

/** A `.{id}.claim` mutex dir beside the published `{id}` entry. */
const parseClaimDirectoryName = (name: string): boolean =>
  /^\.[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.claim$/.test(name);

type TSessionHostOwnerRecord = {
  readonly pid: number;
  readonly processStartTime: string;
  readonly cli: TDaemonCli | null;
};

/**
 * The ownership record a session host publishes atomically (temp + rename)
 * into its claim and staging dirs: pid + start identity + launch token +
 * cli. A readable record is the only proof a transient dir was ever owned;
 * an absent or unparsable one is UNPROVEN — kept, never reaped on age.
 */
const readSessionHostOwnerRecord = (
  directory: string,
): TSessionHostOwnerRecord | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(directory, "owner.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.processStartTime !== "string" ||
      record.processStartTime.length === 0
    )
      return null;
    return {
      pid: record.pid,
      processStartTime: record.processStartTime,
      cli: isDaemonCli(record.cli) ? record.cli : null,
    };
  } catch {
    return null;
  }
};

export const discoverSessionHosts = (
  readIdentity?: TProcessStartIdentityReader,
): TSessionHostDiscovery => {
  let entries: string[];
  if (process.platform === "win32" && existsSync(sessionHostsRoot())) {
    try {
      verifyWindowsSessionDirectory(sessionHostsRoot());
    } catch {
      return {
        hosts: [],
        unknownIdentityCli: [...DAEMON_CLIS],
        unknown: [{ cli: null, directory: sessionHostsRoot() }],
      };
    }
  }
  try {
    entries = readdirSync(sessionHostsRoot());
  } catch {
    return { hosts: [], unknownIdentityCli: [], unknown: [] };
  }
  const sessions: TLiveSessionHost[] = [];
  const unknown: TUnknownSessionHost[] = [];
  for (const name of entries) {
    const directory = sessionHostDir(name);
    // Only directories can be session-host entries. A stray file or symlink
    // is left untouched — never deleted and never a reason to block.
    let entryIsDirectory = false;
    try {
      const stat = lstatSync(directory);
      entryIsDirectory = stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      entryIsDirectory = false;
    }
    if (!entryIsDirectory) continue;
    if (process.platform === "win32") {
      try {
        verifyWindowsSessionDirectory(directory);
        const metaPath = join(directory, "meta.json");
        const socketPath = join(directory, "ctl.sock");
        if (existsSync(metaPath)) verifyWindowsSessionFile(metaPath);
        if (existsSync(socketPath)) verifyWindowsSessionFile(socketPath);
      } catch {
        // ACL verification failure is a refusal, never a reap — a directory
        // we cannot prove ownership of is left exactly as found.
        unknown.push({ cli: null, directory });
        continue;
      }
    }
    const socketPath = join(directory, "ctl.sock");

    // A host's private staging directory names its owner: `.{id}.{pid}.staging`.
    // Its meta.json only appears when onSpawn runs, so a live pid here means a
    // host is STILL STARTING — age alone can never authorize a reap. A dead
    // owner pid is the only proof that lets the scan remove it.
    const staging = parseStagingDirectoryName(name);
    if (staging !== null) {
      // An identity record INSIDE the dir — owner.json (written before the
      // claim is owned) or meta.json (written on spawn) — binds pid + start
      // identity, so a pid reused after the owner died is provably not this
      // staging host. With no record at all, only the pid embedded in the
      // name can vouch: its confirmed death is still the only reap proof,
      // never the dir's age. The predicate is re-run inside the quarantine,
      // so a fresh dir that claimed the name mid-race is put back, not
      // deleted.
      const stagingOwnerDead = (dir: string): boolean => {
        const staged = readSessionHostMeta(dir);
        const owner = readSessionHostOwnerRecord(dir);
        if (staged?.kind === "current") {
          return sessionHostProcessStatus(staged.meta, readIdentity) === "dead";
        }
        if (staged?.kind === "legacy") {
          return pidStatus(staged.meta.pid) === "dead";
        }
        if (owner !== null) {
          return (
            processIdentityStatus(
              owner.pid,
              owner.processStartTime,
              readIdentity,
            ) === "dead"
          );
        }
        return pidStatus(staging.pid) === "dead";
      };
      if (stagingOwnerDead(directory)) {
        reapProvenSessionHostDir(directory, stagingOwnerDead);
        continue;
      }
      // Possibly live: inside the startup grace a mid-launch host neither
      // lists nor blocks; past it the entry blocks (naming the directory,
      // `--new` the escape) because its owner may still own a session we
      // cannot see.
      if (directoryAgeMs(directory) > SESSION_HOST_STARTUP_GRACE_MS) {
        const staged = readSessionHostMeta(directory);
        const owner = readSessionHostOwnerRecord(directory);
        const cli = staged !== null ? staged.meta.cli : (owner?.cli ?? null);
        unknown.push({ cli, directory });
      }
      continue;
    }

    // A `.{id}.claim` mutex is owned through owner.json, published
    // atomically before the claim counts as owned. Reap ONLY a claim whose
    // recorded owner is proven dead by pid + start identity — a live or
    // unproven owner is never deleted on age: inside the grace the claim is
    // mid-launch, and past it the entry blocks rather than letting a second
    // host take a session its owner may still hold.
    if (parseClaimDirectoryName(name)) {
      const claimOwnerDead = (dir: string): boolean => {
        const owner = readSessionHostOwnerRecord(dir);
        return (
          owner !== null &&
          processIdentityStatus(
            owner.pid,
            owner.processStartTime,
            readIdentity,
          ) === "dead"
        );
      };
      if (claimOwnerDead(directory)) {
        reapProvenSessionHostDir(directory, claimOwnerDead);
        continue;
      }
      if (directoryAgeMs(directory) > SESSION_HOST_STARTUP_GRACE_MS) {
        const owner = readSessionHostOwnerRecord(directory);
        unknown.push({ cli: owner?.cli ?? null, directory });
      }
      continue;
    }

    const record = readSessionHostMeta(directory);

    // An unrecognized directory — a malformed or mid-write meta.json, or a
    // shape a newer host version publishes — carries no ownership proof, so
    // it is NEVER reaped: inside the startup grace it
    // may still be a host mid-launch (leave it alone), and past the grace it
    // blocks with the directory named and `--new` as the escape hatch.
    if (record === null) {
      if (directoryAgeMs(directory) > SESSION_HOST_STARTUP_GRACE_MS) {
        unknown.push({ cli: null, directory });
      }
      continue;
    }

    if (record.kind === "legacy") {
      // Non-attachable: block while the recorded pid may still be the host.
      // Reap only on confirmed death or a confirmed pid-recycle (an argv or
      // start-time mismatch) — an undecidable probe keeps blocking since the
      // host could still be alive. processStartTime is required for
      // attach/kill identity, so legacy stays out of the live list even
      // though the host process may still be running.
      const legacyEntryRemovable = (dir: string): boolean => {
        const reread = readSessionHostMeta(dir);
        if (reread?.kind !== "legacy") return false;
        if (pidStatus(reread.meta.pid) === "dead") return true;
        // Reap only a CONFIRMED mismatch: an undecidable probe (`null`)
        // means the pid behind this entry may still be a live host, and
        // deleting the directory would hide it and let a duplicate start.
        return legacyPidIsSessionHost(reread.meta, readIdentity) === false;
      };
      if (legacyEntryRemovable(directory)) {
        reapProvenSessionHostDir(directory, legacyEntryRemovable);
        continue;
      }
      unknown.push({
        cli:
          record.meta.id !== name || record.meta.cli === null
            ? null
            : record.meta.cli,
        directory,
      });
      continue;
    }

    const meta = record.meta;
    if (meta.id !== name) {
      // Same rule as a matching entry: only confirmed death authorizes a
      // reap — an undecidable identity keeps blocking, whatever the dir age.
      const mismatchedOwnerDead = (dir: string): boolean => {
        const reread = readSessionHostMeta(dir);
        return (
          reread?.kind === "current" &&
          reread.meta.id !== name &&
          sessionHostProcessStatus(reread.meta, readIdentity) === "dead"
        );
      };
      if (mismatchedOwnerDead(directory)) {
        reapProvenSessionHostDir(directory, mismatchedOwnerDead);
      } else {
        unknown.push({ cli: meta.cli, directory });
      }
      continue;
    }

    const processStatus = sessionHostProcessStatus(meta, readIdentity);
    if (processStatus === "dead") {
      reapProvenSessionHostDir(directory, (dir) => {
        const reread = readSessionHostMeta(dir);
        return (
          reread?.kind === "current" &&
          sessionHostProcessStatus(reread.meta, readIdentity) === "dead"
        );
      });
      continue;
    }

    // A failed identity probe proves nothing about the process. The entry
    // keeps blocking so a possibly-live host is never hidden, and the refusal
    // names this directory with `--new` as the documented escape hatch.
    if (processStatus === "unknown") {
      unknown.push({ cli: meta.cli, directory });
      continue;
    }

    if (!existsSync(socketPath)) {
      // A verified-live host whose endpoint is absent — bind lag or a socket
      // that vanished — still owns this session. Inside the startup grace it
      // is only mid-launch; past it the entry blocks (naming the directory)
      // rather than being reaped, so a running session cannot be hidden and
      // duplicated. The process itself is never touched either way.
      if (Date.now() - meta.startedAtMs > SESSION_HOST_STARTUP_GRACE_MS) {
        unknown.push({ cli: meta.cli, directory });
      }
      continue;
    }

    sessions.push({ ...meta, socketPath });
  }
  const unknownIdentityCli = DAEMON_CLIS.filter((cli) =>
    unknown.some((entry) => entry.cli === null || entry.cli === cli),
  );
  return {
    hosts: sessions.sort((a, b) => b.startedAtMs - a.startedAtMs),
    unknownIdentityCli,
    unknown,
  };
};

export const discoverLiveSessionHosts = (): readonly TLiveSessionHost[] =>
  discoverSessionHosts().hosts;

/** Wait for the detached host to publish its private local control endpoint. */
export const waitForSessionHostSocket = async (
  id: string,
  timeoutMs = 2_000,
): Promise<string | null> => {
  const socketPath = sessionHostSocketPath(id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return socketPath;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(socketPath) ? socketPath : null;
};

/**
 * Resolve the durable-host binary, allowing an explicit dev override or a
 * normal PATH installation. Shared with lifecycle delegation for one policy.
 */
export const findDaemonBinary = (): string | null => findManagedDaemonBinary();

export const sessionHostSpawnArgv = (args: {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly title: string;
  readonly dangerous: boolean;
  readonly resumeSessionId?: string;
  readonly vendorArgs: readonly string[];
}): readonly string[] | null => {
  if (!validSessionHostSpawnArgs(args)) return null;
  return [
    "__session-host",
    "--id",
    args.id,
    "--cli",
    args.cli,
    "--cwd",
    args.cwd,
    "--title",
    args.title,
    "--cols",
    String(args.cols),
    "--rows",
    String(args.rows),
    ...(args.dangerous ? ["--dangerous"] : []),
    ...(args.resumeSessionId === undefined
      ? []
      : ["--resume", args.resumeSessionId]),
    ...args.vendorArgs.flatMap((arg) => ["--vendor-arg", arg]),
  ];
};

/**
 * Spawn the host as a sibling process so it survives the invoking CLI.
 * Returns the child process so the caller may clean up on fallback.
 */
export const spawnSessionHost = (args: {
  readonly binary: string;
  readonly argv: readonly string[];
}): ReturnType<typeof Bun.spawn> | null => {
  try {
    const command =
      process.platform === "win32" &&
      extname(args.binary).toLowerCase() === ".cmd"
        ? ["cmd.exe", "/c", args.binary, ...args.argv]
        : [args.binary, ...args.argv];
    const reapWithHarness =
      process.env.OPENLLM_SESSION_HOST_KILL_ON_PARENT_EXIT === "1";
    const proc = Bun.spawn(command, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        ...(reapWithHarness
          ? { OPENLLM_SESSION_HOST_OWNER_PID: String(process.pid) }
          : {}),
      },
    });
    proc.unref();
    return proc;
  } catch {
    return null;
  }
};
