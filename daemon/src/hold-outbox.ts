/**
 * Durable delivery of cap-hold records (docs/plan/2026-10-31-hold-finalization.md).
 *
 * A hold's terminal record is the only thing that settles it below the full
 * hold, so losing one overcharges the key. Every record carrying a
 * `hold_nonce` is written to a 0600 JSONL file in the state dir BEFORE the
 * POST and removed only once the cloud answers definitively:
 *
 * - 2xx → delivered.
 * - 400 / 403 / 404 / 409 → final: malformed, not ours, or already
 *   finalized. Retrying cannot change the answer.
 * - anything else (transport error, 5xx, 429, 401 during a key rotation) →
 *   kept and retried with backoff.
 *
 * The nonce is the idempotency key: the cloud finalizes a hold atomically on
 * it, so a retry after a lost response is a no-op. Keep entries until the
 * cloud answers definitively: the sweep can run later than its deadline.
 */
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TDaemonRecordRequest } from "@openllmsh/protocol";
import { stateDir } from "./env";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

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

const readEntries = (): TEntry[] => {
  let text: string;
  try {
    text = readFileSync(outboxPath(), "utf8");
  } catch {
    return [];
  }
  const entries: TEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as TEntry;
      if (typeof value?.row?.hold_nonce === "string") entries.push(value);
    } catch {
      // A torn final line from a crash mid-append; drop it.
    }
  }
  return entries;
};

const writeEntries = (entries: ReadonlyArray<TEntry>): void => {
  const tmp = `${outboxPath()}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    { mode: 0o600 },
  );
  renameSync(tmp, outboxPath());
};

/** Nonces delivered (or final) this process; removed on the next rewrite. */
const done = new Set<string>();
let flushing: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let sender: THoldRecordSender | null = null;

const deliver = async (entry: TEntry): Promise<boolean> => {
  if (sender === null) return false;
  try {
    const response = await sender(entry.row, entry.origin);
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

/** Retry every pending entry once; reschedules while any remain. */
export const flushHoldOutbox = (): Promise<void> => {
  if (flushing !== null) return flushing;
  const run = async (): Promise<void> => {
    // Yield first so `flushing` is assigned before this body can finish.
    await Promise.resolve();
    try {
      const pending = readEntries().filter(
        (entry) => !done.has(entry.row.hold_nonce ?? ""),
      );
      for (const entry of pending) {
        if (await deliver(entry)) done.add(entry.row.hold_nonce ?? "");
      }
      // Re-read: records may have been appended while delivering.
      const remaining = readEntries().filter(
        (entry) => !done.has(entry.row.hold_nonce ?? ""),
      );
      writeEntries(remaining);
      done.clear();
      if (remaining.length > 0) schedule();
      else attempt = 0;
    } catch {
      schedule();
    } finally {
      flushing = null;
    }
  };
  flushing = run();
  return flushing;
};

/**
 * Persist a hold record, then try to deliver it now. Resolves once the first
 * attempt finished (delivered or queued for retry); never rejects.
 */
export const enqueueHoldRecord = async (
  row: TDaemonRecordRequest,
  origin: string | null,
  send: THoldRecordSender,
): Promise<void> => {
  sender = send;
  const entry: TEntry = { row, origin, queued_at: Date.now() };
  try {
    appendFileSync(outboxPath(), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Unwritable state dir: still try once in memory.
    await deliver(entry);
    return;
  }
  if (await deliver(entry)) {
    done.add(row.hold_nonce ?? "");
    await flushHoldOutbox();
    return;
  }
  schedule();
};

/** Start retrying records left by a previous run (daemon boot). */
export const startHoldOutbox = (send: THoldRecordSender): void => {
  sender = send;
  void flushHoldOutbox();
};

/**
 * Best-effort drain before uninstall removes the state dir. Bounded by
 * `timeoutMs`; anything still pending is charged in full by the cloud sweep.
 */
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

/** Pending entries (tests and doctor). */
export const pendingHoldRecords = (): number => readEntries().length;
