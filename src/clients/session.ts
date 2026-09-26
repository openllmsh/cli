/**
 * The IO half of session mode: materialize a launch plan into an ephemeral run
 * dir and exec the real client.
 *
 * Transparency is the contract (proposal §3.4.1.6): the child inherits stdio
 * and the TTY, every user argument is forwarded verbatim, signals reach the
 * child, and our exit code IS the child's — `ollm claude --resume` must be
 * indistinguishable from `claude --resume`.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  executableCandidates,
  executablePathDirs,
} from "@openllmsh/protocol/executable-paths";
import crossSpawnModule from "cross-spawn";
import cmdEscapeModule from "cross-spawn/lib/util/escape.js";
import type { TProcessStartIdentityReader } from "../../../pty-native/session/local-runtime";
import {
  processIdentityStatus,
  processStartCommand,
  processStartIdentity,
  sessionHostSupported,
} from "../../../pty-native/session/local-runtime";
import { findCompatibleDaemonBinary } from "../daemon-delegation";
import { openllmDir, userHome } from "../env";
import { requireCliApiKey } from "../onboarding";
import type { TLiveSessionHost } from "../session-host";
import {
  discoverSessionHosts,
  hasUnknownSessionHost,
  sessionHostProcessStatus,
  sessionHostSpawnArgv,
  spawnSessionHost,
  startIdentityMs,
  waitForSessionHostSocket,
} from "../session-host";
import { attachBrokerSession } from "./attach";
import {
  contextStateDir,
  fetchModelCatalog,
  fetchTier,
  resolveGateway,
} from "./gateway";
import { hermesBundledTuiDir, hermesProfileConfigPath } from "./hermes-home";
import { HOOK_SCRIPTS } from "./hooks";
import { buildLaunchPlan, type TLaunchPlan } from "./launch";
import { buildLiveJson, LIVE_JSON_NAME, writeLiveJson } from "./live";
import type { TClient, TClientFlags, TDaemonCli } from "./registry";
import {
  buildSessionChoices,
  formatSessionPrompt,
  resolveExplicitSession,
  resolvePick,
  shouldStartFreshAfterAttachFailure,
} from "./session-picker";

type TCrossSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type TCommandEscape = {
  readonly command: (command: string) => string;
  readonly argument: (
    argument: string,
    doubleEscapeMetaChars: boolean,
  ) => string;
};

const spawnCrossPlatform: TCrossSpawn = crossSpawnModule;
const escapeCommand: TCommandEscape = cmdEscapeModule;

/** `~/.openllm/run` — every ephemeral per-launch overlay lives here. */
export const runRoot = (): string => join(openllmDir(), "run");

const expandHome = (p: string): string =>
  p.startsWith("~/") ? join(userHome(), p.slice(2)) : p;

/** Resolve the client binary, or null when it isn't installed. */
export const findClientBinary = (client: TClient): string | null => {
  for (const candidate of client.binPaths) {
    const abs = expandHome(candidate);
    for (const path of executableCandidates(abs))
      if (existsSync(path)) return path;
  }
  // Fall back to PATH resolution — `spawn` would do this anyway, but resolving
  // here lets us print the install hint instead of an ENOENT stack.
  const dirs = executablePathDirs();
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    const abs = join(dir, client.bin);
    for (const path of executableCandidates(abs))
      if (existsSync(path)) return path;
  }
  return null;
};

/**
 * Reap run dirs from launches that crashed without cleaning up. Best-effort and
 * conservative: only directories whose pid is no longer alive are removed, so a
 * concurrent launch is never disturbed.
 */
