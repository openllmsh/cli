/**
 * Self-update — converge the installed binary to the gateway's pinned CLI
 * release, the `openllm` twin of the daemon's converge policy:
 *
 *   - `openllm self-update` fetches `GET /api/cli/version` (the committed
 *     manifest tag the gateway serves), compares with the baked
 *     `CLI_VERSION`, and on ANY difference (upgrade or rollback) downloads
 *     `GET /api/cli/binary/<target>` (302 → gzipped release asset), verifies
 *     the DECOMPRESSED bytes against `<target>.sha256`, and atomically
 *     swaps itself via same-directory rename.
 *   - `0.0.0-dev` source builds never self-update (dev guard).
 */

import { dlopen, FFIType } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { TUpdateRouteConfig } from "@openllmsh/protocol/update-policy";
import {
  evaluateUpdatePolicy,
  mayReplaceProductVersion,
} from "@openllmsh/protocol/update-policy";
import {
  processIdentityStatus,
  processStartIdentity,
} from "../../tunnel/session/local-runtime";
import { acquireUpdateLock, updateLockDirFor } from "../../tunnel/update-lock";
import { CLI_RELEASE } from "../manifest";
import { CLI_TARGETS } from "../release-types";
import { CLI_VERSION, cliConfig, cliUpdateRoute, daemonStateDir } from "./env";

const FETCH_TIMEOUT_MS = 30_000;
// Download bounds (NR2-2, mirrors the daemon updater): the fetch signal only
// bounds CONNECT/first-byte; the body stream gets a STALL bound (no bytes →
// abort) plus a large TOTAL cap so a slow link can still finish. Transport
// failures are transient — they earn backoff, never a rejection (TD-4).
const DOWNLOAD_STALL_MS = 60_000;
const DOWNLOAD_TOTAL_MS = 15 * 60_000;
// Bound on `reader.cancel()` itself: a wedged stream can leave the cancel
// promise unsettled forever, which would hang the updater despite the stall
// bound. The fetch's AbortController is fired first so the socket dies even
// when cancel never resolves.
const DOWNLOAD_CANCEL_MS = 5_000;
/**
 * Hard cap on a downloaded artifact (compressed AND decompressed), mirroring
 * the daemon's self-updater — refuse a hostile/corrupt endpoint before it
 * fills memory.
 */
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
/** Cap on the small `.sha256` digest body. */
const DIGEST_MAX_BYTES = 4_096;
/** Bounds on the pre-swap `<binary> --self-test` health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const HEALTH_PROBE_MAX_BYTES = 4_096;
/** How long a manual update waits on the shared swap lock before giving up. */
const UPDATE_LOCK_WAIT_MS = 30_000;

/** This host's release target suffix (`<os>-<arch>`), or null when the
 *  platform/arch isn't one we publish. `process.arch` reports `arm64` / `x64`;
 *  x64 maps to the `-baseline` variant (the single x64 release target).
 *  Windows is rejected BEFORE the canonical mapping even though `win32-x64` is
 *  a published install target: self-update swaps the running binary via a
 *  same-directory rename, which Windows forbids for a running executable —
 *  matching the daemon's `selfUpdateTargetForHost` (Windows self-update is
 *  unavailable during Phase 2; install a current package instead). The result
 *  is checked against `CLI_TARGETS` so any other unsupported OS (e.g. freebsd)
 *  returns null too — matching `hostTarget()` in `scripts/verify.ts` — letting
 *  the caller fail with a clear message instead of 404ing on a bogus target. */
