/**
 * Spawn helpers for official-CLI delegation: capture runs, browser/PTY
 * login spawns, and terminal-output hygiene. Split out of `util.ts`
 * (which re-exports everything here — import from either).
 *
 * Bright line (proposal §6): nothing read from a CLI's store may be sent
 * off-box. These helpers feed the LOCAL runner + the local usage panel
 * only.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { TDoctorEventTimings } from "@openllmsh/protocol";
import type { TReapOutcome, TSuperviseSpawnOptions } from "../child-supervisor";
import { superviseSpawn } from "../child-supervisor";
import type { TCliVersionOpts } from "../cli-version-cache";
import { cachedCliVersion } from "../cli-version-cache";
import { spawnCommand } from "../command";
import {
  budgetFromSignal,
  createDeadlineBudget,
  splitReapBudget,
  timeoutCallbackLatenessMs,
} from "../deadline-budget";
import { opaqueDoctorCorrelation } from "../doctor-report/correlation";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  safeDiagnosticMessage,
} from "../logger";
import { currentTickId } from "../op-context";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { daemonTempDir } from "../sandbox/working-set";
import { redactSensitiveArgv } from "./redact-sensitive-argv";

/**
 * Merge spawn env overrides onto a base env. An override value of `undefined`
 * deletes that key from the result (needed so Muse can strip ambient
 * `META_API_KEY` — Bun also treats undefined as unset, but an explicit delete
 * keeps Node and object consumers honest).
 */
export const mergeSpawnEnv = (
  base: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) next[key] = value;
  }
  if (overrides === undefined) return next;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
};

/** Merge an env map onto the parent env for a spawned isolated CLI. */
export const spawnEnv = (
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined =>
  env === undefined ? undefined : mergeSpawnEnv(process.env, env);

/**
 * The working directory for a spawned isolated CLI. SECURITY: the daemon runs
 * with cwd `/` (launchd/systemd start it with no `WorkingDirectory`), and a
 * child inherits it. A vendor CLI launched at `/` enumerates project context
 * from the filesystem ROOT — statting `/Volumes/*`, which on macOS trips the
 * TCC "wants to access files on a network volume" consent prompt (attributed to
 * the daemon as the responsible parent) and needlessly walks the whole disk.
 *
 * So pin the cwd to the child's OWN isolated home (`env.HOME`, e.g.
 * `~/.openllm/cli/claude_code/home` for claude) — which `cliEnv` always sets and
 * the sandbox working set grants read-write — so the CLI's project scan is
 * confined to its empty isolated home, NEVER `/`. Falls back to the daemon-owned
 * temp dir (always created + granted) when no isolated HOME is present or the
 * home dir doesn't yet exist (a not-yet-created cwd would make `Bun.spawn`
 * `ENOENT`). Never returns `/`.
 */
export const spawnCwd = (
  env: Record<string, string | undefined> | undefined,
): string => {
  const home = env?.HOME;
  // Reject `/` explicitly: it "exists", so an env with `HOME=/` (or a daemon
  // whose HOME wasn't isolated) would otherwise pass the existsSync check and
  // re-introduce the exact root-cwd bug this helper exists to prevent.
  if (home !== undefined && home.length > 0 && home !== "/" && existsSync(home))
    return home;
  return daemonTempDir();
};

/**
 * Surface a child that was KILLED BY A SIGNAL (`signalCode` set) — the silent
 * failure mode behind "the flow doesn't trigger, no errors". The OS sandbox
 * SIGKILLs/SIGABRTs a child that hits a denied operation, and a plain exit-code
 * check misses it. Logging the command + signal at ERROR level puts the actual
 * culprit in `openllmd.err.log` instead of letting it vanish. Returns whether a
 * kill was detected (so callers can treat it as a definite failure). No-op for
 * a clean exit.
 */
export type TLogIfKilledOpts = {
  /**
   * Whether the killed child ran through the `--sandbox-exec` shim. The
   * "OS sandbox denial" hint is only defensible for a CONFINED child; a
   * `probe:true` spawn runs UNWRAPPED (see {@link sandboxSpawnArgs}), so a
   * signal death there cannot be a Seatbelt denial — it's an external signal
   * (a daemon restart/drain, a manual kill). Blaming the sandbox there actively
   * misdirects diagnosis. Defaults to `true` (confined) when the caller can't
   * say, preserving the historical hint for unknown call sites.
   */
  readonly confined?: boolean;
};

export const logIfKilled = (
  argv: ReadonlyArray<string>,
  proc: {
    readonly signalCode: string | null;
    readonly exitCode: number | null;
  },
  opts?: TLogIfKilledOpts,
): boolean => {
  // The `--sandbox-exec` shim mirrors a signal death of its tail as exit code
  // `128 + N` (the daemon-side proc is the SHIM, so its signalCode is null) —
  // without this mapping a sandbox kill of a wrapped child is invisible here
  // and the spawn just looks like a quiet non-zero exit. A CLI can exit 130
  // by its own convention (ctrl-c), so this is a diagnostic breadcrumb, not a
  // hard verdict.
  const signal =
    proc.signalCode ??
    (proc.exitCode !== null && proc.exitCode > 128 && proc.exitCode <= 128 + 31
      ? (SIGNAL_NAMES[proc.exitCode - 128] ?? `signal ${proc.exitCode - 128}`)
      : null);
  if (signal === null) return false;
  // Only a CONFINED child can be Seatbelt-denied. An unconfined (`probe`) kill
  // is an EXTERNAL signal — attributing it to the sandbox sent a real incident's
  // diagnosis down a dead end. Default to the sandbox hint only when confinement
  // is unknown or true.
  const confined = opts?.confined !== false;
  logError("delegation", `child killed by ${signal}`, {
    command: argv[0],
    argv: [...argv],
    signal,
    confined,
    hint: confined
      ? "likely an OS sandbox denial — see DaemonStatus.sandbox / the sandbox working set"
      : "external signal on an unconfined child — likely a daemon restart/drain or manual kill (the sandbox was not involved)",
  });
  return true;
};

/** Conventional signal number → name, for the shim's `128 + N` exit mirror. */
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGUSR1",
  11: "SIGSEGV",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

/** Hard ceiling for one-shot vendor CLI captures and probes. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;
const MIN_CAPTURE_TIMEOUT_MS = 250;

const captureTimeoutMs = (timeoutMs: number | undefined): number =>
  Math.max(MIN_CAPTURE_TIMEOUT_MS, timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

export type TRunCaptureOpts = {
  /** Skip the sandbox shim for a read-only probe that needs direct execution. */
  readonly probe?: boolean;
  /** Classify the disposable child independently of sandbox-shim behavior. */
  readonly kind?: "probe" | "vendor-capture";
  /** Hard ceiling for stdout capture plus child exit before group termination. */
  readonly timeoutMs?: number;
  /** Early-cancel: terminate the process group when aborted (status-probe race). */
  readonly signal?: AbortSignal;
  /** Exit 0 with empty stdout is success (logout prints nothing). */
  readonly allowEmpty?: boolean;
  /**
   * When set, stop reading stdout after this many bytes and treat overflow
   * as failure. Version probes pass a small cap so a hung printer cannot
   * fill memory/disk.
   */
  readonly maxBytes?: number;
  readonly producer?: TNativeAuthProducer;
  readonly operationId?: string;
  /**
   * Opt-in: pipe stderr (capped at {@link FAILURE_STDERR_MAX_BYTES}) and hand
   * it to this callback when the child exits NON-ZERO. For LOCAL failure
   * classification only — callers must never log or upload the text itself.
   * Unset keeps stderr ignored (the default for every existing caller).
   */
  readonly onFailureStderr?: (stderr: string) => void;
};