const reapStaleRuns = (clientRoot: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(clientRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    const pid = Number.parseInt(name, 10);
    if (!Number.isFinite(pid)) continue;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
      continue; // still running — leave it
    } catch {
      // ESRCH (dead) → its run dir is garbage
    }
    try {
      rmSync(join(clientRoot, name), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
};

/** Create `~/.openllm/run/<client>/<pid>/` (0700) and return it. */
const createRunDir = (clientId: string): string => {
  const clientRoot = join(runRoot(), clientId);
  mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
  reapStaleRuns(clientRoot);
  const dir = join(clientRoot, String(process.pid));
  rmSync(dir, { recursive: true, force: true }); // pid reuse after a crash
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // force mode regardless of umask
  return dir;
};

/**
 * Symlink every entry of the user's real config dir into the run dir, so a
 * private `GROK_HOME`-style redirect still resolves credentials, sessions, and
 * history to the user's own files. Entries the plan writes itself are skipped
 * (a real file must win over the symlink).
 */
const mirrorConfigDir = (
  realDir: string,
  runDir: string,
  ownPaths: readonly string[],
): void => {
  if (!existsSync(realDir)) return;
  const owned = new Set(ownPaths.map((p) => p.split("/")[0]));
  for (const entry of readdirSync(realDir)) {
    if (owned.has(entry)) continue;
    try {
      symlinkSync(join(realDir, entry), join(runDir, entry));
    } catch {
      // already present / unsupported — skip
    }
  }
};

/** Write the plan's files, materialize hooks, and set up any symlink farm. */
const materialize = (plan: TLaunchPlan, runDir: string): void => {
  if (plan.mirrorDir !== undefined) {
    mirrorConfigDir(
      expandHome(plan.mirrorDir),
      runDir,
      Object.keys(plan.files),
    );
  }
  for (const [rel, contents] of Object.entries(plan.files)) {
    const abs = join(runDir, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, contents, { mode: 0o600 });
  }
  if (plan.hooks) {
    const hooksDir = join(runDir, "hooks");
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    for (const [name, body] of Object.entries(HOOK_SCRIPTS)) {
      const abs = join(hooksDir, name);
      writeFileSync(abs, body, { mode: 0o700 });
      chmodSync(abs, 0o700);
    }
  }
  // Executable plan entries last, so they land whether or not the client uses
  // hooks and are never clobbered by the shared hook table above.
  for (const [rel, body] of Object.entries(plan.execFiles ?? {})) {
    const abs = join(runDir, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, body, { mode: 0o700 });
    chmodSync(abs, 0o700); // force mode regardless of umask
  }
};

/**
 * Run-dir paths (relative) the plan owns outright — our overlay files, the
 * generated `hooks/` tree, the live index. These are never vendor data:
 * teardown deletes them rather than moving them back, even when the vendor
 * rewrote one — their contents are our merged overlay, and landing them in
 * the user's real config dir would leak run-local references (and our
 * gateway wiring) into files the vendor reads on every ordinary launch.
 * Ownership is per PATH, not per top-level name, so a vendor file that lands
 * NEXT to a plan file in a shared dir (e.g. `rules/notes.md` beside our
 * `rules/openllm.md`) is still preserved.
 */
const planOwnedPaths = (plan: TLaunchPlan): ReadonlySet<string> => {
  const owned = new Set<string>([LIVE_JSON_NAME]);
  if (plan.hooks) owned.add("hooks");
  for (const rel of [
    ...Object.keys(plan.files),
    ...Object.keys(plan.execFiles ?? {}),
  ]) {
    owned.add(rel);
  }
  return owned;
};

/** True for any filesystem entry, including a dangling symlink. */
const entryExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Deepest mtime under a path (lstat — a symlink is compared as the link). */
const newestMtimeMs = (path: string): number => {
  let newest = 0;
  const visit = (p: string): void => {
    try {
      const stat = lstatSync(p);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const child of readdirSync(p)) visit(join(p, child));
      }
    } catch {
      // entry vanished mid-walk — nothing to compare
    }
  };
  visit(path);
  return newest;
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
 * replace. A directory is claimed by an exclusive mkdir and its children are
 * moved one by one (rename(2) would overwrite a racing destination); a leaf
 * is moved by hard-link + unlink, falling back to an exclusive-create copy
 * on filesystems without hard links. The source is only removed after the
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
        // children remain — left for the caller to report
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
 * Move `src` aside to `<nameBase>.openllm-<stamp>[-n]` — the conflict
 * suffix lives next to the REAL name it collided with, so a losing run-dir
 * copy is still preserved inside the vendor dir. The candidate name is
 * claimed by the move itself (EEXIST just picks the next index), so two
 * restorers can never overwrite each other's backup.
 */
const moveEntryAside = (
  src: string,
  nameBase: string,
  stamp: string,
): string => {
  for (let i = 0; i < 64; i += 1) {
    const candidate = `${nameBase}.openllm-${stamp}${i === 0 ? "" : `-${i}`}`;
    try {
      moveNoReplace(src, candidate);
      return candidate;
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error(`no free backup name next to ${nameBase}`);
};

const RESTORE_LOCK_NAME = ".openllm-restore.lock";
const RESTORE_LOCK_OWNER_NAME = "owner.json";
/** Marks an owner record written by this code; anything else is unverifiable. */
const RESTORE_LOCK_KIND = "openllm-restore-lock/v1";
/** Exact start-identity shapes processStartIdentity produces: POSIX
 *  `ps -o lstart=` under LC_ALL=C/TZ=UTC, or a Windows FILETIME integer. */
const RESTORE_LOCK_START_RE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}|\d{1,20})$/;
/** Exact names this code gives quarantined locks (see the steal path). */
const RESTORE_QUARANTINE_NAME_RE =
  /^\.openllm-restore\.lock\.stale-\d+-\d+-\d+$/;
const RESTORE_LOCK_OWNER_FILE_RE = /^owner\.json(?:\.\d+\.tmp)?$/;
const RESTORE_LOCK_WAIT_MS = 5_000;
const RESTORE_LOCK_POLL_MS = 50;
const RESTORE_QUARANTINE_PREFIX = `${RESTORE_LOCK_NAME}.stale-`;
/**
 * The identity probe in local-runtime caps its `ps` spawn at 1.5 s; the
 * restore wait is a hard 5 s budget, so each probe gets only the time that
 * remains and never more than this.
 */
const RESTORE_PROBE_MAX_MS = 1_500;
/**
 * A quarantine entry is live for microseconds — a process holding one is mid
 * steal. Anything minutes old is residue from a crash or a repair that lost
 * its race; it is garbage-collected during acquisition.
 */
const RESTORE_QUARANTINE_GC_MS = 10 * 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** PID liveness probe: true = running, false = confirmed dead, null = cannot tell. */
const restoreLockPidAlive = (pid: number): boolean | null => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
};

let spawnForProbe: typeof spawnSync = spawnSync;

/**
 * Test-only: substitute the identity-probe spawn — e.g. to script process
 * start times or to make a probe run to its full timeout.
 */
export const setRestoreLockProbeSpawnForTests = (
  impl: typeof spawnSync | null,
): void => {
  spawnForProbe = impl ?? spawnSync;
};

/**
 * The same `ps lstart` probe as local-runtime's `processStartIdentity`, but
 * with a caller-supplied timeout: the restore wait is a monotonic 5 s budget
 * and a fixed 1.5 s probe could overrun it. `budgetMs <= 0` means no probe —
 * a nearly-spent deadline must not grow the wait.
 */
const boundedProcessStartIdentity = (
  pid: number,
  budgetMs: number,
): string | null | undefined => {
  if (budgetMs <= 0) return undefined;
  // Windows reads identity through non-blocking FFI calls — nothing spawns.
  if (process.platform === "win32") return processStartIdentity(pid);
  const [bin, ...args] = processStartCommand(pid);
  if (bin === undefined) return undefined;
  const result = spawnForProbe(bin, args, {
    encoding: "utf8",
    timeout: Math.max(1, Math.min(RESTORE_PROBE_MAX_MS, Math.floor(budgetMs))),
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  });
  if (result.error) return undefined;
  if (result.status !== 0) {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      if (fsErrorCode(error) === "ESRCH") return null;
      return undefined;
    }
  }
  const value = result.stdout.trim();
  return value || undefined;
};

type TRestoreLockOwner = {
  readonly pid: number;
  /** Process-start identity; null means the acquirer could not probe itself. */
  readonly start: string | null;
};

/** Record who holds the lock: pid PLUS process-start identity, so a pid
 * recycled onto an unrelated process cannot keep the lock alive. The record
 * is published atomically — a temp file inside the lock directory, then
 * rename — so a reader never observes a partial owner.json. */
