/**
 * Detached (no-supervisor) daemon lifecycle — used when the Linux systemd
 * user bus is unreachable (containers, headless agents without a user
 * manager). The process is spawned setsid-style (`detached: true` + `unref`),
 * logs to the same stdout/stderr capture files the supervised unit uses, and
 * records a pidfile under the state dir with process start time so a recycled
 * pid cannot impersonate a live daemon.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processStartTime } from "./child-supervisor";
import {
  processAlive,
  sleepSyncMs,
  terminateOwnedPidSync,
} from "./child-supervisor/posix";
import {
  daemonStderrLogFilePath,
  daemonStdoutLogFilePath,
  parseEnvLines,
  serviceEnvFilePath,
  stateDir,
} from "./env";

export type TDetachedDaemonRecord = {
  readonly pid: number;
  readonly processStartTime: string;
};

/** Prefix for start-time values read from `/proc/<pid>/stat` field 22. */
export const DETACHED_PROC_STARTTIME_PREFIX = "proc:";

/**
 * Parse Linux `/proc/<pid>/stat` starttime (field 22). `comm` may contain
 * spaces/parens — split after the last `)`. Pure — exported for tests.
 */
export const parseLinuxProcStartTime = (statBody: string): string | null => {
  const closeParen = statBody.lastIndexOf(")");
  if (closeParen === -1) return null;
  // After ") ": state ppid ... starttime is field 22 → index 19 of this list.
  const fields = statBody.slice(closeParen + 2).split(" ");
  const starttime = fields[19];
  if (starttime === undefined || starttime.length === 0) return null;
  if (!/^\d+$/.test(starttime)) return null;
  return `${DETACHED_PROC_STARTTIME_PREFIX}${starttime}`;
};

/** Read `/proc/<pid>/stat` field 22 only (Linux). Null = transient failure. */
export const detachedProcStartTime = (pid: number): string | null => {
  if (process.platform !== "linux") return null;
  try {
    return parseLinuxProcStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Detached-daemon process identity for NEW records. Prefers `ps -o lstart=`;
 * on Linux hosts without `ps` (slim containers / agent VMs), falls back to
 * `/proc/<pid>/stat` field 22 prefixed with
 * {@link DETACHED_PROC_STARTTIME_PREFIX}. Session-host identity keeps using
 * unpinned `ps` via {@link processStartTime}.
 */
export const detachedProcessStartTime = (pid: number): string | null => {
  const fromPs = processStartTime(pid);
  if (fromPs !== null) return fromPs;
  return detachedProcStartTime(pid);
};

/**
 * Choose ONE identity source for comparisons, matching how `recorded` was
 * written. `proc:` values only read `/proc`; lstart values only use `ps`.
 * Null from either source stays a transient failure (do not cross-fallback).
 */
export const detachedStartTimeReaderFor = (
  recorded: string,
): ((pid: number) => string | null) =>
  recorded.startsWith(DETACHED_PROC_STARTTIME_PREFIX)
    ? detachedProcStartTime
    : processStartTime;

/** Absolute path of the detached-daemon pidfile under the state dir. */
export const detachedPidfilePath = (): string => join(stateDir(), "daemon.pid");

/** Parse a pidfile body. Pure — exported for tests. */
export const parseDetachedPidfile = (
  raw: string,
): TDetachedDaemonRecord | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec.pid !== "number" ||
      !Number.isInteger(rec.pid) ||
      rec.pid <= 0 ||
      typeof rec.processStartTime !== "string" ||
      rec.processStartTime.length === 0
    ) {
      return null;
    }
    return { pid: rec.pid, processStartTime: rec.processStartTime };
  } catch {
    return null;
  }
};

/** Read and parse the detached pidfile, or null when missing/invalid. */
export const readDetachedPidfile = (): TDetachedDaemonRecord | null => {
  try {
    return parseDetachedPidfile(readFileSync(detachedPidfilePath(), "utf8"));
  } catch {
    return null;
  }
};

