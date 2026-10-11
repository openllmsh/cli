import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createDeadlineBudget, firstOfBudget } from "../deadline-budget";
import { stateDir } from "../env";
import { logDebug } from "../logger";
import { processGroupExists, signalGroup } from "./posix";

export type TDisposableChildKind =
  | "probe"
  | "vendor-capture"
  | "mcp-helper"
  | "login"
  | "native-runtime";

export type TChildRegistryRecord = {
  readonly instanceId: string;
  readonly kind: TDisposableChildKind;
  readonly pid: number;
  readonly pgid: number;
  readonly processStartTime: string;
  readonly argvDigest: string;
  readonly startedAtMs: number;
};

const childrenDir = (): string => join(stateDir(), "children");

const recordPath = (pid: number): string => join(childrenDir(), `${pid}.json`);

const isKind = (value: unknown): value is TDisposableChildKind =>
  value === "probe" ||
  value === "vendor-capture" ||
  value === "mcp-helper" ||
  value === "login" ||
  value === "native-runtime";

const isRecord = (value: unknown): value is TChildRegistryRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.instanceId === "string" &&
    record.instanceId.length > 0 &&
    isKind(record.kind) &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.pgid === "number" &&
    Number.isInteger(record.pgid) &&
    record.pgid > 0 &&
    typeof record.processStartTime === "string" &&
    record.processStartTime.length > 0 &&
    typeof record.argvDigest === "string" &&
    /^[a-f0-9]{64}$/.test(record.argvDigest) &&
    typeof record.startedAtMs === "number" &&
    Number.isFinite(record.startedAtMs)
  );
};

/**
 * `ps -o lstart=` follows LC_TIME and TZ. Installer writes and daemon reads
 * must share one pin or a live worker looks PID-reused. Keep sync + async
 * helpers on the same env.
 */
const processStartTimePsEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LC_ALL: "C",
  TZ: "UTC",
});

/** PID-reuse-safe process identity. Mirrors the durable session-host lstart check. */
export const processStartTime = (pid: number): string | null => {
  try {
    const output = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: processStartTimePsEnv(),
    });
    if (output.exitCode !== 0) return null;
    const value = new TextDecoder().decode(output.stdout).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/**
 * Named budget for the async `ps -o lstart=` helper. Failure to obtain
 * identity returns null; it must not drop in-memory tracking.
 */
export const PROCESS_START_TIME_HELPER_TIMEOUT_MS = 400;
/** After the named budget expires, wait this long for SIGTERM before SIGKILL. */
export const PROCESS_START_TIME_HELPER_KILL_WAIT_MS = 50;

type TProcessStartTimeHelperSpawn = (
  pid: number,
) => ReturnType<typeof Bun.spawn>;

let processStartTimeHelperSpawnForTests: TProcessStartTimeHelperSpawn | null =
  null;

/**
 * Test-only: replace the `ps` helper spawn. Production kill/read path still
 * runs. Do not use {@link superviseSpawn} here — that would recurse identity
 * lookup.
 */
export const setProcessStartTimeHelperSpawnForTests = (
  spawn: TProcessStartTimeHelperSpawn | null,
): void => {
  processStartTimeHelperSpawnForTests = spawn;
};

const defaultProcessStartTimeHelperSpawn: TProcessStartTimeHelperSpawn = (
  pid,
) =>
  Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: processStartTimePsEnv(),
    // Own process group so reap can SIGKILL descendants without touching
    // the daemon group. Test fakes must also set detached: true.
    detached: true,
  });

const closeHelperStdout = (proc: ReturnType<typeof Bun.spawn>): void => {
  const stdout = proc.stdout;
  if (stdout === undefined || typeof stdout === "number") return;
  try {
    void stdout.cancel().catch(() => {
      // Locked by the in-flight Response reader, or already closed.
    });
  } catch {
    // Already closed.
  }
};

