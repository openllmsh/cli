import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  acquireDirLockSync,
  envDirLockCodec,
} from "../../tunnel/session/dir-lock";
import type {
  TProcessIdentity,
  TProcessStartIdentityReader,
} from "../../tunnel/session/local-runtime";
import {
  legacyProcessStartIdentity,
  processIdentityStatus,
  processStartIdentity,
} from "../../tunnel/session/local-runtime";
import type { TCliConfig } from "./env";
import { cliConfig, sharedEnvFile } from "./env";
import type {
  TCredentialGateMode,
  TCredentialGateTerminal,
} from "./runtime-contracts";
import { isUsableOpenllmApiKey } from "./runtime-contracts";

export type {
  TCredentialGateMode,
  TCredentialGateTerminal,
} from "./runtime-contracts";

export type TCredentialGateResult =
  | { readonly ok: true; readonly config: TCliConfig }
  | { readonly ok: false; readonly message: string };

/** A local envelope check only; the gateway remains authoritative for validity. */
export const isUsableApiKey = isUsableOpenllmApiKey;

const signInUrl = (config: TCliConfig = cliConfig()): string =>
  `${config.gatewayUrl}/sign-in`;

const keyDiagnostic = (
  problem: "required" | "invalid",
  config?: TCliConfig,
): string =>
  `[openllm] ${problem === "required" ? "API key required." : "API key format is invalid."}\nRun \`openllm start\` in an interactive terminal and sign in at ${signInUrl(config)}. New users receive a key during onboarding; returning users can open Keys after signing in. Paste the key when prompted.\n`;

export const missingKeyDiagnostic = (config?: TCliConfig): string =>
  keyDiagnostic("required", config);

export const invalidKeyDiagnostic = (config?: TCliConfig): string =>
  keyDiagnostic("invalid", config);

type THiddenInputSignalProcess = {
  readonly on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly kill: (pid: number, signal: NodeJS.Signals) => boolean;
};

/**
 * Restore echo before forwarding a terminating signal. Hidden input uses a
 * synchronous terminal read, so this handler must be installed before that
 * read begins rather than relying solely on the normal `finally` path.
 */
export const restoreEchoOnSignal = (
  restore: () => void,
  signalProcess: THiddenInputSignalProcess = process,
): (() => void) => {
  let restored = false;
  const restoreOnce = (): void => {
    if (restored) return;
    restored = true;
    restore();
  };
  const forward = (signal: NodeJS.Signals): void => {
    cleanup();
    restoreOnce();
    signalProcess.kill(process.pid, signal);
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  const cleanup = (): void => {
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
  };
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);
  return (): void => {
    cleanup();
    restoreOnce();
  };
};