export const targetSuffix = (
  platform: string = process.platform,
  architecture: string = process.arch,
): string | null => {
  if (platform === "win32") return null;
  const arch =
    architecture === "x64"
      ? "x64-baseline"
      : architecture === "arm64"
        ? "arm64"
        : null;
  if (arch === null) return null;
  const t = `${platform}-${arch}`;
  return (CLI_TARGETS as readonly string[]).includes(t) ? t : null;
};

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Remove quarantine and preserve a valid signature, or ad-hoc sign on macOS. */
export const hardenCliBinary = (
  path: string,
  platform: NodeJS.Platform = process.platform,
): void => {
  if (platform !== "darwin") return;
  try {
    Bun.spawnSync(["xattr", "-dr", "com.apple.quarantine", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // No quarantine attribute or xattr unavailable.
  }
  try {
    const verification = Bun.spawnSync(["codesign", "--verify", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (verification.exitCode === 0) return;
  } catch {
    // Missing or invalid signature; attempt an ad-hoc signature below.
  }
  try {
    Bun.spawnSync(["codesign", "--force", "--sign", "-", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Best effort, matching daemon self-update hardening behavior.
  }
};

export const prepareUpdatedCliBinary = (
  path: string,
  platform: NodeJS.Platform = process.platform,
  harden: (
    binaryPath: string,
    targetPlatform: NodeJS.Platform,
  ) => void = hardenCliBinary,
): void => {
  fs.chmodSync(path, 0o755);
  harden(path, platform);
};

export const mayUpdateCliVersion = (
  currentVersion: string,
  latestVersion: string | null,
  route: TUpdateRouteConfig,
): boolean =>
  mayReplaceProductVersion({ currentVersion, latestVersion, ...route });

/** Self-update downloads + swaps the running binary — the origin must be
 *  HTTPS (plain HTTP only for loopback dev gateways), or a network MITM
 *  could serve both the binary AND the checksum it's verified against. */
export const isSecureOrigin = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

/**
 * A download-stage failure carrying a content-derived discriminator for the
 * artifact that failed (`artifactKey` = sha256 of the bytes actually seen) —
 * used as the rejection key when the advertised digest isn't what failed, so
 * a corrected re-publish of the same version is allowed through.
 */
export class ArtifactFetchError extends Error {
  readonly artifactKey?: string;

  constructor(message: string, artifactKey?: string) {
    super(message);
    this.artifactKey = artifactKey;
  }
}

/**
 * Per-download bounds: stall = no bytes for this long; total = hard cap.
 * `cancelMs` bounds the stream's own `cancel()` promise — a wedged
 * implementation that never settles must not hang the updater past the
 * stall/total verdict that fired.
 */
export type TCliDownloadBounds = {
  readonly stallMs?: number;
  readonly totalMs?: number;
  readonly cancelMs?: number;
};

/**
 * Await a stream teardown promise with its own bound (round-3 rework): a
 * wedged reader can leave `cancel()` unsettled forever, which would hang the
 * updater past the verdict that fired. After the bound we stop waiting —
 * `abort` (the fetch's AbortController) has already killed the socket, so no
 * updater state stays in flight.
 */
const teardownBounded = async (
  pending: Promise<unknown> | undefined,
  cancelMs: number,
): Promise<void> => {
  if (pending === undefined) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      pending.catch(() => {
        // best-effort abort
      }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), cancelMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/**
 * Stream a response body with a hard byte cap — count while reading so an
 * oversized payload is rejected BEFORE it is fully buffered (content-length
 * is an early hint only; a lying endpoint is still caught by the count).
 *
 * NR2-2: the byte cap is joined by a STALL bound (no chunk for `stallMs` →
 * abort) and a TOTAL cap. Both throw plain `Error`s — transport faults are
 * transient (TD-4). Only oversize stays a deterministic `ArtifactFetchError`.
 */
export const readBodyCapped = async (
  res: Response,
  maxBytes: number,
  label: string,
  bounds?: TCliDownloadBounds,
  abort?: () => void,
): Promise<Buffer> => {
  // Hash whatever arrives so an oversize rejection is keyed to the exact
  // bytes that failed (a corrected re-publish yields a different prefix).
  const keyHash = createHash("sha256");
  const cancelMs = bounds?.cancelMs ?? DOWNLOAD_CANCEL_MS;
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort?.();
    await teardownBounded(res.body?.cancel(), cancelMs);
    throw new ArtifactFetchError(`${label} exceeds the ${maxBytes}-byte cap`);
  }
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  const stallMs = bounds?.stallMs ?? DOWNLOAD_STALL_MS;
  const totalMs = bounds?.totalMs ?? DOWNLOAD_TOTAL_MS;
  const deadline = Date.now() + totalMs;
  let total = 0;
  for (;;) {
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const stalled = new Promise<"stalled">((resolve) => {
      stallTimer = setTimeout(() => resolve("stalled"), stallMs);
    });
    try {
      const read = await Promise.race([reader.read(), stalled]);
      if (read === "stalled") {
        abort?.();
        await teardownBounded(reader.cancel(), cancelMs);
        throw new Error(`${label} stalled — no bytes for ${stallMs}ms`);
      }
      if (read.done) break;
      total += read.value.byteLength;
      keyHash.update(read.value);
      if (total > maxBytes) {
        abort?.();
        await teardownBounded(reader.cancel(), cancelMs);
        throw new ArtifactFetchError(
          `${label} exceeds the ${maxBytes}-byte cap`,
          keyHash.digest("hex"),
        );
      }
      if (Date.now() > deadline) {
        abort?.();
        await teardownBounded(reader.cancel(), cancelMs);
        throw new Error(`${label} exceeded its ${totalMs}ms total budget`);
      }
      chunks.push(read.value);
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer);
    }
  }
  return Buffer.concat(chunks);
};

/** The manual remedy printed on a refused update — one clear line. */
const manualRemedy = (gatewayUrl: string): string =>
  `to update manually, re-run the installer: curl -fsSL ${gatewayUrl}/install | bash`;

/**
 * Three-way probe verdict — mirrors the daemon's `TBinaryProbeVerdict`
 * (TD-5/UP-2/FSS-05):
 *  - `ok`           — exit 0 within the bound; `out` is captured output.
 *  - `failed`       — DETERMINISTIC artifact failure: nonzero exit, a crash
 *                     signal (SIGSEGV/SIGBUS/SIGILL/SIGABRT/SIGFPE), or an
 *                     artifact-level spawn refusal (ENOEXEC/ELOOP/EINVAL).
 *  - `inconclusive` — TRANSIENT/environmental: the spawn-level timeout kill,
 *                     a non-crash signal (SIGTERM/SIGKILL), or an
 *                     environmental spawn error (ENOENT/EACCES/EAGAIN/…).
 *                     NEVER a reason to reject — the bytes were not judged.
 */
export type TCliProbeVerdict =
  | { readonly kind: "ok"; readonly out: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "inconclusive"; readonly detail: string };

const CLI_PROBE_CRASH_SIGNALS = new Set([
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGABRT",
  "SIGFPE",
  "SIGSYS",
  "SIGTRAP",
]);
const CLI_PROBE_TRANSIENT_CODES = new Set([
  "EAGAIN",
  "ENOMEM",
  "EMFILE",
  "ENFILE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "EIO",
  "ETXTBSY",
]);

/**
 * Run `<path> <flag>` synchronously and classify the verdict. `TMPDIR` is
 * repointed at the binary's own directory: a missing/unwritable system temp
 * must not decide whether a release is installable (FSS-05).
 */
export const probeCliVerdict = (
  path: string,
  flag: "--version" | "--self-test",
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): TCliProbeVerdict => {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = spawn([path, flag], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: HEALTH_PROBE_TIMEOUT_MS,
      maxBuffer: HEALTH_PROBE_MAX_BYTES,
      // FSS-05: a missing/unwritable TMPDIR must not break the probe — use
      // the binary's own directory (proven writable by the staged file).
      env: { ...process.env, TMPDIR: dirname(path) },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && CLI_PROBE_TRANSIENT_CODES.has(code)) {
      return { kind: "inconclusive", detail: `probe spawn failed: ${code}` };
    }
    return {
      kind: "failed",
      detail: `probe spawn failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const signal = proc.signalCode;
  if (signal !== null && signal !== undefined) {
    return CLI_PROBE_CRASH_SIGNALS.has(signal)
      ? { kind: "failed", detail: `probe crashed on ${signal}` }
      : { kind: "inconclusive", detail: `probe killed by ${signal}` };
  }
  if (proc.exitCode !== 0) {
    return { kind: "failed", detail: `probe exited ${proc.exitCode}` };
  }
  const out = Buffer.concat([
    proc.stdout ?? Buffer.alloc(0),
    proc.stderr ?? Buffer.alloc(0),
  ])
    .toString("utf-8")
    .slice(0, HEALTH_PROBE_MAX_BYTES);
  return { kind: "ok", out };
};

/**
 * Pre-swap health probe (TCB-3): run the staged binary's `--self-test` — NOT
 * `--version`, which exits before the lazy command graph loads and therefore
 * can't catch a binary that crashes on every real command — with a bounded
 * timeout and bounded output, and require it to report the version we
 * intended to install. Returns the parsed version (or null when the binary
 * won't exec, fails the self-test, or reports nothing parseable). Exported
 * for tests.
 */
export const probeCliHealth = (
  path: string,
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): string | null => {
  const verdict = probeCliVerdict(path, "--self-test", spawn);
  if (verdict.kind !== "ok") return null;
  return verdict.out.match(/openllmc? v(\S+)/)?.[1] ?? null;
};

// ── Daemon state-file markers ────────────────────────────────────────────────
// `<stateDir>/state.json` is owned by the daemon (`packages/daemon/src/
// state-file.ts`), but a manual update MUST write the same markers the
// converger does: `updateAttempts.cli` is what lets the daemon's recovery
// path restore `.prev` and pin a bad version rejected when the CLI we just
// installed won't run, and `rejectedUpdates.cli` keeps a deterministic
// failure from being retried forever. Only these two fields are touched —
// every other top-level key is passed through untouched (read-modify-write
// with a pid-suffixed temp + rename, same atomicity contract as the daemon).
// The marker write happens under the swap lock, so it can't interleave with
// the converger's own mutation of the same fields.

/** Mirror of the daemon's first-failure backoff delay (its 15-minute base). */
const CLI_ATTEMPT_RETRY_AFTER_MS = 15 * 60 * 1000;
/** Bound on the per-slot rejected list, matching `REJECTED_UPDATES_MAX`. */
const REJECTED_MAX = 16;

type TJsonObject = Record<string, unknown>;

/** A rejection entry as stored in `rejectedUpdates.<slot>` (round-3 shape). */
type TCliRejectedUpdate = {
  readonly version: string;
  /** Artifact sha256, or `""` for legacy/artifact-unknown rejects (wildcard). */
  readonly digest: string;
};

const daemonStateFilePath = (): string => join(daemonStateDir(), "state.json");

/**
 * Fail-closed suspension (round-3): a state dir lands here the moment ANY
 * `state.json` write fails. While listed, this process refuses to update —
 * an unpersisted reject means another process can retry the same bad
 * artifact, so joining the churn is unsafe. Cleared by the next successful
 * write probe (a transient full-disk window self-heals).
 */
const suspendedStateDirs = new Set<string>();

/**
 * Exported for tests. While suspended, probes a real write — the first
 * success lifts the suspension (mirrors the daemon's `autoUpdateSuspended`).
 */
export const updateStateSuspended = (): boolean => {
  const dir = daemonStateDir();
  if (!suspendedStateDirs.has(dir)) return false;
  if (mutateDaemonState((s) => s)) {
    suspendedStateDirs.delete(dir);
    return false;
  }
  return true;
};

/**
 * Process-local rejection mirror per state dir — a reject that could not be
 * persisted still blocks THIS artifact for the rest of the process (the
 * persisted record protects other processes). Keyed `"<version>\0<digest>"`.
 */
const memoryRejectedByDir = new Map<string, Set<string>>();

const memoryRejectedFor = (dir: string): Set<string> => {
  const existing = memoryRejectedByDir.get(dir);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  memoryRejectedByDir.set(dir, created);
  return created;
};

const rejectedMemoryKey = (version: string, digest: string): string =>
  `${version}${digest}`;

// ── Cross-process state lock ────────────────────────────────────────────────
// FSS-08: `state.json` is written by BOTH this CLI (`self-update` markers)
// and the daemon (every other field). With no shared lock, concurrent
// read-modify-write cycles silently dropped records — the audit measured
// 102–180 of 400 writes lost. Every mutation serializes behind
// `<stateDir>/state.json.lock.d` — a mkdir lock mirroring
// `packages/tunnel/update-lock.ts` (owner record, quarantine steal,
// nonce-verified release) but SYNCHRONOUS, because these writes happen from
// sync code paths. MIRROR of the daemon copy in
// `packages/daemon/src/state-file.ts` — KEEP THE TWO IN SYNC.
//
// Steal policy (round-3 rework): a PROVEN-LIVE owner — live pid AND matching
// recorded start identity — is NEVER stolen, however old the dir. A paused
// holder keeps its lock; the alternative was forced steals that corrupted
// read-modify-write cycles (lost boot history, rejects, device state). Only a
// provably-gone owner (dead pid, or a reused pid whose live start identity no
// longer matches the record) is stolen outright. An owner that can neither be
// convicted nor proven live (no recorded start, inconclusive probe, or no
// readable record at all) is UNPROVEN: still held, but reclaimed once the dir
// has shown no complete owner for STATE_LOCK_RECLAIM_MS — a crash between
// mkdir and publish can then never wedge every writer forever.
const STATE_LOCK_DIR_NAME = "state.json.lock.d";
const STATE_LOCK_OWNER_KIND = "openllm-state-lock/v1";
const STATE_LOCK_OWNER_FILE = "owner.json";
const STATE_LOCK_WAIT_MS = 2_000;
const STATE_LOCK_POLL_MS = 10;
const STATE_LOCK_RECLAIM_MS = 10 * 60_000;

type TStateLockOwner = {
  readonly kind: string;
  readonly pid: number;
  /**
   * The owner's process-start identity (`processStartIdentity`). "" means the
   * owner could not self-probe — liveness alone must not promote such a
   * record to proven-live: a REUSED pid would otherwise inherit the dead
   * owner's lock forever.
   */
  readonly start: string;
  readonly nonce: string;
};

/** Nonces this process currently holds — detects same-process re-entry. */
const ourStateLockNonces = new Set<string>();
/** In-process nesting depth — a mutate inside a mutate reuses the held lock. */
let stateLockDepth = 0;
const stateLockWaitBuf = new Int32Array(new SharedArrayBuffer(4));

const stateLockSleep = (ms: number): void => {
  try {
    Atomics.wait(stateLockWaitBuf, 0, 0, ms);
  } catch {
    // best-effort — a refused wait just shortens one poll
  }
};

const stateLockPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const cliStateLockDir = (): string =>
  join(daemonStateDir(), STATE_LOCK_DIR_NAME);

const readStateLockOwner = (dir: string): TStateLockOwner | null => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(join(dir, STATE_LOCK_OWNER_FILE), "utf-8"),
    ) as Partial<TStateLockOwner>;
    if (
      parsed.kind !== STATE_LOCK_OWNER_KIND ||
      typeof parsed.pid !== "number" ||
      typeof parsed.nonce !== "string"
    )
      return null;
    return {
      kind: parsed.kind,
      pid: parsed.pid,
      start: typeof parsed.start === "string" ? parsed.start : "",
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
};

const stateLockAgeMs = (dir: string): number => {
  try {
    return Math.max(0, Date.now() - fs.statSync(dir).mtimeMs);
  } catch {
    return 0;
  }
};

/**
 * This process's start identity, cached — it cannot change. "" when the
 * self-probe is unavailable: our record then stays UNPROVEN for readers
 * (reclaimable by age) rather than unverifiable-forever.
 */
let ownStateLockStart: string | null = null;
const myStateLockStart = (): string => {
  if (ownStateLockStart !== null) return ownStateLockStart;
  let start: string;
  try {
    start = processStartIdentity(process.pid) ?? "";
  } catch {
    start = "";
  }
  ownStateLockStart = start;
  return start;
};

type TStateLockVerdict = "stale" | "proven-live" | "unproven";

/**
 * Three-way verdict for a recorded owner — mirrors `classifyOwner` in
 * `packages/tunnel/update-lock.ts`:
 *   - `proven-live` — the pid is alive AND its live start identity matches
 *     the record. Never stolen, whatever the dir's age.
 *   - `stale` — the pid is confirmed dead, or alive but a DIFFERENT process
 *     (PID reuse: the live identity no longer matches the recorded start).
 *   - `unproven` — live but unverifiable (empty recorded start, or an
 *     inconclusive probe). Held; stealable only past the reclaim bound.
 */
const classifyStateLockOwner = (owner: TStateLockOwner): TStateLockVerdict => {
  if (owner.start !== "") {
    // Compare through `processIdentityStatus`, never raw string equality:
    // it normalizes `ps lstart` whitespace, so a record written in padded
    // (legacy) form still matches its live owner — a raw `===` would
    // convict it as PID reuse and steal a live lock. The shared reader is
    // also where the clock-independent Linux identity lands (a wall-clock
    // step must never make a live owner look dead).
    const status = processIdentityStatus(owner.pid, owner.start);
    if (status === "alive") return "proven-live";
    if (status === "dead") return "stale"; // dead pid, or a reused one
    // "unknown" — the probe could not judge; fall through to liveness.
  } else {
    // No recorded start to compare: the raw probe is only a dead/alive
    // oracle here (null = confirmed dead). A LIVE pid with nothing to
    // compare stays UNPROVEN — never promoted on liveness alone, or a
    // reused pid would inherit the dead owner's lock forever.
    let probe: string | null | undefined;
    try {
      probe = processStartIdentity(owner.pid);
    } catch {
      probe = undefined;
    }
    if (probe === null) return "stale";
  }
  return stateLockPidAlive(owner.pid) ? "unproven" : "stale";
};

const stealStateLock = (
  lockDir: string,
  owner: TStateLockOwner | null,
): boolean => {
  const quarantine = `${lockDir}.stale-${randomBytes(8).toString("hex")}`;
  try {
    fs.renameSync(lockDir, quarantine);
  } catch {
    return false;
  }
  const current = readStateLockOwner(quarantine);
  if (current !== null && current.nonce !== owner?.nonce) {
    try {
      fs.renameSync(quarantine, lockDir);
    } catch {
      // best-effort — residue is reclaimed by age below
    }
    return false;
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // best-effort — residue is reclaimed by age below
  }
  return true;
};

const sweepStateLockResidue = (): void => {
  let entries: string[];
  try {
    entries = fs.readdirSync(daemonStateDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.startsWith(`${STATE_LOCK_DIR_NAME}.stale-`) ||
      entry.startsWith(`${STATE_LOCK_DIR_NAME}.rel-`)
    ) {
      if (stateLockAgeMs(join(daemonStateDir(), entry)) < STATE_LOCK_RECLAIM_MS)
        continue;
      try {
        fs.rmSync(join(daemonStateDir(), entry), {
          recursive: true,
          force: true,
        });
      } catch {
        // best-effort
      }
      continue;
    }
    const match = /^\.state\.json\.(\d+)\.tmp$/.exec(entry);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid > 0 && stateLockPidAlive(pid)) continue;
    try {
      fs.rmSync(join(daemonStateDir(), entry), { force: true });
    } catch {
      // best-effort
    }
  }
};

/**
 * Acquire the cross-process `state.json` write lock — the same
 * `state.json.lock.d` the daemon takes. Returns a release function, or null
 * when the lock stays held until `waitMs`. Never throws. KEEP IN SYNC with
 * `acquireStateLock` in `packages/daemon/src/state-file.ts`.
 */
export const acquireCliStateLock = (opts?: {
  waitMs?: number;
}): (() => void) | null => {
  const waitMs = opts?.waitMs ?? STATE_LOCK_WAIT_MS;
  const ours: TStateLockOwner = {
    kind: STATE_LOCK_OWNER_KIND,
    pid: process.pid,
    start: myStateLockStart(),
    nonce: randomBytes(16).toString("hex"),
  };
  const lockDir = cliStateLockDir();
  const deadline = Date.now() + waitMs;
  // Per-call verdict cache: a contested acquire polls every few ms, and one
  // `ps` identity probe per pass would dominate the wait. An owner record is
  // immutable per nonce, so one classify per record is enough.
  const verdicts = new Map<string, TStateLockVerdict>();
  let swept = false;
  for (;;) {
    try {
      fs.mkdirSync(daemonStateDir(), { recursive: true });
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(
          join(lockDir, STATE_LOCK_OWNER_FILE),
          JSON.stringify(ours),
        );
      } catch {
        // best-effort — an unpublished owner is unproven, still reclaimable
      }
      ourStateLockNonces.add(ours.nonce);
      // Sweep stale quarantine dirs + dead-pid temps on EVERY clean acquire —
      // otherwise they are only reaped on a contested acquire and residue
      // grows without bound (round-3).
      sweepStateLockResidue();
      return () => {
        ourStateLockNonces.delete(ours.nonce);
        const quarantine = `${lockDir}.rel-${ours.nonce}`;
        try {
          fs.renameSync(lockDir, quarantine);
        } catch {
          return;
        }
        const moved = readStateLockOwner(quarantine);
        if (moved !== null && moved.nonce === ours.nonce) {
          try {
            fs.rmSync(quarantine, { recursive: true, force: true });
          } catch {
            // best-effort — residue is reclaimed by the sweeps
          }
        } else {
          try {
            fs.renameSync(quarantine, lockDir);
          } catch {
            // best-effort
          }
        }
        sweepStateLockResidue();
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return null;
      }
    }
    if (!swept) {
      swept = true;
      sweepStateLockResidue();
    }
    const owner = readStateLockOwner(lockDir);
    if (owner !== null && ourStateLockNonces.has(owner.nonce)) {
      return null;
    }
    let verdict: TStateLockVerdict;
    if (owner === null) {
      verdict = "unproven";
    } else {
      const cached = verdicts.get(owner.nonce);
      if (cached !== undefined) {
        verdict = cached;
      } else {
        verdict = classifyStateLockOwner(owner);
        verdicts.set(owner.nonce, verdict);
      }
    }
    // NEVER steal a live verified owner — a paused holder keeps its lock
    // however long the pause. Steal only a provably-gone owner, or a dir that
    // has shown no complete provable owner past the reclaim bound.
    const wedged = stateLockAgeMs(lockDir) >= STATE_LOCK_RECLAIM_MS;
    if (
      (verdict === "stale" || (verdict === "unproven" && wedged)) &&
      stealStateLock(lockDir, owner)
    ) {
      verdicts.clear(); // the dir changed hands — old verdicts no longer apply
      continue;
    }
    if (Date.now() >= deadline) return null;
    stateLockSleep(STATE_LOCK_POLL_MS);
  }
};

/**
 * Read-modify-write `state.json` atomically AND serialized across processes
 * (FSS-08: the daemon holds the same `state.json.lock.d` for every write).
 * Best-effort: false on any error.
 */
const mutateDaemonState = (fn: (s: TJsonObject) => TJsonObject): boolean => {
  const write = (): boolean => {
    const path = daemonStateFilePath();
    const tmp = join(dirname(path), `.state.json.${process.pid}.tmp`);
    try {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
      } catch {
        parsed = {};
      }
      const base: TJsonObject =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as TJsonObject)
          : {};
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(fn(base)), { mode: 0o600 });
      fs.renameSync(tmp, path);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      return false;
    }
  };
  if (stateLockDepth > 0) return write();
  const release = acquireCliStateLock();
  if (release === null) return false;
  stateLockDepth += 1;
  try {
    return write();
  } finally {
    stateLockDepth -= 1;
    release();
  }
};

/**
 * Prove `state.json` is writable BEFORE downloading anything: if the safety
 * state cannot be persisted, a deterministic-failure reject would protect
 * nobody — fail closed and refuse the update entirely.
 */
const probeUpdateStateWritable = (): boolean => {
  const dir = daemonStateDir();
  const ok = mutateDaemonState((s) => s);
  if (ok) suspendedStateDirs.delete(dir);
  else suspendedStateDirs.add(dir);
  return ok;
};

const isJsonObject = (v: unknown): v is TJsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const coerceRejectionEntry = (v: unknown): TCliRejectedUpdate | null => {
  // Legacy entries were bare version strings — treat as artifact-unknown
  // rejects (blank digest = wildcard, still blocks the version outright).
  if (typeof v === "string")
    return v.length > 0 ? { version: v, digest: "" } : null;
  if (
    isJsonObject(v) &&
    typeof v.version === "string" &&
    v.version.length > 0
  ) {
    return {
      version: v.version,
      digest: typeof v.digest === "string" ? v.digest : "",
    };
  }
  return null;
};

/**
 * Read the CLI slot's rejection list from `state.json`, understanding both
 * the per-slot `{daemon:[], cli:[]}` shape and the legacy flat string array
 * (product-ambiguous — applies to the CLI too).
 */
const readCliRejections = (): TCliRejectedUpdate[] => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(daemonStateFilePath(), "utf-8"),
    );
    if (!isJsonObject(parsed)) return [];
    const raw = parsed.rejectedUpdates;
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : isJsonObject(raw) && Array.isArray(raw.cli)
        ? raw.cli
        : [];
    return list
      .map(coerceRejectionEntry)
      .filter((e): e is TCliRejectedUpdate => e !== null);
  } catch {
    return [];
  }
};