/**
 * Persist the live detached-daemon identity for later stop/status. Written to
 * a per-process temp file then renamed, so a reader never sees a half-written
 * pidfile and concurrent writers never interleave.
 */
export const writeDetachedPidfile = (record: TDetachedDaemonRecord): void => {
  mkdirSync(stateDir(), { recursive: true });
  const target = detachedPidfilePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({
        pid: record.pid,
        processStartTime: record.processStartTime,
      })}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

/** Remove the detached pidfile after the process is gone or proven stale. */
export const clearDetachedPidfile = (): void => {
  rmSync(detachedPidfilePath(), { force: true });
};

/** Retries for a transient `ps` / `/proc` start-time miss. */
const START_TIME_RETRY_ATTEMPTS = 5;
const START_TIME_RETRY_MS = 20;

/**
 * Read a process command line for ownership checks. Linux uses
 * `/proc/<pid>/cmdline`; elsewhere `ps -o command=`. Null = unreadable.
 * Exported for tests.
 */
export const readDetachedProcessCommandLine = (pid: number): string | null => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
};

/**
 * True when a command line looks like our detached daemon (`openllm daemon` /
 * `openllmd daemon` / a target-named compile like `openllm-linux-x64-baseline
 * daemon` that `serviceBinPath()` may launch) or a durable `__session-host`
 * child. Exported for tests.
 */
export const detachedCommandLineLooksOwned = (commandLine: string): boolean => {
  // `/proc/.../cmdline` is NUL-separated; normalize without a control-char regex.
  const normalized = commandLine.split("\0").join(" ");
  if (/(?:^|[\s/])__session-host(?:\s|$)/.test(normalized)) return true;
  // Managed `openllm`/`openllmd`, or a release/compile target binary
  // (`openllm-darwin-arm64`, `openllm-linux-x64-baseline`, …).
  return /(?:^|\/)(openllm(?:-[A-Za-z0-9._-]+)?|openllmd)(?:\.exe)?[\s]+daemon(?:\s|$)/i.test(
    normalized,
  );
};

/** Ownership of a live pid relative to our detached daemon. */
export type TDetachedOwnership = "owned" | "foreign" | "unknown";

/**
 * Classify a pid's cmdline. `unknown` means the cmdline could not be read —
 * callers must not clear the pidfile (a live daemon would be orphaned).
 * Exported for tests.
 */
export const detachedProcessOwnership = (
  pid: number,
  readCommandLine: (
    pid: number,
  ) => string | null = readDetachedProcessCommandLine,
): TDetachedOwnership => {
  const cmd = readCommandLine(pid);
  if (cmd === null) return "unknown";
  return detachedCommandLineLooksOwned(cmd) ? "owned" : "foreign";
};

/** True when the live pid's cmdline matches an OpenLLM daemon we own. */
export const detachedProcessLooksOwned = (pid: number): boolean =>
  detachedProcessOwnership(pid) === "owned";

/** Read start-time with a short retry for transient process-table blips. */
const readStartTimeRetried = (
  pid: number,
  reader: (pid: number) => string | null,
  attempts: number = START_TIME_RETRY_ATTEMPTS,
): string | null => {
  for (let i = 0; i < attempts; i++) {
    const live = reader(pid);
    if (live !== null) return live;
    if (i + 1 < attempts) sleepSyncMs(START_TIME_RETRY_MS);
  }
  return null;
};

/** True when the pidfile names a still-live process with matching start time. */
export const detachedRecordAlive = (
  record: TDetachedDaemonRecord,
  readStartTime?: (pid: number) => string | null,
): boolean => {
  const reader =
    readStartTime ?? detachedStartTimeReaderFor(record.processStartTime);
  const live = readStartTimeRetried(record.pid, reader);
  if (live !== null) return live === record.processStartTime;
  // Start-time unreadable: only treat as owned when cmdline still matches.
  return processAlive(record.pid) && detachedProcessLooksOwned(record.pid);
};

