/**
 * Consolidated daemon-private state — ONE `state.json` under the state dir
 * instead of a scatter of single-purpose files. Holds the self-update attempt
 * cooldowns (daemon + CLI slots) and the crash-loop boot history. Strictly
 * daemon-private: nothing outside this binary reads or writes `state.json`, so
 * its shape is free to evolve — unlike the shared `.env` or the `installed/`
 * stamps, which are deployed contracts.
 *
 * CONCURRENCY INVARIANT: every mutation goes through {@link mutateState},
 * which MUST stay fully synchronous — read-fresh, transform, atomic
 * temp+rename write, with no awaits in between. The daemon and CLI update
 * convergers run concurrently (fired un-awaited on the same bootstrap tick),
 * but single-threaded JS plus sync-only file I/O means their read-modify-write
 * cycles can never interleave, so one slot's record can't clobber the other's.
 * That merge-preserving behavior is the guarantee that previously motivated
 * two separate attempt files.
 *
 * Best-effort + never throws (mirrors `logger.ts` / `boot-guard.ts`): a
 * read failure yields defaults, a write failure is swallowed — the in-memory
 * guards in the callers still prevent tight loops.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

/** Which converger recorded an update attempt. */
export type TUpdateSlot = "daemon" | "cli";

export type TUpdateAttempt = { readonly version: string; readonly ts: number };

/**
 * Liveness sentinel for the RTC native-crash breaker. Written at boot, cleared
 * on ANY graceful exit (a `process.on("exit")` hook). A native signal
 * (SIGSEGV/SIGBUS/SIGKILL) runs NO exit hook, so a sentinel that SURVIVES to the
 * next boot means the prior run died to a signal — the discriminator the breaker
 * keys on. `rtcEnabled` records whether RTC was live that run, so only
 * RTC-attributable crashes count.
 */
export type TRtcRun = {
  readonly pid: number;
  readonly startedAt: number;
  readonly rtcEnabled: boolean;
};

export type TDaemonState = {
  readonly updateAttempts: {
    readonly daemon?: TUpdateAttempt;
    readonly cli?: TUpdateAttempt;
  };
  readonly bootHistory: readonly number[];
  /**
   * Seed-derived device-access public key (SPKI DER, base64) pinned from
   * bootstrap. `null` means explicitly un-provisioned; absent means never
   * set. Survives restarts so enforcement does not wait on the next poll.
   */
  readonly deviceAccessPubkey?: string | null;
  /** RTC native-crash breaker: this run's liveness sentinel (see {@link TRtcRun}). */
  readonly rtcRun?: TRtcRun | null;
  /** Timestamps of detected native crashes while RTC was live (bounded window). */
  readonly rtcCrashes?: readonly number[];
  /** The daemon version {@link rtcCrashes} belongs to — a version change discards it. */
  readonly rtcCrashesVersion?: string | null;
};

/**
 * Don't retry the SAME target version within this window after a swap that
 * didn't converge (a mis-published release) — bounds restart/download loops.
 * Single source for both convergers (was duplicated in `self-update.ts` and
 * `cli-self-update.ts`).
 */
export const UPDATE_ATTEMPT_COOLDOWN_MS = 60 * 60 * 1000;

const DEFAULT_STATE: TDaemonState = { updateAttempts: {}, bootHistory: [] };

export const stateFilePath = (): string => join(stateDir(), "state.json");

const isAttempt = (v: unknown): v is TUpdateAttempt =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as TUpdateAttempt).version === "string" &&
  typeof (v as TUpdateAttempt).ts === "number";

const numberList = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];

const isRtcRun = (v: unknown): v is TRtcRun =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as TRtcRun).pid === "number" &&
  Number.isInteger((v as TRtcRun).pid) &&
  typeof (v as TRtcRun).startedAt === "number" &&
  Number.isFinite((v as TRtcRun).startedAt) &&
  typeof (v as TRtcRun).rtcEnabled === "boolean";