const readHiddenLine = (): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync("/dev/tty", "r+");
    if (spawnSync("stty", ["-echo"], { stdio: [fd, fd, fd] }).status !== 0)
      return null;
    const restore = (): void => {
      spawnSync("stty", ["echo"], { stdio: [fd, fd, fd] });
    };
    const cleanupSignals = restoreEchoOnSignal(restore);
    try {
      const bytes: number[] = [];
      const byte = Buffer.alloc(1);
      while (true) {
        if (readSync(fd, byte, 0, 1, null) === 0) return null;
        if (byte[0] === 10 || byte[0] === 13) break;
        bytes.push(byte[0]);
      }
      return Buffer.from(bytes).toString("utf8");
    } finally {
      cleanupSignals();
      process.stderr.write("\n");
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const defaultTerminal: TCredentialGateTerminal = {
  isInteractive: (): boolean =>
    process.stdin.isTTY === true && process.stderr.isTTY === true,
  promptForKey: (): string | null => {
    process.stderr.write("API key: ");
    return readHiddenLine();
  },
  write: (message: string): void => {
    process.stderr.write(message);
  },
};

/**
 * Shared env-file lock protocol `openllm-env-lock/v1` — the SAME protocol as
 * `packages/daemon/src/env.ts` (and the block duplicated verbatim in both
 * `install.sh` scripts). The lock is the DIRECTORY `<envfile>.lock.d` claimed
 * by atomic `mkdir`; the owner publishes
 * `kind=openllm-env-lock/v1 pid=<pid> start=<identity> nonce=<hex>` no-replace
 * inside it; stale reclaim is marker-first (`steal.<pid>.<nonce>` inside the
 * dir, then re-judge the same generation, then quarantine by rename); the
 * publish is vetoed by an in-flight steal; release renames to `.rel.` and
 * verifies the nonce before deleting. `start` is the canonical
 * `processStartIdentity` value (`boot:<boot_id>:<ticks>` on Linux, `ps
 * lstart` text on macOS); `-` is a legacy record shape this build never
 * writes, and a live `-` owner holds for the full stale window — never the
 * orphan bound. An ownerless or unmarked lock is HELD only inside the
 * orphan bound (default 30 s) and a legacy `.env.lock` FILE inside the same
 * bound. Keep every rule byte-compatible with the daemon side — the parity
 * tests pin both.
 */
const ENV_LOCK_MARKER = "kind=openllm-env-lock/v1";

const envLockStaleMs = (): number => {
  const raw = process.env.OPENLLM_ENV_LOCK_STALE_SECS;
  if (raw !== undefined && /^[0-9]+$/.test(raw) && Number(raw) > 0)
    return Number(raw) * 1000;
  return 600_000;
};

const envLockOrphanMs = (): number => {
  const raw = process.env.OPENLLM_ENV_LOCK_ORPHAN_SECS;
  if (raw !== undefined && /^[0-9]+$/.test(raw) && Number(raw) > 0)
    return Number(raw) * 1000;
  return 30_000;
};

// Installer patience, not the daemon's request-path bound: onboarding is an
// interactive one-shot write outside any event loop, so a held lock is
// waited out like the installers do.
const envLockWaitMs = (): number => {
  const raw = process.env.OPENLLM_ENV_LOCK_WAIT_SECS;
  if (raw !== undefined && /^[0-9]+$/.test(raw) && Number(raw) > 0)
    return Number(raw) * 1000;
  return 10_000;
};

type TEnvLockOwner =
  | {
      readonly state: "marked";
      readonly pid: number;
      readonly start: string;
      readonly nonce: string;
    }
  | { readonly state: "unmarked"; readonly pid: number | null };

/** Identical field rules to the daemon's `envLockReadOwner`. */
const envLockReadOwner = (dir: string): TEnvLockOwner => {
  let text = "";
  try {
    text = readFileSync(join(dir, "owner"), "utf-8").trim();
  } catch {
    text = "";
  }
  const marked = text.match(
    /^kind=openllm-env-lock\/v1 pid=([0-9]+) start=(.+) nonce=([0-9a-fA-F]+)$/,
  );
  if (marked !== null) {
    return {
      state: "marked",
      pid: Number(marked[1]),
      start: marked[2],
      nonce: marked[3],
    };
  }
  const pidField =
    text.match(/(?:^|\s)pid=([0-9]+)(?:\s|$)/)?.[1] ??
    text.match(/^([0-9]+)(?:\s|$)/)?.[1];
  const pid = pidField === undefined ? Number.NaN : Number(pidField);
  return {
    state: "unmarked",
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
};

/** Is `pid` a live process? EPERM means it exists but is owned by another user. */
const envLockOwnerAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The owner's start identity in the canonical format — `processStartIdentity`
 * (`boot:<boot_id>:<ticks>` on Linux, `ps -o lstart=` text on other POSIX),
 * whitespace collapsed exactly like the daemon side. Tri-state: a string
 * identity, null for a confirmed-dead pid, undefined when unknown.
 *
 * A FAILED probe (undefined) is never cached — a stale "unknown" could be
 * trusted for minutes, and a `start=-` record it produced was reclaimable
 * while the owner was still alive.
 */
const IDENTITY_PROBE_TTL_MS = 250;
const identityCache = new Map<
  number,
  { readonly value: string | null; readonly at: number }
>();
let envLockProbe: TProcessStartIdentityReader = processStartIdentity;
let envLockLegacyProbe: TProcessStartIdentityReader =
  legacyProcessStartIdentity;
let selfIdentity: string | null | undefined;
let selfIdentityRead = false;

const envLockStartIdentityProbe = (pid: number): string | null | undefined => {
  const raw = envLockProbe(pid);
  if (typeof raw !== "string") return raw;
  const value = raw.trim().replace(/\s+/g, " ");
  return value.length > 0 ? value : undefined;
};

const envLockLegacyStartIdentityProbe = (
  pid: number,
): string | null | undefined => {
  const raw = envLockLegacyProbe(pid);
  if (typeof raw !== "string") return raw;
  const value = raw.trim().replace(/\s+/g, " ");
  return value.length > 0 ? value : undefined;
};

const envLockStartIdentity = (pid: number): string | null | undefined => {
  if (pid === process.pid) {
    // Our own identity is immutable once read — but a failed probe is NOT
    // latched: a permanently cached "unknown" would publish `start=-`, a
    // record any contender may reclaim while we are still alive. The next
    // call re-probes.
    if (!selfIdentityRead) {
      const value = envLockStartIdentityProbe(pid);
      if (typeof value === "string") {
        selfIdentity = value;
        selfIdentityRead = true;
      }
      return value;
    }
    return selfIdentity;
  }
  const now = Date.now();
  const hit = identityCache.get(pid);
  if (hit !== undefined && now - hit.at < IDENTITY_PROBE_TTL_MS)
    return hit.value;
  const value = envLockStartIdentityProbe(pid);
  if (value !== undefined) {
    if (identityCache.size > 128) identityCache.clear();
    identityCache.set(pid, { value, at: now });
  }
  return value;
};

/**
 * Identity reader bound to ONE owner record. The per-pid cache is trusted
 * only when its entry MATCHES the record's start: a matching identity can
 * only delay a steal by the TTL — the conservative direction. A cached
 * MISMATCH may be the predecessor's identity on a pid that was reused
 * inside the window — serving it would convict a live owner as dead — so
 * a non-matching entry always falls through to a fresh probe. Identical to
 * the daemon's reader in `env.ts`.
 */
const envLockStartIdentityForRecord = (
  pid: number,
  recordedStart: string,
): string | null | undefined => {
  if (pid === process.pid) return envLockStartIdentity(pid);
  const expected = recordedStart.trim().replace(/\s+/g, " ");
  const now = Date.now();
  const hit = identityCache.get(pid);
  if (
    hit !== undefined &&
    now - hit.at < IDENTITY_PROBE_TTL_MS &&
    hit.value === expected
  )
    return hit.value;
  const value = envLockStartIdentityProbe(pid);
  if (value !== undefined) {
    if (identityCache.size > 128) identityCache.clear();
    identityCache.set(pid, { value, at: now });
  }
  return value;
};

/**
 * `processIdentityStatus` verdicts, briefly cached per (pid, recorded
 * start) — a mixed-format record costs a second bridging probe, so the
 * verdict is rate-limited like the daemon's. Only "alive" answers are
 * cached: a cached "dead" could outlive a same-second pid reuse on a
 * coarse `ps lstart` record, and a cached "unknown" would make a
 * transient probe outage outlive the TTL — both re-probe every call.
 */
const statusCache = new Map<
  string,
  { readonly value: TProcessIdentity; readonly at: number }
>();

const envLockIdentityStatus = (
  pid: number,
  recordedStart: string,
): TProcessIdentity => {
  const key = `${pid} ${recordedStart}`;
  const now = Date.now();
  const hit = statusCache.get(key);
  if (hit !== undefined && now - hit.at < IDENTITY_PROBE_TTL_MS)
    return hit.value;
  const value = processIdentityStatus(
    pid,
    recordedStart,
    (probePid) => envLockStartIdentityForRecord(probePid, recordedStart),
    envLockLegacyStartIdentityProbe,
  );
  // Only an "alive" verdict is cached: a cached "dead" could outlive a
  // same-second pid reuse on a coarse `ps lstart` record and convict the
  // LIVE successor, and a cached "unknown" would keep a dead owner
  // unreclaimed while a transient probe failure clears — both re-probe
  // every time.
  if (value === "alive") {
    if (statusCache.size > 128) statusCache.clear();
    statusCache.set(key, { value, at: now });
  }
  return value;
};

/**
 * Test seam: swap the raw start-identity probe and reset every identity
 * cache, so a transient probe outage is replayable. Call with no argument
 * to restore the real probe.
 */
export const envLockSwapProbeForTest = (
  impl?: TProcessStartIdentityReader,
): void => {
  envLockProbe = impl ?? processStartIdentity;
  envLockLegacyProbe = impl ?? legacyProcessStartIdentity;
  selfIdentity = undefined;
  selfIdentityRead = false;
  identityCache.clear();
  statusCache.clear();
};

/**
 * Test seam: plant a pid→start entry in the per-pid identity cache. The
 * "reused pid inside the 250 ms TTL" precondition — any earlier judgement
 * may have cached the PREDECESSOR's start — without a wall-clock wait.
 */
export const envLockSeedIdentityCacheForTests = (
  pid: number,
  value: string | null,
): void => {
  identityCache.set(pid, { value, at: Date.now() });
};

/** Test seam: runs inside the acquire AFTER our dir's inode is captured and
 *  BEFORE the owner publish — identical to the daemon side. */
let envLockPublishGapForTests: ((lockDir: string) => void) | null = null;
export const envLockPublishGapForTest = (
  hook: ((lockDir: string) => void) | null,
): void => {
  envLockPublishGapForTests = hook;
};
let envLockStealGapForTests: ((lockDir: string) => void) | null = null;
export const envLockStealGapForTest = (
  hook: ((lockDir: string) => void) | null,
): void => {
  envLockStealGapForTests = hook;
};

const envLockDirInoDefault = (dir: string): number | undefined => {
  try {
    return lstatSync(dir).ino;
  } catch {
    return undefined;
  }
};
let envLockDirIno = envLockDirInoDefault;

/** Test seam: force the "inode unknown" acquire branch — identical to the
 *  daemon side. */
export const envLockDirInoProbeForTest = (
  probe: ((dir: string) => number | undefined) | null,
): void => {
  envLockDirIno = probe ?? envLockDirInoDefault;
};

/**
 * The shared staleness predicate — identical rules to the daemon side.
 * `asOfMtimeMs` substitutes a pre-captured dir mtime for the age terms: the
 * steal path passes the PRE-MARK stat because our own `steal.*` marker
 * create already bumped the dir's mtime.
 */
const envLockDirIsStale = (dir: string, asOfMtimeMs?: number): boolean => {
  const owner = envLockReadOwner(dir);
  let ageMs = Number.NaN;
  if (asOfMtimeMs !== undefined) {
    ageMs = Date.now() - asOfMtimeMs;
  } else {
    try {
      ageMs = Date.now() - lstatSync(dir).mtimeMs;
    } catch {
      // unreadable — stay held
    }
  }
  if (owner.state === "marked") {
    if (!envLockOwnerAlive(owner.pid)) return true;
    if (owner.start.trim().replace(/\s+/g, " ") === "-") return false;
    // `processIdentityStatus` bridges the legacy `ps lstart` records older
    // builds and pre-XS-1 installers wrote against this build's canonical
    // probe; an unreadable identity is "unknown" — the lock stays held.
    // An unproven identity is held. Only a fresh probe that proves the
    // recorded owner is dead may make a marked lock stale.
    return envLockIdentityStatus(owner.pid, owner.start) === "dead";
  }
  if (!(ageMs >= envLockOrphanMs())) return false;
  if (owner.pid !== null && envLockOwnerAlive(owner.pid)) return false;
  return true;
};

let envLockQuarantineSeq = 0;

/** Marker-first stale reclaim — identical to the daemon's `envLockSteal`. */
const envLockSteal = (lockDir: string, stem: string, nonce: string): void => {
  let beforeIno = Number.NaN;
  let beforeMtimeMs = Number.NaN;
  try {
    const stat = lstatSync(lockDir);
    beforeIno = stat.ino;
    beforeMtimeMs = stat.mtimeMs;
  } catch {
    return;
  }
  const marker = join(lockDir, `steal.${process.pid}.${nonce}`);
  try {
    const fd = openSync(marker, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      try {
        if (statSync(lockDir).isFile()) {
          envLockQuarantineSeq += 1;
          renameSync(
            lockDir,
            `${stem}.stale.${process.pid}.${nonce}.${envLockQuarantineSeq}`,
          );
        }
      } catch {
        // raced — leave it
      }
    }
    return;
  }
  let stale = false;
  try {
    stale =
      lstatSync(lockDir).ino === beforeIno &&
      envLockDirIsStale(lockDir, beforeMtimeMs);
  } catch {
    stale = false;
  }
  if (stale) {
    try {
      envLockQuarantineSeq += 1;
      renameSync(
        lockDir,
        `${stem}.stale.${process.pid}.${nonce}.${envLockQuarantineSeq}`,
      );
      return;
    } catch {
      // lost the rename or the dir vanished — unmark below
    }
  }
  try {
    unlinkSync(marker);
  } catch {
    // already gone, or moved with the dir
  }
};

/** Bounded quarantine sweep — identical allowlist to the daemon's. */
const envLockSweepQuarantine = (parentDir: string, baseName: string): void => {
  let entries: string[] = [];
  try {
    entries = readdirSync(parentDir);
  } catch {
    return;
  }
  const staleMs = envLockStaleMs();
  for (const entry of entries) {
    if (
      !entry.startsWith(`${baseName}.lock.stale.`) &&
      !entry.startsWith(`${baseName}.lock.rel.`)
    )
      continue;
    const path = join(parentDir, entry);
    let isDir = false;
    let mtimeMs = 0;
    try {
      const stat = lstatSync(path);
      isDir = stat.isDirectory();
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (!isDir || Date.now() - mtimeMs < staleMs) continue;
    let clean = true;
    let hasOwner = false;
    try {
      for (const child of readdirSync(path)) {
        if (child === "owner") hasOwner = true;
        else if (!child.startsWith("owner.tmp.") && !child.startsWith("steal."))
          clean = false;
      }
    } catch {
      clean = false;
    }
    if (!clean) continue;
    if (hasOwner && envLockReadOwner(path).state !== "marked") continue;
    for (const child of readdirSync(path)) {
      try {
        unlinkSync(join(path, child));
      } catch {
        // best effort
      }
    }
    try {
      rmdirSync(path);
    } catch {
      // best effort
    }
  }
};

/**
 * Adjudicate a legacy `.env.lock` file already renamed into quarantine —
 * identical verdicts to the daemon's: a live pid is restored no-replace only
 * inside the orphan window; everything else is deleted. Returns true while
 * the legacy path still blocks acquisition.
 */
const envLockLegacyResolveQuarantine = (
  quarantinePath: string,
  legacyPath: string,
): boolean => {
  let movedText = "";
  try {
    movedText = readFileSync(quarantinePath, "utf-8");
  } catch {
    movedText = "";
  }
  const movedPid = Number(movedText.trim().split(/\s+/)[0]);
  let withinWindow = false;
  if (
    Number.isInteger(movedPid) &&
    movedPid > 0 &&
    envLockOwnerAlive(movedPid)
  ) {
    withinWindow = true;
    try {
      withinWindow =
        Date.now() - lstatSync(quarantinePath).mtimeMs < envLockOrphanMs();
    } catch {
      // keep the conservative default
    }
  }
  if (withinWindow) {
    try {
      linkSync(quarantinePath, legacyPath);
      try {
        unlinkSync(quarantinePath);
      } catch {
        // best effort
      }
    } catch {
      let restored = false;
      let created = false;
      let fd = -1;
      try {
        fd = openSync(legacyPath, "wx");
        created = true;
        writeFileSync(fd, movedText);
        fsyncSync(fd);
        closeSync(fd);
        fd = -1;
        // Verify the landed copy before the captured record is consumed —
        // identical to the daemon's.
        restored = readFileSync(legacyPath, "utf-8") === movedText;
      } catch {
        // covered below — only OUR fresh create is ever removed.
      }
      if (!restored && created) {
        if (fd >= 0) {
          try {
            closeSync(fd);
          } catch {
            // best effort
          }
        }
        try {
          unlinkSync(legacyPath);
        } catch {
          // best effort
        }
      }
      if (restored) {
        try {
          unlinkSync(quarantinePath);
        } catch {
          // best effort
        }
      } else {
        try {
          lstatSync(legacyPath);
          try {
            unlinkSync(quarantinePath);
          } catch {
            // best effort
          }
        } catch {
          // Path free but restore failed — keep it quarantined for a retry.
        }
      }
    }
    return true;
  }
  try {
    unlinkSync(quarantinePath);
  } catch {
    // best effort
  }
  return false;
};

/**
 * Legacy `.env.lock` FILE handling — identical to the daemon's: a live or
 * unparseable record holds only inside the orphan window, and reclaim always
 * renames to a unique quarantine name first (never an unlink on the live
 * path). Returns true while the legacy file still blocks acquisition.
 */
const envLockLegacyHeld = (legacyPath: string, nonce: string): boolean => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let text: string;
    try {
      text = readFileSync(legacyPath, "utf-8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    const pid = Number(text.trim().split(/\s+/)[0]);
    const pidProvenDead =
      Number.isInteger(pid) && pid > 0 && !envLockOwnerAlive(pid);
    if (!pidProvenDead) {
      let ageMs = Number.NaN;
      try {
        ageMs = Date.now() - lstatSync(legacyPath).mtimeMs;
      } catch {
        // exists but its age is unknown — stay held
      }
      if (!(ageMs >= envLockOrphanMs())) return true;
    }
    const quarantine = `${legacyPath}.stale.${process.pid}.${nonce}.${attempt}`;
    try {
      renameSync(legacyPath, quarantine);
    } catch {
      continue;
    }
    if (envLockLegacyResolveQuarantine(quarantine, legacyPath)) return true;
  }
  return true;
};

/**
 * Publish OUR owner record no-replace, then check the generation + steal
 * veto: a `steal.*` marker inside the dir, the dir itself gone — or a
 * DIFFERENT inode at the path (`expectedIno`, captured right after our
 * `mkdir`; a successor's dir carries no marker for our quarantined
 * generation) — means a contender committed to reclaiming our generation
 * while our record was in flight, so we drop only OUR record and report
 * failure. Only our own generation is ours to `rmdir`. Identical to the
 * daemon's.
 */
const envLockPublishOwner = (
  lockDir: string,
  nonce: string,
  expectedIno?: number,
): boolean => {
  const start = envLockStartIdentity(process.pid);
  if (typeof start !== "string" || start.length === 0) {
    // A live owner MUST carry a provable start identity — `start=-` made a
    // held lock reclaimable while the owner was still alive. A failed
    // probe publishes NOTHING: drop the dir WE made (only while it is
    // still our generation) and report a retryable failure.
    if (expectedIno !== undefined) {
      try {
        if (lstatSync(lockDir).ino === expectedIno) rmdirSync(lockDir);
      } catch {
        // vanished or foreign — not ours to remove
      }
    }
    return false;
  }
  const record = `${ENV_LOCK_MARKER} pid=${process.pid} start=${start} nonce=${nonce}\n`;
  const tmp = join(lockDir, `owner.tmp.${process.pid}`);
  const ownerPath = join(lockDir, "owner");
  writeFileSync(tmp, record, "utf-8");
  let published = false;
  try {
    linkSync(tmp, ownerPath);
    published = true;
  } catch {
    let fd = -1;
    try {
      fd = openSync(ownerPath, "wx");
      writeFileSync(fd, record);
      closeSync(fd);
      fd = -1;
      published = true;
    } catch {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
        try {
          unlinkSync(ownerPath);
        } catch {
          // best effort
        }
      }
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // best effort — swept later either way
  }
  if (!published) return false;
  let stolen = true;
  let sameGeneration = false;
  try {
    const stat = lstatSync(lockDir);
    if (stat.isDirectory()) {
      sameGeneration = expectedIno === undefined || stat.ino === expectedIno;
      stolen =
        !sameGeneration ||
        readdirSync(lockDir).some((child) => child.startsWith("steal."));
    }
  } catch {
    // dir vanished — stolen outright
  }
  if (stolen) {
    const ours = envLockReadOwner(lockDir);
    if (ours.state === "marked" && ours.nonce === nonce) {
      try {
        unlinkSync(ownerPath);
      } catch {
        // best effort
      }
    }
    if (sameGeneration) {
      try {
        rmdirSync(lockDir);
      } catch {
        // best effort — the dir is being (or was) quarantined regardless
      }
    }
    return false;
  }
  const now = envLockReadOwner(lockDir);
  return now.state === "marked" && now.nonce === nonce;
};

/**
 * Put a quarantined foreign lock dir back at the live path — NO-REPLACE,
 * identical to the daemon's `envLockRestoreQuarantinedDir`: `mkdir` is the
 * atomic no-replace claim (a re-taken path leaves the quarantine parked),
 * then each regular-file child is copied verified (no-replace create,
 * fsync, re-read) and the quarantine drained only after every copy lands.
 * Dotfiles are skipped to match the installers' `"$rel"/*` glob.
 */
const envLockFsyncDirectory = (dir: string): void => {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      code !== undefined &&
      new Set(["EPERM", "EISDIR", "EINVAL"]).has(code)
    )
      return;
    throw error;
  } finally {
    closeSync(fd);
  }
};

const envLockRestoreQuarantinedDir = (
  released: string,
  lockDir: string,
): void => {
  try {
    mkdirSync(lockDir);
  } catch {
    return; // the path was re-taken — leave the quarantine parked
  }
  // Every regular file is copied VERIFIED — created no-replace, fsync'd and
  // re-read — and the quarantined source is deleted only after EVERY copy
  // lands whole: a partial restore never destroys the only valid owner
  // record. Identical to the daemon's.
  const restored: string[] = [];
  let ok = true;
  let children: string[] = [];
  try {
    children = readdirSync(released).sort();
  } catch {
    ok = false; // nothing copyable — back out cleanly below
  }
  if (ok) {
    for (const child of children) {
      if (child.startsWith(".")) continue;
      const src = join(released, child);
      const dst = join(lockDir, child);
      // `[ -f ]` on the shell side: a non-regular or unstatable entry is
      // skipped, never copied — it keeps the quarantine parked below.
      try {
        if (!statSync(src).isFile()) continue;
      } catch {
        continue;
      }
      let created = false;
      let fd = -1;
      try {
        const data = readFileSync(src);
        fd = openSync(dst, "wx", 0o600);
        created = true;
        writeFileSync(fd, data);
        fsyncSync(fd);
        closeSync(fd);
        fd = -1;
        if (!readFileSync(dst).equals(data))
          throw new Error("restored copy failed verification");
        restored.push(child);
      } catch {
        ok = false;
        if (fd >= 0) {
          try {
            closeSync(fd);
          } catch {
            // best effort
          }
        }
        if (created) {
          try {
            unlinkSync(dst);
          } catch {
            // best effort
          }
        }
        break;
      }
    }
  }
  if (ok) {
    try {
      envLockFsyncDirectory(lockDir);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    // Roll the fresh dir back to its claimed-empty state — only the files
    // THIS pass created — and keep the quarantined source for a later pass.
    for (const child of restored) {
      try {
        unlinkSync(join(lockDir, child));
      } catch {
        // best effort
      }
    }
    try {
      rmdirSync(lockDir);
    } catch {
      // a foreign entry arrived — leave the dir for its owner
    }
    return;
  }
  for (const child of restored) {
    try {
      unlinkSync(join(released, child));
    } catch {
      // best effort
    }
  }
  try {
    rmdirSync(released);
  } catch {
    // best effort — foreign entries keep it parked for the sweep
  }
};

/**
 * Adjudicate a lock dir already moved into `.rel.<pid>.<nonce>` — identical
 * to the daemon's `envLockFinishRelease`: our marked record means delete;
 * a foreign one is restored no-replace.
 */
const envLockFinishRelease = (
  released: string,
  lockDir: string,
  nonce: string,
): void => {
  const owner = envLockReadOwner(released);
  if (owner.state === "marked" && owner.nonce === nonce) {
    try {
      for (const child of readdirSync(released)) {
        try {
          unlinkSync(join(released, child));
        } catch {
          // best effort
        }
      }
    } catch {
      // unreadable
    }
    try {
      rmdirSync(released);
    } catch {
      // best effort
    }
    return;
  }
  envLockRestoreQuarantinedDir(released, lockDir);
};

/**
 * Release OUR lock dir — identical to the daemon's `envLockReleaseDir`:
 * only a dir that still reads as OURS at the live path is moved aside
 * (a foreign marked owner is never touched), and a captured dir that turns
 * out foreign is restored no-replace, never `rename`'d over a successor's
 * fresh dir.
 */
const envLockReleaseDir = (lockDir: string, nonce: string): void => {
  const released = `${lockDir.slice(0, -2)}.rel.${process.pid}.${nonce}`;
  try {
    const pre = envLockReadOwner(lockDir);
    if (pre.state !== "marked" || pre.nonce !== nonce) return;
    renameSync(lockDir, released);
  } catch {
    return; // vanished under us — nothing held
  }
  envLockFinishRelease(released, lockDir, nonce);
};

/**
 * Acquire the shared lock, run `operation`, release — identical flow to the
 * daemon's `withEnvFileLock`, including the guaranteed first attempt.
 */
const withEnvFileLock = (
  targetPath: string,
  operation: () => boolean,
  waitMs?: number,
): boolean => {
  const stem = `${targetPath}.lock`;
  const lockDir = `${stem}.d`;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const release = acquireDirLockSync(lockDir, envDirLockCodec, {
    waitMs: waitMs ?? envLockWaitMs(),
    reclaimMs: envLockStaleMs(),
    pollMs: 10,
    inode: envLockDirIno,
    startIdentity: envLockStartIdentity,
    legacyStartIdentity: envLockLegacyStartIdentityProbe,
    isStale: envLockDirIsStale,
    legacyHeld: (): boolean => envLockLegacyHeld(stem, nonce),
    onStep: (step, path): void => {
      if (step === "before-publish") envLockPublishGapForTests?.(path);
      if (step === "after-steal-marker") envLockStealGapForTests?.(path);
    },
  });
  if (release === null) return false;
  try {
    return operation();
  } finally {
    release();
  }
};

/**
 * Serialize read-modify-rename updates with the daemon-compatible directory
 * lock (`<envfile>.lock.d`), the same protocol the installers and daemon
 * share.
 */
const updateEnvFile = (key: string): boolean => {
  const target = sharedEnvFile();
  try {
    if (/[\r\n\0]/.test(key)) return false;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    return withEnvFileLock(target, () => {
      let lines: string[] = [];
      try {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        lines = readFileSync(target, "utf8").split("\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      let replaced = false;
      const next = lines.flatMap((line): string[] => {
        const match = /^\s*OPENLLM_API_KEY\s*=/.test(line);
        if (!match) return [line];
        if (replaced) return [];
        replaced = true;
        return [`OPENLLM_API_KEY=${key}`];
      });
      while (next.length > 0 && next[next.length - 1]?.trim() === "")
        next.pop();
      if (!replaced) next.push(`OPENLLM_API_KEY=${key}`);
      const temp = join(
        dirname(target),
        `.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      try {
        writeFileSync(temp, `${next.join("\n")}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        const fd = openSync(temp, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          const stat = lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink()) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        }
        renameSync(temp, target);
        chmodSync(target, 0o600);
        return true;
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // renamed or never created
        }
      }
    });
  } catch {
    return false;
  }
};

/**
 * Resolve a key for an authenticated CLI operation. Machine mode is deliberately
 * noninteractive so protocol-bearing commands can fail before writing stdout.
 */
export const requireCliApiKey = (
  mode: TCredentialGateMode,
  terminal: TCredentialGateTerminal = defaultTerminal,
): TCredentialGateResult => {
  const configured = cliConfig();
  if (isUsableApiKey(configured.apiKey)) {
    return {
      ok: true,
      config: { ...configured, apiKey: configured.apiKey.trim() },
    };
  }
  const invalid = configured.apiKey.trim().length > 0;
  if (mode === "machine" || !terminal.isInteractive()) {
    return {
      ok: false,
      message: invalid
        ? invalidKeyDiagnostic(configured)
        : missingKeyDiagnostic(configured),
    };
  }
  if (invalid)
    terminal.write(
      "The configured API key format is invalid. Please paste a new key.\n",
    );
  terminal.write(
    `OpenLLM needs an API key.\nSign in at ${signInUrl(configured)}.\nNew users will receive a key during onboarding. Already have an account? Open Keys after signing in.\n`,
  );
  while (true) {
    const pasted = terminal.promptForKey();
    if (pasted === null || pasted.trim().length === 0)
      return { ok: false, message: "[openllm] API key setup cancelled.\n" };
    if (!isUsableApiKey(pasted)) {
      terminal.write("The API key format is invalid. Please try again.\n");
      continue;
    }
    const key = pasted.trim();
    if (!updateEnvFile(key))
      return { ok: false, message: "[openllm] Could not save the API key.\n" };
    process.env.OPENLLM_API_KEY = key;
    terminal.write("API key saved.\n");
    return { ok: true, config: { ...configured, apiKey: key } };
  }
};
