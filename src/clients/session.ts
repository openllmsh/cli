import { v3DirLockCodec } from "../../../tunnel/session/dir-lock-v3";
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
import { randomBytes } from "node:crypto";
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  executableCandidates,
  executablePathDirs,
} from "@openllmsh/protocol/executable-paths";
import crossSpawnModule from "cross-spawn";
import cmdEscapeModule from "cross-spawn/lib/util/escape.js";
import {
  acquireDirLock,
  type TDirLockCodec,
  type TDirLockOptions,
  type TDirLockOwner,
} from "../../../tunnel/session/dir-lock";
import type { TProcessStartIdentityReader } from "../../../tunnel/session/local-runtime";
import {
  legacyProcessStartIdentity,
  processIdentityStatus,
  processStartCommand,
  processStartIdentity,
  sessionHostSupported,
} from "../../../tunnel/session/local-runtime";
import { findCompatibleDaemonBinary } from "../daemon-delegation";
import { openllmDir, userHome } from "../env";
import { requireCliApiKey } from "../onboarding";
import type { TLiveSessionHost } from "../session-host";
import {
  discoverSessionHosts,
  hasUnknownSessionHost,
  killSpawnedSessionHost,
  SESSION_HOST_SOCKET_WAIT_MS,
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
import { requireProviderRouting } from "./provider-preflight";
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
 * Run-dir self-description (SH-1/TD-6/FSS-06). Written at materialize time so
 * a LATER launch's stale-run reaper can restore a crashed run's vendor data
 * before deleting anything. `ownedPaths` is the exact plan-owned set the
 * live teardown uses; `mirrorDir` is the restore target (null for clients
 * whose vendor home is not redirected into the run dir).
 */
const RUN_MANIFEST_NAME = "openllm-run.json";
const RUN_MANIFEST_KIND = "openllm-run/v1";
/**
 * Proof a dead run dir's contents were persisted to the real config dir.
 * The reaper deletes ONLY dirs carrying this marker (or dirs it just
 * restored successfully itself) — a failed restore keeps the dir, so the
 * next launch tries again instead of losing the data (SH-1). The marker is
 * BINDING, not just present: its content must equal the run's manifest
 * `nonce`, so a vendor file that happens to carry the same name never
 * authorizes a deletion (codex P2 — a bare `openllm-restored-ok` file used
 * to be enough). Only the restore code below ever writes it.
 */
const RUN_RESTORED_OK_NAME = "openllm-restored-ok";
const RUN_MANIFEST_NONCE_RE = /^[0-9a-f]{32}$/;

type TRunManifest = {
  readonly clientId: string;
  readonly pid: number;
  readonly mirrorDir: string | null;
  readonly ownedPaths: readonly string[];
  /**
   * Per-run unguessable token minted at materialize time. The restored-ok
   * marker is honored only when its content equals this nonce — a marker
   * without a manifest nonce (pre-nonce builds, or a forged file) is not
   * proof of anything and the dir goes through a real restore instead.
   */
  readonly nonce: string | null;
};

const readRunManifest = (runDir: string): TRunManifest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(runDir, RUN_MANIFEST_NAME), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const m = parsed as Record<string, unknown>;
  if (m.kind !== RUN_MANIFEST_KIND) return null;
  if (
    typeof m.clientId !== "string" ||
    m.clientId.length === 0 ||
    !Number.isSafeInteger(m.pid) ||
    (m.pid as number) <= 0 ||
    (m.mirrorDir !== null && typeof m.mirrorDir !== "string") ||
    !Array.isArray(m.ownedPaths) ||
    !m.ownedPaths.every((p) => typeof p === "string")
  )
    return null;
  return {
    clientId: m.clientId,
    pid: m.pid as number,
    mirrorDir: typeof m.mirrorDir === "string" ? m.mirrorDir : null,
    ownedPaths: m.ownedPaths as string[],
    nonce:
      typeof m.nonce === "string" && RUN_MANIFEST_NONCE_RE.test(m.nonce)
        ? m.nonce
        : null,
  };
};

/** Write the manifest LAST so it describes the final owned-paths set. */
const writeRunManifest = (
  runDir: string,
  clientId: string,
  plan: TLaunchPlan,
): void => {
  const manifest: TRunManifest = {
    clientId,
    pid: process.pid,
    mirrorDir: plan.mirrorDir === undefined ? null : expandHome(plan.mirrorDir),
    ownedPaths: [...planOwnedPaths(plan)],
    nonce: randomBytes(16).toString("hex"),
  };
  writeFileSync(
    join(runDir, RUN_MANIFEST_NAME),
    `${JSON.stringify(manifest)}\n`,
    { mode: 0o600 },
  );
};

/**
 * True when every entry in the run dir is disposable: plan-owned at any
 * depth, or a symlink (whose TARGET lives outside the run dir, so the link
 * itself holds no data). Anything else is unrestored vendor data and the
 * dir must be kept.
 */
const runDirOnlyDisposable = (
  dir: string,
  entries: readonly string[],
  owned: ReadonlySet<string>,
): boolean => {
  const onlyOwned = (abs: string, rel: string): boolean => {
    if (owned.has(rel)) return true;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      return true; // vanished mid-check — nothing left to preserve
    }
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return false;
    let children: string[];
    try {
      children = readdirSync(abs);
    } catch {
      return false; // unreadable dir — cannot prove it empty of data
    }
    return children.every((child) =>
      onlyOwned(join(abs, child), `${rel}/${child}`),
    );
  };
  return entries.every((entry) => onlyOwned(join(dir, entry), entry));
};

/**
 * The restored-ok marker is honored only when it was written by THIS run's
 * own restore: its content must equal the manifest nonce. A vendor file
 * named `openllm-restored-ok` (or a marker left by a build that did not
 * bind it to the run) fails this check and falls through to a real
 * restore. A non-regular or oversized marker is never trusted.
 */
