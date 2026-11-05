/** Durable, nonce-idempotent delivery of cap-hold settlement records. */

import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TDaemonRecordRequest } from "@openllmsh/sdk/protocol";
import { isDevMode, stateDir } from "./env";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const BATCH_SIZE = 64;
const CONCURRENCY = 4;

type TEntry = {
  readonly row: TDaemonRecordRequest;
  readonly origin: string | null;
  readonly queued_at: number;
};

export type THoldRecordSender = (
  row: TDaemonRecordRequest,
  origin: string | null,
) => Promise<Response>;

const FINAL_STATUSES = new Set([400, 403, 404, 409]);
/**
 * One journal per daemon mode. Dev and prod share `stateDir` but bind
 * different ports and talk to different cloud origins, so each needs its own
 * file and an exclusive process-owned lock, independent of the port.
 */
const outboxPath = (): string =>
  join(stateDir(), isDevMode() ? "hold-outbox.dev.jsonl" : "hold-outbox.jsonl");

let lockUnavailableWarned = false;
const withoutJournalLock = (): (() => void) => {
  if (!lockUnavailableWarned) {
    lockUnavailableWarned = true;
    console.warn("hold journal: cross-process locking unavailable");
  }
  return () => {};
};

/** The kernel releases this lock on process death; the file itself is never removed. */
export const acquireHoldJournalLock = (
  libraryNames?: readonly string[],
): (() => void) => {
  const path = `${outboxPath()}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const libraries =
    libraryNames ??
    (process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : ["libc.so.6", "libc.so"]);
  let library: {
    symbols: { flock: (fd: number, flags: number) => number };
    close: () => void;
  } | null = null;
  try {
    const ffi: typeof import("bun:ffi") = require("bun:ffi");
    for (const name of libraries) {
      try {
        library = ffi.dlopen(name, {
          flock: {
            args: [ffi.FFIType.i32, ffi.FFIType.i32],
            returns: ffi.FFIType.i32,
          },
        });
        break;
      } catch {
        /* try the next libc */
      }
    }
  } catch {
    /* FFI is unavailable */
  }
  if (library === null) return withoutJournalLock();
  const fd = openSync(path, "a+", 0o600);
  if (library.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    library.close();
    throw new Error("hold journal is owned by another daemon");
  }
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, String(process.pid));
  } catch (error) {
    closeSync(fd);
    library.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    library.close();
  };
};

const syncDirectory = async (path: string): Promise<void> => {
  const file = await open(dirname(path), "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

const syncWrite = async (
  path: string,
  data: string | Uint8Array,
  flags: string,
): Promise<void> => {
  const file = await open(path, flags, 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
};

const validTail = (tail: string): boolean => {
  try {
    const value: unknown = JSON.parse(tail);
    return typeof (value as TEntry | null)?.row?.hold_nonce === "string";
  } catch {
    return false;
  }
};

/** Inspect a journal without discarding a complete unterminated record. */
const readText = (path: string): string => {
  try {
    const text = readFileSync(path, "utf8");
    if (!text || text.endsWith("\n")) return text;
    const boundary = text.lastIndexOf("\n") + 1;
    return validTail(text.slice(boundary)) ? text : text.slice(0, boundary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const repaired = new Set<string>();
let journalQueue: Promise<void> = Promise.resolve();
const journalOp = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = journalQueue.then(operation);
  journalQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const MAX_QUARANTINE_BYTES = 1024 * 1024;

/** Atomically retain a bounded suffix, without duplicating a crash-replayed tail. */
const quarantineTail = async (path: string, tail: string): Promise<void> => {
  const quarantine = `${path}.corrupt`;
  const fragment = Buffer.from(`${tail}\n`);
  const entry = fragment.subarray(
    Math.max(0, fragment.length - MAX_QUARANTINE_BYTES),
  );
  let previous = Buffer.alloc(0);
  let oversized = false;
  try {
    const file = await open(quarantine, "r");
    try {
      const size = (await file.stat()).size;
      oversized = size > MAX_QUARANTINE_BYTES;
      previous = Buffer.alloc(Math.min(size, MAX_QUARANTINE_BYTES));
      await file.read(previous, 0, previous.length, size - previous.length);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const duplicate =
    previous.length >= entry.length &&
    previous.subarray(previous.length - entry.length).equals(entry) &&
    (previous.length === entry.length ||
      previous[previous.length - entry.length - 1] === 10);
  if (duplicate && !oversized) return;
  const combined = duplicate ? previous : Buffer.concat([previous, entry]);
  const tmp = `${quarantine}.${process.pid}.tmp`;
  await syncWrite(
    tmp,
    combined.subarray(Math.max(0, combined.length - MAX_QUARANTINE_BYTES)),
    "w",
  );
  await rename(tmp, quarantine);
  await syncDirectory(path);
};

/** Wait for journal operations already queued, without waiting for network delivery. */
export const drainHoldJournal = async (): Promise<void> => {
  await journalQueue;
};

const readJournal = async (path: string): Promise<string> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  if (!repaired.has(path) && text && !text.endsWith("\n")) {
    const boundary = text.lastIndexOf("\n") + 1;
    const tail = text.slice(boundary);
    if (validTail(tail)) {
      await syncWrite(path, "\n", "a");
      text += "\n";
    } else {
      await quarantineTail(path, tail);
      const file = await open(path, "r+");
      try {
        await file.truncate(Buffer.byteLength(text.slice(0, boundary)));
        await file.sync();
      } finally {
        await file.close();
      }
      text = text.slice(0, boundary);
    }
  }
  return text;
};

const ensureRepaired = async (path: string): Promise<void> => {
  if (repaired.has(path)) return;
  await readJournal(path);
  repaired.add(path);
};

const parseEntries = (text: string): TEntry[] => {
  const entries: TEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as TEntry;
      if (typeof value?.row?.hold_nonce === "string") entries.push(value);
    } catch {
      console.error("hold outbox: invalid record in journal");
    }
  }
  return entries;
};

const writeEntries = async (
  path: string,
  entries: ReadonlyArray<TEntry>,
): Promise<void> => {
  const tmp = `${path}.${process.pid}.tmp`;
  await syncWrite(
    tmp,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    "w",
  );
  await rename(tmp, path);
  await syncDirectory(path);
};

// Volatile fallback is scoped by state dir, like the journal itself.
const volatile = new Map<string, Map<string, TEntry>>();
let flushing: Promise<void> | null = null;
let appendedDuringFlush: TEntry[] | null = null;
let flushPath: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let sender: THoldRecordSender | null = null;

const deliver = async (
  entry: TEntry,
  send: THoldRecordSender | null,
): Promise<boolean> => {
  if (send === null) return false;
  try {
    const response = await send(entry.row, entry.origin);
    return response.ok || FINAL_STATUSES.has(response.status);
  } catch {
    return false;
  }
};

const schedule = (): void => {
  if (timer !== null) return;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  attempt += 1;
  timer = setTimeout(() => {
    timer = null;
    void flushHoldOutbox();
  }, delay);
  timer.unref?.();
};

/** Retry the snapshot once, retaining entries appended while sending. */
export const flushHoldOutbox = (): Promise<void> => {
  const path = outboxPath();
  if (flushing !== null) {
    // An in-flight flush of another journal (the state dir changed) does not
    // cover this one: run a fresh flush once it ends.
    if (flushPath === path) return flushing;
    return flushing.then(() => flushHoldOutbox());
  }
  flushPath = path;
  appendedDuringFlush = [];
  const run = async (): Promise<void> => {
    await Promise.resolve();
    let disk: TEntry[] | null = null;
    try {
      disk = await journalOp(async () => {
        const text = await readJournal(path);
        repaired.add(path);
        return parseEntries(text);
      });
    } catch (error) {
      console.error("hold outbox: cannot read journal", error);
    }
    const memory = volatile.get(path);
    const entries = new Map<string, TEntry>();
    for (const entry of disk ?? [])
      entries.set(entry.row.hold_nonce ?? "", entry);
    for (const [nonce, entry] of memory ?? []) entries.set(nonce, entry);
    const snapshot = [...entries.values()];
    const done = new Set<string>();
    const send = sender;
    for (let start = 0; start < snapshot.length; start += BATCH_SIZE) {
      const batch = snapshot.slice(start, start + BATCH_SIZE);
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, batch.length) },
          async () => {
            while (next < batch.length) {
              const entry = batch[next++];
              if (await deliver(entry, send))
                done.add(entry.row.hold_nonce ?? "");
            }
          },
        ),
      );
    }
    let remaining = true;
    try {
      if (disk !== null) {
        await journalOp(async () => {
          const keptByNonce = new Map<string, TEntry>();
          const pendingMemory = volatile.get(path);
          for (const entry of [
            ...disk,
            ...(appendedDuringFlush ?? []),
            ...(pendingMemory?.values() ?? []),
          ]) {
            const nonce = entry.row.hold_nonce ?? "";
            if (!done.has(nonce)) keptByNonce.set(nonce, entry);
          }
          const kept = [...keptByNonce.values()];
          await writeEntries(path, kept);
          pendingMemory?.clear();
          if (pendingMemory?.size === 0) volatile.delete(path);
          remaining = kept.length > 0 || (volatile.get(path)?.size ?? 0) > 0;
        });
      }
    } catch (error) {
      repaired.delete(path);
      console.error("hold outbox: cannot compact journal", error);
    } finally {
      flushing = null;
      flushPath = null;
      appendedDuringFlush = null;
    }
    if (remaining) schedule();
    else attempt = 0;
  };
  flushing = run();
  return flushing;
};

/** Persist and sync before attempting delivery; failures stay in memory for retry. */
export const enqueueHoldRecord = async (
  row: TDaemonRecordRequest,
  origin: string | null,
  send: THoldRecordSender,
): Promise<void> => {
  sender = send;
  const entry: TEntry = { row, origin, queued_at: Date.now() };
  const path = outboxPath();
  await journalOp(async () => {
    try {
      await ensureRepaired(path);
      await syncWrite(path, `${JSON.stringify(entry)}\n`, "a");
      await syncDirectory(path);
      if (flushPath === path) appendedDuringFlush?.push(entry);
    } catch (error) {
      repaired.delete(path);
      console.error(
        "hold outbox: durable append failed; retrying in memory",
        error,
      );
      let memory = volatile.get(path);
      if (!memory) {
        memory = new Map();
        volatile.set(path, memory);
      }
      memory.set(row.hold_nonce ?? "", entry);
      if (flushPath === path) appendedDuringFlush?.push(entry);
    }
  });
  const active = flushing;
  if (active !== null) await active;
  await flushHoldOutbox();
};

export const startHoldOutbox = (send: THoldRecordSender): void => {
  sender = send;
  void flushHoldOutbox();
};

export const drainHoldOutbox = async (
  send: THoldRecordSender,
  timeoutMs = 5_000,
): Promise<void> => {
  sender = send;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flushHoldOutbox(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
};

/** Current unique backlog and age, including non-durable fallback entries. */
export const holdOutboxBacklog = (): {
  size: number;
  oldestAgeMs: number | null;
} => {
  const path = outboxPath();
  const entries = new Map<string, TEntry>();
  try {
    for (const entry of parseEntries(readText(path)))
      entries.set(entry.row.hold_nonce ?? "", entry);
  } catch (error) {
    console.error("hold outbox: cannot inspect journal", error);
  }
  for (const [nonce, entry] of volatile.get(path) ?? [])
    entries.set(nonce, entry);
  let oldest: number | null = null;
  for (const entry of entries.values()) {
    if (Number.isFinite(entry.queued_at))
      oldest =
        oldest === null ? entry.queued_at : Math.min(oldest, entry.queued_at);
  }
  return {
    size: entries.size,
    oldestAgeMs: oldest === null ? null : Math.max(0, Date.now() - oldest),
  };
};

export const pendingHoldRecords = (): number => holdOutboxBacklog().size;