/**
 * True when `(version, digest)` is rejected — an exact digest entry blocks
 * that artifact only; a blank-digest entry blocks every artifact of the
 * version. A digest-less query matches only blank-digest entries (a
 * version-only pre-check must not hide a corrected re-publish).
 */
export const isCliUpdateRejected = (
  version: string,
  digest?: string,
): boolean => {
  const memory = memoryRejectedFor(daemonStateDir());
  if (
    memory.has(rejectedMemoryKey(version, digest ?? "")) ||
    (digest !== undefined && memory.has(rejectedMemoryKey(version, "")))
  ) {
    return true;
  }
  return readCliRejections().some(
    (e) =>
      e.version === version &&
      (e.digest === "" || (digest !== undefined && e.digest === digest)),
  );
};

/**
 * Record `updateAttempts.cli` — the SAME shape the daemon's `recordAttempt`
 * writes — so a manual update is visible to the daemon's recovery path and
 * its `recentlyAttempted` backoff gate. `digest` is the artifact sha256 the
 * attempt ran against (omitted when unknown).
 */
export const recordCliUpdateAttempt = (
  version: string,
  digest?: string,
): void => {
  const ok = mutateDaemonState((s) => {
    const attempts = isJsonObject(s.updateAttempts) ? s.updateAttempts : {};
    const prev = isJsonObject(attempts.cli) ? attempts.cli : {};
    const failures =
      (prev.version === version && typeof prev.failures === "number"
        ? prev.failures
        : 0) + 1;
    return {
      ...s,
      updateAttempts: {
        ...attempts,
        cli: {
          version,
          ts: Date.now(),
          failures,
          retryAfterMs: CLI_ATTEMPT_RETRY_AFTER_MS,
          ...(digest !== undefined && digest.length > 0 ? { digest } : {}),
        },
      },
    };
  });
  if (!ok) suspendedStateDirs.add(daemonStateDir());
};

