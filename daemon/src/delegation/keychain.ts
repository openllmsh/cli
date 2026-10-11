/**
 * Isolated macOS login keychain. Split out of `util.ts` (which re-exports
 * everything here — import from either).
 *
 * On macOS, Claude Code stores its OAuth credential in the login Keychain
 * (there is NO file-based override — confirmed via the Claude Code docs).
 * Claude resolves the login keychain by HOME path, so running it with an
 * isolated HOME and no keychain there fails with the system dialog "A
 * keychain cannot be found to store <user>". The fix: give the isolated
 * HOME its OWN login keychain at `<home>/Library/Keychains/login.keychain-db`.
 *
 * We deliberately do NOT call `security default-keychain`/`list-keychains`:
 * those mutate the live securityd SESSION search list (not HOME-scoped),
 * which would pollute the user's real keychain environment. Instead we
 * create + unlock the keychain at the HOME-derived path (which Claude
 * finds on its own) and READ it back by EXPLICIT path (the `security` CLI
 * resolves the default via the session, not HOME, so the path is required).
 *
 * ── Readiness gate (2026-08 GUI-prompt fix) ─────────────────────────────
 * The isolated keychain is created empty-password. If that invariant ever
 * breaks (a pre-existing file whose password drifted from `""`, e.g. one
 * created under the old reserved-name-under-sandbox path that itself popped a
 * dialog), `unlock-keychain -p ""` fails. Historically we still ran
 * `dump-keychain` — and let the vendor CLI (`claude auth status`) open the
 * locked chain — which raises a `builtin:unlock-keychain` SecurityAgent GUI
 * dialog every status tick. So `ensureKeychainReady` now RETURNS a tri-state:
 * NOTHING that could prompt (our dump/grant, or the vendor CLI in
 * `claude-code.ts`) runs unless it reports `present` (unlocked THIS call). A
 * genuine empty-password drift self-heals once (rename-aside + recreate); a
 * chain that still can't unlock is negative-cached so it stops re-prompting.
 * See docs/plan/2026-08-22-daemon-keychain-gui-prompt-wedge-fix.md.
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  TDoctorOutcomeLedger,
  TDoctorStoreClassifier,
  TDoctorStoreOperation,
  TDoctorStoreResult,
  TDoctorStoreStage,
} from "@openllmsh/protocol";
import { superviseSpawn } from "../child-supervisor";
import type { TDeadlineBudget } from "../deadline-budget";
import {
  budgetFromSignal,
  createDeadlineBudget,
  splitReapBudget,
  waitUntilExpired,
} from "../deadline-budget";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  safeDiagnosticMessage,
} from "../logger";
import { currentLoginCommandCorrelation, currentTickId } from "../op-context";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { classifyStatError } from "./observation-cache";
import { redactSensitiveArgv } from "./redact-sensitive-argv";
import { bindAbort, logIfKilled, spawnCwd } from "./spawn";
import type { TStoreRead } from "./util";

const MAC = platform() === "darwin";

/** Readiness = the shared tri-state: `present` (created + unlocked this call),
 *  `indeterminate` (create/unlock failed or the chain is unusable). Off macOS
 *  there is nothing to gate, so it is always `present`. */
const READY: TStoreRead<void> = { kind: "present", value: undefined };

/**
 * Resolve an existing HOME to its real path so symlink aliases share one
 * readiness / in-flight / identity key. Missing or unresolvable HOMEs keep the
 * caller spelling — first-create still needs a usable path, and maps stay keyed
 * by whatever `loginKeychainPath` returns for that call.
 */
const canonicalizeHome = (home: string): string => {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
};

const keychainsDir = (home: string): string =>
  join(canonicalizeHome(home), "Library", "Keychains");

/** Name the vendor CLIs resolve from HOME. macOS 27 `securityd` refuses to
 *  UNLOCK any keychain with this basename other than the account's own
 *  (exit 51, "passphrase … not correct" — password-independent), so it is only
 *  ever a SYMLINK to {@link ISOLATED_KEYCHAIN_NAME}. */
const VENDOR_KEYCHAIN_NAME = "login.keychain-db";
/** The real isolated store. Every `security` operation targets this file. */
const ISOLATED_KEYCHAIN_NAME = "openllm.keychain-db";

/** The REAL isolated store (create / unlock / grant / read / identity). */
const loginKeychainPath = (home: string): string =>
  join(keychainsDir(home), ISOLATED_KEYCHAIN_NAME);

/** The HOME-derived path the vendor CLIs open; a relative symlink. */
const vendorKeychainPath = (home: string): string =>
  join(keychainsDir(home), VENDOR_KEYCHAIN_NAME);

type TKeychainLayout = "ready" | "absent" | "conflict";

/**
 * Reconcile the two-name layout. Lossless and create-only:
 * - legacy regular file at the vendor name, no real store → atomic same-dir
 *   rename to the real name (keeps every credential; it just becomes
 *   unlockable on macOS 27), then link the vendor name back;
 * - real store present, vendor name missing → create the symlink;
 * - both REGULAR files, or a foreign symlink → `conflict`: touch nothing.
 * Never deletes or recreates a store. Racing peers converge via EEXIST.
 */
const reconcileKeychainLayout = async (
  home: string,
): Promise<TKeychainLayout> => {
  const real = loginKeychainPath(home);
  const vendor = vendorKeychainPath(home);
  const vendorKind = await lstat(vendor).then(
    (st) => (st.isSymbolicLink() ? "link" : "file"),
    () => "missing" as const,
  );
  if (vendorKind === "link") {
    const target = await readlink(vendor).catch(() => null);
    if (target !== ISOLATED_KEYCHAIN_NAME && target !== real) {
      return "conflict";
    }
    return existsSync(real) ? "ready" : "absent";
  }
  if (vendorKind === "file") {
    if (existsSync(real)) return "conflict";
    try {
      await rename(vendor, real);
    } catch {
      return existsSync(real) ? "conflict" : "absent";
    }
    logInfo(
      "keychain",
      safeDiagnosticMessage`keychain store migrated off the reserved name`,
    );
  }
  if (!existsSync(real)) return "absent";
  try {
    await symlink(ISOLATED_KEYCHAIN_NAME, vendor);
  } catch (err) {
    if (!isExistError(err)) return "conflict";
    // A peer linked first; re-check it points at us.
    const target = await readlink(vendor).catch(() => null);
    if (target !== ISOLATED_KEYCHAIN_NAME && target !== real) {
      return "conflict";
    }
  }
  return "ready";
};

type TSpawnMode = "ignore" | "pipe";

/** Per-command ceiling; the caller's monotonic budget includes FIFO queue wait. */
const DEFAULT_SECURITY_SPAWN_TIMEOUT_MS = 4_000;

/** Do not start a `security` child with less than this remaining — a sliver
 *  spawn just times out and logs. Capped by `securitySpawnTimeoutMs()` so
 *  tests that inject a 20–30ms timeout still spawn at the head of an empty
 *  lane. */
export const KEYCHAIN_LANE_SPAWN_FLOOR_MS = 400;

/** Per-call so tests can drive `OPENLLM_SECURITY_TIMEOUT_MS`. Finite + positive
 *  or the default. Dump/unlock on a one-cred isolated chain is fast. */
const securitySpawnTimeoutMs = (): number => {
  const raw = process.env.OPENLLM_SECURITY_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_SECURITY_SPAWN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SECURITY_SPAWN_TIMEOUT_MS;
};

const laneSpawnFloorMs = (): number =>
  Math.min(KEYCHAIN_LANE_SPAWN_FLOOR_MS, securitySpawnTimeoutMs());

/** Skip a spawn when remaining is below the floor, except when the floor
 *  *is* the whole configured timeout (`min(400, 20) === 20`). In that case
 *  1ms of scheduling would skip the empty-lane head — tests inject 20–30ms
 *  and T14/T15 count those spawns. Full expiry still skips. */
const remainingBelowSpawnFloor = (remainingMs: number): boolean => {
  const configured = securitySpawnTimeoutMs();
  const floor = laneSpawnFloorMs();
  if (floor >= configured) return false;
  return remainingMs < floor;
};

type TSecurityOutcome =
  | {
      readonly kind: "complete";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

const FAILED_SPAWN = { code: -1, stdout: "", stderr: "" } as const;

/** ONE `security` spawn helper (create/unlock/dump/read all route here).
 *  Unconfined on macOS (`sandbox/policy.ts`): `security` talks to securityd,
 *  which refuses a Seatbelt-confined caller. These paths are macOS-only.
 *  `stdout`/`stderr` are captured only when the mode is `pipe` (unlock needs
 *  stderr to classify a failure; dump/read need stdout). Never throws.
 *  Bounded: a hung `security` (e.g. blocked on SecurityAgent) is killed so
 *  `inFlightKeychains` can settle. */
type TSecuritySpawnOpts = {
  readonly stdout: TSpawnMode;
  readonly stderr: TSpawnMode;
  readonly signal?: AbortSignal;
};

type TSecurityResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
};

/** Accept a native exit only when it is already an integer in 0..255; omit
 *  otherwise (fail-closed — never synthesize or truncate a fractional code). */
const storeExitCodeOf = (code: number): number | undefined => {
  if (!Number.isInteger(code) || code < 0 || code > 255) return undefined;
  return code;
};

const storeClassifierOf = (
  token: string | null | undefined,
): TDoctorStoreClassifier | undefined => {
  if (token === "-25293") return "auth_failed";
  if (token === "-25295") return "invalid_keychain";
  if (
    token === "passphrase you entered" ||
    token === "username or passphrase"
  ) {
    return "passphrase_refused";
  }
  return undefined;
};

