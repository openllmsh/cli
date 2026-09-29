import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  acquireDirLockSync,
  envDirLockCodec,
} from "../../tunnel/session/dir-lock";
import { LegacyLockError } from "../../tunnel/session/dir-lock-control";
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
 * publish is vetoed by an in-flight steal. Release moves the lock to a
 * nonce-qualified quarantine and verifies ownership before deleting it.
 * `start` is the canonical
 * `processStartIdentity` value (`boot:<boot_id>:<ticks>` on Linux, `ps
 * lstart` text on macOS); `-` is a legacy record shape this build never
 * writes, and a live `-` owner holds for the full stale window — never the
 * orphan bound. An ownerless or unmarked lock is HELD only inside the
 * orphan bound (default 30 s) and a legacy `.env.lock` FILE inside the same
 * bound. Keep every rule byte-compatible with the daemon side — the parity
 * tests pin both.
 */
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
    ownerlessMs: envLockOrphanMs(),
    pollMs: 10,
    inode: envLockDirIno,
    startIdentity: envLockStartIdentity,
    ownerStartIdentity: envLockStartIdentity,
    legacyStartIdentity: envLockLegacyStartIdentityProbe,
    isStale: envLockDirIsStale,
    legacyHeld:
      process.platform === "win32"
        ? (): boolean => envLockLegacyHeld(stem, nonce)
        : undefined,
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
  } catch (error) {
    if (error instanceof LegacyLockError) throw error;
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