/**
 * Pin `(version, digest)` rejected for the CLI slot — written for the same
 * reason the daemon rejects: a deterministic artifact failure or a failed
 * health probe can never heal by re-downloading the same bytes. `digest` is
 * the advertised artifact sha256 when known; a content-derived key (sha256 of
 * the bytes that failed) when the advertised digest itself was unreadable; or
 * `""` for an artifact-unknown reject. A corrected re-publish of the same
 * version advertises a different digest and is allowed. The reject lands in
 * the process-local mirror BEFORE persistence so a failed write still blocks
 * this artifact for the rest of the process (fail closed).
 */
export const rejectCliUpdateVersion = (
  version: string,
  digest: string = "",
): boolean => {
  const dir = daemonStateDir();
  memoryRejectedFor(dir).add(rejectedMemoryKey(version, digest));
  const ok = mutateDaemonState((s) => {
    const raw = s.rejectedUpdates;
    const base: TJsonObject = Array.isArray(raw)
      ? // Legacy flat list was product-ambiguous — carry it on both slots.
        {
          daemon: raw.map(coerceRejectionEntry).filter((e) => e !== null),
          cli: raw.map(coerceRejectionEntry).filter((e) => e !== null),
        }
      : isJsonObject(raw)
        ? raw
        : {};
    const cli: TCliRejectedUpdate[] = (Array.isArray(base.cli) ? base.cli : [])
      .map(coerceRejectionEntry)
      .filter((e): e is TCliRejectedUpdate => e !== null);
    const ix = cli.findIndex(
      (e) => e.version === version && e.digest === digest,
    );
    if (ix !== -1) cli.splice(ix, 1);
    // Refresh to the tail so the CURRENTLY advertised bad artifact is the
    // last eviction candidate — it is never silently evicted.
    cli.push({ version, digest });
    return {
      ...s,
      rejectedUpdates: { ...base, cli: cli.slice(-REJECTED_MAX) },
    };
  });
  if (!ok) suspendedStateDirs.add(dir);
  return ok;
};