const FAILURE_STDERR_MAX_BYTES = 2_048;

const readCappedText = async (
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || n >= cap) continue; // keep draining
      const take = value.subarray(0, cap - n);
      chunks.push(take);
      n += take.byteLength;
    }
  } catch {
    // stream torn down — return what was read
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  const merged = new Uint8Array(n);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
};

/** Subscribe to `signal` abort; invoke `onAbort` immediately if already aborted. */
export const bindAbort = (
  signal: AbortSignal | undefined,
  onAbort: () => void,
): (() => void) => {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return (): void => {
    signal.removeEventListener("abort", onAbort);
  };
};

/**
 * Read abort without using `=== true` on a property TypeScript may have
 * narrowed to `false` after an earlier early-return. A later abort remains
 * observable.
 */
const signalAbortRequested = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted ?? false;

type TCaptureOutcome =
  | { readonly kind: "complete"; readonly out: string; readonly code: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "overflow" };

type TCaptureCompleteHook = () => void;

let captureCompleteHookForTests: TCaptureCompleteHook | null = null;

/** Test-only: run after `complete` settles, before `Promise.race` reactions. */
export const setCaptureCompleteHookForTests = (
  hook: TCaptureCompleteHook | null,
): void => {
  captureCompleteHookForTests = hook;
};

type TCaptureTimeoutScheduler = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;

let captureTimeoutSchedulerForTests: TCaptureTimeoutScheduler | null = null;
let loginTimeoutSchedulerForTests: TCaptureTimeoutScheduler | null = null;

export type TNativeAuthProducer =
  | "claude-refresh"
  | "claude-auth-status"
  | "claude-login"
  | "claude-logout"
  /** Browser-URL stream logins (cursor, codex) recorded by makeStreamConnect. */
  | "stream-login";

const nativeAuthOperationMeta = (
  operationId: string | undefined,
): { readonly operation_id: string } | Record<string, never> => {
  const id = opaqueDoctorCorrelation(operationId);
  return id !== undefined ? { operation_id: id } : {};
};

const nativeAuthDoctorObservation = (
  operationId: string | undefined,
  timings: TDoctorEventTimings,
): {
  readonly timings: TDoctorEventTimings;
  readonly correlation_id?: string;
} => {
  const correlation_id = opaqueDoctorCorrelation(operationId);
  return {
    timings,
    ...(correlation_id !== undefined ? { correlation_id } : {}),
  };
};

let nativeAuthOperationSeq = 0;

/** Ephemeral correlation id for one native-auth child. Not an account identity. */
export const newNativeAuthOperationId = (): string => {
  nativeAuthOperationSeq += 1;
  return `na-${nativeAuthOperationSeq.toString(36)}-${Math.floor(performance.now()).toString(36)}`;
};

/**
 * Test-only: replace the capture watchdog `setTimeout`. Used to inject a
 * delayed fire for lateness fields. Production always uses `setTimeout`.
 */
export const setCaptureTimeoutSchedulerForTests = (
  scheduler: TCaptureTimeoutScheduler | null,
): void => {
  captureTimeoutSchedulerForTests = scheduler;
};

/**
 * Test-only: replace the login watchdog `setTimeout`. Used to inject a
 * delayed fire for lateness fields. Production always uses `setTimeout`.
 */
export const setLoginTimeoutSchedulerForTests = (
  scheduler: TCaptureTimeoutScheduler | null,
): void => {
  loginTimeoutSchedulerForTests = scheduler;
};

export type TRunCaptureResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed" };

/**
 * Run a command and capture trimmed stdout. Distinguishes timeout from
 * abort / non-zero / empty / spawn failure. stdin is ignored so it never
 * blocks. `env` is merged onto the parent env — used to run the isolated vendor
 * CLIs with their home pointed inside the OpenLLM dir.
 *
 * The stdout read and root child exit share one hard deadline. On expiry, use
 * the supervisor's process-group termination rather than `proc.kill()`: a
 * descendant holding the inherited stdout fd must be reaped for EOF to occur.
 */
