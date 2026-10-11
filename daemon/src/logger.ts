/**
 * Daemon logs. ONE structured destination, plus native-only stream capture —
 * no duplication between files:
 *
 *   1. `~/.openllm/openllmd.log` — the SINGLE structured log: one timestamped
 *      JSON line per event, rotated past a size cap. The canonical
 *      `tail -f` / `openllmd logs` target. Find faults by grepping
 *      `"level":"error"` (or `"warn"`); every scope is tagged. Which levels
 *      land here is gated by `OPENLLM_LOG_LEVEL` (default `info` — so `debug`
 *      is OFF unless explicitly enabled); see {@link thresholdRank}.
 *   2. `openllmd.out.log` / `openllmd.err.log` — the OS supervisor's capture of
 *      the daemon's raw stdout / stderr (launchd `StandardOut/ErrorPath`,
 *      systemd `append:` — see `service.ts`). These are reserved for NATIVE
 *      output the app logger CAN'T produce (Bun panics, uncaught exceptions,
 *      OOM, a sandbox SIGKILL's dying breath). The app does NOT echo its
 *      structured logs to the streams, so out/err NEVER duplicate the combined
 *      log — `err.log` is crash forensics, usually empty in steady state.
 *
 * The one stream write the app makes is the boot readiness line (a plain stdout
 * line → out.log, for humans + the install-time launcher); readiness GATING is
 * the HTTP `/status` probe (`service.ts`), not a stdout parse.
 *
 * The daemon is headless and the control loop deliberately BACKS OFF on errors
 * instead of crashing — so a relay 404, a sealed-open miss, an unreachable
 * cloud, or a SANDBOX-KILLED child used to vanish with no trace. These helpers
 * make every fault land in `openllmd.log` at `error` level with enough context
 * to diagnose it.
 *
 * Best-effort + self-contained: never throws (a logging failure must not take
 * down the daemon), depends only on `stateDir`, rotates past a size cap.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { TDoctorOutcomeLedger } from "@openllmsh/protocol";
import { projectDoctorOutcomeLedger } from "@openllmsh/protocol";
import { observeDoctorEvent } from "./doctor-report/engine";
import type { TSafeDiagnosticMessage } from "./doctor-report/message";
import {
  isSafeDiagnosticMessage,
  localDiagnosticMessage,
} from "./doctor-report/message";
import type { TDoctorObservationInput } from "./doctor-report/record";
import { currentCommandReplaySessionId } from "./op-context";

export { safeDiagnosticMessage } from "./doctor-report/message";

import { logFilePath, stateDir } from "./env";

// Rotate past 5MB → `<log file>.1` (one generation; the daemon is chatty only
// on errors, and we only need the recent tail to debug).
const MAX_BYTES = 5 * 1024 * 1024;

type TLevel = "error" | "warn" | "info" | "debug";

/** Severity ordering: a lower rank is more severe and always survives the gate. */
const LEVEL_RANK: Record<TLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * The most-verbose level written to the combined log, from `OPENLLM_LOG_LEVEL`
 * (`error` | `warn` | `info` | `debug`, case-insensitive; default `info`).
 * Anything more verbose than this is dropped — so `debug` is OFF by default and
 * turns on only when the env explicitly sets it.
 *
 * Resolved LAZILY per call (not a module constant) so the value the env file
 * loads at boot — and any later change — takes effect regardless of import
 * order; logging is best-effort and infrequent, so the `process.env` read is
 * cheap. An unset or unrecognized value falls back to `info`.
 */
const thresholdRank = (): number => {
  const raw = process.env.OPENLLM_LOG_LEVEL?.trim().toLowerCase();
  if (raw !== undefined && Object.hasOwn(LEVEL_RANK, raw)) {
    return LEVEL_RANK[raw as TLevel];
  }
  return LEVEL_RANK.info;
};

const serializeErr = (err: unknown): string => {
  try {
    if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
    if (typeof err === "string") return err;
    return JSON.stringify(err) ?? "Unknown daemon error";
  } catch {
    // Getters, toJSON and coercion can all throw; never invoke them again.
    return "Unknown daemon error";
  }
};

// Rotation is decided against an in-memory byte tally, NOT a per-line
// `statSync` — that stat was itself synchronous hot-path work that a burst of
// timeout warnings multiplied. The tally is seeded once from the file's real
// size (re-seeded if the log path changes, e.g. between tests) and reset on
// rotation, so it can't drift unboundedly.
let approxBytes = 0;
let seededFor: string | null = null;

const rotateIfBig = (file: string): void => {
  if (seededFor !== file) {
    try {
      approxBytes = statSync(file).size;
    } catch {
      approxBytes = 0; // no file yet
    }
    seededFor = file;
  }
  if (approxBytes <= MAX_BYTES) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or rotate failed — either way, keep appending.
  }
  // Reset the tally regardless: on success the live file is empty; on failure,
  // resetting avoids re-attempting the rename on every subsequent line.
  approxBytes = 0;
};

/**
 * Combined-log append. `error` writes SYNCHRONOUSLY: the last-resort crash
 * handlers in `main.ts` call `process.exit` right after `logError`, so the fatal
 * line must reach disk first. `warn`/`info`/`debug` take a serialized async tail
 * ({@link appendTail}) — a burst (e.g. five per-slug status-timeout warnings) no
 * longer performs N synchronous `appendFileSync` calls inline on the event loop.
 * The two share one file, so a sync error line can land physically between queued
 * lines; each line's `ts` preserves the true order. Returns whether a SYNC write
 * succeeded (async writes report `true` optimistically — their fallback is their
 * own `.catch`).
 */