const storeResultOf = (
  res: Pick<TSecurityResult, "code" | "timedOut" | "aborted">,
): TDoctorStoreResult => {
  if (res.aborted) return "aborted";
  if (res.timedOut) return "timed_out";
  return res.code === 0 ? "succeeded" : "failed";
};

const completedStoreExitCodeOf = (
  res: Pick<TSecurityResult, "code" | "timedOut" | "aborted">,
): number | undefined =>
  res.timedOut || res.aborted ? undefined : storeExitCodeOf(res.code);

type TStoreObservationInput = {
  readonly operation: TDoctorStoreOperation;
  readonly stage: TDoctorStoreStage;
  readonly result: TDoctorStoreResult;
  readonly exitCode?: number;
  readonly classifier?: TDoctorStoreClassifier;
  readonly recovery?: {
    readonly created: boolean;
    readonly unlocked: boolean;
    readonly replaced: boolean;
  };
};

type TStoreLogObservation = TDoctorOutcomeLedger & {
  readonly correlation_id?: string;
};

/** Fourth-arg observation for `logWarn`/`logError`/`logInfo` — projected by
 *  the logger onto the doctor ledger. Never put paths, stderr, or tokens here.
 *  Opaque login-flow correlation is attached only when a login command ALS is
 *  bound (via op-context); invalid/unbound ids are omitted. */
const toStoreObservation = (
  input: TStoreObservationInput,
): TStoreLogObservation => {
  const ledger: {
    -readonly [K in keyof TStoreLogObservation]?: TStoreLogObservation[K];
  } = {
    store_operation: input.operation,
    store_stage: input.stage,
    store_result: input.result,
  };
  if (input.exitCode !== undefined) {
    const exit = storeExitCodeOf(input.exitCode);
    if (exit !== undefined) ledger.store_exit_code = exit;
  }
  if (input.classifier !== undefined)
    ledger.store_classifier = input.classifier;
  if (input.recovery !== undefined) {
    ledger.recovery_created = input.recovery.created;
    ledger.recovery_unlocked = input.recovery.unlocked;
    ledger.recovery_replaced = input.recovery.replaced;
  }
  const correlation_id = currentLoginCommandCorrelation();
  if (correlation_id !== undefined) ledger.correlation_id = correlation_id;
  return ledger;
};

type TKeychainCounters = {
  attempts: number;
  timeouts: number;
  aborted: number;
  skipped_expired: number;
  skipped_floor: number;
  skipped: number;
  complete_ok: number;
  complete_fail: number;
  by_verb: Record<string, number>;
};

const emptyKeychainCounters = (): TKeychainCounters => ({
  attempts: 0,
  timeouts: 0,
  aborted: 0,
  skipped_expired: 0,
  skipped_floor: 0,
  skipped: 0,
  complete_ok: 0,
  complete_fail: 0,
  by_verb: {},
});

let keychainCounters = emptyKeychainCounters();
let lastWatcherSnapshot = emptyKeychainCounters();

let securitySpawnSetupHookForTests: (() => Promise<void> | void) | null = null;
let lastSecurityTimerMsForTests: number | null = null;

/** Test-only: run after `superviseSpawn`, before the child timeout is armed. */
export const setSecuritySpawnSetupHookForTests = (
  hook: (() => Promise<void> | void) | null,
): void => {
  securitySpawnSetupHookForTests = hook;
};

/** Test-only: delay passed to `setTimeout` for the last security child. */
export const lastSecurityTimerMsForTestsSnapshot = (): number | null =>
  lastSecurityTimerMsForTests;

const cloneKeychainCounters = (
  counters: TKeychainCounters,
): TKeychainCounters => ({
  ...counters,
  by_verb: { ...counters.by_verb },
});

export const keychainTelemetrySnapshot = (): Readonly<TKeychainCounters> =>
  cloneKeychainCounters(keychainCounters);

/** Did anything at all happen in this window? `by_verb` is derived from the
 *  scalars, so the scalars alone decide. */
const hasKeychainActivity = (d: TKeychainCounters): boolean =>
  d.attempts !== 0 ||
  d.timeouts !== 0 ||
  d.aborted !== 0 ||
  d.skipped_expired !== 0 ||
  d.skipped_floor !== 0 ||
  d.skipped !== 0 ||
  d.complete_ok !== 0 ||
  d.complete_fail !== 0;

const deltaKeychainCounters = (
  now: TKeychainCounters,
  prev: TKeychainCounters,
): TKeychainCounters => {
  const by_verb: Record<string, number> = {};
  for (const verb of new Set([
    ...Object.keys(now.by_verb),
    ...Object.keys(prev.by_verb),
  ])) {
    const d = (now.by_verb[verb] ?? 0) - (prev.by_verb[verb] ?? 0);
    if (d !== 0) by_verb[verb] = d;
  }
  return {
    attempts: now.attempts - prev.attempts,
    timeouts: now.timeouts - prev.timeouts,
    aborted: now.aborted - prev.aborted,
    skipped_expired: now.skipped_expired - prev.skipped_expired,
    skipped_floor: now.skipped_floor - prev.skipped_floor,
    skipped: now.skipped - prev.skipped,
    complete_ok: now.complete_ok - prev.complete_ok,
    complete_fail: now.complete_fail - prev.complete_fail,
    by_verb,
  };
};

/** One debug line per watcher tick: totals + deltas since the last tick. */
export const logKeychainWatcherTick = (): void => {
  const snapshot = keychainTelemetrySnapshot();
  const deltas = deltaKeychainCounters(keychainCounters, lastWatcherSnapshot);
  lastWatcherSnapshot = cloneKeychainCounters(keychainCounters);
  // A quiet tick logs NOTHING. The unconditional version wrote ~5.7k all-zero
  // lines a day on an idle host, which buys no history and costs log budget
  // that a wedged machine needs for the ticks that DID spawn. Live counters
  // stay readable at any moment on `GET /status` (`keychain_spawns`); this line
  // exists only to reconstruct *when* activity happened, after the fact.
  // Routine summaries stay DEBUG (default log gate is `info`) so a benign
  // partition/`complete_fail` delta does not flood the combined log. Actionable
  // timeout/error lines keep their levels; counter names stay on the wire.
  if (!hasKeychainActivity(deltas)) return;
  logDebug("keychain", "keychain spawn snapshot", { snapshot, deltas });
};

const noteKeychainVerb = (verb: string): void => {
  keychainCounters.by_verb[verb] = (keychainCounters.by_verb[verb] ?? 0) + 1;
};

const securityVerb = (argv: ReadonlyArray<string>): string =>
  argv[0] ?? "unknown";