export const runCaptureResult = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
  opts?: TRunCaptureOpts,
): Promise<TRunCaptureResult> => {
  if (signalAbortRequested(opts?.signal)) return { kind: "aborted" };
  try {
    const setupStartedAtMs = performance.now();
    const command = spawnCommand(
      process.platform,
      argv[0] ?? "",
      argv.slice(1),
    );
    const spawnOptions: TSuperviseSpawnOptions = {
      kind: opts?.kind ?? (opts?.probe === true ? "probe" : "vendor-capture"),
      stdin: "ignore",
      stdout: "pipe",
      stderr: opts?.onFailureStderr !== undefined ? "pipe" : "ignore",
      cwd: spawnCwd(env),
      ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
    };
    const child = superviseSpawn(
      sandboxSpawnArgs(command, { probe: opts?.probe }),
      spawnOptions,
    );
    const spawnedAtMs = performance.now();
    const spawnSetupMs = spawnedAtMs - setupStartedAtMs;
    const proc = child.subprocess;
    if (opts?.producer !== undefined) {
      logDebug("spawn", "native auth child started", {
        producer: opts.producer,
        ...nativeAuthOperationMeta(opts.operationId),
        phase: "start",
        child_pid: typeof proc.pid === "number" ? proc.pid : null,
        tick_id: currentTickId(),
        configured_timeout_ms: captureTimeoutMs(opts.timeoutMs),
        spawn_setup_ms: spawnSetupMs,
        clock: "performance.now",
      });
    }
    const stderrStream = proc.stderr;
    const stderrText =
      opts?.onFailureStderr !== undefined &&
      stderrStream !== undefined &&
      typeof stderrStream !== "number"
        ? readCappedText(stderrStream, FAILURE_STDERR_MAX_BYTES)
        : null;
    const stdout = proc.stdout;
    if (stdout === undefined || typeof stdout === "number") {
      await child.terminate();
      return { kind: "failed" };
    }
    const configuredTimeoutMs = captureTimeoutMs(opts?.timeoutMs);
    const parentBudget = budgetFromSignal(opts?.signal);
    const budget =
      parentBudget?.child(configuredTimeoutMs) ??
      createDeadlineBudget(configuredTimeoutMs, opts?.signal);
    const remainingAtSpawn = budget.remainingMs();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerArmedAtMs: number | null = null;
    let timerFiredAtMs: number | null = null;
    let timerDelayMs = remainingAtSpawn;
    let stdoutClosed = false;
    let rootExitCode: number | null = null;
    const unbind = bindAbort(opts?.signal, () => {
      void child.terminate(splitReapBudget(budget.remainingMs()));
    });
    let unbindAbortWait = (): void => {};
    try {
      const readStdout = async (): Promise<{
        readonly out: string;
        readonly overflow: boolean;
      }> => {
        const cap = opts?.maxBytes;
        if (cap === undefined || cap <= 0) {
          const out = await new Response(stdout).text();
          return { out, overflow: false };
        }
        const reader = stdout.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            n += value.byteLength;
            if (n > cap) {
              try {
                await reader.cancel();
              } catch {
                // already closed
              }
              return { out: "", overflow: true };
            }
            chunks.push(value);
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
        }
        const merged = new Uint8Array(n);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        return { out: new TextDecoder().decode(merged), overflow: false };
      };
      void proc.exited.then((code) => {
        rootExitCode = code;
      });
      const complete = (async (): Promise<TCaptureOutcome> => {
        const read = await readStdout().finally(() => {
          stdoutClosed = true;
        });
        if (read.overflow) return { kind: "overflow" };
        const code = await proc.exited;
        return { kind: "complete", out: read.out, code };
      })();
      const scheduleTimeout =
        captureTimeoutSchedulerForTests ??
        ((
          callback: () => void,
          delayMs: number,
        ): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs));
      const timeout = new Promise<TCaptureOutcome>((resolve) => {
        timerDelayMs = budget.remainingMs();
        timerArmedAtMs = performance.now();
        timer = scheduleTimeout(() => {
          timerFiredAtMs = performance.now();
          resolve({ kind: "timeout" });
        }, timerDelayMs);
      });
      const abortWait =
        opts?.signal === undefined
          ? null
          : new Promise<TCaptureOutcome>((resolve) => {
              unbindAbortWait = bindAbort(opts.signal, () =>
                resolve({ kind: "aborted" }),
              );
            });
      if (captureCompleteHookForTests !== null) {
        const hook = captureCompleteHookForTests;
        void complete.then(() => {
          hook();
        });
      }
      const outcome = await Promise.race(
        abortWait === null
          ? [complete, timeout]
          : [complete, timeout, abortWait],
      );
      const raceObservedAtMs = performance.now();
      // Race winner is authoritative. Unbind before branching so a late abort
      // cannot flip the shared flag and discard a completed stdout.
      unbind();
      unbindAbortWait();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (outcome.kind === "timeout") {
        const stdoutClosedAtRace = stdoutClosed;
        const rootExitedAtRace =
          rootExitCode !== null ||
          proc.exitCode !== null ||
          proc.signalCode !== null;
        const rootExitCodeAtRace = rootExitCode ?? proc.exitCode;
        const armed = timerArmedAtMs ?? spawnedAtMs;
        const fired = timerFiredAtMs ?? raceObservedAtMs;
        const lateness = timeoutCallbackLatenessMs(armed, fired, timerDelayMs);
        const timeoutMessage =
          opts?.producer === "claude-auth-status"
            ? safeDiagnosticMessage`Authentication status probe exceeded its time budget.`
            : opts?.producer === "claude-refresh"
              ? safeDiagnosticMessage`Credential refresh exceeded its time budget.`
              : opts?.producer === "claude-logout"
                ? safeDiagnosticMessage`Logout exceeded its time budget.`
                : safeDiagnosticMessage`Native capture exceeded its time budget.`;
        const raceMeta = {
          configured_timeout_ms: configuredTimeoutMs,
          deadline_ms: remainingAtSpawn,
          remaining_at_spawn_ms: remainingAtSpawn,
          budget_remaining_ms_at_spawn: remainingAtSpawn,
          spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
          spawn_setup_ms: spawnSetupMs,
          timer_armed_at_ms: armed,
          timer_fired_at_ms: fired,
          race_observed_at_ms: raceObservedAtMs,
          timeout_callback_lateness_ms: lateness,
          stdout_closed: stdoutClosedAtRace,
          root_exited: rootExitedAtRace,
          root_exit_code: rootExitCodeAtRace,
          clock: "performance.now" as const,
          child_pid: typeof proc.pid === "number" ? proc.pid : null,
          tick_id: currentTickId(),
          kind: spawnOptions.kind,
          probe: opts?.probe === true,
          reason_code: "timeout" as const,
          phase: "timeout_race" as const,
          cancel_requested: signalAbortRequested(opts?.signal),
          ...(opts?.producer !== undefined ? { producer: opts.producer } : {}),
          ...nativeAuthOperationMeta(opts?.operationId),
          ...(opts?.producer === undefined
            ? { argv: redactSensitiveArgv(argv) }
            : {}),
        };
        const raceDoctor = nativeAuthDoctorObservation(opts?.operationId, {
          configured_timeout_ms: configuredTimeoutMs,
          spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
          budget_remaining_ms_at_spawn: remainingAtSpawn,
          timeout_callback_lateness_ms: Math.max(0, lateness),
          stdout_closed: stdoutClosedAtRace,
          root_exited: rootExitedAtRace,
          ...(typeof rootExitCodeAtRace === "number"
            ? { root_exit_code: rootExitCodeAtRace }
            : {}),
        });
        logWarn("spawn", timeoutMessage, raceMeta, raceDoctor);
        const cleanupStartedAtMs = performance.now();
        const reap = await child.terminate(
          splitReapBudget(budget.remainingMs()),
        );
        const cleanupMs = performance.now() - cleanupStartedAtMs;
        const cleanup = childCleanupOutcome(
          reap,
          signalAbortRequested(opts?.signal),
        );
        logInfo(
          "spawn",
          safeDiagnosticMessage`Native capture cleanup finished.`,
          {
            ...raceMeta,
            phase: "cleanup",
            reason_code: "cleanup",
            cleanup_ms: cleanupMs,
            cleanup_reap: cleanup.reap,
            cleanup_confirmed: cleanup.confirmed,
            cancel_requested: cleanup.cancel_requested,
          },
          nativeAuthDoctorObservation(opts?.operationId, {
            cleanup_ms: cleanupMs,
            stdout_closed: stdoutClosedAtRace,
            root_exited: rootExitedAtRace,
            ...(typeof rootExitCodeAtRace === "number"
              ? { root_exit_code: rootExitCodeAtRace }
              : {}),
          }),
        );

        return { kind: "timeout" };
      }
      if (outcome.kind === "aborted") {
        await child.terminate(splitReapBudget(budget.remainingMs()));
        return { kind: "aborted" };
      }
      if (outcome.kind === "overflow") {
        await child.terminate(splitReapBudget(budget.remainingMs()));
        return { kind: "failed" };
      }
      // `probe:true` runs UNWRAPPED — a signal death there is not a sandbox
      // denial (this was the mislabeled `--version` status-probe drain).
      logIfKilled(redactSensitiveArgv(argv), proc, {
        confined: opts?.probe !== true,
      });
      if (outcome.code !== 0) {
        if (stderrText !== null && opts?.onFailureStderr !== undefined) {
          try {
            opts.onFailureStderr(await stderrText);
          } catch {
            // classification must never change the capture outcome
          }
        }
        return { kind: "failed" };
      }
      const trimmed = outcome.out.trim();
      if (trimmed.length > 0) return { kind: "ok", text: trimmed };
      return opts?.allowEmpty === true
        ? { kind: "ok", text: "" }
        : { kind: "failed" };
    } finally {
      unbind();
      unbindAbortWait();
      if (timer !== null) clearTimeout(timer);
      budget.release();
    }
  } catch {
    return { kind: "failed" };
  }
};