const writeRestoreLockOwner = (lockPath: string, budgetMs: number): void => {
  let start: string | null = null;
  try {
    start = boundedProcessStartIdentity(process.pid, budgetMs) ?? null;
  } catch {
    start = null;
  }
  const tmp = join(lockPath, `${RESTORE_LOCK_OWNER_NAME}.${process.pid}.tmp`);
  writeFileSync(
    tmp,
    `${JSON.stringify({ kind: RESTORE_LOCK_KIND, pid: process.pid, start })}\n`,
    { mode: 0o600 },
  );
  try {
    renameSync(tmp, join(lockPath, RESTORE_LOCK_OWNER_NAME));
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // a stray temp file is inert — ownership simply stays unpublished
    }
    throw error;
  }
};

const readRestoreLockOwner = (lockPath: string): TRestoreLockOwner | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(lockPath, RESTORE_LOCK_OWNER_NAME), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const owner = parsed as Record<string, unknown>;
    if (owner.kind !== RESTORE_LOCK_KIND) return null;
    if (
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      return null;
    // A start identity must look like one this code wrote (printable, short).
    // Anything else cannot prove PID reuse, so the record is unreadable → held.
    if (owner.start !== undefined && owner.start !== null) {
      if (
        typeof owner.start !== "string" ||
        !RESTORE_LOCK_START_RE.test(owner.start)
      )
        return null;
    }
    return {
      pid: owner.pid,
      start: typeof owner.start === "string" ? owner.start : null,
    };
  } catch {
    return null;
  }
};

type TRestoreLockVerdict = "held" | "stale" | "gone";

type TRestoreLockDiagnosis = {
  readonly verdict: TRestoreLockVerdict;
  /**
   * A "held" verdict with no provable owner: the entry may be orphaned
   * residue only manual cleanup can free, so a waiter that times out reports
   * it with a remediation hint instead of silently failing.
   */
  readonly unproven: boolean;
};

/**
 * A legacy FILE lock written by an older CLI is `<pid> <createdMs>` — the
 * recorded creation time lets a live pid be checked for recycling: a process
 * that started AFTER the lock was written cannot be the process that wrote
 * it, so the recorded owner is dead.
 */
const parseLegacyLockRecord = (
  content: string,
): { readonly pid: number | null; readonly createdMs: number | null } => {
  const [pidText = "", createdText = ""] = content.trim().split(/\s+/, 2);
  const pid = Number.parseInt(pidText, 10);
  const createdMs = Number(createdText);
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    createdMs:
      createdText !== "" && Number.isSafeInteger(createdMs) && createdMs > 0
        ? createdMs
        : null,
  };
};

/**
 * A legacy FILE lock still serializes restores exactly like the lock
 * directory — but it is never declared stale by age. A dead recorded pid is
 * stale; a live pid is compared against the recorded creation time to prove
 * or rule out recycling. When identity cannot be proven — an unreadable or
 * malformed record, a missing creation time, a probe that cannot run — the
 * lock stays held and the waiter reports it for manual cleanup.
 */
const diagnoseLegacyFileLock = (
  lockPath: string,
  budgetMs: number,
): TRestoreLockDiagnosis => {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf8");
  } catch {
    return { verdict: "held", unproven: true };
  }
  const { pid, createdMs } = parseLegacyLockRecord(content);
  if (pid === null) return { verdict: "held", unproven: true };
  const alive = restoreLockPidAlive(pid);
  if (alive === false) return { verdict: "stale", unproven: false };
  if (alive !== true) return { verdict: "held", unproven: true };
  const identity = boundedProcessStartIdentity(pid, budgetMs);
  if (identity === null) return { verdict: "stale", unproven: false };
  if (identity === undefined || createdMs === null)
    return { verdict: "held", unproven: true };
  const startedMs = startIdentityMs(identity);
  if (startedMs === null) return { verdict: "held", unproven: true };
  // The lock's real owner started before it wrote the record, so a live pid
  // holder that began afterwards is a different process — the pid was
  // recycled and the recorded owner is dead.
  return startedMs > createdMs
    ? { verdict: "stale", unproven: false }
    : { verdict: "held", unproven: false };
};

/**
 * Decide whether the entry at `lockPath` still has a live owner. A lock is
 * stale ONLY on proof: a dead owner pid, or a start-time comparison proving
 * the pid was recycled onto another process. Anything unverifiable — an
 * owner record that is missing, malformed, or temporarily unreadable, an
 * identity probe that cannot run, a legacy record without a creation time —
 * stays "held" and is NEVER downgraded by age: a live owner whose record
 * cannot be read must never have its lock stolen on a timer.
 */
const restoreLockDiagnosis = (
  lockPath: string,
  budgetMs: number,
): TRestoreLockDiagnosis => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(lockPath);
  } catch {
    return { verdict: "gone", unproven: false };
  }
  if (!stat.isDirectory()) return diagnoseLegacyFileLock(lockPath, budgetMs);
  const owner = readRestoreLockOwner(lockPath);
  if (owner === null) return { verdict: "held", unproven: true };
  if (owner.start !== null) {
    // Identity-verified: "dead" covers a gone pid AND a live pid whose
    // start time proves the recorded owner is dead (pid reuse).
    const status = processIdentityStatus(owner.pid, owner.start, (pid) =>
      boundedProcessStartIdentity(pid, budgetMs),
    );
    if (status === "dead") return { verdict: "stale", unproven: false };
    return { verdict: "held", unproven: status !== "alive" };
  }
  const alive = restoreLockPidAlive(owner.pid);
  if (alive === false) return { verdict: "stale", unproven: false };
  return { verdict: "held", unproven: alive !== true };
};

let restoreLockStealCounter = 0;

/**
 * Seize a lock judged stale by atomically renaming it to a unique quarantine
 * name — only ONE racing stealer's rename can succeed, because the source
 * vanishes under the loser (ENOENT). The diagnosis is then RE-CHECKED on the
 * seized entry: a lock that became live again in the microseconds between
 * verdict and rename is put back with a NO-REPLACE move, never by rename —
 * a lock path reclaimed by a fresh owner during the repair window must not
 * be overwritten. When the destination now exists (or the move fails) the
 * quarantine entry is left in place for the acquisition-time GC.
 */