/**
 * Return the pidfile record only while it still names a live matching process;
 * clears stale pidfiles. A transient null start-time is retried, then confirmed
 * via cmdline — never treated as live on pid liveness alone (PID reuse).
 */
export const readLiveDetachedDaemon = (
  readStartTime?: (pid: number) => string | null,
  readCommandLine?: (pid: number) => string | null,
): TDetachedDaemonRecord | null => {
  const record = readDetachedPidfile();
  if (record === null) return null;
  const reader =
    readStartTime ?? detachedStartTimeReaderFor(record.processStartTime);
  const live = readStartTimeRetried(record.pid, reader);
  if (live === null) {
    if (!processAlive(record.pid)) {
      clearDetachedPidfile();
      return null;
    }
    // Unreadable start-time with a live pid: trust cmdline ownership. A
    // foreign cmdline clears a recycled-PID pidfile so start is not a no-op;
    // an unreadable cmdline keeps the pidfile (ownership uncertain).
    const ownership = detachedProcessOwnership(
      record.pid,
      readCommandLine ?? readDetachedProcessCommandLine,
    );
    if (ownership === "owned" || ownership === "unknown") return record;
    clearDetachedPidfile();
    return null;
  }
  // A matching start time can still be a zombie (exited, not reaped).
  if (live !== record.processStartTime || !processAlive(record.pid)) {
    clearDetachedPidfile();
    return null;
  }
  return record;
};

/**
 * Stop a live detached daemon (pidfile). Idempotent. Returns the pid that was
 * signalled, or null when nothing was running. Clears the pidfile only when
 * the process is gone; if it is still alive after the bounded wait, leaves the
 * pidfile and reports that it is still running.
 */
export const stopDetachedDaemon = (
  readStartTime?: (pid: number) => string | null,
  readCommandLine?: (pid: number) => string | null,
): number | null => {
  const record = readDetachedPidfile();
  if (record === null) return null;
  const reader =
    readStartTime ?? detachedStartTimeReaderFor(record.processStartTime);
  const cmdlineReader = readCommandLine ?? readDetachedProcessCommandLine;
  const live = readStartTimeRetried(record.pid, reader);
  if (live === null) {
    if (!processAlive(record.pid)) {
      clearDetachedPidfile();
      return null;
    }
    // Identity via start-time failed — signal only when cmdline still looks
    // like our daemon (avoids PID-reuse kills; unblocks uninstall/stop).
    // Unknown cmdline: keep the pidfile and report the live pid rather than
    // treating a possibly-ours daemon as stale.
    const ownership = detachedProcessOwnership(record.pid, cmdlineReader);
    if (ownership === "unknown") {
      process.stderr.write(
        `[openllm] detached daemon pid ${record.pid}: cannot verify process identity; leaving pidfile in place\n`,
      );
      return record.pid;
    }
    if (ownership === "foreign") {
      process.stderr.write(
        `[openllm] detached daemon pid ${record.pid}: process is not an OpenLLM daemon; clearing stale pidfile\n`,
      );
      clearDetachedPidfile();
      return null;
    }
    terminateOwnedPidSync(
      record.pid,
      () =>
        processAlive(record.pid) &&
        detachedProcessOwnership(record.pid, cmdlineReader) === "owned",
    );
  } else if (live !== record.processStartTime) {
    clearDetachedPidfile();
    return null;
  } else {
    const stillOwned = (): boolean => detachedRecordAlive(record, reader);
    terminateOwnedPidSync(record.pid, stillOwned);
  }
  // Final bounded wait so a just-SIGKILL'd pid is gone before callers spawn.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processAlive(record.pid)) {
    sleepSyncMs(50);
  }
  if (processAlive(record.pid)) {
    process.stderr.write(
      `[openllm] detached daemon pid ${record.pid} still running after stop\n`,
    );
    return record.pid;
  }
  clearDetachedPidfile();
  return record.pid;
};