/** Coerce parsed-unknown JSON into a valid state, field by field. */
const coerceState = (v: unknown): TDaemonState => {
  if (typeof v !== "object" || v === null) return DEFAULT_STATE;
  const raw = v as {
    updateAttempts?: unknown;
    bootHistory?: unknown;
    deviceAccessPubkey?: unknown;
    rtcRun?: unknown;
    rtcCrashes?: unknown;
    rtcCrashesVersion?: unknown;
  };
  const attempts =
    typeof raw.updateAttempts === "object" && raw.updateAttempts !== null
      ? (raw.updateAttempts as { daemon?: unknown; cli?: unknown })
      : {};
  const pubkey =
    raw.deviceAccessPubkey === null
      ? null
      : typeof raw.deviceAccessPubkey === "string" &&
          raw.deviceAccessPubkey.length > 0
        ? raw.deviceAccessPubkey
        : undefined;
  const rtcCrashes = numberList(raw.rtcCrashes);
  const rtcCrashesVersion =
    typeof raw.rtcCrashesVersion === "string" &&
    raw.rtcCrashesVersion.length > 0
      ? raw.rtcCrashesVersion
      : undefined;
  return {
    updateAttempts: {
      ...(isAttempt(attempts.daemon) ? { daemon: attempts.daemon } : {}),
      ...(isAttempt(attempts.cli) ? { cli: attempts.cli } : {}),
    },
    bootHistory: numberList(raw.bootHistory),
    ...(pubkey !== undefined ? { deviceAccessPubkey: pubkey } : {}),
    ...(isRtcRun(raw.rtcRun) ? { rtcRun: raw.rtcRun } : {}),
    ...(rtcCrashes.length > 0 ? { rtcCrashes } : {}),
    ...(rtcCrashesVersion !== undefined ? { rtcCrashesVersion } : {}),
  };
};

/** Atomic write: pid-suffixed temp + rename. Best-effort — swallows errors. */
const writeStateAtomic = (state: TDaemonState): void => {
  const tmp = join(stateDir(), `.state.json.${process.pid}.tmp`);
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, stateFilePath());
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
};

/**
 * The current consolidated state. Absent or corrupt file → defaults. Never
 * throws. A pure read must not create a state file.
 */
export const readState = (): TDaemonState => {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath(), "utf-8");
  } catch {
    return DEFAULT_STATE;
  }
  try {
    return coerceState(JSON.parse(raw));
  } catch {
    return DEFAULT_STATE;
  }
};

/**
 * Synchronous read-fresh → transform → atomic-write. MUST stay synchronous
 * end to end (see the module header) — that is the whole concurrency story.
 */
export const mutateState = (fn: (s: TDaemonState) => TDaemonState): void => {
  writeStateAtomic(fn(readState()));
};

/**
 * True when `slot` already tried to converge to `version` recently — so a
 * relaunch/tick that still isn't on it (bad publish) backs off instead of
 * looping.
 */
export const recentlyAttempted = (
  slot: TUpdateSlot,
  version: string,
): boolean => {
  const attempt = readState().updateAttempts[slot];
  return (
    attempt !== undefined &&
    attempt.version === version &&
    Date.now() - attempt.ts < UPDATE_ATTEMPT_COOLDOWN_MS
  );
};

/** Record `slot`'s attempt, merge-preserving the other slot's record. */
export const recordAttempt = (slot: TUpdateSlot, version: string): void => {
  mutateState((s) => ({
    ...s,
    updateAttempts: {
      ...s.updateAttempts,
      [slot]: { version, ts: Date.now() },
    },
  }));
};

/** Boot timestamps for the crash-loop breaker (`boot-guard.ts`). */
export const readBootHistory = (): readonly number[] => readState().bootHistory;

export const writeBootHistory = (timestamps: readonly number[]): void => {
  mutateState((s) => ({ ...s, bootHistory: [...timestamps] }));
};

// ── RTC native-crash circuit breaker ────────────────────────────────────────
// The daemon can crash NATIVELY (SIGBUS/SIGSEGV) inside the werift/Bun UDP
// stack — a runtime fault we can't catch in JS. If a host keeps doing it with
// RTC live, we degrade that host to relay-mux (one hop slower, still fully
// functional) instead of crash-looping. This is the durable half; the boot
// wiring lives in `boot-guard.ts`.