/** Run a command and capture trimmed stdout (best-effort). Returns null on
 *  spawn failure, non-zero exit, abort, or a timeout. */
export const runCapture = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
  opts?: TRunCaptureOpts,
): Promise<string | null> => {
  const result = await runCaptureResult(argv, env, opts);
  return result.kind === "ok" ? result.text : null;
};

/** Run a binary's `--version` (best-effort). Returns null on failure.
 *  UNWRAPPED (`probe: true`): a fixed-argv, read-only `<bin> --version` is the
 *  canonical skip-the-shim probe (see {@link TSandboxSpawnOpts.probe}). Leaving
 *  it confined was a latent bug — harmless while `--version` was a pure print,
 *  but the `openllm` CLI's `--version` now spawns a nested `openllmd --version`
 *  child, and a confined caller spawning that child can be Seatbelt/Landlock
 *  denied (→ null → the CLI converger's "did not report a version" skip).
 *  Stamp-keyed via {@link cachedCliVersion}: success and completed failure
 *  reuse until the resolved binary identity changes (no TTL). */
export const cliVersion = (
  bin: string,
  env?: Record<string, string>,
  opts?: TCliVersionOpts,
): Promise<string | null> => cachedCliVersion(bin, env, opts);

export type TLoginResult = {
  readonly code: number;
  /** Combined stdout+stderr (trimmed), for surfacing failures. */
  readonly output: string;
  /** True when we abandoned the child (early `until` match or timeout) rather
   *  than it exiting on its own — its OUTPUT is still valid (the token/cred was
   *  produced first), it just never cleanly exited. */
  readonly abandoned: boolean;
  /** Wall clock immediately after `superviseSpawn`. Null when no child ran. */
  readonly spawned_at_ms: number | null;
  /** Child pid immediately after `superviseSpawn`. Null when no child ran. */
  readonly child_pid: number | null;
  /** `performance.now()` spawn setup duration. */
  readonly spawn_setup_ms?: number;
  /** `performance.now()` child-wait duration until race/exit. */
  readonly child_wait_ms?: number;
  /**
   * Actual group-reap result. Absent when no child ran. `confirmed: false`
   * means termination was not observed — retain ownership. Not implied by
   * `signal` being cancellable.
   */
  readonly cleanup?: TChildCleanupOutcome;
  /**
   * Settles when supervisor tracking is dropped. Pending while cleanup is
   * unconfirmed. P1 should await this instead of parsing thrown handles.
   */
  readonly whenReleased?: Promise<TReapOutcome>;
};

/**
 * Confirmed process-group cleanup for an owned login/capture child.
 * `cancellable: true` on a signal is never treated as completed termination.
 */
export type TChildCleanupOutcome = {
  readonly reap: TReapOutcome;
  readonly confirmed: boolean;
  readonly cancel_requested: boolean;
};

export const childCleanupOutcome = (
  reap: TReapOutcome,
  cancelRequested: boolean,
): TChildCleanupOutcome => ({
  reap,
  confirmed: reap !== "reap_unconfirmed",
  cancel_requested: cancelRequested,
});

const noChildResult = (abandoned: boolean): TLoginResult => ({
  code: -1,
  output: "",
  abandoned,
  spawned_at_ms: null,
  child_pid: null,
});

const spawnStamp = (proc: {
  readonly pid?: number;
}): Pick<TLoginResult, "spawned_at_ms" | "child_pid"> => ({
  spawned_at_ms: Date.now(),
  child_pid: typeof proc.pid === "number" ? proc.pid : null,
});

export type TSpawnLoginOpts = {
  /** Hard ceiling: kill the child after this and return what was captured.
   *  A browser OAuth needs the user to sign in, so it's generous. */
  readonly timeoutMs?: number;
  /** When the COMBINED output matches this, the child has produced what we
   *  need (e.g. a printed verification prompt) — kill it and return immediately
   *  instead of waiting for it to exit. Vendor CLIs (themselves Bun/Node
   *  binaries) can hang in `__cxa_finalize`/atexit AFTER printing it, so waiting
   *  on `proc.exited` would block forever + pile up 99%-CPU runaways. We don't
   *  need the exit — only the output. */
  readonly until?: RegExp;
  /** Skip the `--sandbox-exec` wrap (see `TSandboxSpawnOpts.probe`). REQUIRED
   *  for children that must operate a macOS-keychain-backed credential store
   *  (claude/cursor status + refresh): securityd refuses keychain reads for a
   *  Seatbelt-confined caller, so a wrapped spawn reports "not signed in" and
   *  a wrapped refresh silently never persists the rotated token. */
  readonly probe?: boolean;
  /** Early-cancel the login child. Refresh must not pass an observer abort here. */
  readonly signal?: AbortSignal;
  /**
   * Refresh-only: after the spawn deadline fires, decide whether to defer
   * SIGTERM for {@link TSpawnLoginOpts.persistenceGraceMs}. True only when a
   * validated newer store is already visible. The child stays supervised; a
   * later exit or bounded terminate still finalizes ownership.
   */
  readonly onDeadline?: () => boolean | Promise<boolean>;
  /** Finite persistence grace after a true {@link TSpawnLoginOpts.onDeadline}. */
  readonly persistenceGraceMs?: number;
  readonly producer?: TNativeAuthProducer;
  readonly operationId?: string;
};

/**
 * Cap for `onDeadline` (store re-read). A hung Darwin `security`/keychain must
 * not delay SIGTERM; grace starts only after a finished verified persist.
 */
export const DEADLINE_CHECK_CAP_MS = 400;