export type TStartDetachedDaemonOpts = {
  /**
   * When true, spawn even if a live detached daemon is recorded (used by the
   * self-update path: this process IS the recorded daemon and is about to
   * exit, so a replacement must be launched first). The replacement gets
   * {@link DETACHED_HANDOFF_PID_ENV} and waits in-process for this pid to
   * exit before binding ({@link awaitDetachedHandoff}).
   */
  readonly replace?: boolean;
  /** Override spawn (tests). */
  readonly spawn?: (
    argv: readonly string[],
    opts: {
      readonly detached: true;
      readonly stdin: "ignore";
      readonly stdout: number;
      readonly stderr: number;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => { readonly pid: number; readonly unref: () => void };
  readonly readStartTime?: (pid: number) => string | null;
  /**
   * Pid the replacement waits on. Defaults to `process.pid` (the
   * still-running daemon that called replace).
   */
  readonly replaceWaitPid?: number;
};

/**
 * `env` minus every key the service env file defines. A self-update replacement
 * is spawned by the running daemon, whose `process.env` holds the env file as
 * it was at ITS boot; dropping those keys makes the replacement reload the
 * file instead of inheriting stale values. With `only`, drop just those keys
 * (and only when the file defines them). Exported for tests.
 */
export const withoutEnvFileKeys = (
  env: NodeJS.ProcessEnv,
  envFile: string = serviceEnvFilePath(),
  only?: readonly string[],
): NodeJS.ProcessEnv => {
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return { ...env };
  }
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of parseEnvLines(text).keys()) {
    if (only === undefined || only.includes(key)) delete out[key];
  }
  return out;
};

/**
 * Keys a plain detached start always takes from the saved env file: the
 * credential gate has already validated and saved the service key there, so
 * an inherited (possibly stale) `OPENLLM_API_KEY` must not shadow it. Other
 * caller env (selectors, explicit overrides) passes through.
 */
const SAVED_SERVICE_KEYS = ["OPENLLM_API_KEY"] as const;

/** Env var naming the old daemon pid a detached replacement waits on. */
export const DETACHED_HANDOFF_PID_ENV = "OPENLLM_DAEMON_HANDOFF_PID";

/** Upper bound on the handoff wait — refuse to boot if the old pid survives. */
export const DETACHED_HANDOFF_WAIT_MS = 30_000;

/**
 * Called first thing on daemon boot. When this process is a detached
 * self-update replacement, wait (bounded) for the old daemon to exit so the
 * listen port is free. In-process (Atomics sleep) — no external `sleep`, no
 * shell. The env var is removed so children never inherit it. Throws when the
 * old pid is still alive after the bound — never proceed into a bind fight.
 */
export const awaitDetachedHandoff = (
  alive: (pid: number) => boolean = processAlive,
  timeoutMs: number = DETACHED_HANDOFF_WAIT_MS,
): void => {
  const raw = process.env[DETACHED_HANDOFF_PID_ENV];
  delete process.env[DETACHED_HANDOFF_PID_ENV];
  if (raw === undefined) return;
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const deadline = Date.now() + timeoutMs;
  let stillAlive = alive(pid);
  while (Date.now() < deadline && stillAlive) {
    sleepSyncMs(100);
    stillAlive = alive(pid);
  }
  if (stillAlive) {
    throw new Error(
      `detached handoff timed out: old daemon pid ${pid} is still running`,
    );
  }
};

/**
 * Spawn `binPath daemon` detached. Logs append to the supervised capture
 * files. Returns the new record, or the existing live one when `replace` is
 * false and a daemon is already running. Throws when identity cannot be
 * recorded.
 */