/** Test-only: drop every in-memory fallback record. Never called in production. */
export const clearCliUpdateGuardsForTests = (): void => {
  memoryRejectedByDir.clear();
  suspendedStateDirs.clear();
  ourStateLockNonces.clear();
};

// ── Atomic swap ──────────────────────────────────────────────────────────────

/**
 * Write `<self>.prev` ATOMICALLY (temp + fsync + rename, mode-preserving) —
 * the rollback copy the daemon's self-heal restores if the new binary won't
 * run. A torn `.prev` (power loss, disk-full mid-copy) is worse than none:
 * the restore path now probes it before swapping it back.
 */
const writePrevBinaryAtomic = (src: string, prev: string): void => {
  const tmp = `${prev}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    const fd = fs.openSync(tmp, "r");
    try {
      fsyncFdSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, prev);
    fsyncDirBestEffort(dirname(prev));
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }
};

/**
 * macOS `fcntl(fd, F_FULLFSYNC)` — <fcntl.h> command 51. Darwin's fsync(2)
 * only hands bytes to the drive's write cache; F_FULLFSYNC is the barrier
 * that lands them on stable storage, which is the crash durability FSS-18
 * requires. Bound lazily out of libSystem; the `fullSync` seam on
 * {@link fsyncFdSync} exercises the darwin branch off-mac. MIRRORS the
 * daemon copy in `packages/daemon/src/self-update.ts` — keep in sync.
 */
const DARWIN_F_FULLFSYNC = 51;

/** The bound `fcntl(fd, F_FULLFSYNC, 0)` call, or null when it cannot load. */
type TDarwinFullSync = (fd: number) => number;

let cachedDarwinFullSync: TDarwinFullSync | null | undefined;

const loadDarwinFullSync = (): TDarwinFullSync | null => {
  if (cachedDarwinFullSync !== undefined) return cachedDarwinFullSync;
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      fcntl: {
        // fcntl is variadic; F_FULLFSYNC ignores the third argument.
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    const fcntl = lib.symbols.fcntl;
    cachedDarwinFullSync = (fd) => fcntl(fd, DARWIN_F_FULLFSYNC, 0);
  } catch {
    cachedDarwinFullSync = null;
  }
  return cachedDarwinFullSync;
};

/**
 * Flush an open descriptor to stable storage (FSS-18). Darwin needs
 * fcntl(F_FULLFSYNC): a plain fsync(2) can leave the bytes in the drive's
 * volatile write cache, so a power loss after the swap could still
 * resurrect the old binary or lose both. An unavailable or refused
 * F_FULLFSYNC falls back to fsync(2) — a weaker barrier, never a new
 * failure mode. Throws only on a real fsync failure.
 *
 * `platform`/`fullSync` are the test seam for the darwin branch: pass
 * `"darwin"` with a recording stub to observe the F_FULLFSYNC call, or
 * `null` to simulate a missing symbol. `undefined` binds real libc.
 */
export const fsyncFdSync = (
  fd: number,
  platform: NodeJS.Platform = process.platform,
  fullSync: TDarwinFullSync | null | undefined = undefined,
): void => {
  if (platform === "darwin") {
    const fcntl = fullSync === undefined ? loadDarwinFullSync() : fullSync;
    if (fcntl !== null) {
      try {
        if (fcntl(fd) === 0) return;
      } catch {
        // refused/faulted — fsync(2) below is still a real barrier
      }
    }
  }
  fs.fsyncSync(fd);
};

/** fsync one file's bytes to stable storage. Throws on failure (FSS-18). */
export const fsyncFileSync = (
  path: string,
  platform: NodeJS.Platform = process.platform,
  fullSync?: TDarwinFullSync | null,
): void => {
  const fd = fs.openSync(path, "r");
  try {
    fsyncFdSync(fd, platform, fullSync);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * fsync a directory so rename dirents survive a crash (FSS-18) — on darwin
 * the same F_FULLFSYNC barrier applies to the dir fd. Best-effort.
 */
export const fsyncDirBestEffort = (
  dir: string,
  platform: NodeJS.Platform = process.platform,
  fullSync?: TDarwinFullSync | null,
): void => {
  try {
    fsyncFileSync(dir, platform, fullSync);
  } catch {
    // best-effort — a filesystem without directory fsync
  }
};

// Staging-temp name shapes swept on update start (FSS-16/FSS-17): a dead
// updater's temp is an orphan keyed by its pid — live pids are never touched.
const UPDATE_TEMP_RE =
  /^\.openllm[cd]?\.(?:update|prev)\.(\d+)(?:\.[^.]*)?\.tmp$/;
const CLI_NEXT_TEMP_RE = /^\.openllm\.next-(\d+)(?:-.*)?$/;

/**
 * Remove staging temps in `dir` left by a DEAD updater process. Best-effort;
 * never throws. Mirrors `sweepStaleUpdateTemps` in the daemon's self-update.
 */
export const sweepStaleUpdateTemps = (dir: string): void => {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = UPDATE_TEMP_RE.exec(entry) ?? CLI_NEXT_TEMP_RE.exec(entry);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!(pid > 0) || stateLockPidAlive(pid)) continue;
    try {
      fs.rmSync(join(dir, entry), { force: true });
    } catch {
      // best-effort residue cleanup
    }
  }
};

export type TCliSwapOutcome =
  | "updated"
  | "probe-failed"
  /** The staged probe could not judge the bytes (timeout/kill/env) — transient. */
  | "probe-inconclusive"
  | "backup-failed"
  /** The staged file could not be written/fsync'd durably. */
  | "stage-failed"
  /** Another updater already landed `latest` while we downloaded (UP-4). */
  | "converged"
  /** The installed file changed under our download — owned by someone else. */
  | "changed"
  | "busy";

/** Probe the INSTALLED binary's `--version` verdict (UP-4 in-lock re-check). */
const probeInstalledCliVerdict = (
  path: string,
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): TCliProbeVerdict => probeCliVerdict(path, "--version", spawn);

const parseCliVersionOut = (out: string): string | null =>
  out.match(/openllmc? v(\S+)/)?.[1] ?? null;

/**
 * The serialized swap region for a verified staged binary: acquire the shared
 * cross-process lock (same dir the daemon converger uses), RE-READ the
 * installed version inside it (UP-4 — a daemon converger or another manual
 * update that landed during our download must not be overwritten), health-
 * probe the staged binary, atomically back the current binary up to `.prev`
 * (FAIL CLOSED — no backup, no swap), rename it in, and record the attempt
 * marker. Exported for tests; `runSelfUpdate` maps the outcome to messages
 * + codes.
 */
export const commitCliSwap = async (args: {
  /** The running binary's path (`process.execPath`). */
  readonly self: string;
  /** The downloaded+verified staged binary to swap in. */
  readonly staged: string;
  readonly latest: string;
  readonly digest?: string;
  readonly probe?: (path: string) => string | null;
  /** Test seam: verdict-shaped staged probe (expresses `inconclusive`). */
  readonly probeVerdict?: (
    path: string,
    flag: "--version" | "--self-test",
  ) => TCliProbeVerdict;
  /**
   * Test seam: installed-version probe for the UP-4 re-check. A null return
   * means the probe could not judge the installed file — treated as
   * inconclusive (`busy`), never as "unchanged".
   */
  readonly probeInstalled?: (path: string) => string | null;
  /**
   * Test seam: verdict-shaped installed probe — expresses the difference
   * between an inconclusive probe (`busy`) and a provably broken installed
   * binary (proceed: overwriting it heals, never clobbers a working update).
   */
  readonly probeInstalledVerdict?: (path: string) => TCliProbeVerdict;
  /** The version `self` reported when this update began — defaults to
   *  `CLI_VERSION` (this process IS that binary). */
  readonly expectedInstalled?: string;
  readonly lockWaitMs?: number;
  /**
   * Test seam: observe/override the durability steps (FSS-18). The required
   * order is fsync file → probe → backup → rename → fsync dir.
   */
  readonly hooks?: {
    readonly fsyncFile?: (path: string) => void;
    readonly fsyncDir?: (dir: string) => void;
    readonly onWarn?: (message: string) => void;
  };
}): Promise<TCliSwapOutcome> => {
  const fsyncFile = args.hooks?.fsyncFile ?? fsyncFileSync;
  const fsyncDir = args.hooks?.fsyncDir ?? fsyncFileSync;
  const onWarn =
    args.hooks?.onWarn ??
    ((message: string) => process.stderr.write(`[self-update] ${message}\n`));
  const release = await acquireUpdateLock(updateLockDirFor(args.self), {
    waitMs: args.lockWaitMs ?? UPDATE_LOCK_WAIT_MS,
  });
  if (release === null) return "busy";
  try {
    // UP-4: inside the lock, re-check what `self` reports NOW. A converger or
    // manual run that landed `latest` while we downloaded wins — return
    // converged; a file changed to anything else is owned by someone else.
    // An INCONCLUSIVE probe (timeout/transient spawn failure) cannot prove
    // what is installed — return busy rather than overwrite on unproven
    // evidence (round-3). Only a `failed` verdict (the installed binary
    // provably cannot run) falls through to the swap: overwriting heals it.
    let installed: string | null;
    if (args.probeInstalledVerdict !== undefined) {
      const verdict = args.probeInstalledVerdict(args.self);
      if (verdict.kind === "inconclusive") return "busy";
      installed =
        verdict.kind === "ok" ? parseCliVersionOut(verdict.out) : null;
    } else if (args.probeInstalled !== undefined) {
      installed = args.probeInstalled(args.self);
      if (installed === null) return "busy";
    } else {
      const verdict = probeInstalledCliVerdict(args.self);
      if (verdict.kind === "inconclusive") return "busy";
      installed =
        verdict.kind === "ok" ? parseCliVersionOut(verdict.out) : null;
    }
    if (installed === args.latest) return "converged";
    if (
      installed !== null &&
      installed !== (args.expectedInstalled ?? CLI_VERSION)
    ) {
      return "changed";
    }
    // FSS-18: fsync the staged bytes before the rename lands on `self`.
    try {
      fsyncFile(args.staged);
    } catch {
      return "stage-failed";
    }
    if (args.probeVerdict !== undefined) {
      const verdict = args.probeVerdict(args.staged, "--self-test");
      if (verdict.kind === "inconclusive") return "probe-inconclusive";
      const probed =
        verdict.kind === "ok"
          ? (verdict.out.match(/openllmc? v(\S+)/)?.[1] ?? null)
          : null;
      if (probed !== args.latest) return "probe-failed";
    } else if ((args.probe ?? probeCliHealth)(args.staged) !== args.latest) {
      return "probe-failed";
    }
    try {
      writePrevBinaryAtomic(args.self, `${args.self}.prev`);
    } catch {
      return "backup-failed";
    }
    fs.renameSync(args.staged, args.self);
    // FSS-18: fsync the directory so the rename's dirent survives a crash —
    // the LAST filesystem step, after which nothing mutates the install dir.
    // A refusal does not un-swap the binary, but it must not be silent.
    try {
      fsyncDir(dirname(args.self));
    } catch (err) {
      onWarn(
        `post-swap directory fsync failed — openllm v${args.latest} is installed but not proven crash-durable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    recordCliUpdateAttempt(args.latest, args.digest);
    return "updated";
  } finally {
    release();
  }
};