const restoredMarkerMatches = (dir: string, nonce: string): boolean => {
  const markerPath = join(dir, RUN_RESTORED_OK_NAME);
  try {
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.size > 64) return false;
    return readFileSync(markerPath, "utf8").trim() === nonce;
  } catch {
    return false;
  }
};

/**
 * Per-run-dir restore bookkeeping, persisted NEXT to the dir as
 * `.openllm-restore-state-<name>.json` so a restore can never move it into
 * the user's real config dir and a crash mid-restore cannot lose the
 * count. This is also the doctor-visible record: it says why a dead run
 * dir still exists and what was tried. The file dies with its dir (the
 * reaper removes it on delete and renames it on `kept-*` quarantine).
 */
const RUN_RESTORE_STATE_PREFIX = ".openllm-restore-state-";
const RUN_RESTORE_STATE_SUFFIX = ".json";
const RUN_RESTORE_STATE_KIND = "openllm-restore-state/v1";
const RUN_RESTORE_STATE_RE = /^\.openllm-restore-state-(.+)\.json$/;

/** Defaults: a few spread-out retries, then the dir is left for manual
 *  recovery. Env overrides exist for operators and deterministic tests. */
const RUN_RESTORE_MAX_ATTEMPTS = 5;
const RUN_RESTORE_BACKOFF_BASE_MS = 60_000;
const RUN_RESTORE_BACKOFF_CAP_MS = 6 * 3_600_000;
/** Restore work (lock + moves) is the expensive part of a launch pass; cap
 *  how many dirs get one per launch so N permanently-failing runs cannot
 *  stall startup without bound. */
const REAP_MAX_RESTORES_PER_PASS = 8;

/** A manifest-less dead run dir is kept only this long for manual recovery —
 *  past the bound, retention is unbounded growth for a dir nothing can
 *  restore. */
const RUN_MANIFESTLESS_KEEP_MS = 7 * 24 * 60 * 60 * 1_000;

const envBoundedInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : fallback;
};

const runRestoreMaxAttempts = (): number =>
  Math.max(
    1,
    envBoundedInt("OPENLLM_RUN_RESTORE_MAX_ATTEMPTS", RUN_RESTORE_MAX_ATTEMPTS),
  );

const runRestoreBackoffMs = (attempts: number): number => {
  const base = envBoundedInt(
    "OPENLLM_RUN_RESTORE_BACKOFF_MS",
    RUN_RESTORE_BACKOFF_BASE_MS,
  );
  return Math.min(
    base * 2 ** Math.max(0, attempts - 1),
    RUN_RESTORE_BACKOFF_CAP_MS,
  );
};

const reapMaxRestoresPerPass = (): number =>
  Math.max(
    1,
    envBoundedInt("OPENLLM_RUN_REAP_MAX_RESTORES", REAP_MAX_RESTORES_PER_PASS),
  );

const runManifestlessKeepMs = (): number =>
  envBoundedInt("OPENLLM_RUN_MANIFESTLESS_KEEP_MS", RUN_MANIFESTLESS_KEEP_MS);

type TRestoreStateRecord = {
  readonly attempts: number;
  readonly firstFailedAt: string | null;
  readonly lastFailedAt: string | null;
  readonly lastFailedAtMs: number | null;
  readonly lastError: string | null;
  readonly suspended: boolean;
  readonly reason: string | null;
};

const restoreStatePath = (clientRoot: string, dirName: string): string =>
  join(
    clientRoot,
    `${RUN_RESTORE_STATE_PREFIX}${dirName}${RUN_RESTORE_STATE_SUFFIX}`,
  );

const readRestoreState = (path: string): TRestoreStateRecord | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (r.kind !== RUN_RESTORE_STATE_KIND) return null;
    if (!Number.isSafeInteger(r.attempts) || (r.attempts as number) < 0)
      return null;
    return {
      attempts: r.attempts as number,
      firstFailedAt:
        typeof r.firstFailedAt === "string" ? r.firstFailedAt : null,
      lastFailedAt: typeof r.lastFailedAt === "string" ? r.lastFailedAt : null,
      lastFailedAtMs:
        typeof r.lastFailedAtMs === "number" &&
        Number.isFinite(r.lastFailedAtMs)
          ? r.lastFailedAtMs
          : null,
      lastError: typeof r.lastError === "string" ? r.lastError : null,
      suspended: r.suspended === true,
      reason: typeof r.reason === "string" ? r.reason : null,
    };
  } catch {
    return null;
  }
};

/** Write the record atomically (tmp + rename) so a crash cannot tear it. */
const writeRestoreState = (path: string, record: TRestoreStateRecord): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ kind: RUN_RESTORE_STATE_KIND, ...record })}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
  }
};

const removeRestoreState = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
};

type TReapOutcome = {
  /** The dir is gone (deleted, or never readable). */
  readonly gone: boolean;
  /** A real restore attempt ran — counts against the per-pass budget. */
  readonly attempted: boolean;
};

const REAP_GONE: TReapOutcome = { gone: true, attempted: false };
const REAP_KEPT: TReapOutcome = { gone: false, attempted: false };
const REAP_ATTEMPTED: TReapOutcome = { gone: false, attempted: true };
const REAP_RESTORED: TReapOutcome = { gone: true, attempted: true };

/**
 * Mark a run dir's restore permanently suspended: the record (kept beside
 * the dir) is the doctor-visible explanation, and a stderr note names the
 * recovery path. The dir itself is retained — data is never deleted on a
 * failure path (SH-1).
 */
