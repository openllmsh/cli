/** Durable, nonce-idempotent delivery of cap-hold settlement records. */
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TDaemonRecordRequest } from "@openllmsh/protocol";
import { stateDir } from "./env";

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
const outboxPath = (): string => join(stateDir(), "hold-outbox.jsonl");

const syncDirectory = (path: string): void => {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const syncWrite = (path: string, data: string, flags: string): void => {
  const fd = openSync(path, flags, 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Preserve a torn tail before truncating it; never join it to a new record. */
const readText = (path: string, repair: boolean): string => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  if (text.length > 0 && !text.endsWith("\n")) {
    const boundary = text.lastIndexOf("\n") + 1;
    if (repair) {
      syncWrite(`${path}.corrupt`, `${text.slice(boundary)}\n`, "a");
      syncDirectory(path);
      // Truncate by byte length, not JavaScript string length.
      const fd = openSync(path, "r+");
      try {
        ftruncateSync(fd, Buffer.byteLength(text.slice(0, boundary)));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return text.slice(0, boundary);
  }
  return text;
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

const writeEntries = (path: string, entries: ReadonlyArray<TEntry>): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  syncWrite(
    tmp,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    "w",
  );
  renameSync(tmp, path);
  syncDirectory(path);
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
  if (flushing !== null) return flushing;
  const path = outboxPath();
  flushPath = path;
  appendedDuringFlush = [];
  const run = async (): Promise<void> => {
    await Promise.resolve();
    let disk: TEntry[] | null = null;
    try {
      disk = parseEntries(readText(path, true));
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
    for (const nonce of done) memory?.delete(nonce);
    if (memory?.size === 0) volatile.delete(path);
    let remaining = true;
    try {
      if (disk !== null) {
        const keptByNonce = new Map<string, TEntry>();
        for (const entry of [...disk, ...(appendedDuringFlush ?? [])]) {
          const nonce = entry.row.hold_nonce ?? "";
          if (!done.has(nonce)) keptByNonce.set(nonce, entry);
        }
        const kept = [...keptByNonce.values()];
        writeEntries(path, kept);
        remaining = kept.length > 0 || (volatile.get(path)?.size ?? 0) > 0;
      }
    } catch (error) {
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
  try {
    readText(path, true);
    syncWrite(path, `${JSON.stringify(entry)}\n`, "a");
    syncDirectory(path);
    if (flushPath === path) appendedDuringFlush?.push(entry);
  } catch (error) {
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
    // An append may have reached disk even when its sync failed.
    if (flushPath === path) appendedDuringFlush?.push(entry);
  }
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
    for (const entry of parseEntries(readText(path, false)))
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