/** Wait for shared producer work without giving one observer ownership of it. */
const awaitSharedStoreRead = async <T>(
  work: Promise<TStoreRead<T>>,
  signal: AbortSignal | undefined,
  cause: string,
): Promise<TStoreRead<T>> => {
  if (signal === undefined) return work;
  if (signal.aborted) return { kind: "indeterminate", cause };

  let unbind = (): void => {};
  const aborted = new Promise<TStoreRead<T>>((resolve) => {
    unbind = bindAbort(signal, () => {
      resolve({ kind: "indeterminate", cause });
    });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    unbind();
  }
};

let macosKeychainLane: Promise<void> = Promise.resolve();

/**
 * One FIFO lane for OpenLLM-issued `security` commands only. Vendor CLI
 * auth-status / refresh / login / logout talk to securityd themselves and must
 * not occupy this lane. Queue waiters that abort before spawn never start.
 * `onSkip` is the typed skip: expiry or remaining below the spawn floor
 * returns it instead of `operation()`, still releasing the slot after the
 * predecessor settles so the lane cannot leak.
 */
export const withMacosKeychainAccess = async <T>(
  operation: () => Promise<T>,
  budget?: TDeadlineBudget,
  onSkip?: () => T,
): Promise<T> => {
  if (!MAC) return operation();
  const previous = macosKeychainLane;
  let release = (): void => {};
  const occupied = new Promise<void>((resolve) => {
    release = resolve;
  });
  macosKeychainLane = previous.then(
    () => occupied,
    () => occupied,
  );
  const waitPrev = previous.catch(() => {});
  if (budget !== undefined) {
    await Promise.race([waitPrev, waitUntilExpired(budget)]);
    const remaining = budget.remainingMs();
    if (budget.expired() || remainingBelowSpawnFloor(remaining)) {
      void waitPrev.finally(() => {
        release();
      });
      if (onSkip !== undefined) return onSkip();
      return operation();
    }
  }
  await waitPrev;
  try {
    return await operation();
  } finally {
    release();
  }
};

const spawnSecurityNow = async (
  argv: ReadonlyArray<string>,
  home: string,
  opts: TSecuritySpawnOpts,
  budget: TDeadlineBudget,
  queuedAtMs: number,
): Promise<TSecurityResult> => {
  if (opts.signal?.aborted === true) {
    keychainCounters.aborted++;
    return { ...FAILED_SPAWN, timedOut: false, aborted: true };
  }
  if (budget.expired()) {
    keychainCounters.skipped_expired++;
    return { ...FAILED_SPAWN, timedOut: true, aborted: false };
  }
  const verb = securityVerb(argv);
  const laneWaitMs = Math.max(0, Date.now() - queuedAtMs);
  const remainingAtSpawn = budget.remainingMs();
  const configuredTimeoutMs = securitySpawnTimeoutMs();
  const preSpawnMs = performance.now();
  try {
    const child = superviseSpawn(
      sandboxSpawnArgs(["security", ...argv], { probe: unwrapKeychainSpawn() }),
      {
        kind: "probe",
        stdin: "ignore",
        stdout: opts.stdout,
        stderr: opts.stderr,
        cwd: spawnCwd({ HOME: home }),
        env: { ...process.env, HOME: home },
      },
    );
    if (securitySpawnSetupHookForTests !== null) {
      await securitySpawnSetupHookForTests();
    }
    const spawnedAtMs = performance.now();
    const spawnSetupMs = spawnedAtMs - preSpawnMs;
    keychainCounters.attempts++;
    noteKeychainVerb(verb);
    const proc = child.subprocess;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unbindAbortWait = (): void => {};
    const readPiped = async (
      stream: unknown,
      mode: TSpawnMode,
    ): Promise<string> => {
      if (mode !== "pipe" || !(stream instanceof ReadableStream)) return "";
      try {
        return await new Response(stream).text();
      } catch {
        return "";
      }
    };
    try {
      const complete = Promise.all([
        readPiped(proc.stdout, opts.stdout),
        readPiped(proc.stderr, opts.stderr),
        proc.exited,
      ]).then(
        ([stdout, stderr, code]): TSecurityOutcome => ({
          kind: "complete",
          code,
          stdout,
          stderr,
        }),
      );
      void complete.catch(() => {});
      // Setup (Bun.spawn + test hook) is part of the absolute 4 s budget.
      // Arm from remaining *after* spawn so a slow spawn cannot extend the
      // deadline. Pre-spawn remaining stays in telemetry only.
      const remainingAfterSpawn = budget.remainingMs();
      lastSecurityTimerMsForTests = remainingAfterSpawn;
      const timeout =
        remainingAfterSpawn === 0
          ? Promise.resolve<TSecurityOutcome>({ kind: "timeout" })
          : new Promise<TSecurityOutcome>((resolve) => {
              timer = setTimeout(
                () => resolve({ kind: "timeout" }),
                remainingAfterSpawn,
              );
            });
      const abortWait =
        opts.signal === undefined
          ? null
          : new Promise<TSecurityOutcome>((resolve) => {
              unbindAbortWait = bindAbort(opts.signal, () =>
                resolve({ kind: "aborted" }),
              );
            });
      const outcome = await Promise.race(
        abortWait === null
          ? [complete, timeout]
          : [complete, timeout, abortWait],
      );
      if (outcome.kind === "aborted" || outcome.kind === "timeout") {
        const reap = await child.terminate(
          splitReapBudget(budget.remainingMs()),
        );
        try {
          proc.kill();
        } catch {
          // mock / already gone
        }
        if (reap === "reap_unconfirmed") {
          logError(
            "keychain",
            safeDiagnosticMessage`security command did not reap after SIGKILL`,
            {
              argv: redactSensitiveArgv(["security", ...argv]),
            },
          );
        }
        if (outcome.kind === "timeout") {
          keychainCounters.timeouts++;
          logError(
            "keychain",
            safeDiagnosticMessage`security command timed out`,
            {
              argv: redactSensitiveArgv(["security", ...argv]),
              configured_timeout_ms: configuredTimeoutMs,
              lane_wait_ms: laneWaitMs,
              budget_remaining_ms_at_spawn: remainingAtSpawn,
              spawn_setup_ms: spawnSetupMs,
              spawn_elapsed_ms: performance.now() - spawnedAtMs,
              verb,
              child_pid: child.pid,
              tick_id: currentTickId(),
            },
          );
          return { ...FAILED_SPAWN, timedOut: true, aborted: false };
        }
        keychainCounters.aborted++;
        return { ...FAILED_SPAWN, timedOut: false, aborted: true };
      }
      logIfKilled(redactSensitiveArgv(["security", ...argv]), proc, {
        confined: unwrapKeychainSpawn() !== true,
      });
      if (outcome.code === 0) keychainCounters.complete_ok++;
      else keychainCounters.complete_fail++;
      return {
        code: outcome.code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        timedOut: false,
        aborted: false,
      };
    } finally {
      unbindAbortWait();
      if (timer !== null) clearTimeout(timer);
    }
  } catch {
    return { ...FAILED_SPAWN, timedOut: false, aborted: false };
  }
};

const spawnSecurity = async (
  argv: ReadonlyArray<string>,
  home: string,
  opts: TSecuritySpawnOpts,
): Promise<TSecurityResult> => {
  const parentBudget = budgetFromSignal(opts.signal);
  const budget =
    parentBudget?.child(securitySpawnTimeoutMs()) ??
    createDeadlineBudget(securitySpawnTimeoutMs(), opts.signal);
  const queuedAtMs = Date.now();
  const skippedSpawn = (reason: "expired" | "floor"): TSecurityResult => {
    if (opts.signal?.aborted === true) {
      keychainCounters.aborted++;
      return { ...FAILED_SPAWN, timedOut: false, aborted: true };
    }
    if (reason === "floor") keychainCounters.skipped_floor++;
    else keychainCounters.skipped_expired++;
    return { ...FAILED_SPAWN, timedOut: true, aborted: false };
  };
  return withMacosKeychainAccess(
    async () => {
      if (budget.expired()) return skippedSpawn("expired");
      if (remainingBelowSpawnFloor(budget.remainingMs())) {
        return skippedSpawn("floor");
      }
      return spawnSecurityNow(argv, home, opts, budget, queuedAtMs);
    },
    budget,
    () => skippedSpawn(budget.expired() ? "expired" : "floor"),
  );
};

// In-flight ensures, keyed by keychain path — the SINGLE owner of the
// create/heal race. Overlapping callers await the SAME operation.
//
// Transient create/settings/unlock failures share one retry-not-before map.
// After the capped delay, exactly one keyed owner may re-probe; success
// clears the entry immediately. There is no permanent unusable latch.
const inFlightKeychains = new Map<string, Promise<TStoreRead<void>>>();
const inFlightObserveKeychains = new Map<string, Promise<TStoreRead<void>>>();
const TRANSIENT_RETRY_CAP_MS = 60_000;
const transientTimeouts = new Map<
  string,
  { readonly count: number; readonly nextAtMs: number }
>();
/** Passive observe backoff — must not suppress active ensure/login/inference. */
const observeTransientTimeouts = new Map<
  string,
  { readonly count: number; readonly nextAtMs: number }
>();

/** Process-local positive unlock skip. Empty at start so the first unlock
 *  after boot is always real. No clock — mtime/size are content-replacement
 *  only; `show-keychain-info` confirms auto-lock is off, not lock state. */
type TUnlockSkip = {
  readonly unlockedByUs: true;
  readonly mtimeMs: number;
  readonly size: number;
  readonly autoLockOff: true;
};

const unlockSkip = new Map<string, TUnlockSkip>();
const pendingUnlockSkip = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number }
>();
const autoLockOffByKc = new Map<string, boolean>();

/** Second classifier beside `matchUnlockFailureToken`. `-25308` stays
 *  TRANSIENT for recreate (must not nuke a good credential); it DOES
 *  invalidate a skip because the chain may have relocked under us. */
const isInteractionNotAllowed = (stderr: string): boolean => {
  const s = stderr.toLowerCase();
  // The literal message, verified with `security error -25308`, is "User
  // interaction is not allowed." — note the "is". `security` reports the text
  // WITHOUT the numeric code (e.g. "security: SecKeychainSearchCopyNext: User
  // interaction is not allowed."), so a numeric-only match never fires on a
  // real host; the `-25308` arm is kept only for callers that do surface codes.
  return (
    s.includes("-25308") || /interaction\s+(?:is\s+)?not\s+allowed/.test(s)
  );
};

const invalidateUnlockSkip = (kc: string): void => {
  unlockSkip.delete(kc);
  pendingUnlockSkip.delete(kc);
};

const noteKeychainIoResult = (kc: string, res: TSecurityResult): void => {
  // Timeouts stay `unknown` with observe/active backoff. Tear the skip only
  // on a classified lock-state change (`-25308`); mtime/size drift is
  // detected by `skipEligible` on the next call.
  if (isInteractionNotAllowed(res.stderr)) {
    invalidateUnlockSkip(kc);
  }
};

/** Parse `security show-keychain-info`. The grammar is POSITIONAL, not
 *  `name: value` — verified against macOS 15 (`security` writes this line to
 *  **stderr**, so pass both streams):
 *
 *      Keychain "x.keychain-db" no-timeout                 → auto-lock OFF
 *      Keychain "x.keychain-db" lock-on-sleep no-timeout   → locks on sleep
 *      Keychain "x.keychain-db" timeout=900s               → idle auto-lock
 *      Keychain "x.keychain-db" lock-on-sleep timeout=300s → both (the default)
 *
 *  Auto-lock is off IFF `no-timeout` is present AND `lock-on-sleep` is not.
 *  Our own chains are created with a bare `set-keychain-settings`, which yields
 *  the first form. Returns `null` when the output is not recognisable at all,
 *  so an inconclusive probe is never cached as a verdict. */
export const parseAutoLockOffForTests = (out: string): boolean | null =>
  parseAutoLockOff(out);

export const isInteractionNotAllowedForTests = (stderr: string): boolean =>
  isInteractionNotAllowed(stderr);

const parseAutoLockOff = (out: string): boolean | null => {
  const lower = out.toLowerCase();
  const noTimeout = lower.includes("no-timeout");
  const hasTimeout = /timeout=\d+s/.test(lower);
  // Neither token ⇒ this is not show-keychain-info output (empty, an error, a
  // future format). Unknown is NOT "auto-lock on".
  if (!noTimeout && !hasTimeout) return null;
  return noTimeout && !lower.includes("lock-on-sleep");
};