const reapStartTimeHelper = async (
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> => {
  closeHelperStdout(proc);
  const pgid = proc.pid;
  // Detached helper is group leader (pgid === pid). Never signalGroup(0/1).
  signalGroup(pgid, "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      proc.exited.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROCESS_START_TIME_HELPER_KILL_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  if (processGroupExists(pgid)) signalGroup(pgid, "SIGKILL");
};

/**
 * Async twin of {@link processStartTime}, for the spawn HOT PATH.
 *
 * `Bun.spawnSync(["ps", …])` is a synchronous fork/exec/wait that BLOCKS the
 * single JS thread. `superviseSpawn` used to call it inline on every spawn, and
 * a status sweep fans out five `--version` probes at once — so a slow process
 * table stalled the event loop and starved unrelated async work (the all-provider
 * status-timeout symptom). This variant reads the same `lstart` via a
 * non-blocking `Bun.spawn`, so the identity read no longer pauses the loop.
 *
 * The helper has an owned terminate path: a hung `ps` must not leak unbounded.
 * A miss (timeout/failure) returns null and MUST NOT imply the child is reaped.
 *
 * The synchronous {@link processStartTime} stays for the ONE-TIME boot identity
 * and the boot-sweep `childProcessMatchesRecord`, neither of which is hot.
 */
export const readProcessStartTime = async (
  pid: number,
): Promise<string | null> => {
  // Owner-created helper budget — never a shared login/logout budget.
  // firstOfBudget only detaches its waiter; this finally releases the helper.
  const budget = createDeadlineBudget(PROCESS_START_TIME_HELPER_TIMEOUT_MS);
  const spawn =
    processStartTimeHelperSpawnForTests ?? defaultProcessStartTimeHelperSpawn;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = spawn(pid);
    const stdout = proc.stdout;
    const read =
      stdout === undefined || typeof stdout === "number"
        ? Promise.resolve({ out: "", code: 1 })
        : Promise.all([new Response(stdout).text(), proc.exited]).then(
            ([out, code]) => ({ out, code }),
          );
    const raced = await firstOfBudget(budget, read);
    if (raced.kind === "expired") {
      await reapStartTimeHelper(proc);
      return null;
    }
    if (raced.value.code !== 0) return null;
    const value = raced.value.out.trim();
    return value.length > 0 ? value : null;
  } catch {
    if (proc !== null) await reapStartTimeHelper(proc);
    return null;
  } finally {
    budget.release();
  }
};

// The boot process must be distinguishable even on a platform where its
// creation timestamp cannot be read. The random-like startup timestamp is
// intentionally process-local rather than durable state.
const daemonInstanceId = `${process.pid}:${processStartTime(process.pid) ?? String(Date.now())}`;

export const currentDaemonInstanceId = (): string => daemonInstanceId;

export const currentChildSupervisorInstanceId = (): string => daemonInstanceId;

export const argvDigest = (argv: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(argv)).digest("hex");

export const addChildRegistryRecord = (record: TChildRegistryRecord): void => {
  const directory = childrenDir();
  const target = recordPath(record.pid);
  const temporary = join(directory, `.${record.pid}.${process.pid}.tmp`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    logDebug("child-supervisor", "failed to persist child registry record", {
      pid: record.pid,
      kind: record.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort registry cleanup.
    }
  }
};

export const removeChildRegistryRecord = (pid: number): void => {
  try {
    rmSync(recordPath(pid), { force: true });
  } catch {
    // A concurrent reaper or an already-exited child may own cleanup.
  }
};

export const listChildRegistryRecords = (): readonly TChildRegistryRecord[] => {
  let entries: string[];
  try {
    entries = readdirSync(childrenDir());
  } catch {
    return [];
  }
  const records: TChildRegistryRecord[] = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(childrenDir(), entry), "utf8"),
      );
      if (isRecord(parsed)) records.push(parsed);
      else rmSync(join(childrenDir(), entry), { force: true });
    } catch {
      try {
        rmSync(join(childrenDir(), entry), { force: true });
      } catch {
        // Retry an unreadable record at the next boot.
      }
    }
  }
  return records;
};

export const childProcessMatchesRecord = (
  record: TChildRegistryRecord,
): boolean => processStartTime(record.pid) === record.processStartTime;
