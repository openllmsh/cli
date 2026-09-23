import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, openSync } from "node:fs";

const MAX_EVENT_BYTES = 256 * 1024;
const WORKER_START_TIMEOUT_MS = 1_500;

/** Bun compiled entries are virtual; source runs must re-exec their real entry. */
export const hookWorkerInvocation = (
  executable: string,
  entry: string | undefined,
  group: string,
  verb: string,
): readonly string[] => [
  executable,
  ...(entry === undefined || entry.startsWith("/$bunfs/") ? [] : [entry]),
  "exec",
  group,
  verb,
];

/** Bound untrusted hook input; never spill a conversation or key into argv. */
export const readHookEvent = async (): Promise<unknown> => {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_EVENT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
};

/** Only pipe delivery is awaited; the worker never inherits the hook's stdio. */
export const startHookWorker = (
  input: unknown,
  invocation: readonly string[],
  logFd?: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(invocation[0], invocation.slice(1), {
      detached: true,
      stdio: ["pipe", logFd ?? "ignore", logFd ?? "ignore"],
      env: process.env,
    });
    let finished = false;
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!ok) child.kill();
      child.unref();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WORKER_START_TIMEOUT_MS);
    child.once("error", () => finish(false));
    const stdin = child.stdin;
    if (!stdin) {
      finish(false);
      return;
    }
    stdin.once("error", () => finish(false));
    child.once("spawn", () => {
      stdin.end(JSON.stringify(input), () => finish(true));
    });
  });

/** SQLite is embedded in the compiled CLI. Its OS locks serialize workers and
 * release on process death, unlike lock directories that strand crashed runs.
 * No rows/content are stored here; BEGIN EXCLUSIVE is only a nonblocking lock.
 */
export const tryHookLock = (path: string): (() => void) | null => {
  let database: Database | undefined;
  try {
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    database = new Database(path);
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    const held = database;
    return (): void => {
      held.close();
    };
  } catch {
    database?.close();
    return null;
  }
};