/** Result of the manual download+verify+swap — `runSelfUpdate` prints it. */
export type TManualUpdateResult =
  | { readonly code: 0; readonly out: string }
  | { readonly code: 1; readonly err: string };

/**
 * Download → verify → stage → commit the CLI update for `latest`/`target`
 * against `gatewayUrl`. Separated from `runSelfUpdate` so tests can drive it
 * without `process.exit`. TD-4: a TRANSPORT failure (HTTP error, socket
 * drop, stall/total timeout, unreadable checksum stream) only records the
 * attempt — rejections are reserved for what the bytes themselves prove
 * (checksum mismatch, oversize, bad gzip, deterministic probe failure).
 */
export const applyManualCliUpdate = async (args: {
  readonly gatewayUrl: string;
  readonly latest: string;
  readonly target: string;
  /** Test override: the binary to replace (defaults to this execPath). */
  readonly self?: string;
  readonly download?: TCliDownloadBounds & { readonly connectMs?: number };
  readonly probeVerdict?: (
    path: string,
    flag: "--version" | "--self-test",
  ) => TCliProbeVerdict;
  readonly probeInstalled?: (path: string) => string | null;
  readonly probeInstalledVerdict?: (path: string) => TCliProbeVerdict;
  /** The version `self` reported when this update began — defaults to
   *  `CLI_VERSION` (this process IS that binary). */
  readonly expectedInstalled?: string;
  readonly lockWaitMs?: number;
  /**
   * Test seam: observe/override the durability + prepare steps (FSS-18). The
   * required order is stage → prepare (chmod+harden) → fsync file → probe →
   * backup → rename → fsync dir.
   */
  readonly hooks?: {
    readonly fsyncFile?: (path: string) => void;
    readonly fsyncDir?: (dir: string) => void;
    readonly prepare?: (path: string) => void;
    readonly onWarn?: (message: string) => void;
  };
}): Promise<TManualUpdateResult> => {
  const { gatewayUrl, latest, target } = args;
  const connectMs = args.download?.connectMs ?? FETCH_TIMEOUT_MS;

  // The tiny digest fetch comes FIRST: the advertised artifact sha256 is the
  // rejection key, so it must be known before the ~40 MB binary download is
  // spent on an artifact already proven bad. HTTP/transport failures here are
  // transient (TD-4): record the try, back off, never reject.
  // The AbortController bounds the connect AND survives into the body read:
  // `readBodyCapped` fires it when a stall/total verdict must kill the socket
  // even if the stream's own cancel never settles.
  const shaCtrl = new AbortController();
  const shaConnectTimer = setTimeout(() => shaCtrl.abort(), connectMs);
  let shaRes: Response;
  try {
    shaRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}.sha256`, {
      signal: shaCtrl.signal,
    });
  } catch (err) {
    recordCliUpdateAttempt(latest);
    return {
      code: 1,
      err: `[self-update] checksum fetch failed: ${
        err instanceof Error ? err.message : String(err)
      } — will retry later\n`,
    };
  } finally {
    clearTimeout(shaConnectTimer);
  }
  if (!shaRes.ok) {
    recordCliUpdateAttempt(latest);
    return {
      code: 1,
      err: `[self-update] checksum fetch failed: ${shaRes.status} — will retry later\n`,
    };
  }
  let digestBody: string;
  try {
    digestBody = (
      await readBodyCapped(
        shaRes,
        DIGEST_MAX_BYTES,
        "checksum download",
        args.download,
        () => shaCtrl.abort(),
      )
    )
      .toString("utf-8")
      .trim();
  } catch (err) {
    if (err instanceof ArtifactFetchError) {
      // Oversized digest body — deterministic; reject keyed to the bytes that
      // failed so a corrected re-publish is allowed through.
      const key = err.artifactKey ?? "";
      rejectCliUpdateVersion(latest, key);
      recordCliUpdateAttempt(latest, key.length > 0 ? key : undefined);
    } else {
      // Stream error / stall / total-cap — transient transport (TD-4).
      recordCliUpdateAttempt(latest);
    }
    return {
      code: 1,
      err: `[self-update] ${err instanceof Error ? err.message : String(err)} — aborting\n`,
    };
  }
  const expected = (digestBody.split(/\s+/)[0] ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    // Key the reject to sha256 of the BAD BODY — a corrected re-publish
    // serves a valid digest, hashes differently, and is allowed through.
    const key = createHash("sha256").update(digestBody).digest("hex");
    rejectCliUpdateVersion(latest, key);
    recordCliUpdateAttempt(latest, key);
    return {
      code: 1,
      err: "[self-update] checksum response was not a sha-256 digest — aborting\n",
    };
  }
  if (isCliUpdateRejected(latest, expected)) {
    // This exact advertised artifact already failed deterministic checks on
    // this host — a corrected re-publish advertises a different digest.
    recordCliUpdateAttempt(latest, expected);
    return {
      code: 1,
      err: `[self-update] v${latest} (artifact ${expected.slice(0, 12)}…) previously failed verification on this host — refusing to retry; ${manualRemedy(gatewayUrl)}\n`,
    };
  }

  let binRes: Response;
  const binCtrl = new AbortController();
  const binConnectTimer = setTimeout(() => binCtrl.abort(), connectMs);
  try {
    binRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}`, {
      // connect/first-byte bound only — the body stream has its own
      // stall + total bounds (NR2-2) so a slow link can still finish.
      signal: binCtrl.signal,
    });
  } catch (err) {
    recordCliUpdateAttempt(latest, expected);
    return {
      code: 1,
      err: `[self-update] download failed: ${
        err instanceof Error ? err.message : String(err)
      } — will retry later\n`,
    };
  } finally {
    clearTimeout(binConnectTimer);
  }
  if (!binRes.ok) {
    recordCliUpdateAttempt(latest, expected);
    return {
      code: 1,
      err: `[self-update] download failed: ${binRes.status} — will retry later\n`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readBodyCapped(
      binRes,
      MAX_BINARY_BYTES,
      "binary download",
      args.download,
      () => binCtrl.abort(),
    );
  } catch (err) {
    if (err instanceof ArtifactFetchError) {
      // Oversize — the advertised artifact can never be valid; reject keyed
      // to its digest so a corrected re-publish is allowed through.
      rejectCliUpdateVersion(latest, expected);
    }
    // Transport faults (socket drop, stall, total cap) stay transient (TD-4).
    recordCliUpdateAttempt(latest, expected);
    return {
      code: 1,
      err: `[self-update] ${err instanceof Error ? err.message : String(err)} — aborting\n`,
    };
  }
  // `maxOutputLength` bounds a gzip bomb the same way the wire cap bounds the
  // compressed payload.
  if (bytes.subarray(0, 2).equals(GZIP_MAGIC)) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: MAX_BINARY_BYTES });
    } catch (err) {
      rejectCliUpdateVersion(latest, expected);
      recordCliUpdateAttempt(latest, expected);
      return {
        code: 1,
        err: `[self-update] decompress failed: ${err instanceof Error ? err.message : String(err)} — aborting\n`,
      };
    }
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    // A checksum mismatch is a mis-published artifact — deterministic, so the
    // artifact is pinned rejected (the daemon converger won't retry it either).
    rejectCliUpdateVersion(latest, expected);
    recordCliUpdateAttempt(latest, expected);
    return {
      code: 1,
      err: `[self-update] checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — aborting\n`,
    };
  }

  // Atomic same-directory swap: write next to the running binary (a UNIQUE
  // name — UP-1), fsync + chmod, rename over under the shared lock.
  const self = args.self ?? process.execPath;
  sweepStaleUpdateTemps(dirname(self));
  const staging = join(
    dirname(self),
    `.openllm.next-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const fsyncFile = args.hooks?.fsyncFile ?? fsyncFileSync;
  const prepare =
    args.hooks?.prepare ?? ((path: string) => prepareUpdatedCliBinary(path));
  try {
    try {
      fs.writeFileSync(staging, bytes, { mode: 0o755 });
      // FSS-18 ordering: chmod+harden BEFORE the fsync — the fsync must make
      // the file's FINAL state durable (hardening after it would leave the
      // xattr changes outside the durability point).
      prepare(staging);
      fsyncFile(staging);
    } catch (err) {
      // FSS-16/FSS-17: a failed staging write must not leave the ~90 MB temp.
      recordCliUpdateAttempt(latest, expected);
      return {
        code: 1,
        err: `[self-update] could not stage the new binary: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      };
    }
    const swap = await commitCliSwap({
      self,
      staged: staging,
      latest,
      digest: expected,
      expectedInstalled: args.expectedInstalled ?? CLI_VERSION,
      ...(args.probeVerdict !== undefined
        ? { probeVerdict: args.probeVerdict }
        : {}),
      ...(args.probeInstalled !== undefined
        ? { probeInstalled: args.probeInstalled }
        : {}),
      ...(args.probeInstalledVerdict !== undefined
        ? { probeInstalledVerdict: args.probeInstalledVerdict }
        : {}),
      ...(args.lockWaitMs !== undefined ? { lockWaitMs: args.lockWaitMs } : {}),
      ...(args.hooks !== undefined
        ? {
            hooks: {
              ...(args.hooks.fsyncFile !== undefined
                ? { fsyncFile: args.hooks.fsyncFile }
                : {}),
              ...(args.hooks.fsyncDir !== undefined
                ? { fsyncDir: args.hooks.fsyncDir }
                : {}),
              ...(args.hooks.onWarn !== undefined
                ? { onWarn: args.hooks.onWarn }
                : {}),
            },
          }
        : {}),
    });
    if (swap === "busy") {
      return {
        code: 1,
        err: "[self-update] another update holds the CLI swap lock — try again in a moment\n",
      };
    }
    if (swap === "converged") {
      return {
        code: 0,
        out: `openllm v${latest} is already installed (converged by another updater)\n`,
      };
    }
    if (swap === "changed") {
      return {
        code: 1,
        err: "[self-update] the installed CLI changed while this update ran — re-run to update the new binary\n",
      };
    }
    if (swap === "stage-failed") {
      recordCliUpdateAttempt(latest, expected);
      return {
        code: 1,
        err: "[self-update] could not durably stage the new binary — refusing to swap\n",
      };
    }
    if (swap === "probe-inconclusive") {
      // The probe never judged the bytes (timeout/kill/broken env) — record
      // the try and back off, but do NOT reject the artifact (TD-5/UP-2).
      recordCliUpdateAttempt(latest, expected);
      return {
        code: 1,
        err: `[self-update] the v${latest} health check could not complete (environment) — will retry later\n`,
      };
    }
    if (swap === "probe-failed") {
      // The staged binary failed its `--self-test` health check (won't exec,
      // crashes loading its command graph, or reports the wrong version) —
      // deterministic, so pin this artifact rejected instead of swapping.
      rejectCliUpdateVersion(latest, expected);
      recordCliUpdateAttempt(latest, expected);
      return {
        code: 1,
        err: `[self-update] downloaded v${latest} failed its health check — refusing to swap; ${manualRemedy(gatewayUrl)}\n`,
      };
    }
    if (swap === "backup-failed") {
      // FAIL CLOSED: no rollback copy, no swap. (Round-1 swapped anyway and
      // left the daemon nothing reliable to restore; the daemon updater has
      // always refused to swap without a rollback path — the CLI now matches.)
      recordCliUpdateAttempt(latest, expected);
      return {
        code: 1,
        err: `[self-update] could not create the rollback backup at ${self}.prev — refusing to swap without a recovery path\n`,
      };
    }
    return { code: 0, out: `openllm updated to v${latest}\n` };
  } finally {
    // FSS-16/FSS-17: the ~90 MB staging file never survives an exit path —
    // a successful swap renamed it away; every failure lands here.
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
};