const confirmAutoLockOff = async (
  home: string,
  kc: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  const cached = autoLockOffByKc.get(kc);
  if (cached !== undefined) return cached;
  const res = await spawnSecurity(["show-keychain-info", kc], home, {
    stdout: "pipe",
    stderr: "pipe",
    ...(signal !== undefined ? { signal } : {}),
  });
  noteKeychainIoResult(kc, res);
  const parsed =
    res.code === 0 && !res.timedOut && !res.aborted
      ? // `security` prints this line on STDERR; stdout is empty. Read both so
        // the parse does not depend on which stream macOS chooses.
        parseAutoLockOff(`${res.stderr}\n${res.stdout}`)
      : null;
  // Cache only a CONCLUSIVE verdict. A timeout, abort, non-zero exit or
  // unrecognised output must not poison the cache with `false`: that is
  // process-lifetime state, so one transient failure would disable the skip for
  // this chain until the daemon restarts — and the caller already treats
  // "not confirmed" as "do not skip" for this call.
  if (parsed === null) return false;
  autoLockOffByKc.set(kc, parsed);
  return parsed;
};

const recordUnlockSuccessForSkip = (kc: string): void => {
  const meta = keychainMetadata(kc);
  if (meta.mtimeMs === null || meta.size === null) {
    invalidateUnlockSkip(kc);
    return;
  }
  pendingUnlockSkip.set(kc, { mtimeMs: meta.mtimeMs, size: meta.size });
};

const skipEligible = (kc: string): boolean => {
  const skip = unlockSkip.get(kc);
  if (skip === undefined) return false;
  if (!existsSync(kc)) {
    invalidateUnlockSkip(kc);
    return false;
  }
  const meta = keychainMetadata(kc);
  if (
    meta.mtimeMs === null ||
    meta.size === null ||
    meta.mtimeMs !== skip.mtimeMs ||
    meta.size !== skip.size
  ) {
    invalidateUnlockSkip(kc);
    return false;
  }
  return skip.unlockedByUs && skip.autoLockOff;
};

const tryPromoteUnlockSkip = async (
  home: string,
  kc: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (skipEligible(kc)) return true;
  const pending = pendingUnlockSkip.get(kc);
  if (pending === undefined) return false;
  if (!existsSync(kc)) {
    invalidateUnlockSkip(kc);
    return false;
  }
  const meta = keychainMetadata(kc);
  if (
    meta.mtimeMs === null ||
    meta.size === null ||
    meta.mtimeMs !== pending.mtimeMs ||
    meta.size !== pending.size
  ) {
    invalidateUnlockSkip(kc);
    return false;
  }
  const autoLockOff = await confirmAutoLockOff(home, kc, signal);
  if (!autoLockOff) {
    pendingUnlockSkip.delete(kc);
    return false;
  }
  unlockSkip.set(kc, {
    unlockedByUs: true,
    mtimeMs: pending.mtimeMs,
    size: pending.size,
    autoLockOff: true,
  });
  pendingUnlockSkip.delete(kc);
  return true;
};

const dumpCache = new Map<
  string,
  {
    readonly mtimeMs: number;
    readonly value: TStoreRead<ReadonlyArray<string>>;
  }
>();

type TKeychainPayloads = {
  readonly values: ReadonlyArray<string>;
  readonly secretUnreadable: boolean;
};

/** Complete credential reads, keyed by isolated keychain + service prefix. */
const inFlightKeychainReads = new Map<
  string,
  Promise<TStoreRead<TKeychainPayloads>>
>();

// A chain we recreated once this process (bounds self-heal to one attempt per
// path per process — launchd KeepAlive resets it on restart).
const healedKeychains = new Set<string>();

// First existing-chain unlock logged once per path per process. This is the
// boot breadcrumb that distinguishes a healthy unlock from a self-heal.
const initialExistingKeychainUnlocks = new Set<string>();

// Throttle the create-failure log so a persistent failure doesn't spam the
// error stream on every periodic status observation. One line per window.
const lastKeychainFailureLogMs = new Map<string, number>();
const KEYCHAIN_FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;

const logKeychainFailure = (kc: string): void => {
  const now = Date.now();
  if (
    now - (lastKeychainFailureLogMs.get(kc) ?? 0) <
    KEYCHAIN_FAILURE_LOG_INTERVAL_MS
  )
    return;
  lastKeychainFailureLogMs.set(kc, now);
  // Summary only — createIsolatedKeychain may have failed at staging, install,
  // or final unlock; stage-accurate store_* fields are already emitted there.
  // Do not invent create/staging here.
  const correlation_id = currentLoginCommandCorrelation();
  logError(
    "keychain",
    safeDiagnosticMessage`failed to create the isolated login keychain; sign-in will be blocked until the store is ready`,
    { keychain: kc },
    {
      reason_code: "keychain_unavailable",
      ...(correlation_id !== undefined ? { correlation_id } : {}),
    },
  );
};

const logSelfHeal = (kc: string): void =>
  logError(
    "keychain",
    safeDiagnosticMessage`recreated a drifted isolated login keychain; the provider will require re-login`,
    { keychain: kc },
  );

/** The positive classifier token, preserving the established matching order. */
export const matchUnlockFailureToken = (stderr: string): string | null => {
  const s = stderr.toLowerCase();
  if (s.includes("-25293")) return "-25293";
  if (s.includes("-25295")) return "-25295";
  if (s.includes("passphrase you entered")) return "passphrase you entered";
  if (s.includes("username or passphrase")) return "username or passphrase";
  return null;
};