export const startDetachedDaemon = (
  binPath: string,
  opts: TStartDetachedDaemonOpts = {},
): TDetachedDaemonRecord => {
  if (opts.replace !== true) {
    const existing = readLiveDetachedDaemon();
    if (existing !== null) return existing;
  }
  mkdirSync(stateDir(), { recursive: true });
  const outPath = daemonStdoutLogFilePath();
  const errPath = daemonStderrLogFilePath();
  // Ensure the capture files exist so open(append) never surprises.
  closeSync(openSync(outPath, "a", 0o600));
  closeSync(openSync(errPath, "a", 0o600));
  const outFd = openSync(outPath, "a");
  const errFd = openSync(errPath, "a");
  const spawn =
    opts.spawn ??
    ((
      argv,
      spawnOpts,
    ): { readonly pid: number; readonly unref: () => void } => {
      const proc = Bun.spawn([...argv], spawnOpts);
      return { pid: proc.pid, unref: () => proc.unref() };
    });
  const argv = [binPath, "daemon"];
  let proc: { readonly pid: number; readonly unref: () => void };
  try {
    proc = spawn(argv, {
      detached: true,
      stdin: "ignore",
      stdout: outFd,
      stderr: errFd,
      env: {
        ...(opts.replace === true
          ? withoutEnvFileKeys(process.env)
          : withoutEnvFileKeys(
              process.env,
              serviceEnvFilePath(),
              SAVED_SERVICE_KEYS,
            )),
        OPENLLM_DAEMON_ENV_FILE: serviceEnvFilePath(),
        ...(opts.replace === true
          ? {
              [DETACHED_HANDOFF_PID_ENV]: String(
                opts.replaceWaitPid ?? process.pid,
              ),
            }
          : {}),
      },
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const readStart = opts.readStartTime ?? detachedProcessStartTime;
  // A freshly spawned pid should be readable immediately; retry briefly for a
  // slow process table rather than recording an unsafe pid-only identity.
  let startTime: string | null = null;
  for (let i = 0; i < 10; i++) {
    startTime = readStart(proc.pid);
    if (startTime !== null) break;
    sleepSyncMs(20);
  }
  if (startTime === null) {
    terminateOwnedPidSync(proc.pid, () => processAlive(proc.pid), 500, 500);
    throw new Error(
      `failed to record start time for detached daemon (pid ${proc.pid})`,
    );
  }
  const record: TDetachedDaemonRecord = {
    pid: proc.pid,
    processStartTime: startTime,
  };
  try {
    writeDetachedPidfile(record);
  } catch (error) {
    // Pidfile write failed after spawn — do not leave an untracked daemon.
    terminateOwnedPidSync(proc.pid, () => processAlive(proc.pid), 500, 500);
    throw error;
  }
  proc.unref();
  return record;
};

export type TSystemdUserBusDeps = {
  readonly tryRun?: (cmd: string, args: readonly string[]) => boolean;
};

/**
 * True when `systemctl --user` can talk to a user manager. A missing binary
 * or a failed `show-environment` means the bus is unreachable — callers
 * should fall back to a detached daemon.
 *
 * Do NOT gate on `$XDG_RUNTIME_DIR/bus`: real systemd user managers talk over
 * `$XDG_RUNTIME_DIR/systemd/private`, and a missing legacy `bus` socket
 * false-negatives working hosts into the detached path.
 */
export const systemdUserBusAvailable = (
  deps: TSystemdUserBusDeps = {},
): boolean => {
  const run =
    deps.tryRun ??
    ((cmd: string, args: readonly string[]): boolean => {
      try {
        execFileSync(cmd, [...args], { stdio: "ignore", timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    });
  if (!run("systemctl", ["--version"])) return false;
  return run("systemctl", ["--user", "show-environment"]);
};

/** Render the status `supervisor:` value for a detached daemon. */
export const formatDetachedSupervisor = (pid: number): string =>
  `detached (pid ${pid})`;