const stealRestoreLock = (lockPath: string, budgetMs: number): void => {
  restoreLockStealCounter += 1;
  const quarantine = `${RESTORE_QUARANTINE_PREFIX}${process.pid}-${Date.now()}-${restoreLockStealCounter}`;
  const quarantinePath = join(dirname(lockPath), quarantine);
  try {
    renameSync(lockPath, quarantinePath);
  } catch {
    // The lock vanished or a racing stealer's rename won first.
    return;
  }
  if (restoreLockDiagnosis(quarantinePath, budgetMs).verdict === "stale") {
    try {
      rmSync(quarantinePath, { recursive: true, force: true });
    } catch {
      // a leftover quarantine entry is inert — GC reaps it later
    }
    return;
  }
  try {
    moveNoReplace(quarantinePath, lockPath);
  } catch {
    // A fresh lock claimed the path during the repair window, or the move
    // failed partway: leave the quarantine entry — GC reaps it, and the
    // live lock that won the path is never replaced.
  }
};

/**
 * Best-effort removal of abandoned quarantine entries — left behind when a
 * stealer crashed mid-recovery or a repair found the lock path reclaimed.
 * Only entries older than the GC window are removed: a young entry may
 * belong to a steal in progress. Runs once per acquisition so residue from
 * transient failures or crashes cannot accumulate indefinitely.
 */
const gcRestoreLockQuarantine = (realDir: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(realDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RESTORE_QUARANTINE_GC_MS;
  for (const name of entries) {
    // Only exact names the steal path generates; a user entry that merely
    // shares the prefix is never touched.
    if (!RESTORE_QUARANTINE_NAME_RE.test(name)) continue;
    const entry = join(realDir, name);
    try {
      const st = lstatSync(entry);
      if (st.mtimeMs > cutoff) continue;
      if (st.isDirectory()) {
        // A quarantined lock dir holds nothing but its owner record (or the
        // temp file of an interrupted publish). Any other content → keep.
        const children = readdirSync(entry);
        if (!children.every((c) => RESTORE_LOCK_OWNER_FILE_RE.test(c)))
          continue;
        // Every owner file present (published or interrupted temp) must be a
        // marked record this code wrote; an empty dir holds no data at all.
        const allOurs = children.every((c) => {
          try {
            const parsed: unknown = JSON.parse(
              readFileSync(join(entry, c), "utf8"),
            );
            return (
              parsed !== null &&
              typeof parsed === "object" &&
              (parsed as Record<string, unknown>).kind === RESTORE_LOCK_KIND
            );
          } catch {
            return false;
          }
        });
        if (!allOurs) continue;
      } else if (st.isFile()) {
        // A quarantined legacy file lock: exactly "<pid> <createdMs>".
        if (st.size > 64) continue;
        if (!/^\d+\s+\d+\s*$/.test(readFileSync(entry, "utf8"))) continue;
      } else continue;
      rmSync(entry, { recursive: true, force: true });
    } catch {
      // retried by the next acquirer
    }
  }
};

/**
 * Cross-process restore lock for one vendor dir, claimed by an atomic
 * exclusive mkdir so concurrent `openllm` teardowns serialize. Ownership is
 * the pid + process-start identity inside the lock directory, so a crashed
 * acquirer's recycled pid cannot wedge the lock. Stale locks are recovered
 * by atomically RENAMING the lock aside to a unique quarantine name — only
 * the first stealer's rename can succeed, so two racing restorers can never
 * both believe they reclaimed it — then reclaiming via mkdir. The wait is
 * asynchronous (setTimeout polling bounded by a monotonic RESTORE_LOCK_WAIT_MS
 * deadline — every synchronous identity probe is capped by the time that
 * remains so the bound holds even when a probe is slow), never blocking the
 * CLI event loop longer than needed, and on timeout the caller keeps the run
 * dir rather than touching contested data. Returns a release function, or
 * null when a live process still holds the lock past the wait window.
 */
const acquireRestoreLock = async (
  realDir: string,
): Promise<(() => void) | null> => {
  const lockPath = join(realDir, RESTORE_LOCK_NAME);
  gcRestoreLockQuarantine(realDir);
  const deadline = performance.now() + RESTORE_LOCK_WAIT_MS;
  let unprovenHold = false;
  for (;;) {
    // Every non-acquire path funnels back here, so contention, racing
    // stealers, and flapping stale locks are all bounded by the same window.
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      if (unprovenHold) {
        process.stderr.write(
          `[openllm] restore lock ${lockPath} is held but its owner could not be verified; if no openllm teardown is running, remove it manually and retry\n`,
        );
      }
      return null;
    }
    let verdict: TRestoreLockVerdict | "acquired";
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeRestoreLockOwner(lockPath, remaining);
      } catch (error) {
        // Ownership could not be recorded: do not hold an anonymous lock.
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      verdict = "acquired";
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
      const diagnosis = restoreLockDiagnosis(lockPath, remaining);
      verdict = diagnosis.verdict;
      unprovenHold = verdict === "held" && diagnosis.unproven;
    }
    if (verdict === "acquired") break;
    if (verdict === "gone") {
      unprovenHold = false;
      continue; // vanished mid-check — retry the mkdir
    }
    if (verdict === "stale") {
      unprovenHold = false;
      stealRestoreLock(lockPath, deadline - performance.now());
      continue;
    }
    const waitMs = Math.min(RESTORE_LOCK_POLL_MS, deadline - performance.now());
    if (waitMs > 0) await sleep(waitMs);
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // stale-owner recovery already removed it
    }
  };
};

type TRestoreState = {
  readonly problems: string[];
  readonly skipped: string[];
};

/**
 * Make `dest` a real directory: create it exclusively, or — when the name is
 * held by a file or symlink — move that entry aside first.
 */
const ensureRealDir = (dest: string, stamp: string): void => {
  for (;;) {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(dest);
    } catch {
      stat = undefined;
    }
    if (stat === undefined) {
      try {
        mkdirSync(dest, { mode: 0o700 });
        return;
      } catch (error) {
        if (fsErrorCode(error) !== "EEXIST") throw error;
        continue; // a concurrent create won — re-inspect
      }
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) return;
    moveEntryAside(dest, dest, stamp);
  }
};

/**
 * Move a non-directory run-dir entry back. An existing destination keeps
 * BOTH versions — the newer entry takes the real name and the loser is
 * preserved under the conflict suffix.
 */