export const runSelfUpdate = async (): Promise<void> => {
  if (CLI_VERSION === "0.0.0-dev") {
    process.stderr.write(
      "[self-update] dev build (0.0.0-dev) never self-updates\n",
    );
    process.exit(0);
  }
  const { gatewayUrl } = cliConfig();
  if (!isSecureOrigin(gatewayUrl)) {
    process.stderr.write(
      `[self-update] refusing to update over an insecure origin (${gatewayUrl}) — use https:// (http:// is allowed only for localhost)\n`,
    );
    process.exit(1);
  }

  const vRes = await fetch(`${gatewayUrl}/api/cli/version`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!vRes.ok) {
    process.stderr.write(
      `[self-update] version check failed: HTTP ${vRes.status}\n`,
    );
    process.exit(1);
  }
  const payload = (await vRes.json().catch(() => null)) as {
    latest_version?: unknown;
  } | null;
  if (payload === null || typeof payload.latest_version !== "string") {
    process.stderr.write(
      "[self-update] malformed version response (no latest_version string)\n",
    );
    process.exit(1);
  }
  const latest = payload.latest_version.replace(/^v/, "");
  if (latest.length === 0) {
    process.stderr.write("[self-update] no CLI release published yet\n");
    process.exit(1);
  }
  if (latest === CLI_VERSION) {
    process.stdout.write(`openllm v${CLI_VERSION} is up to date\n`);
    process.exit(0);
  }
  const route = cliUpdateRoute();
  const verdict = evaluateUpdatePolicy({
    currentVersion: CLI_VERSION,
    latestVersion: latest,
    ...route,
  });
  if (!verdict.allow) {
    process.stderr.write(
      `[self-update] refusing ${CLI_VERSION} → ${latest}: ${verdict.reason ?? "update policy"} — ${manualRemedy(gatewayUrl)}\n`,
    );
    process.exit(1);
  }
  // Fail closed (round-3): if the safety state cannot be persisted, a
  // deterministic-failure reject protects nobody — another process would
  // retry the same bad artifact. Refuse rather than join the churn.
  if (!probeUpdateStateWritable()) {
    process.stderr.write(
      "[self-update] update state is not writable — refusing to update without a persistent rejection guard\n",
    );
    process.exit(1);
  }

  const target = targetSuffix();
  if (target === null && process.platform === "win32") {
    // win32-x64 IS published, but a running Windows executable cannot be
    // renamed over, so in-place self-update is unavailable.
    process.stderr.write(
      "[self-update] in-place self-update is unavailable on Windows — install the current package instead.\n",
    );
    process.exit(1);
  }
  if (target === null) {
    // No prebuilt binary for this arch — point at the source repo, whose
    // README documents building the host binary (`bun run compile:host`).
    process.stderr.write(
      `[self-update] unsupported host ${process.platform}/${process.arch} — no prebuilt openllm for this arch.\n` +
        `  Build from source: https://github.com/${CLI_RELEASE.repo}#build-from-source\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[self-update] v${CLI_VERSION} → v${latest} (${target})\n`,
  );

  const result = await applyManualCliUpdate({ gatewayUrl, latest, target });
  if (result.code === 0) process.stdout.write(result.out);
  else process.stderr.write(result.err);
  process.exit(result.code);
};