/** How far back a native crash counts toward the RTC breaker tally. */
export const RTC_CRASH_WINDOW_MS = 30 * 60 * 1000;
/** Native crashes (RTC live) within {@link RTC_CRASH_WINDOW_MS} that trip it. */
export const RTC_CRASH_LIMIT = 2;

export type TRtcBreakerDecision = {
  /** Whether THIS run should withdraw RTC (fall back to relay-mux). */
  readonly disableRtc: boolean;
  /** State to persist: fresh sentinel + trimmed crash tally + version. */
  readonly nextState: TDaemonState;
};

/**
 * PURE breaker decision (mirrors `boot-guard.ts` `shouldPark` — unit-testable
 * without a real crash). Given the persisted state, `now`, the running daemon
 * `version`, and this process's `pid`:
 *
 * - A prior `rtcRun` sentinel that SURVIVED (still present, different pid, was
 *   RTC-enabled) means the previous run died to a native signal with RTC live —
 *   append `now` to the crash tally.
 * - The tally belongs to a specific `version`; a version change (self-update)
 *   discards it, so a new binary earns a clean trial.
 * - Trip when the in-window tally reaches {@link RTC_CRASH_LIMIT}. A tripped run
 *   records `rtcEnabled:false` in its own sentinel, so a crash while degraded
 *   isn't re-attributed to RTC (the breaker can't self-perpetuate), and the
 *   tally ages out of the window on a later clean run → auto-recovery.
 *
 * HEURISTIC, not proof: a surviving sentinel means "the prior run died to a
 * signal (ran no exit hook) while RTC was live" — which is SIGSEGV/SIGBUS (the
 * target), but ALSO an OOM `SIGKILL`, a `kill -9`, a power loss, or a SIGTERM
 * that arrived before the daemon installed its handlers. Those over-count, but
 * the only consequence is a one-hop-slower relay-mux fallback, and it takes
 * {@link RTC_CRASH_LIMIT} in-window to trip — a benign bias toward safety.
 */
export const evaluateRtcBreaker = (
  state: TDaemonState,
  now: number,
  version: string,
  pid: number,
): TRtcBreakerDecision => {
  const prior = state.rtcRun ?? null;
  const priorCrashedWithRtc =
    prior !== null && prior.pid !== pid && prior.rtcEnabled === true;
  // Discard a tally from a different binary version.
  const priorTally =
    state.rtcCrashesVersion === version
      ? (state.rtcCrashes ?? []).filter(
          (t) => t <= now && now - t < RTC_CRASH_WINDOW_MS,
        )
      : [];
  const rtcCrashes = priorCrashedWithRtc ? [...priorTally, now] : priorTally;
  const disableRtc = rtcCrashes.length >= RTC_CRASH_LIMIT;
  return {
    disableRtc,
    nextState: {
      ...state,
      rtcRun: { pid, startedAt: now, rtcEnabled: !disableRtc },
      rtcCrashes,
      rtcCrashesVersion: version,
    },
  };
};

/**
 * Clear THIS process's liveness sentinel — called from a `process.on("exit")`
 * hook, so it MUST stay synchronous (`mutateState` is). Marks a GRACEFUL exit:
 * the absence of a surviving sentinel next boot is how the breaker tells a clean
 * shutdown from a native crash.
 *
 * PID-guarded: only clear a sentinel this process owns. During a self-update →
 * relaunch handoff (or a supervised fast restart) an exiting process can overlap
 * a freshly-booted one that has already written ITS sentinel; an unguarded clear
 * would erase the new run's evidence and silently defeat the breaker in exactly
 * the crash-churn it exists for. Mirrors the pid identity check in
 * {@link evaluateRtcBreaker}.
 */
export const clearRtcRun = (pid: number = process.pid): void => {
  mutateState((s) => (s.rtcRun?.pid === pid ? { ...s, rtcRun: null } : s));
};