const restoreLeaf = (src: string, dest: string, stamp: string): void => {
  try {
    moveNoReplace(src, dest);
    return;
  } catch (error) {
    if (fsErrorCode(error) !== "EEXIST") throw error;
  }
  if (newestMtimeMs(src) >= newestMtimeMs(dest)) {
    // The run-dir copy is newer (e.g. a token the vendor rotated by
    // temp+rename): it takes the real name and the older real entry is
    // preserved under the conflict suffix.
    moveEntryAside(dest, dest, stamp);
    moveNoReplace(src, dest);
  } else {
    // The real entry is newer: keep it and park the run copy beside it.
    moveEntryAside(src, dest, stamp);
  }
};

/**
 * Move one run-dir entry into the real config dir without ever losing data.
 * Plan-owned paths are deleted (they die with the overlay, never landing in
 * the user's real dir); symlinks are skipped and reported at ANY depth so
 * an `escape -> /outside` link inside a vendor-created tree can never be
 * moved into the real config dir; real directories always merge
 * child-by-child so a failed child never deletes its siblings.
 */
const restoreEntry = (
  src: string,
  dest: string,
  rel: string,
  stamp: string,
  state: TRestoreState,
  ownedPaths: ReadonlySet<string>,
): void => {
  if (ownedPaths.has(rel)) {
    rmSync(src, { recursive: true, force: true });
    return;
  }
  try {
    const srcStat = lstatSync(src);
    if (srcStat.isSymbolicLink()) {
      state.skipped.push(rel);
      return;
    }
    if (srcStat.isDirectory()) {
      ensureRealDir(dest, stamp);
      for (const child of readdirSync(src)) {
        restoreEntry(
          join(src, child),
          join(dest, child),
          `${rel}/${child}`,
          stamp,
          state,
          ownedPaths,
        );
      }
      // Remove the source only once every child is gone: a failed move or a
      // skipped symlink keeps the tree — and its data — in the run dir.
      try {
        rmdirSync(src);
      } catch {
        // unrestored children remain
      }
      return;
    }
    restoreLeaf(src, dest, stamp);
  } catch (error) {
    state.problems.push(
      `${rel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export type TRestoreOutcome = {
  /**
   * True only when every non-owned, non-mirror entry left the run dir. On
   * false the run dir MUST be kept — deleting it would lose vendor data.
   */
  readonly ok: boolean;
  /** Top-level entries handed back to the real dir. */
  readonly moved: readonly string[];
  /** Entries never restored because they are symlinks. */
  readonly skipped: readonly string[];
  /** Entries that failed to move, with the reason. */
  readonly problems: readonly string[];
};

/**
 * FS-3: hand the vendor's in-session writes back to the real config dir.
 *
 * The run dir mirrors the vendor home through symlinks of the entries that
 * existed at launch, so anything the client creates during the session — a
 * first `sessions/`/`memories/` tree, a refreshed token written by
 * temp+rename — becomes a REAL file that would die with `rmSync(runDir)`.
 * Under a cross-process lock, move every non-symlink, non-plan-owned
 * top-level entry back into the real dir with no-replace semantics.
 * Conflicts keep both versions; `ok` in the outcome says whether the run
 * dir may be deleted without losing data.
 */
export const restoreMirrorEntries = async (
  realDir: string,
  runDir: string,
  ownedPaths: ReadonlySet<string> | readonly string[],
): Promise<TRestoreOutcome> => {
  const owned = ownedPaths instanceof Set ? ownedPaths : new Set(ownedPaths);
  mkdirSync(realDir, { recursive: true, mode: 0o700 });
  const stamp = `${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}-${process.pid}`;
  const moved: string[] = [];
  const state: TRestoreState = { problems: [], skipped: [] };
  let release: (() => void) | null;
  try {
    release = await acquireRestoreLock(realDir);
  } catch (error) {
    release = null;
    state.problems.push(
      `restore lock ${join(realDir, RESTORE_LOCK_NAME)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (release === null) {
    if (state.problems.length === 0) {
      state.problems.push(
        `restore lock ${join(realDir, RESTORE_LOCK_NAME)} is held by another process`,
      );
    }
  } else {
    try {
      for (const entry of readdirSync(runDir)) {
        const src = join(runDir, entry);
        try {
          if (lstatSync(src).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        restoreEntry(src, join(realDir, entry), entry, stamp, state, owned);
        if (!owned.has(entry) && !entryExists(src)) moved.push(entry);
      }
    } finally {
      release();
    }
  }
  // Any real (non-owned, non-mirror) entry still in the run dir was not
  // fully persisted — deleting the run dir would lose it, whatever the
  // reason it stayed behind.
  let unrestored = false;
  let entries: readonly string[] = [];
  try {
    entries = readdirSync(runDir);
  } catch {
    unrestored = true;
    state.problems.push(`${runDir}: run dir could not be re-read`);
  }
  for (const entry of entries) {
    if (owned.has(entry)) continue;
    const src = join(runDir, entry);
    try {
      if (lstatSync(src).isSymbolicLink()) continue;
    } catch {
      // Cannot classify the entry, so it cannot be proven persisted.
      if (entryExists(src)) unrestored = true;
      continue;
    }
    unrestored = true;
    const explained =
      state.skipped.some(
        (rel) => rel === entry || rel.startsWith(`${entry}/`),
      ) ||
      state.problems.some(
        (rel) =>
          rel === entry ||
          rel.startsWith(`${entry}/`) ||
          rel.startsWith(`${entry}:`),
      );
    if (!explained) {
      state.problems.push(`${entry}: could not be fully restored`);
    }
  }
  const ok = !unrestored && state.problems.length === 0;
  if (moved.length > 0) {
    process.stderr.write(
      `[openllm] preserved ${moved.length} entr${moved.length === 1 ? "y" : "ies"} the client created: ${moved.join(", ")} → ${realDir}\n`,
    );
  }
  for (const rel of state.skipped) {
    process.stderr.write(`[openllm] left symlink unrestored: ${rel}\n`);
  }
  for (const problem of state.problems) {
    process.stderr.write(`[openllm] could not preserve ${problem}\n`);
  }
  if (!ok) {
    process.stderr.write(
      `[openllm] kept the session run dir so nothing is lost: ${runDir}\n`,
    );
  }
  return {
    ok,
    moved,
    skipped: state.skipped,
    problems: state.problems,
  };
};

/** The user's existing config text for a client, when readable. */
const readUserConfig = (client: TClient): string | undefined => {
  const paths: Partial<Record<string, string>> = {
    grok: join(userHome(), ".grok", "config.toml"),
    hermes: hermesProfileConfigPath(),
    opencode: join(
      process.env.XDG_CONFIG_HOME ?? join(userHome(), ".config"),
      "opencode",
      "opencode.json",
    ),
  };
  const path = paths[client.id];
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

/** The gate is ordered: device children bypass first; every later false selects direct launch. */
export const brokerEligible = (args: {
  readonly client: TClient;
  readonly userArgs: readonly string[];
  readonly flags: TClientFlags;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly platform: NodeJS.Platform;
  readonly deviceSessionId?: string;
}): boolean => {
  if (
    args.deviceSessionId !== undefined &&
    args.deviceSessionId.trim().length > 0
  )
    return false;
  if (args.flags.remote) return false;
  // A bare launch is an internal one-shot (doctor's summarizer): the durable
  // session host and attach discovery know nothing of `bare`, so brokering it
  // would start Claude with the normal MCP overlay. Direct launch only.
  if (args.flags.bare) return false;
  if (!args.stdinIsTty || !args.stdoutIsTty) return false;
  if (!sessionHostSupported(args.platform)) return false;
  return !args.client.nonInteractiveMarkers?.some((marker) =>
    args.userArgs.includes(marker),
  );
};

/** Remove the one optional argv disambiguator before handing args to a vendor or broker. */
export const forwardedVendorArgs = (
  userArgs: readonly string[],
): readonly string[] =>
  userArgs[0] === "--" ? userArgs.slice(1) : userArgs.slice(0);

/**
 * Run a session client: interactive local sessions get a detached durable host;
 * all other invocations retain the direct, inherited-stdio launch contract.
 */
const launchDurableSessionHost = async (args: {
  readonly client: TClient;
  readonly forwarded: readonly string[];
  readonly dangerous: boolean;
}): Promise<number | null> => {
  const cli = args.client.daemonCli;
  if (cli === undefined) return null;
  const binary = await findCompatibleDaemonBinary();
  if (binary === null) return null;
  const id = crypto.randomUUID();
  const terminalCols = process.stdout.columns ?? 80;
  const terminalRows = process.stdout.rows ?? 24;
  const argv = sessionHostSpawnArgv({
    id,
    cli,
    cols: terminalCols,
    rows: terminalRows,
    cwd: process.cwd(),
    title: basename(process.cwd()),
    dangerous: args.dangerous,
    vendorArgs: args.forwarded,
  });
  if (argv === null) return null;
  const spawned = spawnSessionHost({ binary, argv });
  if (spawned === null) return null;
  const socketPath = await waitForSessionHostSocket(id);
  if (socketPath === null) {
    // The host may still be starting. Reap it so the direct-launch fallback
    // does not leave a second vendor PTY on the same cwd.
    try {
      spawned.kill();
    } catch {
      // best-effort
    }
    return null;
  }
  const result = await attachBrokerSession({
    target: socketPath,
    open: {
      session_id: id,
      cli,
      cols: terminalCols,
      rows: terminalRows,
      mode: "attach",
    },
    announce: true,
  });
  if (result.kind === "completed") return result.code;
  try {
    spawned.kill();
  } catch {
    // best-effort
  }
  return null;
};

/**
 * Attach this terminal to an ALREADY-RUNNING durable session. Returns the exit
 * code, or null when the host went away between discovery and dial (raced
 * teardown) so the caller can fall through to starting a fresh session.
 */
const attachRunningSession = async (
  session: TLiveSessionHost,
): Promise<number | null> => {
  const result = await attachBrokerSession({
    target: session.socketPath,
    open: {
      session_id: session.id,
      cli: session.cli,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      mode: "attach",
    },
    announce: true,
  });
  return result.kind === "completed" ? result.code : null;
};

/**
 * Read one line from the terminal. Deliberately hand-rolled rather than
 * `node:readline`: this runs microseconds before `attachBrokerSession` takes
 * stdin into raw mode, and readline's interface leaves listeners and mode
 * changes behind that the attach path would then have to undo. Here stdin is
 * returned to exactly the state it was found in.
 */
const readLine = async (): Promise<string> =>
  new Promise<string>((resolve) => {
    const stdin = process.stdin;
    let buffer = "";
    const finish = (value: string): void => {
      stdin.off("data", onData);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // Ctrl-C / Ctrl-D at the prompt: decline the offer, start fresh.
        if (byte === 0x03 || byte === 0x04) {
          process.stdout.write("\n");
          finish("n");
          return;
        }
        if (byte === 0x0a || byte === 0x0d) {
          process.stdout.write("\n");
          finish(buffer);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 0x20) continue;
        const char = String.fromCharCode(byte);
        buffer += char;
        process.stdout.write(char);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  }).then((value) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    return value;
  });

/**
 * Offer the sessions already running on this machine for this client.
 *
 * Refuses an explicit missing attach selector, returns a session to attach to,
 * or selects a new launch. Re-prompts on unusable input rather than guessing —
 * attaching to the wrong session drops the user into someone else's directory.
 *
 * Exported for tests; the launch path is `runSessionClient`.
 */
export const chooseRunningSession = async (args: {
  readonly client: TClient;
  readonly cli: TDaemonCli;
  readonly flags: TClientFlags;
  readonly vendorArgs: readonly string[];
  /** Test seam: the process-start probe passed to session-host discovery. */
  readonly readIdentity?: TProcessStartIdentityReader;
}): Promise<
  | { readonly kind: "attach"; readonly session: TLiveSessionHost }
  | { readonly kind: "new" }
  | { readonly kind: "refused" }
> => {
  const discovery = discoverSessionHosts(args.readIdentity);
  // `--new` bypasses the unknown-identity refusal: discovery already ran (so
  // stale directories were reaped), and a dir that cannot be verified must
  // never lock the explicit "start fresh" escape hatch out.
  if (args.flags.fresh) return { kind: "new" };
  if (hasUnknownSessionHost(discovery, args.cli)) {
    const blocked = discovery.unknown.filter(
      (entry) => entry.cli === null || entry.cli === args.cli,
    );
    process.stderr.write(
      "[openllm] a session host could not be verified; refusing to start a duplicate session\n" +
        blocked.map((entry) => `  ${entry.directory}\n`).join("") +
        "  remove a stale directory by hand, or re-run with --new to start anyway\n",
    );
    return { kind: "refused" };
  }
  // Client arguments describe a NEW invocation (`--resume x`, a prompt, a
  // model). An attach reaches an already-running process that can never receive
  // them, so silently swallowing them would be worse than not offering.
  // `--attach` is an explicit override and still wins.
  if (args.vendorArgs.length > 0 && args.flags.attach === null)
    return { kind: "new" };
  const choices = buildSessionChoices(discovery.hosts, args.cli, process.cwd());
  if (choices.length === 0) {
    if (args.flags.attach !== null && args.flags.attach.length > 0) {
      process.stderr.write(
        `[openllm] --attach ${args.flags.attach} is not a running session\n`,
      );
      return { kind: "refused" };
    }
    return args.flags.attach === null ? { kind: "new" } : { kind: "refused" };
  }

  if (args.flags.attach !== null) {
    // Bare `--attach` (no id) still means "join something" — prefer the
    // same-cwd session when one exists, otherwise the first listed row.
    // Interactive Enter defaults to NEW; only the explicit flag auto-attaches.
    if (args.flags.attach.length === 0) {
      const preferred = choices.find((choice) => choice.sameCwd) ?? choices[0];
      return preferred === undefined
        ? { kind: "refused" }
        : { kind: "attach", session: preferred.session };
    }
    const resolved = resolveExplicitSession(
      choices.map((choice) => choice.session),
      args.flags.attach,
    );
    if (resolved.kind === "refused") {
      process.stderr.write(
        `[openllm] --attach ${args.flags.attach} is ${resolved.reason === "missing" ? "not a running session" : "ambiguous"}\n`,
      );
      return resolved;
    }
    return resolved;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    process.stdout.write(
      `\n${formatSessionPrompt(choices, {
        clientName: args.client.name,
        nowMs: Date.now(),
        ...(process.env.HOME === undefined ? {} : { home: process.env.HOME }),
      })}`,
    );
    const pick = resolvePick(await readLine(), choices);
    if (pick.kind === "attach")
      return { kind: "attach", session: pick.session };
    if (pick.kind === "new") return { kind: "new" };
    process.stdout.write(
      "[openllm] pick a listed number, or n for a new session\n",
    );
  }
  return { kind: "new" };
};

/**
 * Run a session client: interactive local sessions get a detached durable host;
 * all other invocations retain the direct, inherited-stdio launch contract.
 */
export const runSessionClient = async (
  client: TClient,
  userArgs: readonly string[],
  flags: TClientFlags,
): Promise<number> => {
  // `-d` must fail loudly on a client with no equivalent: silently launching
  // WITH approval prompts after the user asked to skip them is the wrong
  // surprise.
  if (flags.dangerous && client.dangerousFlag === undefined) {
    process.stderr.write(
      `${client.name} has no skip-approvals flag, so -d does not apply.\n`,
    );
    return 2;
  }
  const credential = requireCliApiKey("human");
  if (!credential.ok) {
    process.stderr.write(credential.message);
    return 1;
  }
  const gateway = await resolveGateway({
    remote: flags.remote,
    config: credential.config,
  });

  const forwarded = forwardedVendorArgs(userArgs);
  // Durable local sessions do not need a running daemon. An explicit cloud
  // selection still means direct launch, preserving the existing `-r` and
  // OPENLLM_GATEWAY=cloud semantics.
  if (
    process.env.OPENLLM_GATEWAY !== "cloud" &&
    brokerEligible({
      client,
      userArgs: forwarded,
      flags,
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      platform: process.platform,
      deviceSessionId: process.env.OPENLLM_DEVICE_SESSION_ID,
    })
  ) {
    // Sessions already running on this machine — started here OR by the
    // browser, since both origins publish to the same filesystem registry —
    // are offered before a new one is spawned. Attaching joins the live PTY
    // alongside any existing viewer; no vendor `--resume` is involved.
    const cli = client.daemonCli;
    if (cli !== undefined) {
      const selection = await chooseRunningSession({
        client,
        cli,
        flags,
        vendorArgs: forwarded,
      });
      if (selection.kind === "refused") return 1;
      if (selection.kind === "attach") {
        const code = await attachRunningSession(selection.session);
        if (code !== null) return code;
        const hostStatus = sessionHostProcessStatus(selection.session);
        if (
          !shouldStartFreshAfterAttachFailure({
            explicitAttach: flags.attach !== null,
            hostStillAlive: hostStatus !== "dead",
          })
        ) {
          process.stderr.write(
            hostStatus === "unknown"
              ? `[openllm] could not verify ${selection.session.id}; refusing to start a duplicate session\n`
              : `[openllm] could not attach to ${selection.session.id}; the existing session is still running\n`,
          );
          return 1;
        }
        process.stderr.write(
          "[openllm] that session went away — starting a new one\n",
        );
      }
    }
    const code = await launchDurableSessionHost({
      client,
      forwarded,
      dangerous: flags.dangerous,
    });
    if (code !== null) return code;
  }

  const bin = findClientBinary(client);
  if (bin === null) {
    process.stderr.write(
      `${client.name} is not installed. Install it first:\n  ${client.installHint}\n\n` +
        `OpenLLM does not install third-party CLIs for you.\n`,
    );
    return 127;
  }

  // Catalog + tier are independent gateway reads — fetch them together. Tier
  // gates the code-search MCP group (free tier drops it); both fail open.
  const [catalog, tier] = await Promise.all([
    client.catalogSlug === undefined
      ? Promise.resolve(null)
      : fetchModelCatalog(gateway, client.catalogSlug),
    fetchTier(gateway),
  ]);

  const runDir = createRunDir(client.id);
  let code = 1;
  let plan: TLaunchPlan | undefined;
  try {
    plan = buildLaunchPlan({
      client,
      apiBase: gateway.base,
      cloudOrigin: gateway.cloudOrigin,
      apiKey: gateway.apiKey,
      // `OPENLLM_BIN` bakes this into wrapped-client MCP `command` entries. Run
      // from a compiled binary, `process.execPath` IS `openllm` — correct. Run
      // from source (dev: the daemon spawns us via a shim that execs
      // `bun main.ts`), `process.execPath` is `bun`, which would make those MCP
      // entries launch bun with no script. The daemon carries the shim path in
      // `OPENLLM_BIN_OVERRIDE` so MCP resolves to a real runnable `openllm`.
      binPath:
        process.env.OPENLLM_BIN_OVERRIDE !== undefined &&
        process.env.OPENLLM_BIN_OVERRIDE.length > 0
          ? process.env.OPENLLM_BIN_OVERRIDE
          : process.execPath,
      runDir,
      stateDir: contextStateDir(),
      userConfig: readUserConfig(client),
      catalog: catalog ?? undefined,
      tier,
      bare: flags.bare,
    });
    materialize(plan, runDir);
    const tuiDir =
      client.id === "hermes" ? hermesBundledTuiDir(bin) : undefined;
    // First-party children (the openllm MCP server, hook scripts) inherit the
    // daemon's per-boot local caller token so they authenticate to the
    // loopback `/v1/*` surface without re-reading the token file. Cloud-bound
    // children keep the `sk-llm` key; the token never leaves the machine.
    const env = {
      ...plan.env,
      ...(tuiDir === undefined ? {} : { HERMES_TUI_DIR: tuiDir }),
      ...(gateway.localToken === null
        ? {}
        : { OPENLLM_LOCAL_TOKEN: gateway.localToken }),
    };

    // `-d` becomes the client's OWN flag, ahead of the user's args so their
    // explicit choices still win on anything that conflicts.
    const dangerous =
      flags.dangerous && client.dangerousFlag !== undefined
        ? [client.dangerousFlag]
        : [];

    // Index this process for the daemon's local-session list / attach path.
    // Device PTYs set OPENLLM_DEVICE_SESSION_ID so host=device + openllm id
    // land here; local interactive launches stay host=local.
    writeLiveJson(
      runDir,
      buildLiveJson({
        clientId: client.id,
        cwd: process.cwd(),
        dangerous: flags.dangerous,
        userArgs: forwarded,
      }),
    );

    code = await execClient(
      bin,
      [...plan.args, ...dangerous, ...forwarded],
      env,
      plan.unsetEnv,
    );
  } finally {
    // FS-3: before the run dir dies, move the vendor's in-session writes
    // (non-symlink, non-plan-owned entries) back into the real config dir.
    // The run dir is deleted ONLY when every non-owned entry was persisted —
    // a failed or partial restore keeps the dir (and its data) and surfaces
    // a non-zero exit so the loss can never pass silently.
    if (plan?.mirrorDir !== undefined) {
      try {
        const outcome = await restoreMirrorEntries(
          expandHome(plan.mirrorDir),
          runDir,
          planOwnedPaths(plan),
        );
        if (outcome.ok) {
          rmSync(runDir, { recursive: true, force: true });
        } else if (code === 0) {
          code = 1;
        }
      } catch (error) {
        process.stderr.write(
          `[openllm] could not preserve session files from ${runDir}: ${
            error instanceof Error ? error.message : String(error)
          }\n  run dir kept: ${runDir}\n`,
        );
        if (code === 0) code = 1;
      }
    } else {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
  return code;
};

/**
 * Build the child environment as inherited env minus explicit removes, then
 * overlayed with plan-specific env. The overlay always wins: an unset name is
 * removed only when the plan does not explicitly set it.
 */
export const mergeSessionEnv = (
  inherited: NodeJS.ProcessEnv,
  env: Readonly<Record<string, string>>,
  unsetEnv: readonly string[] = [],
): NodeJS.ProcessEnv => {
  const remove = new Set(unsetEnv);
  const output = {} as NodeJS.ProcessEnv;

  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) {
      continue;
    }
    if (remove.has(name) && !Object.hasOwn(env, name)) {
      continue;
    }
    output[name] = value;
  }

  for (const [name, value] of Object.entries(env)) {
    output[name] = value;
  }

  return output;
};

/**
 * Spawn the client with inherited stdio (so it owns the TTY) and forward
 * signals, resolving to the exit code the child produced. A signal-terminated
 * child maps to the conventional 128+signo so shell callers see the same thing
 * they would from a direct invocation.
 */
export const execClient = (
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  unsetEnv: readonly string[] = [],
): Promise<number> =>
  new Promise((resolve) => {
    // cross-spawn quotes cmd/bat launchers without interpolating caller args.
    // PowerShell files retain the host's execution policy (no bypass).
    const powershell = process.platform === "win32" && /\.ps1$/i.test(bin);
    // Global npm shims also re-parse %*. cross-spawn only double-escapes
    // node_modules/.bin shims, so explicitly cover global cmd/bat launchers.
    const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const batchCommand = batch
      ? '"' +
        [
          escapeCommand.command(bin),
          ...args.map((arg) => escapeCommand.argument(arg, true)),
        ].join(" ") +
        '"'
      : "";
    const command = batch
      ? (process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe")
      : powershell
        ? "powershell.exe"
        : bin;
    const childArgs = batch
      ? ["/d", "/s", "/c", batchCommand]
      : powershell
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", bin, ...args]
        : [...args];
    const options: SpawnOptions = {
      ...(batch ? { windowsVerbatimArguments: true } : {}),
      stdio: "inherit",
      env: mergeSessionEnv(process.env, env, unsetEnv),
    };
    const child =
      batch || process.platform !== "win32"
        ? spawn(command, childArgs, options)
        : spawnCrossPlatform(command, childArgs, options);
    const forward = (signal: NodeJS.Signals) => (): void => {
      // Let the child decide how to die; our own exit follows its code.
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };
    const sigint = forward("SIGINT");
    const sigterm = forward("SIGTERM");
    const sighup = forward("SIGHUP");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    process.on("SIGHUP", sighup);
    const cleanup = (): void => {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      process.off("SIGHUP", sighup);
    };
    child.on("error", (err) => {
      cleanup();
      process.stderr.write(`failed to launch ${bin}: ${err.message}\n`);
      resolve(127);
    });
    child.on("exit", (exitCode, signal) => {
      cleanup();
      if (signal !== null) {
        // Shell convention for a signal-terminated child. Use Node's own signal
        // table rather than a hand-rolled map so every signal maps correctly.
        const signo: number = osConstants.signals[signal] ?? 0;
        resolve(128 + signo);
        return;
      }
      resolve(exitCode ?? 0);
    });
  });