const suspendStaleRunDir = (
  clientRoot: string,
  name: string,
  record: TRestoreStateRecord,
): void => {
  writeRestoreState(restoreStatePath(clientRoot, name), {
    ...record,
    suspended: true,
    reason: `restore failed ${record.attempts} times; kept for manual recovery`,
  });
  process.stderr.write(
    `[openllm] restore of ${join(clientRoot, name)} failed ${record.attempts} times; ` +
      `kept for manual recovery (see ${restoreStatePath(clientRoot, name)})\n`,
  );
};

/**
 * Reap one dead-pid run dir. Never deletes unrestored vendor data: a
 * manifest-less, suspended or failed-restore dir is KEPT (SH-1). A dir is
 * deleted only when a manifest-nonce-bound restored-ok marker proves an
 * earlier pass persisted everything (and nothing non-owned appeared
 * since), or this pass restores it cleanly. Failed restores are recorded
 * per dir with a backoff and a hard attempt cap — a permanently failing
 * restore is retried a bounded number of times, then suspended for manual
 * recovery instead of stalling every launch forever.
 */
const reapStaleRunDir = async (
  clientRoot: string,
  name: string,
  budget: { remaining: number },
): Promise<TReapOutcome> => {
  const dir = join(clientRoot, name);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return REAP_GONE; // unreadable/gone — nothing to preserve
  }
  const manifest = readRunManifest(dir);
  if (manifest === null) {
    // No manifest: written by a pre-SH-1 build or a crashed materialize.
    // The plan-owned set is unknowable and no marker can be verified, so
    // nothing can be proven safe to delete — kept for manual recovery, but
    // BOUNDED: past the keep window a dir nothing can restore is just
    // unbounded growth, so it is reaped like any other dead residue.
    const newestMs = newestMtimeMs(dir);
    // 0 means nothing inside could be stated — unverifiable stays kept.
    if (newestMs === 0 || Date.now() - newestMs < runManifestlessKeepMs())
      return REAP_KEPT;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — a failed delete is retried by the next launch
    }
    removeRestoreState(restoreStatePath(clientRoot, name));
    return REAP_GONE;
  }
  // The manifest plus the marker name are ours regardless of what an older
  // or partial manifest recorded.
  const owned = new Set([
    ...manifest.ownedPaths,
    RUN_MANIFEST_NAME,
    RUN_RESTORED_OK_NAME,
  ]);
  if (
    manifest.nonce !== null &&
    entries.includes(RUN_RESTORED_OK_NAME) &&
    restoredMarkerMatches(dir, manifest.nonce) &&
    runDirOnlyDisposable(dir, entries, owned)
  ) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — the marker still proves it next pass
    }
    removeRestoreState(restoreStatePath(clientRoot, name));
    return REAP_GONE;
  }
  const statePath = restoreStatePath(clientRoot, name);
  const record = readRestoreState(statePath);
  if (record?.suspended === true) return REAP_KEPT;
  const attempts = record?.attempts ?? 0;
  if (attempts >= runRestoreMaxAttempts()) {
    suspendStaleRunDir(
      clientRoot,
      name,
      record ?? {
        attempts,
        firstFailedAt: null,
        lastFailedAt: null,
        lastFailedAtMs: null,
        lastError: null,
        suspended: false,
        reason: null,
      },
    );
    return REAP_KEPT;
  }
  if (
    record !== null &&
    record.lastFailedAtMs !== null &&
    Date.now() - record.lastFailedAtMs < runRestoreBackoffMs(attempts)
  ) {
    return REAP_KEPT; // backoff — a later launch retries
  }
  if (manifest.mirrorDir === null) {
    // No mirror target: the run dir is pure plan content unless a stray
    // vendor write landed — prove nothing non-owned survives before
    // deleting.
    if (!runDirOnlyDisposable(dir, entries, owned)) return REAP_KEPT;
    try {
      // Marker first: if we crash between here and the rm, the next launch
      // sees a verified restored-ok and deletes without re-checking.
      if (manifest.nonce !== null) {
        writeFileSync(join(dir, RUN_RESTORED_OK_NAME), `${manifest.nonce}\n`, {
          mode: 0o600,
        });
      }
      rmSync(dir, { recursive: true, force: true });
      removeRestoreState(statePath);
      return REAP_GONE;
    } catch {
      return REAP_GONE; // best-effort — the marker or next pass finishes it
    }
  }
  if (budget.remaining <= 0) return REAP_KEPT;
  budget.remaining -= 1;
  const attemptNo = attempts + 1;
  const nowMs = Date.now();
  const base: TRestoreStateRecord = {
    attempts: attemptNo,
    firstFailedAt: record?.firstFailedAt ?? new Date(nowMs).toISOString(),
    lastFailedAt: new Date(nowMs).toISOString(),
    lastFailedAtMs: nowMs,
    lastError: "attempt in progress",
    suspended: false,
    reason: null,
  };
  // Count the attempt BEFORE restoring: a crash mid-restore still leaves a
  // record that this dir consumed a try.
  writeRestoreState(statePath, base);
  let outcome: TRestoreOutcome;
  try {
    outcome = await restoreMirrorEntries(manifest.mirrorDir, dir, owned);
  } catch (error) {
    outcome = {
      ok: false,
      moved: [],
      skipped: [],
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (!outcome.ok) {
    const failed: TRestoreStateRecord = {
      ...base,
      lastError: outcome.problems.slice(0, 4).join("; ") || "restore failed",
    };
    if (attemptNo >= runRestoreMaxAttempts()) {
      suspendStaleRunDir(clientRoot, name, failed);
    } else {
      writeRestoreState(statePath, failed);
    }
    return REAP_ATTEMPTED;
  }
  try {
    // Marker first: if we crash between here and the rm, the next launch
    // sees a verified restored-ok and deletes without re-restoring.
    if (manifest.nonce !== null) {
      writeFileSync(join(dir, RUN_RESTORED_OK_NAME), `${manifest.nonce}\n`, {
        mode: 0o600,
      });
    }
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort — the marker or next pass finishes it
  }
  removeRestoreState(statePath);
  return REAP_RESTORED;
};

/** The run-dir name a state record belongs to, or null for other files. */
const restoreStateTarget = (entryName: string): string | null =>
  RUN_RESTORE_STATE_RE.exec(entryName)?.[1] ?? null;

/**
 * Reap run dirs from launches that crashed without cleaning up. Best-effort
 * and conservative: only directories whose recorded pid is dead are
 * touched, and those are RESTORED FIRST — a dir is deleted only when a
 * verified `restored-ok` marker proves an earlier pass persisted it, or
 * this pass just restored it cleanly (SH-1). Restore work is bounded per
 * pass so a pile of unrecoverable dirs cannot stall a launch, and each
 * dir's failures are bounded by a persisted backoff + cap.
 */
const reapStaleRuns = async (clientRoot: string): Promise<void> => {
  let entries: string[];
  try {
    entries = readdirSync(clientRoot);
  } catch {
    return;
  }
  const budget = { remaining: reapMaxRestoresPerPass() };
  for (const name of entries) {
    // `<pid>` or the `<pid>-<hex>` suffix createRunDir uses when a recycled
    // pid collides with an unreaped dir; `kept-*` is quarantined on purpose
    // and only manual recovery touches it.
    const pidMatch = /^(\d+)(?:-[0-9a-f]{8})?$/.exec(name);
    if (pidMatch === null) {
      // Sweep a state record whose run dir is gone (deleted by hand or
      // renamed without the record). A record whose dir exists — even a
      // `kept-*` one — is the doctor-visible trail, so it stays.
      const target = restoreStateTarget(name);
      if (target !== null && !existsSync(join(clientRoot, target))) {
        removeRestoreState(join(clientRoot, name));
      }
      continue;
    }
    const pid = Number.parseInt(pidMatch[1] as string, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
      continue; // still running — leave it
    } catch (error) {
      // Only a confirmed ESRCH is death: EPERM means the pid is alive and
      // owned by another user — anything else cannot be proven either.
      if (fsErrorCode(error) !== "ESRCH") continue;
    }
    try {
      await reapStaleRunDir(clientRoot, name, budget);
    } catch {
      // best-effort — a failed restore keeps the dir for the next launch
    }
  }
};

/** Test seam: run the stale-run reaper over a client run root directly. */
export const reapStaleRunsForTests = async (
  clientRoot: string,
): Promise<void> => {
  await reapStaleRuns(clientRoot);
};

/** Create `~/.openllm/run/<client>/<pid>/` (0700) and return it. */
const createRunDir = async (clientId: string): Promise<string> => {
  const clientRoot = join(runRoot(), clientId);
  mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
  await reapStaleRuns(clientRoot);
  const dir = join(clientRoot, String(process.pid));
  if (existsSync(dir)) {
    // Pid reuse after a crash: the dir was a DIFFERENT process's run dir and
    // may hold unrestored vendor data — restore it before reclaiming the
    // name, and never delete it outright (SH-1).
    let recovered = false;
    try {
      recovered = (
        await reapStaleRunDir(clientRoot, String(process.pid), {
          remaining: reapMaxRestoresPerPass(),
        })
      ).gone;
    } catch {
      recovered = false;
    }
    if (!recovered) {
      // Keep the data under a name the numeric-pid scan skips: it stays
      // for manual recovery rather than blocking this launch. The restore
      // record moves with the dir so the doctor-visible trail still pairs.
      const keptName = `kept-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        renameSync(dir, join(clientRoot, keptName));
        try {
          renameSync(
            restoreStatePath(clientRoot, String(process.pid)),
            restoreStatePath(clientRoot, keptName),
          );
        } catch {
          // no record to carry — fine
        }
      } catch {
        // rename failed — fall back to a suffixed run dir name
      }
    }
  }
  const target = existsSync(dir)
    ? join(clientRoot, `${process.pid}-${randomBytes(4).toString("hex")}`)
    : dir;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700); // force mode regardless of umask
  return target;
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
const materialize = (
  plan: TLaunchPlan,
  runDir: string,
  clientId: string,
): void => {
  if (plan.mirrorDir !== undefined) {
    mirrorConfigDir(
      expandHome(plan.mirrorDir),
      runDir,
      // The manifest name is OURS — never let a same-named real-dir entry be
      // symlinked in, or the manifest write would follow the link into the
      // user's real config dir.
      [...Object.keys(plan.files), RUN_MANIFEST_NAME, RUN_RESTORED_OK_NAME],
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
  // SH-1: the manifest goes last so the next launch's reaper can restore this
  // dir even when we die mid-session. A failure here is fatal to the launch:
  // a run dir without a manifest can never be reaped, so it must not start.
  writeRunManifest(runDir, clientId, plan);
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
  const owned = new Set<string>([
    LIVE_JSON_NAME,
    RUN_MANIFEST_NAME,
    RUN_RESTORED_OK_NAME,
  ]);
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
 *  `ps -o lstart=` under LC_ALL=C/TZ=UTC, a Windows FILETIME integer, or the
 *  post-RT-1 Linux `boot:<boot_id>:<ticks>` pair. */
const RESTORE_LOCK_START_RE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}|\d{1,20}|boot:[0-9a-f-]{36}:\d+)$/;
/** Exact names this code gives quarantined locks (steal + release paths). */
const RESTORE_QUARANTINE_NAME_RE =
  /^\.openllm-restore\.lock\.(?:stale-\d+-\d+-\d+|rel-(?:\d+-\d+-\d+|\d+-[0-9a-f]{32}))$/;
/** Steal-in-flight marker siblings (`<lock>.stealing-<pid>-<nonce>`). */
const RESTORE_STEAL_MARKER_RE =
  /^\.openllm-restore\.lock\.stealing-(\d+)-[0-9a-f]+$/;
const RESTORE_LOCK_OWNER_FILE_RE = /^owner\.json(?:\.\d+\.tmp)?$/;
const RESTORE_LOCK_WAIT_MS = 5_000;
/**
 * Teardown waits on a contended restore lock only this long; on a very slow
 * filesystem an operator can widen it. The bound stays finite either way —
 * it exists so a wedged lock cannot hang an exit forever.
 */
const restoreLockWaitMs = (): number => {
  const override = Number(process.env.OPENLLM_RESTORE_LOCK_WAIT_MS);
  return Number.isFinite(override) && override > 0
    ? Math.floor(override)
    : RESTORE_LOCK_WAIT_MS;
};
const RESTORE_LOCK_POLL_MS = 50;
const RESTORE_QUARANTINE_PREFIX = `${RESTORE_LOCK_NAME}.stale-`;
const RESTORE_REL_QUARANTINE_PREFIX = `${RESTORE_LOCK_NAME}.rel-`;
const RESTORE_STEAL_MARKER_PREFIX = `${RESTORE_LOCK_NAME}.stealing-`;
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
/**
 * FSS-07/PM-3: a crash between `mkdir(lock)` and the owner publish leaves a
 * lock dir with NO record that nothing can reclaim — every later teardown
 * timed out on it. The publish window is milliseconds, so a dir that has
 * carried no owner record for this long is orphaned residue, stealable like
 * any stale lock. A dir with an unreadable-but-PRESENT owner.json is never
 * covered by this rule — unverifiable is held, not stale.
 */
const RESTORE_OWNERLESS_RECLAIM_MS = 30_000;
const restoreOwnerlessReclaimMs = (): number => {
  const override = Number(process.env.OPENLLM_RESTORE_OWNERLESS_RECLAIM_MS);
  return Number.isFinite(override) && override > 0
    ? Math.floor(override)
    : RESTORE_OWNERLESS_RECLAIM_MS;
};

/**
 * Nonces this process minted AND released. A `.rel-<pid>` quarantine is
 * released residue only when its owner record carries one of these: a
 * same-pid record with any other nonce — an acquisition this process still
 * holds, or one a pid-reuse predecessor minted — is never ours to reap and
 * goes through the same revalidate-then-restore path as a steal quarantine.
 */
const releasedRestoreNonces = new Set<string>();

/** PID liveness probe: true = running, false = confirmed dead, null = cannot tell. */
const restoreLockPidAlive = (pid: number): boolean | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commEnd = stat.lastIndexOf(") ");
      if (commEnd >= 0 && stat[commEnd + 2] === "Z") return false;
    } catch {
      // Fall through to kill(2); a missing proc entry is handled there.
    }
  }
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
 * start times or to make a probe run to its full timeout. Only reaches the
 * POSIX `ps` path: win32 (FFI) and linux (/proc) resolve in-process, so
 * tests that must script THOSE identities use the reader seam below.
 */
export const setRestoreLockProbeSpawnForTests = (
  impl: typeof spawnSync | null,
): void => {
  spawnForProbe = impl ?? spawnSync;
};

/** Test seam: replaces the whole bounded identity probe (any platform). */
let identityProbeForTests:
  | ((pid: number, budgetMs: number) => string | null | undefined)
  | null = null;
export const setRestoreLockIdentityProbeForTests = (
  probe: ((pid: number, budgetMs: number) => string | null | undefined) | null,
): void => {
  identityProbeForTests = probe;
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
  if (identityProbeForTests !== null)
    return identityProbeForTests(pid, budgetMs);
  if (budgetMs <= 0) return undefined;
  // Windows reads identity through non-blocking FFI calls, and Linux reads
  // /proc directly — neither spawns a helper, so a `ps` that rejects
  // `lstart` (busybox) cannot wedge the restore wait (SH-2).
  if (process.platform === "win32" || process.platform === "linux")
    return processStartIdentity(pid);
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

/**
 * The same bounded probe in the LEGACY `ps lstart` format — the shape older
 * owner records carry. `processIdentityStatus`'s mixed-format bridge re-reads
 * the pid in the record's own format; an unbounded reader there would let a
 * slow `ps` outspend the caller's remaining restore-lock budget (SH-2).
 */
const boundedLegacyProcessStartIdentity = (
  pid: number,
  budgetMs: number,
): string | null | undefined => {
  if (identityProbeForTests !== null)
    return identityProbeForTests(pid, budgetMs);
  if (budgetMs <= 0) return undefined;
  // Windows reads FILETIME through non-blocking FFI — no helper spawn.
  if (process.platform === "win32") return legacyProcessStartIdentity(pid);
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
  /**
   * 128-bit ownership token (FSS-15/SH-7): release renames the lock to
   * quarantine and deletes it only when the record inside still carries OUR
   * nonce, so a stolen-and-re-acquired lock is never deleted out from under
   * its new owner. Records written by older builds have no nonce — they
   * diagnose the same, but only a nonce'd record can be released by us.
   */
  readonly nonce: string | null;
};

export const restoreDirLockCodec: TDirLockCodec =
  process.platform !== "win32"
    ? v3DirLockCodec("r")
    : {
        kind: RESTORE_LOCK_KIND,
        ownerFile: RESTORE_LOCK_OWNER_NAME,
        readOwner: (dir: string): TDirLockOwner | null => {
          const owner = readRestoreLockOwner(dir);
          if (owner === null) return null;
          return {
            kind: RESTORE_LOCK_KIND,
            pid: owner.pid,
            start: owner.start ?? "",
            nonce: owner.nonce ?? "",
          };
        },
        serializeOwner: (owner: TDirLockOwner): string =>
          `${JSON.stringify({
            kind: RESTORE_LOCK_KIND,
            pid: owner.pid,
            start: owner.start,
            nonce: owner.nonce,
          })}\n`,
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
      nonce:
        typeof owner.nonce === "string" && /^[0-9a-f]{32}$/.test(owner.nonce)
          ? owner.nonce
          : null,
    };
  } catch {
    return null;
  }
};

/**
 * A single un-renamed publish temp is still a readable owner record — the
 * holder died between the temp write and the rename. Two or more temps (or
 * an unreadable one) prove nothing: unmarked.
 */
const readRestoreLockTmpOwner = (
  lockPath: string,
): TRestoreLockOwner | null => {
  let names: string[];
  try {
    names = readdirSync(lockPath);
  } catch {
    return null;
  }
  const tmps = names.filter(
    (name) =>
      name !== RESTORE_LOCK_OWNER_NAME && RESTORE_LOCK_OWNER_FILE_RE.test(name),
  );
  if (names.includes(RESTORE_LOCK_OWNER_NAME) || tmps.length !== 1) return null;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(lockPath, tmps[0] ?? ""), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const owner = parsed as Record<string, unknown>;
    if (
      owner.kind !== RESTORE_LOCK_KIND ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      return null;
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
      nonce:
        typeof owner.nonce === "string" && /^[0-9a-f]{32}$/.test(owner.nonce)
          ? owner.nonce
          : null,
    };
  } catch {
    return null;
  }
};

/**
 * True when the lock dir carries NO owner-record-shaped entry at all — the
 * crash-between-mkdir-and-publish shape (FSS-07). Any `owner.json` or
 * `owner.json.*.tmp` entry — even an unreadable one — counts as presence:
 * unverifiable is held, never ownerless. A failed listing is also presence.
 */
const restoreLockIsOwnerless = (lockPath: string): boolean => {
  let names: string[];
  try {
    names = readdirSync(lockPath);
  } catch {
    return false;
  }
  return !names.some((name) => RESTORE_LOCK_OWNER_FILE_RE.test(name));
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
  /**
   * Inode of the entry this verdict judged. stealRestoreLock re-checks it
   * before renaming so a fresh dir created after the verdict can never be
   * quarantined in the stale entry's place.
   */
  readonly ino: number | null;
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

type TRestoreLockVerdictOnly = Omit<TRestoreLockDiagnosis, "ino">;

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
): TRestoreLockVerdictOnly => {
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
    return { verdict: "gone", unproven: false, ino: null };
  }
  if (!stat.isDirectory())
    return { ...diagnoseLegacyFileLock(lockPath, budgetMs), ino: stat.ino };
  // The published record wins; a LONE publish-temp (`owner.json.<pid>.tmp`)
  // is still a readable record from a holder that died mid-publish.
  const owner =
    readRestoreLockOwner(lockPath) ?? readRestoreLockTmpOwner(lockPath);
  if (owner === null) {
    // No complete owner record: a dir that carries any `owner.json`-shaped
    // entry is mid-publish or unreadable — held, never aged out. A dir with
    // NO owner record at all is the crash-between-mkdir-and-publish shape
    // (FSS-07/PM-3): reclaimable once it has been ownerless for the bound.
    if (!restoreLockIsOwnerless(lockPath))
      return { verdict: "held", unproven: true, ino: stat.ino };
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - stat.mtimeMs;
    } catch {
      // unstatable — cannot prove the bound, keep holding
    }
    return ageMs > restoreOwnerlessReclaimMs()
      ? { verdict: "stale", unproven: false, ino: stat.ino }
      : { verdict: "held", unproven: true, ino: stat.ino };
  }
  if (owner.start !== null) {
    // Identity-verified: "dead" covers a gone pid AND a live pid whose
    // start time proves the recorded owner is dead (pid reuse).
    const status = processIdentityStatus(
      owner.pid,
      owner.start,
      (pid) => boundedProcessStartIdentity(pid, budgetMs),
      (pid) => boundedLegacyProcessStartIdentity(pid, budgetMs),
    );
    if (status === "dead")
      return { verdict: "stale", unproven: false, ino: stat.ino };
    return { verdict: "held", unproven: status !== "alive", ino: stat.ino };
  }
  const alive = restoreLockPidAlive(owner.pid);
  if (alive === false)
    return { verdict: "stale", unproven: false, ino: stat.ino };
  return { verdict: "held", unproven: alive !== true, ino: stat.ino };
};

let restoreLockStealCounter = 0;

/** The creator pid embedded in a `<lock>.stealing-<pid>-<nonce>` marker. */
const restoreStealMarkerPid = (name: string): number | null => {
  const match = RESTORE_STEAL_MARKER_RE.exec(name);
  if (match === null) return null;
  const pid = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/** The pid and nonce embedded in a release quarantine name. */
const restoreRelQuarantineIdentity = (
  name: string,
): { readonly pid: number; readonly nonce: string | null } | null => {
  const match =
    /^\.openllm-restore\.lock\.rel-(\d+)-(\d+)-(\d+)$/.exec(name) ??
    /^\.openllm-restore\.lock\.rel-(\d+)-([0-9a-f]{32})$/.exec(name);
  if (match === null) return null;
  const pid = Number.parseInt(match[1] ?? "", 10);
  const nonce = match[0]?.match(/[0-9a-f]{32}$/)?.[0] ?? null;
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, nonce } : null;
};

/** Test seam: runs inside a steal AFTER the quarantine rename — the exact
 *  window the FSS-15 regression test exploits. */
let restoreStealGapHookForTests: ((lockPath: string) => void) | null = null;
export const setRestoreLockStealGapHookForTests = (
  hook: ((lockPath: string) => void) | null,
): void => {
  restoreStealGapHookForTests = hook;
};

/** Test seam: runs inside an acquisition just before the owner publish —
 *  the window where a racing steal's rename can take our just-made dir. */
let restorePublishGapHookForTests: ((lockPath: string) => void) | null = null;
export const setRestoreLockPublishGapHookForTests = (
  hook: ((lockPath: string) => void) | null,
): void => {
  restorePublishGapHookForTests = hook;
};

let restoreReleaseGapHookForTests: ((path: string) => void) | null = null;
export const setRestoreLockReleaseGapHookForTests = (
  hook: ((path: string) => void) | null,
): void => {
  restoreReleaseGapHookForTests = hook;
};

/**
 * The dir inode used to pin a lock generation — null when it cannot be
 * read. A capture failure must never widen into a delete: an unknown inode
 * means the path may already be a successor's, so every cleanup that keys
 * off it is skipped.
 */
const restoreLockDirInoDefault = (path: string): number | null => {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
};
let restoreLockDirIno = restoreLockDirInoDefault;

/** Test seam: force the "inode unknown" branch — a failed capture must
 *  never let a later owner-write failure delete the lock path. */
export const setRestoreLockDirInoProbeForTests = (
  probe: ((path: string) => number | null) | null,
): void => {
  restoreLockDirIno = probe ?? restoreLockDirInoDefault;
};

/** Test seam: mark a nonce as released by this process, so a `.rel-*`
 *  quarantine carrying it counts as our own released residue. */
export const restoreLockMarkNonceReleasedForTests = (nonce: string): void => {
  releasedRestoreNonces.add(nonce);
};

/**
 * Seize a lock judged stale. The `.stealing-*` marker goes up BEFORE the
 * quarantine rename and stays until the re-validation is final, so the
 * name gap can never admit a second logical owner (FSS-15): an acquirer
 * whose mkdir lands in the gap sees the marker and undoes its own empty
 * dir. The diagnosis is then RE-CHECKED on the seized entry: a lock that
 * became live again between verdict and rename is put back with a
 * NO-REPLACE move — a lock path reclaimed by a fresh owner during the
 * repair window must not be overwritten. The rename is additionally PINNED
 * to the inode the verdict judged: a verdict is only ever of one specific
 * entry, and a fresh dir that claimed the name between diagnosis and the
 * rename is never ours to quarantine.
 */
const stealRestoreLock = (
  lockPath: string,
  budgetMs: number,
  expectedIno: number | null,
): void => {
  const realDir = dirname(lockPath);
  const nonce = randomBytes(16).toString("hex");
  const marker = join(
    realDir,
    `${RESTORE_STEAL_MARKER_PREFIX}${process.pid}-${nonce}`,
  );
  try {
    mkdirSync(marker, { mode: 0o700 });
  } catch {
    return; // another steal (or a stranded marker) is in flight
  }
  try {
    // Pin the rename to the entry we judged: if the stale entry vanished or
    // a different dir claimed the name after our diagnosis, this steal does
    // not apply — an acquirer's fresh dir is never quarantined by a verdict
    // that was not about it.
    if (expectedIno !== null) {
      try {
        if (statSync(lockPath).ino !== expectedIno) return;
      } catch {
        return; // already gone — nothing to seize
      }
    }
    restoreLockStealCounter += 1;
    const quarantine = `${RESTORE_QUARANTINE_PREFIX}${process.pid}-${Date.now()}-${restoreLockStealCounter}`;
    const quarantinePath = join(realDir, quarantine);
    try {
      renameSync(lockPath, quarantinePath);
    } catch {
      // The lock vanished or a racing stealer's rename won first.
      return;
    }
    if (expectedIno !== null) {
      // The name was swapped between the pin check and the rename: the dir
      // we seized is not the one judged — restore it untouched.
      let seizedIno: number | null = null;
      try {
        seizedIno = statSync(quarantinePath).ino;
      } catch {
        seizedIno = null;
      }
      if (seizedIno !== expectedIno) {
        try {
          moveNoReplace(quarantinePath, lockPath);
        } catch {
          // GC reaps the leftover; the live lock at the name is untouched
        }
        return;
      }
    }
    restoreStealGapHookForTests?.(lockPath);
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
  } finally {
    try {
      rmdirSync(marker);
    } catch {
      // a stranded marker is swept once its pid dies or it ages out
    }
  }
};

/**
 * Best-effort removal of abandoned quarantine entries and steal markers —
 * left behind when a stealer crashed mid-recovery or a repair found the
 * lock path reclaimed. Quarantine entries are removed only past the GC
 * window (a young entry may belong to a steal in progress); a marker is
 * removed when its creator pid is dead OR it has outlived the GC window —
 * a live steal never takes that long, and a reused pid cannot wedge the
 * lock on a stale marker. Runs once per acquisition.
 */
const gcRestoreLockQuarantine = (realDir: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(realDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RESTORE_QUARANTINE_GC_MS;
  // Identity probes during GC share one bounded budget: each entry's
  // revalidation gets only what remains, and an exhausted budget degrades
  // to "unproven" — kept, never deleted.
  const gcProbeDeadline = Date.now() + RESTORE_PROBE_MAX_MS;
  for (const name of entries) {
    // The shared core owns nonce-qualified releases and their markers.
    // Do not restore a release that the shared core must finish deleting.
    if (/^\.openllm-restore\.lock\.rel-\d+-[0-9a-f]{32}$/.test(name)) continue;
    // A stranded steal marker: remove once its creator is dead or the GC
    // window passed — a live marker is honored, never swept.
    const markerPid = restoreStealMarkerPid(name);
    if (markerPid !== null) {
      const markerPath = join(realDir, name);
      try {
        const aged = lstatSync(markerPath).mtimeMs <= cutoff;
        if (aged || restoreLockPidAlive(markerPid) === false)
          rmdirSync(markerPath);
      } catch {
        // raced or non-empty marker — retried by the next acquirer
      }
      continue;
    }
    // Only exact names the steal and release paths generate; a user entry
    // that merely shares the prefix is never touched.
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
      // A stolen OR released lock's quarantine may still belong to a LIVE
      // owner — it is parked here only because a successor won the live path
      // mid-repair. Revalidate before deleting: a proven-live owner is never
      // reaped, and gets its lock back when the live path has freed up.
      // The .rel-* exception: an entry OUR release created AND still
      // carrying OUR record is released residue — safe to reap like any
      // other. A `.rel-*` made by ANOTHER pid that captured OUR live lock is
      // not residue: it still holds a live owner's record, so it goes
      // through the same revalidate-then-restore path as a steal quarantine.
      const isStealQuarantine = name.startsWith(RESTORE_QUARANTINE_PREFIX);
      const isReleaseQuarantine = name.startsWith(
        RESTORE_REL_QUARANTINE_PREFIX,
      );
      if (isStealQuarantine || isReleaseQuarantine) {
        const relOwner = isReleaseQuarantine
          ? (readRestoreLockOwner(entry) ?? readRestoreLockTmpOwner(entry))
          : null;
        const ownReleasedLock =
          relOwner !== null &&
          relOwner.pid === process.pid &&
          relOwner.nonce !== null &&
          releasedRestoreNonces.has(relOwner.nonce) &&
          restoreRelQuarantineIdentity(name)?.pid === process.pid &&
          (restoreRelQuarantineIdentity(name)?.nonce === null ||
            restoreRelQuarantineIdentity(name)?.nonce === relOwner.nonce);
        if (!ownReleasedLock) {
          const diagnosis = restoreLockDiagnosis(
            entry,
            Math.max(0, gcProbeDeadline - Date.now()),
          );
          if (diagnosis.verdict === "held") {
            if (!diagnosis.unproven) {
              try {
                moveNoReplace(entry, join(realDir, RESTORE_LOCK_NAME));
              } catch {
                // name still taken — keep the quarantine for the next pass
              }
            }
            continue;
          }
        }
      }
      rmSync(entry, { recursive: true, force: true });
    } catch {
      // retried by the next acquirer
    }
  }
};

/** Acquire the restore lock through the shared directory-lock core. */
const acquireRestoreLock = async (
  realDir: string,
): Promise<(() => void) | null> => {
  const lockPath = join(realDir, RESTORE_LOCK_NAME);
  if (process.platform === "win32") gcRestoreLockQuarantine(realDir);
  const deadline = performance.now() + restoreLockWaitMs();
  const remaining = (): number => Math.max(0, deadline - performance.now());
  const lockOptions: TDirLockOptions = {
    waitMs: restoreLockWaitMs(),
    reclaimMs: restoreOwnerlessReclaimMs(),
    pollMs: RESTORE_LOCK_POLL_MS,
    inode: restoreLockDirIno,
    propagatePublishErrors: true,
    startIdentity: (pid) => {
      const budget = Math.min(RESTORE_PROBE_MAX_MS, remaining());
      return budget > 0 ? boundedProcessStartIdentity(pid, budget) : undefined;
    },
    legacyStartIdentity: (pid) => {
      const budget = Math.min(RESTORE_PROBE_MAX_MS, remaining());
      return budget > 0
        ? boundedLegacyProcessStartIdentity(pid, budget)
        : undefined;
    },
    legacyHeld: (): boolean => {
      try {
        if (lstatSync(lockPath).isDirectory()) return false;
      } catch {
        return false;
      }
      const diagnosis = restoreLockDiagnosis(lockPath, remaining());
      if (diagnosis.verdict === "stale") {
        stealRestoreLock(lockPath, remaining(), diagnosis.ino);
      }
      return existsSync(lockPath);
    },
    onStep: (step, path): void => {
      if (step === "before-publish") restorePublishGapHookForTests?.(lockPath);
      if (step === "after-steal-rename")
        restoreStealGapHookForTests?.(lockPath);
      if (step === "after-release-rename")
        restoreReleaseGapHookForTests?.(path);
    },
  };
  const release = await acquireDirLock(
    lockPath,
    restoreDirLockCodec,
    lockOptions,
  );
  if (release === null) {
    process.stderr.write(
      `[openllm] restore lock ${lockPath} is held but its owner could not be verified; if no openllm teardown is running, remove it manually and retry\n`,
    );
  }
  return release;
};

/** Test seam: the cross-process restore lock's acquire/release pair. */
export const acquireRestoreLockForTests = (
  realDir: string,
): Promise<(() => void) | null> => acquireRestoreLock(realDir);

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
  // SH-4: the ConPTY first-compile on Windows can take ~12 s — a 2 s wait
  // killed the host mid-startup and fell back to a direct launch, leaving
  // TWO vendor processes on the same cwd.
  const socketPath = await waitForSessionHostSocket(
    id,
    SESSION_HOST_SOCKET_WAIT_MS,
  );
  if (socketPath === null) {
    // The host may still be starting. Kill the whole tree (SH-4): on Windows
    // the spawned leader is a wrapper whose children would otherwise outlive
    // it — the direct-launch fallback must not leave a second vendor PTY on
    // the same cwd.
    await killSpawnedSessionHost(spawned);
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
  await killSpawnedSessionHost(spawned);
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
  if (!(await requireProviderRouting(gateway))) return 1;

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

  const runDir = await createRunDir(client.id);
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
    materialize(plan, runDir, client.id);
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
          // Drop the nonce-bound marker first: a crash between here and the
          // rm leaves the next launch a proof it can verify and trust
          // without re-restoring. Only restore code ever writes it.
          const manifest = readRunManifest(runDir);
          if (manifest !== null && manifest.nonce !== null) {
            try {
              writeFileSync(
                join(runDir, RUN_RESTORED_OK_NAME),
                `${manifest.nonce}\n`,
                { mode: 0o600 },
              );
            } catch {
              // best-effort — an unmarked dir just gets re-restored
            }
          }
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
      windowsHide: true,
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