const awaitOnDeadline = async (
  check: (() => boolean | Promise<boolean>) | undefined,
): Promise<boolean> => {
  if (check === undefined) return false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve(check()).then((v) => v === true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), DEADLINE_CHECK_CAP_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

const waitWithCap = async (
  work: Promise<unknown>,
  capMs: number,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      work.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/** Default login ceiling — long enough for a human to complete the browser
 *  OAuth, short enough that a wedged child is reaped, not left forever. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** After `opts.until` first matches, wait this long for the rest of a
 *  chunk-split token to arrive before killing — so the captured token is the
 *  COMPLETE one even though the regex isn't boundary-anchored. */
export const UNTIL_SETTLE_MS = 400;

/**
 * Spawn a vendor CLI's login command and capture its output. The CLI opens the
 * user's browser; the user signs in and the CLI completes via its own localhost
 * callback, at which point the credential is in the CLI's OWN store. stdin is
 * ignored (browser-driven; headless daemon has no usable stdin).
 *
 * Robustness (load-bearing): we NEVER block indefinitely on the child exiting.
 * Output is STREAMED; if `opts.until` matches we kill the child and return
 * (the vendor CLI can hang in atexit AFTER printing the token — see
 * `TSpawnLoginOpts.until`), and a `timeoutMs` ceiling reaps a wedged child
 * regardless. Either way the captured output is returned — the caller re-reads
 * the store / parses the token from it.
 */
export const spawnLogin = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
  opts?: TSpawnLoginOpts,
): Promise<TLoginResult> => {
  const loginOpts = opts;
  if (signalAbortRequested(loginOpts?.signal)) {
    return noChildResult(true);
  }
  const setupStartedAtMs = performance.now();
  const timeoutMs = loginOpts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const parentBudget = budgetFromSignal(loginOpts?.signal);
  const budget =
    parentBudget?.child(timeoutMs) ??
    createDeadlineBudget(timeoutMs, loginOpts?.signal);
  const remainingAtSpawn = budget.remainingMs();
  const child = superviseSpawn(
    sandboxSpawnArgs(argv, { probe: loginOpts?.probe }),
    {
      kind: "login",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd(env),
      ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
    },
  );
  let terminatePromise: Promise<TReapOutcome> | null = null;
  const requestTerminate = (): Promise<TReapOutcome> => {
    if (terminatePromise === null) {
      terminatePromise = child.terminate(splitReapBudget(budget.remainingMs()));
    }
    return terminatePromise;
  };
  try {
    const spawnedAtMs = performance.now();
    const spawnSetupMs = spawnedAtMs - setupStartedAtMs;
    const proc = child.subprocess;
    const stamp = spawnStamp(proc);
    const unbindEarlyAbort = bindAbort(loginOpts?.signal, () => {
      void requestTerminate();
    });
    if (loginOpts?.producer !== undefined) {
      logDebug("spawn", "native auth child started", {
        producer: loginOpts.producer,
        ...nativeAuthOperationMeta(loginOpts.operationId),
        phase: "start",
        child_pid: stamp.child_pid,
        tick_id: currentTickId(),
        configured_timeout_ms: timeoutMs,
        remaining_at_spawn_ms: remainingAtSpawn,
        spawn_setup_ms: spawnSetupMs,
        clock: "performance.now",
      });
    }
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (
      stdout === undefined ||
      typeof stdout === "number" ||
      stderr === undefined ||
      typeof stderr === "number"
    ) {
      unbindEarlyAbort();
      const reap = await requestTerminate();
      return {
        code: -1,
        output: "",
        abandoned: true,
        spawn_setup_ms: spawnSetupMs,
        cleanup: childCleanupOutcome(
          reap,
          signalAbortRequested(loginOpts?.signal),
        ),
        whenReleased: child.whenReleased,
        ...stamp,
      };
    }
    const dec = new TextDecoder();
    let out = "";
    let err = "";
    let abandoned = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let timerArmedAtMs: number | null = null;
    let timerFiredAtMs: number | null = null;
    let timerDelayMs = remainingAtSpawn;
    let stdoutClosed = false;
    let stderrClosed = false;
    let rootExitCode: number | null = null;
    let cleanupMs: number | null = null;
    let cleanup: TChildCleanupOutcome | undefined;
    const cancelRequested = (): boolean =>
      signalAbortRequested(loginOpts?.signal);
    void proc.exited.then((code) => {
      rootExitCode = code;
    });
    let markAbandoned!: () => void;
    const abandonedGate = new Promise<void>((resolve) => {
      markAbandoned = resolve;
    });
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    const kill = (): void => {
      if (abandoned) return;
      abandoned = true;
      markAbandoned();
      for (const reader of readers) {
        void reader.cancel().catch(() => {});
      }
      void requestTerminate();
    };

    const emitLoginTimeoutRace = (opts: {
      readonly stdoutClosed: boolean;
      readonly stderrClosed: boolean;
      readonly rootExited: boolean;
      readonly rootExitCode: number | null;
    }): {
      readonly raceObservedAtMs: number;
      readonly armed: number;
      readonly fired: number;
      readonly lateness: number;
    } => {
      const raceObservedAtMs = performance.now();
      const armed = timerArmedAtMs ?? spawnedAtMs;
      const fired = timerFiredAtMs ?? raceObservedAtMs;
      const lateness = timeoutCallbackLatenessMs(armed, fired, timerDelayMs);
      logWarn(
        "spawn",
        loginOpts?.producer === "claude-refresh"
          ? safeDiagnosticMessage`Credential refresh exceeded its time budget.`
          : safeDiagnosticMessage`Login exceeded its time budget.`,
        {
          configured_timeout_ms: timeoutMs,
          deadline_ms: remainingAtSpawn,
          remaining_at_spawn_ms: remainingAtSpawn,
          budget_remaining_ms_at_spawn: remainingAtSpawn,
          spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
          spawn_setup_ms: spawnSetupMs,
          timer_armed_at_ms: armed,
          timer_fired_at_ms: fired,
          race_observed_at_ms: raceObservedAtMs,
          timeout_callback_lateness_ms: lateness,
          stdout_closed: opts.stdoutClosed,
          stderr_closed: opts.stderrClosed,
          root_exited: opts.rootExited,
          root_exit_code: opts.rootExitCode,
          clock: "performance.now",
          child_pid: stamp.child_pid,
          tick_id: currentTickId(),
          kind: "login",
          probe: loginOpts?.probe === true,
          reason_code: "timeout",
          phase: "timeout_race",
          abandoned: true,
          cancel_requested: cancelRequested(),
          ...(loginOpts?.producer !== undefined
            ? { producer: loginOpts.producer }
            : {}),
          ...nativeAuthOperationMeta(loginOpts?.operationId),
        },
        nativeAuthDoctorObservation(loginOpts?.operationId, {
          configured_timeout_ms: timeoutMs,
          spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
          budget_remaining_ms_at_spawn: remainingAtSpawn,
          timeout_callback_lateness_ms: Math.max(0, lateness),
          stdout_closed: opts.stdoutClosed,
          stderr_closed: opts.stderrClosed,
          root_exited: opts.rootExited,
          ...(typeof opts.rootExitCode === "number"
            ? { root_exit_code: opts.rootExitCode }
            : {}),
        }),
      );
      return { raceObservedAtMs, armed, fired, lateness };
    };

    const emitLoginCleanup = (opts: {
      readonly stdoutClosed: boolean;
      readonly stderrClosed: boolean;
      readonly rootExited: boolean;
      readonly rootExitCode: number | null;
      readonly cleanupMs: number;
      readonly cleanup: TChildCleanupOutcome;
    }): void => {
      logInfo(
        "spawn",
        safeDiagnosticMessage`Login cleanup finished.`,
        {
          configured_timeout_ms: timeoutMs,
          spawn_setup_ms: spawnSetupMs,
          stdout_closed: opts.stdoutClosed,
          stderr_closed: opts.stderrClosed,
          root_exited: opts.rootExited,
          root_exit_code: opts.rootExitCode,
          cleanup_ms: opts.cleanupMs,
          cleanup_reap: opts.cleanup.reap,
          cleanup_confirmed: opts.cleanup.confirmed,
          cancel_requested: opts.cleanup.cancel_requested,
          clock: "performance.now",
          child_pid: stamp.child_pid,
          tick_id: currentTickId(),
          kind: "login",
          probe: loginOpts?.probe === true,
          reason_code: "cleanup",
          phase: "cleanup",
          abandoned: true,
          ...(loginOpts?.producer !== undefined
            ? { producer: loginOpts.producer }
            : {}),
          ...nativeAuthOperationMeta(loginOpts?.operationId),
        },
        nativeAuthDoctorObservation(loginOpts?.operationId, {
          cleanup_ms: opts.cleanupMs,
          stdout_closed: opts.stdoutClosed,
          stderr_closed: opts.stderrClosed,
          root_exited: opts.rootExited,
          ...(typeof opts.rootExitCode === "number"
            ? { root_exit_code: opts.rootExitCode }
            : {}),
        }),
      );
    };

    const onTimeout = (): void => {
      void (async (): Promise<void> => {
        if (abandoned) return;
        const stdoutClosedAtDeadline = stdoutClosed;
        const stderrClosedAtDeadline = stderrClosed;
        const rootExitedAtDeadline =
          rootExitCode !== null ||
          proc.exitCode !== null ||
          proc.signalCode !== null;
        const rootExitCodeAtDeadline = rootExitCode ?? proc.exitCode;
        emitLoginTimeoutRace({
          stdoutClosed: stdoutClosedAtDeadline,
          stderrClosed: stderrClosedAtDeadline,
          rootExited: rootExitedAtDeadline,
          rootExitCode: rootExitCodeAtDeadline,
        });
        const defer = await awaitOnDeadline(loginOpts?.onDeadline);
        if (abandoned) return;
        if (defer) {
          const graceMs = Math.max(0, loginOpts?.persistenceGraceMs ?? 0);
          if (
            graceMs > 0 &&
            proc.exitCode === null &&
            proc.signalCode === null
          ) {
            await waitWithCap(proc.exited, graceMs);
          }
          if (abandoned) return;
          if (proc.exitCode !== null || proc.signalCode !== null) return;
        }
        const cleanupStartedAtMs = performance.now();
        kill();
        const reap = await requestTerminate();
        cleanupMs = performance.now() - cleanupStartedAtMs;
        cleanup = childCleanupOutcome(reap, cancelRequested());
        emitLoginCleanup({
          stdoutClosed: stdoutClosedAtDeadline,
          stderrClosed: stderrClosedAtDeadline,
          rootExited: rootExitedAtDeadline,
          rootExitCode: rootExitCodeAtDeadline,
          cleanupMs,
          cleanup,
        });
      })().catch((err: unknown) => {
        logError("spawn", err, {
          phase: "timeout_worker",
          child_pid: stamp.child_pid,
          tick_id: currentTickId(),
        });
        try {
          kill();
        } catch {
          // containment — do not end login-slot ownership from this worker
        }
        void requestTerminate().catch((reapErr: unknown) => {
          logError("spawn", reapErr, {
            phase: "timeout_worker_reap",
            child_pid: stamp.child_pid,
            tick_id: currentTickId(),
          });
        });
      });
    };
    const scheduleTimeout =
      loginTimeoutSchedulerForTests ??
      ((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> =>
        setTimeout(callback, delayMs));
    timerDelayMs = budget.remainingMs();
    timerArmedAtMs = performance.now();
    killTimer = scheduleTimeout(() => {
      timerFiredAtMs = performance.now();
      onTimeout();
    }, timerDelayMs);
    const unbindAbort = bindAbort(opts?.signal, kill);

    const pump = async (
      stream: ReadableStream<Uint8Array>,
      onChunk: (s: string) => void,
      onClose: () => void,
    ): Promise<void> => {
      const reader = stream.getReader();
      readers.push(reader);
      try {
        for (;;) {
          if (abandoned) break;
          const { done, value } = await reader.read();
          if (done) {
            onClose();
            break;
          }
          if (abandoned) break;
          if (value !== undefined) onChunk(dec.decode(value));
          // Early-return once the awaited output appears (the child may never exit
          // cleanly — it can WEDGE after printing the token). Match the COMBINED
          // stream so a token on either fd is seen. We don't kill immediately: a
          // token can arrive split across read chunks, so a SETTLE delay lets the
          // remaining bytes land before we kill + parse — capturing the FULL token
          // without needing a stricter (and more brittle) trailing-boundary regex.
          if (
            opts?.until !== undefined &&
            settleTimer === null &&
            !abandoned &&
            opts.until.test(`${out}\n${err}`)
          ) {
            settleTimer = setTimeout(kill, UNTIL_SETTLE_MS);
          }
        }
      } catch {
        // Cancelled reader after abandon — captured output is still valid.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Already cancelled.
        }
      }
    };

    await Promise.race([
      Promise.all([
        pump(
          stdout,
          (s) => {
            out += s;
          },
          () => {
            stdoutClosed = true;
          },
        ),
        pump(
          stderr,
          (s) => {
            err += s;
          },
          () => {
            stderrClosed = true;
          },
        ),
        proc.exited,
      ]),
      abandonedGate,
    ]);
    unbindEarlyAbort();
    unbindAbort();
    if (killTimer !== null) clearTimeout(killTimer);
    if (settleTimer !== null) clearTimeout(settleTimer);
    if (abandoned) {
      const cleanupStartedAtMs = performance.now();
      const reap = await requestTerminate();
      cleanupMs = performance.now() - cleanupStartedAtMs;
      cleanup = childCleanupOutcome(reap, cancelRequested());
    }

    // Only surface a SIGNAL kill we did NOT cause (a sandbox/OS kill) — our own
    // `until`/timeout kill is expected and its output is valid.
    if (!abandoned) logIfKilled(argv, proc, { confined: opts?.probe !== true });
    const childWaitMs = performance.now() - spawnedAtMs;
    if (loginOpts?.producer !== undefined) {
      logDebug("spawn", "native auth child finished", {
        producer: loginOpts.producer,
        ...nativeAuthOperationMeta(loginOpts.operationId),
        phase: "result",
        reason_code: abandoned ? "abandoned" : "complete",
        abandoned,
        child_pid: stamp.child_pid,
        tick_id: currentTickId(),
        clock: "performance.now",
        spawn_setup_ms: spawnSetupMs,
        child_wait_ms: childWaitMs,
        ...(cleanupMs !== null ? { cleanup_ms: cleanupMs } : {}),
        ...(cleanup !== undefined
          ? {
              cleanup_reap: cleanup.reap,
              cleanup_confirmed: cleanup.confirmed,
              cancel_requested: cleanup.cancel_requested,
            }
          : {}),
      });
    }
    // Join with a newline, NOT bare concatenation: a token printed as the last
    // bytes of stdout (no trailing newline) must not fuse with the first bytes
    // of stderr, or a greedy token match would swallow the spillover.
    return {
      code: proc.exitCode ?? -1,
      output: `${out}\n${err}`.trim(),
      abandoned,
      spawn_setup_ms: spawnSetupMs,
      child_wait_ms: childWaitMs,
      ...(cleanup !== undefined ? { cleanup } : {}),
      whenReleased: child.whenReleased,
      ...stamp,
    };
  } catch {
    const reap = await requestTerminate();
    return {
      code: -1,
      output: "",
      abandoned: true,
      cleanup: childCleanupOutcome(
        reap,
        signalAbortRequested(loginOpts?.signal),
      ),
      whenReleased: child.whenReleased,
      spawned_at_ms: Date.now(),
      child_pid:
        typeof child.subprocess.pid === "number" ? child.subprocess.pid : null,
    };
  } finally {
    budget.release();
  }
};

// OSC (ESC ] … BEL/ST), CSI (ESC [ … final), and lone ESC. Built from a
// string so the source stays free of raw control bytes.
const ANSI_RE = new RegExp(
  "\\u001b\\][^]*?(?:\\u0007|\\u001b\\\\)" +
    "|\\u001b\\[[0-9;?]*[ -/]*[@-~]" +
    "|\\u001b[@-Z\\\\-_]",
  "g",
);

/**
 * Strip ANSI/terminal control sequences (CSI colour codes, OSC, lone escapes)
 * from CLI output so a value parsed out of it isn't fused with rendering bytes.
 */
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/** Strip URL query strings from diagnostics so OAuth parameters never surface
 * in a local log or dashboard error while retaining the actionable origin/path. */
export const redactUrls = (value: string): string =>
  value.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/**
 * Build the `script(1)` argv that runs `argv` under a PSEUDO-TERMINAL, writing
 * the terminal capture to `typescript` — or null on an OS without `script`
 * (caller falls back to a plain pipe spawn). Some vendor CLIs only run attached
 * to a real terminal (e.g. `kimi -p`'s raw-mode-gated print mode), emitting
 * NOTHING under a plain pipe. Shared by
 * {@link spawnLoginPty} (which POLLS the typescript for an `until` regex) and
 * the exec-fixture capture (which ignores the typescript — pass `/dev/null` —
 * and drives off its HTTP recorder instead).
 *
 * Subtleties baked in:
 *   - `-F` (BSD) / `-f` (util-linux, inside `-qfc`) is LOAD-BEARING: without it
 *     `script` BUFFERS the typescript and only flushes on close, so a poller
 *     reads empty until the child exits. `-F` flushes after every write.
 *   - `script` allocates the PTY at the DEFAULT 80×24 — window size is an ioctl
 *     (TIOCSWINSZ), NOT `COLUMNS`/`LINES` — so a TUI rendering a fixed-width box
 *     wraps a long value mid-line. We resize the slave with `stty` INSIDE the
 *     PTY (runs on the controlling tty before the real command via `exec`).
 *     `2>/dev/null` keeps an `stty`-less environment from breaking the flow.
 *   - BSD (`script -q <file> cmd…`) vs util-linux (`script -qfc "cmd" <file>`)
 *     differ in argument order.
 */
export const ptyScriptArgv = (
  argv: ReadonlyArray<string>,
  typescript: string,
): string[] | null => {
  const os = platform();
  if (os !== "darwin" && os !== "linux") return null;
  const escapeShellArg = (arg: string): string =>
    `'${arg.replace(/'/g, "'\\''")}'`;
  const cmd = argv.map(escapeShellArg).join(" ");
  const widen = `stty cols 1000 rows 50 2>/dev/null; exec ${cmd}`;
  return os === "darwin"
    ? ["script", "-F", "-q", typescript, "sh", "-c", widen]
    : ["script", "-qfc", widen, typescript];
};

/**
 * Like {@link spawnLogin}, but runs `argv` under a PSEUDO-TERMINAL (via
 * `script(1)`). Some vendor CLIs only work attached to a real terminal — e.g.
 * `kimi -p`'s raw-mode-gated print mode writes to its controlling terminal
 * (`/dev/tty`), so spawned with a plain pipe (no controlling TTY) it emits
 * NOTHING and the headless daemon captures `outputLen: 0`. A PTY makes it
 * actually run, and we capture its terminal output to a `script` typescript
 * file which we POLL — so `opts.until` returns the instant the match appears.
 *
 * Key subtleties, each load-bearing (see the harness in `tests/`):
 *   - stdin is `/dev/null` (`"ignore"`): a Bun pipe/stream/inherited stdin makes
 *     `script` block before it sets up the PTY (empirically 0 bytes captured).
 *   - the child does NOT EOF-exit despite `/dev/null`: it reads the PTY SLAVE,
 *     not `script`'s stdin, so its stdin stays open for the browser flow.
 *   - we read the typescript FILE, not `script`'s stdout: piping `script`'s
 *     stdout under `Bun.spawn` also yields 0 bytes.
 *   - BSD (`script -q <file> cmd…`) vs util-linux (`script -qfc "cmd" <file>`)
 *     differ; unsupported elsewhere → falls back to plain {@link spawnLogin}.
 */
export const spawnLoginPty = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
  opts?: TSpawnLoginOpts,
): Promise<TLoginResult> => {
  const ptyOpts = opts;
  const os = platform();
  if (os !== "darwin" && os !== "linux") return spawnLogin(argv, env, ptyOpts);
  if (signalAbortRequested(ptyOpts?.signal)) {
    return noChildResult(true);
  }

  const tsFile = join(
    daemonTempDir(),
    `openllmd-pty-${process.pid}-${Date.now().toString(36)}.log`,
  );
  await Bun.write(tsFile, "");
  // PTY argv (shared with the exec-fixture capture). Non-null here: the OS was
  // already gated to darwin/linux above. We POLL `tsFile` for `opts.until`.
  const scriptArgv = ptyScriptArgv(argv, tsFile) ?? [...argv];

  // Wrap the WHOLE `script(1)` argv — the PTY wrapper and the vendor CLI it
  // runs are one confined tree.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const parentBudget = budgetFromSignal(opts?.signal);
  const budget =
    parentBudget?.child(timeoutMs) ??
    createDeadlineBudget(timeoutMs, opts?.signal);
  try {
    const child = superviseSpawn(
      sandboxSpawnArgs(scriptArgv, { probe: opts?.probe }),
      {
        kind: "login",
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        cwd: spawnCwd(env),
        ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
      },
    );
    const proc = child.subprocess;
    const stamp = spawnStamp(proc);
    const spawnedAtMs = performance.now();
    let terminatePromise: Promise<TReapOutcome> | null = null;
    const requestTerminate = (): Promise<TReapOutcome> => {
      if (terminatePromise === null) {
        terminatePromise = child.terminate(
          splitReapBudget(budget.remainingMs()),
        );
      }
      return terminatePromise;
    };

    const readFile = (): Promise<string> =>
      Bun.file(tsFile)
        .text()
        .catch(() => "");
    let abandoned = false;
    let captured = "";
    const kill = (): void => {
      if (abandoned) return;
      abandoned = true;
      void requestTerminate();
    };
    const unbindAbort = bindAbort(opts?.signal, kill);
    let ptyCleanup: TChildCleanupOutcome | undefined;
    try {
      for (;;) {
        if (abandoned) break;
        captured = await readFile();
        if (opts?.until?.test(stripAnsi(captured)) === true) {
          // Settle: let the rest of the token line render before we kill + parse.
          await new Promise((r) => setTimeout(r, UNTIL_SETTLE_MS));
          captured = await readFile();
          kill();
          break;
        }
        if (proc.exitCode !== null || proc.signalCode !== null) break; // exited
        if (budget.expired()) {
          logWarn(
            "spawn",
            ptyOpts?.producer === "claude-refresh"
              ? safeDiagnosticMessage`Credential refresh exceeded its time budget.`
              : safeDiagnosticMessage`Login exceeded its time budget.`,
            {
              configured_timeout_ms: timeoutMs,
              spawn_elapsed_ms: performance.now() - spawnedAtMs,
              clock: "performance.now",
              child_pid: stamp.child_pid,
              kind: "login",
              probe: ptyOpts?.probe === true,
              reason_code: "timeout",
              phase: "timeout_race",
              abandoned: true,
              cancel_requested: signalAbortRequested(ptyOpts?.signal),
              ...(ptyOpts?.producer !== undefined
                ? { producer: ptyOpts.producer }
                : {}),
              ...nativeAuthOperationMeta(ptyOpts?.operationId),
            },
            nativeAuthDoctorObservation(ptyOpts?.operationId, {
              configured_timeout_ms: timeoutMs,
              spawn_elapsed_ms: performance.now() - spawnedAtMs,
            }),
          );
          const defer = await awaitOnDeadline(ptyOpts?.onDeadline);
          if (defer) {
            const graceMs = Math.max(0, ptyOpts?.persistenceGraceMs ?? 0);
            if (
              graceMs > 0 &&
              proc.exitCode === null &&
              proc.signalCode === null
            ) {
              await waitWithCap(proc.exited, graceMs);
            }
            if (proc.exitCode !== null || proc.signalCode !== null) break;
          }
          kill();
          break;
        }
        await new Promise((r) =>
          setTimeout(r, Math.min(400, budget.remainingMs())),
        );
      }
      if (abandoned) {
        const cleanupStartedAtMs = performance.now();
        const reap = await requestTerminate();
        const ptyCleanupMs = performance.now() - cleanupStartedAtMs;
        ptyCleanup = childCleanupOutcome(
          reap,
          signalAbortRequested(ptyOpts?.signal),
        );
        logInfo(
          "spawn",
          safeDiagnosticMessage`Login cleanup finished.`,
          {
            cleanup_ms: ptyCleanupMs,
            cleanup_reap: ptyCleanup.reap,
            cleanup_confirmed: ptyCleanup.confirmed,
            cancel_requested: ptyCleanup.cancel_requested,
            clock: "performance.now",
            child_pid: stamp.child_pid,
            kind: "login",
            reason_code: "cleanup",
            phase: "cleanup",
            abandoned: true,
            ...(ptyOpts?.producer !== undefined
              ? { producer: ptyOpts.producer }
              : {}),
            ...nativeAuthOperationMeta(ptyOpts?.operationId),
          },
          nativeAuthDoctorObservation(ptyOpts?.operationId, {
            cleanup_ms: ptyCleanupMs,
          }),
        );
      } else {
        const leftover = budget.remainingMs();
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            proc.exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, leftover);
            }),
          ]);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
        if (proc.exitCode === null && proc.signalCode === null) {
          const reap = await requestTerminate();
          abandoned = true;
          ptyCleanup = childCleanupOutcome(
            reap,
            signalAbortRequested(ptyOpts?.signal),
          );
        }
      }
    } finally {
      unbindAbort();
    }
    captured = await readFile(); // final read (token written just before exit)
    await rm(tsFile, { force: true }).catch(() => {});
    if (!abandoned)
      logIfKilled(scriptArgv, proc, { confined: opts?.probe !== true });
    return {
      code: proc.exitCode ?? -1,
      output: stripAnsi(captured),
      abandoned,
      ...(ptyCleanup !== undefined ? { cleanup: ptyCleanup } : {}),
      whenReleased: child.whenReleased,
      ...stamp,
    };
  } finally {
    budget.release();
  }
};