/** Keep stderr evidence useful without retaining passwords or directory paths. */
export const redactSecurityStderr = (stderr: string): string => {
  const withoutPasswords = stderr
    // Quoted values may carry escaped quotes (`-p "a\"b"`): consume `\.`
    // pairs inside the quotes so the whole value is replaced, never a tail.
    .replace(
      /(^|\s)(-p|--password)=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S*)/g,
      "$1$2=[redacted]",
    )
    .replace(
      /(^|\s)(-p|--password)\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g,
      "$1$2 [redacted]",
    )
    .replace(/(^|\s)(?:-p|--password)(?=\s*$)/g, "$1")
    // Keep the established excerpt for the common trailing `-p value` form.
    .replace(/\s+-p \[redacted\]$/, "");
  const pathBasename = (path: string): string => {
    const value = path.trim();
    const name = basename(value);
    return name.length > 0 ? name : "<path>";
  };
  const knownHomePath =
    /(?:\/Users\/|\/home\/|\/var\/|\/private\/|\/tmp\/|~\/)[\s\S]*?(?=\s+(?=-{1,2}[A-Za-z])|\s+(?=(?:\/Users\/|\/home\/|\/var\/|\/private\/|\/tmp\/|~\/))|$)/g;

  return withoutPasswords
    .replace(/(["'])((?:\/|~\/)[\s\S]*?)\1/g, (_match, _quote, path) =>
      pathBasename(path),
    )
    .replace(knownHomePath, pathBasename)
    .replace(/(?:\/|~\/)[^\s"'`]+/g, pathBasename)
    .trim()
    .slice(0, 200);
};

/** A non-null `matchUnlockFailureToken` is auth-drift (recreate). Everything
 *  else — empty stderr the sandbox shim may swallow, user-canceled (-128), or
 *  interaction-not-allowed (-25308) — is TRANSIENT: do NOT recreate (fail-safe;
 *  the readiness gate already prevents any prompt), so a transient securityd
 *  hiccup never nukes a good credential. */
type TKeychainMetadata = {
  readonly mtimeMs: number | null;
  readonly size: number | null;
};

const keychainMetadata = (kc: string): TKeychainMetadata => {
  try {
    const { mtimeMs, size } = statSync(kc);
    return { mtimeMs, size };
  } catch {
    return { mtimeMs: null, size: null };
  }
};

/**
 * Cheap identity for idle observation reuse. Includes replacement identity
 * (`ino`) plus mtime/size. `skipEligible` is the existing unlock-skip seam —
 * true only after we unlocked this chain, auto-lock is off, and metadata still
 * matches. Never treat this as proof the chain is unlocked if skip is false.
 */
export type TKeychainStoreIdentity = {
  readonly path: string;
  readonly present: boolean;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly ino: number | null;
  readonly skipEligible: boolean;
  readonly statOk: boolean;
};

export const keychainStoreIdentity = (home: string): TKeychainStoreIdentity => {
  const path = loginKeychainPath(home);
  if (!MAC) {
    return {
      path,
      present: false,
      mtimeMs: null,
      size: null,
      ino: null,
      skipEligible: true,
      statOk: true,
    };
  }
  try {
    const st = statSync(path);
    return {
      path,
      present: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: Number(st.ino),
      skipEligible: skipEligible(path),
      statOk: true,
    };
  } catch (err) {
    const absent = classifyStatError(err) === "absent";
    return {
      path,
      present: false,
      mtimeMs: null,
      size: null,
      ino: null,
      skipEligible: false,
      statOk: absent,
    };
  }
};

const brokenKeychainCount = async (kc: string): Promise<number> => {
  try {
    const prefix = `${basename(kc)}.broken-`;
    return (await readdir(dirname(kc))).filter((name) =>
      name.startsWith(prefix),
    ).length;
  } catch {
    return 0;
  }
};

const stagingPrefixForPid = (pid: number): string => `.openllm-staging-${pid}-`;

const ownedStagingPath = (dir: string): string =>
  join(
    dir,
    `${stagingPrefixForPid(process.pid)}${randomBytes(8).toString("hex")}.keychain-db`,
  );

const isOwnedStagingName = (name: string): boolean =>
  name.startsWith(stagingPrefixForPid(process.pid)) &&
  name.endsWith(".keychain-db");

const sweepOwnedStaging = async (dir: string): Promise<void> => {
  try {
    for (const f of await readdir(dir)) {
      if (isOwnedStagingName(f)) await rm(join(dir, f), { force: true });
    }
  } catch {
    // dir unreadable / race — non-fatal
  }
};

const removeOwnedPath = async (path: string): Promise<void> => {
  await rm(path, { force: true }).catch(() => {});
};

type TStoreFingerprint = {
  readonly present: boolean;
  readonly ino: number | null;
  readonly mtimeMs: number | null;
  readonly size: number | null;
};

const storeFingerprint = (kc: string): TStoreFingerprint => {
  try {
    const st = statSync(kc);
    return {
      present: true,
      ino: Number(st.ino),
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
  } catch {
    return { present: false, ino: null, mtimeMs: null, size: null };
  }
};

const sameStoreFingerprint = (
  a: TStoreFingerprint,
  b: TStoreFingerprint,
): boolean =>
  a.present === b.present &&
  a.ino === b.ino &&
  a.mtimeMs === b.mtimeMs &&
  a.size === b.size;

const isExistError = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err as { code?: unknown }).code === "EEXIST";

/**
 * Atomic create-only install: hard-link staging onto the vacant final path,
 * then drop the owned staging name. Only `EEXIST` means a peer won — leave
 * their store untouched. Other link errors are failures even if `kc` happens
 * to exist afterward (that is not a reliable peer-adoption signal).
 * Same-directory staging/final keeps this off the EXDEV path. `link` itself
 * is the atomic create; residual races live in repair's fingerprint recheck /
 * aside micro-window, not in first-time create-only install.
 */
const installStagingCreateOnly = async (
  staging: string,
  kc: string,
): Promise<"installed" | "peer-exists" | "failed"> => {
  try {
    await link(staging, kc);
    await removeOwnedPath(staging);
    return "installed";
  } catch (err) {
    await removeOwnedPath(staging);
    if (isExistError(err)) return "peer-exists";
    return "failed";
  }
};

type TPreparedStaging =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly operation: "create" | "settings" | "unlock";
      /** Present only for a real `security` spawn result — never fabricated. */
      readonly exitCode?: number;
      readonly timedOut: boolean;
      readonly aborted: boolean;
    };

const spawnSecurityQuiet = (
  argv: ReadonlyArray<string>,
  home: string,
  signal?: AbortSignal,
): Promise<TSecurityResult> =>
  spawnSecurity(argv, home, {
    stdout: "ignore",
    stderr: "ignore",
    ...(signal !== undefined ? { signal } : {}),
  });

/**
 * Create-only restore of an aside onto a vacant final path. Uses `link` so a
 * peer that reoccupied `kc` is not overwritten; aside is retained on conflict.
 */
const restoreAsideCreateOnly = async (
  aside: string,
  kc: string,
  classifier?: TDoctorStoreClassifier,
): Promise<"restored" | "peer-exists" | "failed"> => {
  try {
    await link(aside, kc);
    await removeOwnedPath(aside);
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain restore completed`,
      undefined,
      toStoreObservation({
        operation: "restore",
        stage: "recovery",
        result: "succeeded",
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    return "restored";
  } catch (err) {
    if (isExistError(err)) {
      logWarn(
        "keychain",
        safeDiagnosticMessage`keychain restore peer won`,
        undefined,
        toStoreObservation({
          operation: "restore",
          stage: "recovery",
          result: "peer_won",
          ...(classifier !== undefined ? { classifier } : {}),
        }),
      );
      return "peer-exists";
    }
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain restore failed`,
      undefined,
      toStoreObservation({
        operation: "restore",
        stage: "recovery",
        result: "failed",
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    return "failed";
  }
};

/** Create + settings + unlock a unique owned staging keychain. Never touches
 *  the final reserved path. Failure removes only this process's staging and
 *  emits a stage-specific closed store observation (no paths/stderr). */
const prepareStagingKeychain = async (
  home: string,
  dir: string,
  signal?: AbortSignal,
  classifier?: TDoctorStoreClassifier,
): Promise<TPreparedStaging> => {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Filesystem refusal before any security spawn — dedicated staging
    // observation with no store_exit_code (never fabricate a native exit).
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain staging directory was refused`,
      undefined,
      toStoreObservation({
        operation: "create",
        stage: "staging",
        result: "failed",
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    return {
      ok: false,
      operation: "create",
      timedOut: false,
      aborted: false,
    };
  }
  await sweepOwnedStaging(dir);
  const staging = ownedStagingPath(dir);
  const created = await spawnSecurityQuiet(
    ["create-keychain", "-p", "", staging],
    home,
    signal,
  );
  if (created.code !== 0 || created.timedOut || created.aborted) {
    await removeOwnedPath(staging);
    const createdExit = completedStoreExitCodeOf(created);
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain staging create was refused`,
      undefined,
      toStoreObservation({
        operation: "create",
        stage: "staging",
        result: storeResultOf(created),
        ...(createdExit !== undefined ? { exitCode: createdExit } : {}),
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    return {
      ok: false,
      operation: "create",
      exitCode: createdExit,
      timedOut: created.timedOut,
      aborted: created.aborted,
    };
  }
  const settings = await spawnSecurityQuiet(
    ["set-keychain-settings", staging],
    home,
    signal,
  );
  if (settings.code !== 0 || settings.timedOut || settings.aborted) {
    await removeOwnedPath(staging);
    const settingsExit = completedStoreExitCodeOf(settings);
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain staging settings failed`,
      undefined,
      toStoreObservation({
        operation: "settings",
        stage: "staging",
        result: storeResultOf(settings),
        ...(settingsExit !== undefined ? { exitCode: settingsExit } : {}),
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    return {
      ok: false,
      operation: "settings",
      exitCode: settingsExit,
      timedOut: settings.timedOut,
      aborted: settings.aborted,
    };
  }
  const unlocked = await spawnSecurityQuiet(
    ["unlock-keychain", "-p", "", staging],
    home,
    signal,
  );
  if (unlocked.code !== 0 || unlocked.timedOut || unlocked.aborted) {
    await removeOwnedPath(staging);
    const unlockedExit = completedStoreExitCodeOf(unlocked);
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain staging unlock failed`,
      undefined,
      toStoreObservation({
        operation: "unlock",
        stage: "staging",
        result: storeResultOf(unlocked),
        ...(unlockedExit !== undefined ? { exitCode: unlockedExit } : {}),
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    return {
      ok: false,
      operation: "unlock",
      exitCode: unlockedExit,
      timedOut: unlocked.timedOut,
      aborted: unlocked.aborted,
    };
  }
  return { ok: true, path: staging };
};

/** Create + configure the isolated login keychain at `kc`. macOS `securityd`
 *  REFUSES `create-keychain` at the RESERVED `login.keychain-db` name inside
 *  the $HOME subtree under Seatbelt. Staging is owner-pid unique; settings
 *  must succeed before install. Final install is create-only (`link`); a peer
 *  that already occupies `kc` is adopted and unlocked, never overwritten. */
const createIsolatedKeychain = async (
  home: string,
  kc: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  const dir = dirname(kc);
  const prepared = await prepareStagingKeychain(home, dir, signal);
  if (!prepared.ok) return false;
  const installed = await installStagingCreateOnly(prepared.path, kc);
  if (installed === "failed") {
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain install failed`,
      undefined,
      toStoreObservation({
        operation: "install",
        stage: "final",
        result: "failed",
      }),
    );
    return false;
  }
  if (installed === "peer-exists") {
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain install peer won`,
      undefined,
      toStoreObservation({
        operation: "install",
        stage: "final",
        result: "peer_won",
      }),
    );
  }
  // stderr captured only to classify; never logged or uploaded.
  const unlock = await spawnSecurity(["unlock-keychain", "-p", "", kc], home, {
    stdout: "ignore",
    stderr: "pipe",
    ...(signal !== undefined ? { signal } : {}),
  });
  if (unlock.code !== 0 || unlock.timedOut || unlock.aborted) {
    const classifier = storeClassifierOf(
      matchUnlockFailureToken(unlock.stderr),
    );
    const observation = toStoreObservation({
      operation: "unlock",
      stage: "final",
      result: storeResultOf(unlock),
      exitCode: unlock.code,
      ...(classifier !== undefined ? { classifier } : {}),
    });
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain final unlock failed`,
      undefined,
      // Staging unlocked this same store moments ago: a refusal now points at
      // the store's name/location, not its password.
      installed === "installed"
        ? { ...observation, store_staging_unlocked: true }
        : observation,
    );
    return false;
  }
  return existsSync(kc);
};

type TRecreateOutcome = {
  readonly created: boolean;
  readonly unlocked: boolean;
  readonly replaced: boolean;
};

const logSelfHealOutcome = (
  meta: {
    readonly created: boolean;
    readonly unlocked: boolean;
  },
  observation: TStoreObservationInput,
): void => {
  logWarn(
    "keychain",
    safeDiagnosticMessage`keychain self-heal outcome`,
    meta,
    toStoreObservation(observation),
  );
};

const adoptPeerStore = async (
  home: string,
  kc: string,
  staging: string,
  signal: AbortSignal | undefined,
  classifier: TDoctorStoreClassifier | undefined,
): Promise<TRecreateOutcome> => {
  await removeOwnedPath(staging);
  const unlock = await spawnSecurityQuiet(
    ["unlock-keychain", "-p", "", kc],
    home,
    signal,
  );
  const unlocked = unlock.code === 0 && !unlock.timedOut && !unlock.aborted;
  logSelfHealOutcome(
    { created: false, unlocked },
    {
      operation: "recreate",
      stage: "final",
      result: "peer_won",
      exitCode: unlock.code,
      ...(classifier !== undefined ? { classifier } : {}),
      recovery: { created: false, unlocked, replaced: false },
    },
  );
  return { created: false, unlocked, replaced: false };
};

/** Build and verify staging while the original remains. Snapshot identity
 *  before the long staging work; if a peer changes the final store, discard
 *  owned staging and adopt theirs instead of moving their credential aside.
 *  Move the original aside only immediately before create-only install;
 *  restore it if install/verify fails, without deleting a peer-owned final.
 *  Timeout/cancel/ambiguous errors never authorize replacement (caller).
 *  Identity recheck narrows the race; it does not close the FS micro-window. */
const recreateIsolatedKeychain = async (
  home: string,
  kc: string,
  signal: AbortSignal | undefined,
  classifier: TDoctorStoreClassifier | undefined,
): Promise<TRecreateOutcome> => {
  invalidateUnlockSkip(kc);
  autoLockOffByKc.delete(kc);
  const dir = dirname(kc);
  const before = storeFingerprint(kc);
  const prepared = await prepareStagingKeychain(home, dir, signal, classifier);
  if (!prepared.ok) {
    const prepResult: TDoctorStoreResult = prepared.aborted
      ? "aborted"
      : prepared.timedOut
        ? "timed_out"
        : "failed";
    logSelfHealOutcome(
      { created: false, unlocked: false },
      {
        operation: "recreate",
        stage: "staging",
        result: prepResult,
        ...(prepared.exitCode !== undefined
          ? { exitCode: prepared.exitCode }
          : {}),
        ...(classifier !== undefined ? { classifier } : {}),
        recovery: { created: false, unlocked: false, replaced: false },
      },
    );
    return { created: false, unlocked: false, replaced: false };
  }
  const afterStaging = storeFingerprint(kc);
  // Peer installed or replaced the final store during staging — adopt it.
  if (
    afterStaging.present &&
    (!before.present || !sameStoreFingerprint(before, afterStaging))
  ) {
    return adoptPeerStore(home, kc, prepared.path, signal, classifier);
  }

  const aside = `${kc}.broken-${process.pid}-${Date.now()}`;
  let originalMoved = false;
  let installedFingerprint: TStoreFingerprint | null = null;
  try {
    const preAside = storeFingerprint(kc);
    if (preAside.present) {
      if (before.present && !sameStoreFingerprint(before, preAside)) {
        return adoptPeerStore(home, kc, prepared.path, signal, classifier);
      }
      await rename(kc, aside);
      originalMoved = true;
    }
    const installed = await installStagingCreateOnly(prepared.path, kc);
    if (installed === "peer-exists") {
      // Peer reoccupied final after our aside (or won the vacant slot).
      // Do not restore aside over a live peer store.
      logWarn(
        "keychain",
        safeDiagnosticMessage`keychain install peer won`,
        undefined,
        toStoreObservation({
          operation: "install",
          stage: "final",
          result: "peer_won",
          ...(classifier !== undefined ? { classifier } : {}),
        }),
      );
      const unlock = await spawnSecurityQuiet(
        ["unlock-keychain", "-p", "", kc],
        home,
        signal,
      );
      const unlocked = unlock.code === 0 && !unlock.timedOut && !unlock.aborted;
      logSelfHealOutcome(
        { created: false, unlocked },
        {
          operation: "recreate",
          stage: "final",
          result: "peer_won",
          exitCode: unlock.code,
          ...(classifier !== undefined ? { classifier } : {}),
          recovery: { created: false, unlocked, replaced: false },
        },
      );
      return { created: false, unlocked, replaced: false };
    }
    if (installed === "failed") {
      logWarn(
        "keychain",
        safeDiagnosticMessage`keychain install failed`,
        undefined,
        toStoreObservation({
          operation: "install",
          stage: "final",
          result: "failed",
          ...(classifier !== undefined ? { classifier } : {}),
        }),
      );
      if (originalMoved && !existsSync(kc)) {
        await restoreAsideCreateOnly(aside, kc, classifier);
      }
      logSelfHealOutcome(
        { created: true, unlocked: false },
        {
          operation: "recreate",
          stage: "final",
          result: "failed",
          ...(classifier !== undefined ? { classifier } : {}),
          recovery: { created: true, unlocked: false, replaced: false },
        },
      );
      return { created: true, unlocked: false, replaced: false };
    }
    installedFingerprint = storeFingerprint(kc);
  } catch {
    await removeOwnedPath(prepared.path);
    if (originalMoved && !existsSync(kc)) {
      await restoreAsideCreateOnly(aside, kc, classifier);
    }
    logSelfHealOutcome(
      { created: true, unlocked: false },
      {
        operation: "recreate",
        stage: "final",
        result: "failed",
        ...(classifier !== undefined ? { classifier } : {}),
        recovery: { created: true, unlocked: false, replaced: false },
      },
    );
    return { created: true, unlocked: false, replaced: false };
  }
  const unlock = await spawnSecurityQuiet(
    ["unlock-keychain", "-p", "", kc],
    home,
    signal,
  );
  const unlocked = unlock.code === 0 && !unlock.timedOut && !unlock.aborted;
  if (!unlocked && originalMoved) {
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain final unlock failed`,
      undefined,
      toStoreObservation({
        operation: "unlock",
        stage: "final",
        result: storeResultOf(unlock),
        exitCode: unlock.code,
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    const current = storeFingerprint(kc);
    // Roll back only while final still matches the full installed fingerprint
    // (ino + mtime + size). Inode alone is not enough: a peer can write in
    // place into our staged file during the failed final unlock. If metadata
    // drifted (including conservative native unlock side-effects), keep the
    // final bytes and retain the original aside rather than delete peer data.
    if (
      current.present &&
      installedFingerprint !== null &&
      sameStoreFingerprint(installedFingerprint, current)
    ) {
      await rm(kc, { force: true }).catch(() => {});
      if (!existsSync(kc)) {
        await restoreAsideCreateOnly(aside, kc, classifier);
      }
    }
    logSelfHealOutcome(
      { created: true, unlocked: false },
      {
        operation: "recreate",
        stage: "final",
        result: storeResultOf(unlock),
        exitCode: unlock.code,
        ...(classifier !== undefined ? { classifier } : {}),
        recovery: { created: true, unlocked: false, replaced: false },
      },
    );
    return { created: true, unlocked: false, replaced: false };
  }
  if (!unlocked) {
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain final unlock failed`,
      undefined,
      toStoreObservation({
        operation: "unlock",
        stage: "final",
        result: storeResultOf(unlock),
        exitCode: unlock.code,
        ...(classifier !== undefined ? { classifier } : {}),
      }),
    );
    // Vacancy / missing-original install still records replaced:true so the
    // process-lifetime one-shot latch holds (deep-recovery characterization).
    logSelfHeal(kc);
    logSelfHealOutcome(
      { created: true, unlocked: false },
      {
        operation: "recreate",
        stage: "final",
        result: storeResultOf(unlock),
        exitCode: unlock.code,
        ...(classifier !== undefined ? { classifier } : {}),
        recovery: { created: true, unlocked: false, replaced: true },
      },
    );
    return { created: true, unlocked: false, replaced: true };
  }
  logSelfHeal(kc);
  logSelfHealOutcome(
    { created: true, unlocked: true },
    {
      operation: "recreate",
      stage: "final",
      result: "succeeded",
      exitCode: 0,
      ...(classifier !== undefined ? { classifier } : {}),
      recovery: { created: true, unlocked: true, replaced: true },
    },
  );
  return { created: true, unlocked: true, replaced: true };
};

/** Ensure the isolated login keychain exists and is UNLOCKED for this call,
 *  reporting readiness as a tri-state. Create when missing; unlock with the
 *  empty password; on a classified empty-password DRIFT of an existing file,
 *  self-heal once (rename-aside + recreate); if it still won't unlock, mark it
 *  unusable so callers stop touching it. A transient unlock failure stays
 *  retryable (returns `indeterminate`, never recreates). No-op `present` off
 *  macOS. */
const noteUnlockSuccess = (kc: string): TStoreRead<void> => {
  transientTimeouts.delete(kc);
  observeTransientTimeouts.delete(kc);
  recordUnlockSuccessForSkip(kc);
  // Login-scoped only: the doctor allowlist already accepts these store_*
  // fields + phase=readiness. Emitting under the login correlation id makes the
  // next fresh-keychain incident diagnosable without paths/stderr.
  const correlation_id = currentLoginCommandCorrelation();
  if (correlation_id !== undefined) {
    logInfo("keychain", safeDiagnosticMessage`keychain ready`, undefined, {
      phase: "readiness",
      outcome: "succeeded",
      store_operation: "unlock",
      store_stage: "final",
      store_result: "succeeded",
      correlation_id,
    });
  }
  return READY;
};

const noteTransientFailure = (kc: string, cause: string): TStoreRead<void> => {
  const prev = transientTimeouts.get(kc);
  const count = (prev?.count ?? 0) + 1;
  const delayMs = Math.min(TRANSIENT_RETRY_CAP_MS, 2_500 * 2 ** (count - 1));
  transientTimeouts.set(kc, { count, nextAtMs: Date.now() + delayMs });
  return { kind: "indeterminate", cause };
};

const noteObserveTransientFailure = (
  kc: string,
  cause: string,
): TStoreRead<void> => {
  const prev = observeTransientTimeouts.get(kc);
  const count = (prev?.count ?? 0) + 1;
  const delayMs = Math.min(TRANSIENT_RETRY_CAP_MS, 2_500 * 2 ** (count - 1));
  observeTransientTimeouts.set(kc, {
    count,
    nextAtMs: Date.now() + delayMs,
  });
  return { kind: "indeterminate", cause };
};

const ensureKeychainNow = async (
  home: string,
  kc: string,
  signal?: AbortSignal,
): Promise<TStoreRead<void>> => {
  // Migrates a legacy reserved-name store before anything opens it.
  const layout = await reconcileKeychainLayout(home);
  if (layout === "conflict") {
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain layout conflict; leaving both stores untouched`,
    );
    return { kind: "indeterminate", cause: "keychain_create_failed" };
  }
  const existedAtStart = existsSync(kc);
  const isInitialExistingUnlock =
    existedAtStart && !initialExistingKeychainUnlocks.has(kc);
  if (isInitialExistingUnlock) initialExistingKeychainUnlocks.add(kc);
  if (!existedAtStart) {
    const created = await createIsolatedKeychain(home, kc, signal);
    if (!created) {
      logKeychainFailure(kc);
      return noteTransientFailure(kc, "keychain_create_failed");
    }
    if ((await reconcileKeychainLayout(home)) !== "ready") {
      logKeychainFailure(kc);
      return noteTransientFailure(kc, "keychain_create_failed");
    }
    // createIsolatedKeychain already unlocked the final store. A second
    // unlock here has failed in the field after a healthy create and then
    // parked every Connect behind readiness backoff (G1).
    return noteUnlockSuccess(kc);
  }
  // Unlock at the FINAL path (securityd keys unlock state by path). Unlocking
  // the reserved name by explicit path is fine — only `create-keychain` at it
  // fails. Capture stderr to classify a failure.
  const res = await spawnSecurity(["unlock-keychain", "-p", "", kc], home, {
    stdout: "ignore",
    stderr: "pipe",
    ...(signal !== undefined ? { signal } : {}),
  });
  if (isInitialExistingUnlock) {
    logInfo("keychain", "keychain initial empty-password unlock", {
      unlocked: res.code === 0,
    });
  }
  if (res.code === 0) return noteUnlockSuccess(kc);

  noteKeychainIoResult(kc, res);
  // Caller abort (status-race cancel) is not a keychain fault — skip timeout
  // accounting so a healthy chain is never marked unusable.
  if (res.aborted) {
    logInfo(
      "keychain",
      safeDiagnosticMessage`keychain final unlock aborted`,
      undefined,
      toStoreObservation({
        operation: "unlock",
        stage: "final",
        result: "aborted",
        exitCode: res.code,
      }),
    );
    return { kind: "indeterminate", cause: "keychain_unlock_transient" };
  }
  if (res.timedOut) {
    logWarn(
      "keychain",
      safeDiagnosticMessage`keychain final unlock timed out`,
      undefined,
      toStoreObservation({
        operation: "unlock",
        stage: "final",
        result: "timed_out",
        exitCode: res.code,
      }),
    );
    return noteTransientFailure(kc, "keychain_unlock_transient");
  }

  const failureToken = matchUnlockFailureToken(res.stderr);
  if (failureToken !== null) {
    invalidateUnlockSkip(kc);
    const classifier = storeClassifierOf(failureToken);
    if (!healedKeychains.has(kc)) {
      const metadata = keychainMetadata(kc);
      // Local meta kept for existing GUI-guard assertions; doctor fields ride
      // the fourth-arg observation (no paths/stderr/tokens on that ledger).
      logWarn(
        "keychain",
        safeDiagnosticMessage`keychain auth-drift evidence`,
        {
          classifier_token: failureToken,
          exit_code: res.code,
          stderr_length: res.stderr.length,
          stderr_excerpt: redactSecurityStderr(res.stderr),
          keychain_mtime_ms: metadata.mtimeMs,
          keychain_size: metadata.size,
          broken_count: await brokenKeychainCount(kc),
        },
        toStoreObservation({
          operation: "recreate",
          stage: "recovery",
          result: "failed",
          exitCode: res.code,
          ...(classifier !== undefined ? { classifier } : {}),
          recovery: {
            created: false,
            unlocked: false,
            replaced: false,
          },
        }),
      );
      const outcome = await recreateIsolatedKeychain(
        home,
        kc,
        signal,
        classifier,
      );
      if (outcome.replaced) healedKeychains.add(kc);
      if (outcome.unlocked) return noteUnlockSuccess(kc);
    } else {
      // Process-lifetime one-shot: searchable skip, not a synthetic success.
      logWarn(
        "keychain",
        safeDiagnosticMessage`keychain recovery skipped; already healed`,
        undefined,
        toStoreObservation({
          operation: "recreate",
          stage: "recovery",
          result: "skipped",
          exitCode: res.code,
          ...(classifier !== undefined ? { classifier } : {}),
          recovery: {
            created: false,
            unlocked: false,
            replaced: false,
          },
        }),
      );
    }
    return noteTransientFailure(kc, "keychain_unlock_transient");
  }
  // Unclassified unlock failure (exact-dialog cases without auth-drift tokens).
  logWarn(
    "keychain",
    safeDiagnosticMessage`keychain final unlock failed`,
    undefined,
    toStoreObservation({
      operation: "unlock",
      stage: "final",
      result: "failed",
      exitCode: res.code,
    }),
  );
  return noteTransientFailure(kc, "keychain_unlock_transient");
};

/**
 * macOS only: ensure an isolated, unlocked login keychain and REPORT
 * readiness. `present` ⇒ safe to run any keychain-touching op (our
 * `dump-keychain`, `set-key-partition-list`, or the vendor CLI reading the
 * store). `indeterminate` ⇒ a create/unlock failure or an unusable chain —
 * callers MUST NOT proceed (that is the GUI-prompt path). Concurrency-deduped;
 * negative-cached; `present` off macOS.
 */
export const ensureKeychainReady = async (
  home: string,
  signal?: AbortSignal,
): Promise<TStoreRead<void>> => {
  if (!MAC) return READY;
  const kc = loginKeychainPath(home);
  const backoff = transientTimeouts.get(kc);
  if (backoff !== undefined && backoff.nextAtMs > Date.now()) {
    const correlation_id = currentLoginCommandCorrelation();
    logInfo(
      "keychain",
      safeDiagnosticMessage`keychain readiness deferred by backoff`,
      undefined,
      {
        phase: "readiness",
        reason_code: "keychain_unavailable",
        outcome: "unknown",
        ...(correlation_id !== undefined ? { correlation_id } : {}),
      },
    );
    return { kind: "indeterminate", cause: "keychain_unlock_transient" };
  }
  let op = inFlightKeychains.get(kc);
  if (op === undefined) {
    if (signal?.aborted === true) {
      return { kind: "indeterminate", cause: "keychain_wait_aborted" };
    }
    if (skipEligible(kc)) {
      keychainCounters.skipped++;
      return READY;
    }
    // The producer owns its command deadline. A status observer's cancellation
    // must not kill readiness work an inference waiter still needs.
    // Promote (one-shot show-keychain-info) is part of this owner so a
    // mid-unlock joiner cannot skip and two first-callers cannot double-spawn.
    op = (async (): Promise<TStoreRead<void>> => {
      if (await tryPromoteUnlockSkip(home, kc)) {
        keychainCounters.skipped++;
        return READY;
      }
      return ensureKeychainNow(home, kc);
    })().finally(() => {
      if (inFlightKeychains.get(kc) === op) inFlightKeychains.delete(kc);
    });
    inFlightKeychains.set(kc, op);
  }
  return awaitSharedStoreRead(op, signal, "keychain_wait_aborted");
};

/**
 * Passive idle readiness: unlock an EXISTING isolated keychain or report
 * unknown. Never create, recreate, rename-aside, or grant ACLs. Classified
 * empty-password drift is indeterminate — repair stays on login / inference /
 * `readToken` via {@link ensureKeychainReady}.
 */
const observeKeychainNow = async (
  home: string,
  kc: string,
  signal?: AbortSignal,
): Promise<TStoreRead<void>> => {
  // Rename-only migration is lossless, so it is safe even on the passive path.
  await reconcileKeychainLayout(home);
  if (!existsSync(kc)) {
    return { kind: "indeterminate", cause: "keychain_absent" };
  }
  const res = await spawnSecurity(["unlock-keychain", "-p", "", kc], home, {
    stdout: "ignore",
    stderr: "pipe",
    ...(signal !== undefined ? { signal } : {}),
  });
  if (res.code === 0) {
    observeTransientTimeouts.delete(kc);
    return noteUnlockSuccess(kc);
  }
  noteKeychainIoResult(kc, res);
  if (res.aborted) {
    return { kind: "indeterminate", cause: "keychain_unlock_transient" };
  }
  return noteObserveTransientFailure(kc, "keychain_unlock_transient");
};

export const observeKeychainReady = async (
  home: string,
  signal?: AbortSignal,
): Promise<TStoreRead<void>> => {
  if (!MAC) return READY;
  const kc = loginKeychainPath(home);
  const backoff = observeTransientTimeouts.get(kc);
  if (backoff !== undefined && backoff.nextAtMs > Date.now()) {
    return { kind: "indeterminate", cause: "keychain_unlock_transient" };
  }
  let op = inFlightObserveKeychains.get(kc);
  if (op === undefined) {
    if (signal?.aborted === true) {
      return { kind: "indeterminate", cause: "keychain_wait_aborted" };
    }
    if (skipEligible(kc)) {
      keychainCounters.skipped++;
      return READY;
    }
    op = (async (): Promise<TStoreRead<void>> => {
      if (await tryPromoteUnlockSkip(home, kc)) {
        keychainCounters.skipped++;
        return READY;
      }
      return observeKeychainNow(home, kc);
    })().finally(() => {
      if (inFlightObserveKeychains.get(kc) === op) {
        inFlightObserveKeychains.delete(kc);
      }
    });
    inFlightObserveKeychains.set(kc, op);
  }
  return awaitSharedStoreRead(op, signal, "keychain_wait_aborted");
};

/** Test-only: process-global keychain caches leak across suites. */
export const resetKeychainStateForTests = (): void => {
  inFlightKeychains.clear();
  inFlightObserveKeychains.clear();
  healedKeychains.clear();
  initialExistingKeychainUnlocks.clear();
  lastKeychainFailureLogMs.clear();
  transientTimeouts.clear();
  observeTransientTimeouts.clear();
  unlockSkip.clear();
  pendingUnlockSkip.clear();
  autoLockOffByKc.clear();
  dumpCache.clear();
  inFlightKeychainReads.clear();
  macosKeychainLane = Promise.resolve();
  keychainCounters = emptyKeychainCounters();
  lastWatcherSnapshot = emptyKeychainCounters();
  securitySpawnSetupHookForTests = null;
  lastSecurityTimerMsForTests = null;
};

/**
 * macOS only: ensure the isolated login keychain exists + is unlocked so a
 * CLI run with `HOME=<home>` (e.g. `claude auth login`) can WRITE its
 * credential without the "Keychain Not Found" dialog. Returns the same
 * tri-state as `ensureKeychainReady` — prompt-capable vendor login must not
 * spawn unless this is `present`.
 *
 * This is the EXPLICIT demand path (browser/CLI Connect). A prior transient
 * unlock/create failure must not make the next user click fail instantly from
 * readiness backoff — clear the active ensure backoff and re-attempt once.
 * Passive observe + refresh keep their own backoff via
 * {@link observeKeychainReady} / {@link ensureKeychainReady}.
 */
export const ensureIsolatedKeychain = async (
  home: string,
): Promise<TStoreRead<void>> => {
  if (MAC) {
    const kc = loginKeychainPath(home);
    if (transientTimeouts.has(kc)) {
      transientTimeouts.delete(kc);
      const correlation_id = currentLoginCommandCorrelation();
      logInfo(
        "keychain",
        safeDiagnosticMessage`keychain readiness demand reattempt`,
        undefined,
        {
          phase: "readiness",
          outcome: "unknown",
          ...(correlation_id !== undefined ? { correlation_id } : {}),
        },
      );
    }
  }
  return ensureKeychainReady(home);
};

/**
 * `security set-key-partition-list` matched no item. `-s` selects symmetric
 * KEYS, but every vendor CLI we host stores its credential as a generic
 * PASSWORD (`class: "genp"`) — a keychain holding only those has no key to
 * partition, so `security` exits 1 with this. That is "nothing to grant", NOT a
 * refusal: the credential is still readable prompt-free. Reporting it as a
 * failure false-fails an otherwise healthy login.
 */
const noKeyToPartition = (stderr: string): boolean =>
  /SecItemCopyMatching/i.test(stderr) &&
  /could not be found in the keychain/i.test(stderr);

/**
 * macOS only: grant command-line tools prompt-free access to the items in
 * the isolated keychain. Run AFTER a login writes them. Gated on readiness.
 * Returns whether the keychain ended up in the granted state (true off macOS,
 * and true when there was no key to partition — see {@link noKeyToPartition}).
 */
export const grantKeychainToolAccess = async (
  home: string,
): Promise<boolean> => {
  if (!MAC) return true;
  if ((await ensureKeychainReady(home)).kind !== "present") return false;
  const kc = loginKeychainPath(home);
  const res = await spawnSecurity(
    ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", "", kc],
    home,
    { stdout: "ignore", stderr: "pipe" },
  );
  noteKeychainIoResult(kc, res);
  if (res.code === 0) {
    logInfo(
      "keychain",
      safeDiagnosticMessage`keychain grant persisted`,
      undefined,
      toStoreObservation({
        operation: "grant",
        stage: "final",
        result: "succeeded",
        exitCode: res.code,
      }),
    );
    return true;
  }
  if (noKeyToPartition(res.stderr)) {
    logInfo(
      "keychain",
      safeDiagnosticMessage`keychain grant skipped; no key to partition`,
      undefined,
      toStoreObservation({
        operation: "grant",
        stage: "final",
        result: "skipped",
        exitCode: res.code,
      }),
    );
    return true;
  }
  logWarn(
    "keychain",
    safeDiagnosticMessage`partition-list grant failed`,
    {
      exit_code: res.code,
      stderr_excerpt: redactSecurityStderr(res.stderr),
    },
    toStoreObservation({
      operation: "grant",
      stage: "final",
      result: storeResultOf(res),
      exitCode: res.code,
    }),
  );
  return false;
};

/**
 * Discover every generic-password service name in the isolated keychain
 * that STARTS WITH `prefix`. Claude suffixes its keychain service with a
 * per-install hash (e.g. `Claude Code-credentials-753e4afa`) so multiple
 * configs don't collide, so an exact-name lookup misses it. `dump-keychain`
 * lists attributes only (no `-d`), so it doesn't prompt for item SECRETS —
 * but it DOES open the keychain, so callers MUST have a `present` readiness
 * first (a locked chain would prompt). `readIsolatedKeychain` enforces that.
 */
const keychainMtimeMs = (kc: string): number => {
  try {
    return statSync(kc).mtimeMs;
  } catch {
    return -1;
  }
};

export const findKeychainServices = async (
  home: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<TStoreRead<ReadonlyArray<string>>> => {
  const kc = loginKeychainPath(home);
  const mtimeMs = keychainMtimeMs(kc);
  const cacheKey = `${kc}\0${prefix}`;
  const cached = dumpCache.get(cacheKey);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.value;
  }
  const dump = await spawnSecurity(["dump-keychain", kc], home, {
    stdout: "pipe",
    stderr: "pipe",
    ...(signal !== undefined ? { signal } : {}),
  });
  noteKeychainIoResult(kc, dump);
  if (dump.code !== 0) {
    return { kind: "indeterminate", cause: `dump-keychain_exit_${dump.code}` };
  }
  const { stdout } = dump;
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/"svce"<blob>="([^"]*)"/);
    if (m?.[1]?.startsWith(prefix) === true) {
      names.add(m[1]);
    }
  }
  const value: TStoreRead<ReadonlyArray<string>> = {
    kind: "present",
    value: [...names],
  };
  dumpCache.set(cacheKey, { mtimeMs, value });
  return value;
};

const readKeychainSecret = async (
  home: string,
  service: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  const kc = loginKeychainPath(home);
  const found = await spawnSecurity(
    ["find-generic-password", "-s", service, "-w", kc],
    home,
    {
      stdout: "pipe",
      stderr: "pipe",
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  noteKeychainIoResult(kc, found);
  if (found.code !== 0) return null;
  const { stdout } = found;
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Read a generic-password `-w` payload from the ISOLATED login keychain,
 * matching `servicePrefix` (Claude's service name carries a per-install
 * hash suffix, so we match by prefix and try each candidate). `validate`
 * rejects a wrong-but-matching item — the first valid payload wins.
 * Returns `absent` off macOS / when no matching item exists;
 * `indeterminate` when the keychain isn't ready (locked / unusable) or when
 * dump-keychain / secret read fails. NEVER dumps a not-ready chain (that is
 * the GUI-prompt path).
 */
const readIsolatedKeychainNow = async (
  home: string,
  servicePrefix: string,
  observeOnly: boolean,
): Promise<TStoreRead<TKeychainPayloads>> => {
  const ready = observeOnly
    ? await observeKeychainReady(home)
    : await ensureKeychainReady(home);
  if (ready.kind !== "present") return ready;
  const services = await findKeychainServices(home, servicePrefix);
  if (services.kind !== "present") return services;

  const values: string[] = [];
  let secretUnreadable = false;
  try {
    for (const service of services.value) {
      const secret = await readKeychainSecret(home, service);
      if (secret === null) {
        secretUnreadable = true;
      } else {
        values.push(secret);
      }
    }
    return { kind: "present", value: { values, secretUnreadable } };
  } catch (err) {
    return {
      kind: "indeterminate",
      cause: err instanceof Error ? err.name : "keychain_read_failed",
    };
  }
};

export const readIsolatedKeychain = async (
  home: string,
  servicePrefix: string,
  validate?: (payload: string) => boolean,
  signal?: AbortSignal,
  observeOnly = false,
): Promise<TStoreRead<string>> => {
  if (!MAC) return { kind: "absent" };
  const key = `${loginKeychainPath(home)}\0${servicePrefix}\0${observeOnly ? "observe" : "mutate"}`;
  let op = inFlightKeychainReads.get(key);
  if (op === undefined) {
    if (signal?.aborted === true) {
      return { kind: "indeterminate", cause: "keychain_read_aborted" };
    }
    op = readIsolatedKeychainNow(home, servicePrefix, observeOnly).finally(
      () => {
        if (inFlightKeychainReads.get(key) === op) {
          inFlightKeychainReads.delete(key);
        }
      },
    );
    inFlightKeychainReads.set(key, op);
  }

  const payloads = await awaitSharedStoreRead(
    op,
    signal,
    "keychain_read_aborted",
  );
  if (payloads.kind !== "present") return payloads;
  for (const payload of payloads.value.values) {
    if (validate === undefined || validate(payload)) {
      return { kind: "present", value: payload };
    }
  }
  if (payloads.value.secretUnreadable) {
    return { kind: "indeterminate", cause: "keychain_secret_unreadable" };
  }
  return { kind: "absent" };
};