let appendTail: Promise<void> = Promise.resolve();

const appendCombined = (line: string, sync: boolean): boolean => {
  // Resolve the destination SYNCHRONOUSLY (at log time), then close over it: a
  // deferred write must land in the state dir that was active when the line was
  // logged, not whatever `logFilePath()` resolves to when the tail later drains
  // (which, under a state-dir change, would misfile the line).
  const dir = stateDir();
  const file = logFilePath();
  // Grow the rotation tally only AFTER a successful write: a failed append that
  // still bumped the counter would inflate it unboundedly under sustained
  // failure and force spurious rotation attempts.
  if (sync) {
    try {
      mkdirSync(dir, { recursive: true });
      rotateIfBig(file);
      appendFileSync(file, line, { mode: 0o600 });
      approxBytes += Buffer.byteLength(line);
      return true;
    } catch {
      return false;
    }
  }
  appendTail = appendTail.then(async () => {
    try {
      mkdirSync(dir, { recursive: true });
      rotateIfBig(file);
      await appendFile(file, line, { mode: 0o600 });
      approxBytes += Buffer.byteLength(line);
    } catch {
      // Logging is best-effort — never surface a failed append.
    }
  });
  return true;
};

/**
 * Await any queued async log appends. TEST-ONLY: production never needs to
 * block on the log tail, but a test that asserts a `logWarn`/`logInfo` landed
 * must first drain the serialized queue.
 */
export const flushLogs = (): Promise<void> => appendTail;

type TLogObservation = TDoctorOutcomeLedger &
  Pick<TDoctorObservationInput, "timings" | "correlation_id">;

const write = (
  level: TLevel,
  scope: string,
  message: string | TSafeDiagnosticMessage,
  meta?: Record<string, unknown>,
  observation?: TLogObservation,
): void => {
  if (level === "info" || level === "warn" || level === "error") {
    try {
      observeDoctorEvent({
        severity: level,
        scope,
        message,
        timings: observation?.timings,
        correlation_id: observation?.correlation_id,
        replay_session_id: currentCommandReplaySessionId(),
        ...projectDoctorOutcomeLedger(observation ?? {}),
      });
    } catch {
      // Reporting must never throw or log recursively.
    }
  }
  message = localDiagnosticMessage(message);
  // The boot readiness line is a plain stdout signal for the install-time
  // launcher, so it is emitted regardless of the level gate. Everything else
  // more verbose than `OPENLLM_LOG_LEVEL` is dropped before any write.
  const isBootReadiness = scope === "boot" && level === "info";
  if (LEVEL_RANK[level] > thresholdRank() && !isBootReadiness) return;
  let line: string;
  try {
    // Serialize INSIDE the guard: a circular / BigInt `meta` would otherwise
    // throw here and escape the logger despite its "never throws" contract.
    line = `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...(meta !== undefined ? { meta } : {}),
    })}\n`;
  } catch {
    // Unserializable meta — drop it rather than throw; keep the message.
    line = `${JSON.stringify({ ts: new Date().toISOString(), level, scope, message })}\n`;
  }
  // Only `error` needs the synchronous flush-before-exit guarantee; everything
  // else is queued so it never blocks the event loop.
  const wroteCombinedLog = appendCombined(line, level === "error");
  try {
    // App structured logs go ONLY to the combined `openllmd.log` (the
    // appendFileSync above). They are deliberately NOT echoed to stdout/stderr:
    // the supervisor-captured `openllmd.out.log` (← stdout) / `openllmd.err.log`
    // (← stderr) are reserved for NATIVE output the app logger can't produce
    // (Bun panics, uncaught crashes, OOM) — so those files never DUPLICATE the
    // combined log. Find app errors by grepping `openllmd.log` for
    // `"level":"error"` (or `openllmd logs`); `err.log` is crash forensics.
    //
    // The ONE exception: the boot readiness line, emitted as a single PLAIN
    // stdout line (→ out.log) for humans + the install-time launcher. Readiness
    // GATING is the HTTP `/status` probe (`service.ts probeHealth`), not a
    // stdout parse, so this line is informational only.
    if (isBootReadiness) {
      process.stdout.write(`${message}\n`);
    } else if (!wroteCombinedLog) {
      // Failure-only fallback: when the combined-log file write failed (disk
      // full, perms, read-only FS), echo to stderr so a fault during filesystem
      // trouble isn't a total diagnostics blind spot. In healthy operation this
      // never fires, so out/err stay free of structured-log duplication.
      process.stderr.write(line);
    }
  } catch {
    // streams may be closed under a service manager — ignore.
  }
};

/** Log an error (Error, string, or anything) with an optional context bag. */
export const logError = (
  scope: string,
  err: unknown,
  meta?: Record<string, unknown>,
  observation?: TLogObservation,
): void =>
  write(
    "error",
    scope,
    isSafeDiagnosticMessage(err) ? err : serializeErr(err),
    meta,
    observation,
  );

export const logWarn = (
  scope: string,
  message: string | TSafeDiagnosticMessage,
  meta?: Record<string, unknown>,
  observation?: TLogObservation,
): void => write("warn", scope, message, meta, observation);

export const logInfo = (
  scope: string,
  message: string | TSafeDiagnosticMessage,
  meta?: Record<string, unknown>,
  observation?: TLogObservation,
): void => write("info", scope, message, meta, observation);

/**
 * Low-severity backoff/weather (a transient cloud hiccup, an abort/timeout on
 * the long-poll). Recorded for context but NOT a fault — keeps the error log
 * free of expected re-dials. See `docs/proposals/daemon-poll-db-resilience.md`.
 */
export const logDebug = (
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void => write("debug", scope, message, meta);