/**
 * Best-effort open a URL in the user's default browser (macOS `open`, Windows
 * `cmd /c start`, else `xdg-open`). Used by the browser / device-code login
 * flows to bring up the vendor's auth page FROM the daemon — some vendor CLIs
 * print the URL but their own auto-open doesn't reach the user's GUI session
 * when the daemon spawns them (e.g. codex). Never throws; the user can copy the
 * URL from the card.
 */
export const openUrl = (url: string): void => {
  // Never launch a real browser under the test runner (`bun test` sets
  // NODE_ENV=test) — a device/browser login test that reaches this line would
  // otherwise pop a tab on the developer's machine. Production is unaffected.
  if (process.env.NODE_ENV === "test") return;
  const os = platform();
  // Windows: `start` is a cmd builtin, so it must run via `cmd /c`; the empty
  // "" is the (required) window-title arg, and the URL is quoted so `cmd.exe`
  // doesn't treat an OAuth URL's `&` as a command separator.
  const argv: string[] =
    os === "darwin"
      ? ["open", url]
      : os === "win32"
        ? ["cmd", "/c", "start", "", `"${url}"`]
        : ["xdg-open", url];
  try {
    // Deliberately UNWRAPPED (no `sandboxSpawnArgs`): opening the user's
    // browser is a user-facing action like the session-PTY exemption — the
    // launcher must reach the real GUI session/LaunchServices state, and it
    // takes only the URL string (no filesystem payload to confine).
    Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cwd: spawnCwd(undefined),
    });
  } catch {
    // best-effort — the user can copy the URL from the card detail
  }
};
