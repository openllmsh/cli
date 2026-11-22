/**
 * Event-loop stall watch. Every timeout in the daemon (keychain `security`,
 * status probes, spawn budgets) is a timer; when something blocks the loop —
 * a synchronous spawn, a long sync read — those timers fire late and their
 * operations report as timed out even though the real cause was the stall.
 * This makes the stall itself a doctor record, so a report of mass timeouts
 * can be told apart from a slow machine or a hung child.
 */
import { timeoutCallbackLatenessMs } from "./deadline-budget";
import { logWarn, safeDiagnosticMessage } from "./logger";

/** How often the watch ticks. */
export const EVENT_LOOP_WATCH_INTERVAL_MS = 500;
/** A tick this late (beyond its interval) counts as a stall. */
export const EVENT_LOOP_STALL_MS = 1_000;
/** At most one stall record per this window (the worst one in it). */
export const EVENT_LOOP_STALL_REPORT_EVERY_MS = 60_000;

/** Lateness beyond this is not a stall worth a record (a suspended process,
 *  a debugger pause) — it would only drown the real ones. */
export const EVENT_LOOP_STALL_IGNORE_MS = 5 * 60_000;

export type TEventLoopWatch = { readonly stop: () => void };

const reportStall = (lateMs: number, stallsInWindow: number): void => {
  logWarn(
    "event-loop",
    safeDiagnosticMessage`The daemon event loop stalled.`,
    undefined,
    {
      timings: {
        timeout_callback_lateness_ms: Math.round(lateMs),
        repeat_count: stallsInWindow,
      },
    },
  );
};

/**
 * Tick every {@link EVENT_LOOP_WATCH_INTERVAL_MS}; a tick later than
 * {@link EVENT_LOOP_STALL_MS} is a stall. The first stall is reported at once;
 * later ones in the same {@link EVENT_LOOP_STALL_REPORT_EVERY_MS} window are
 * folded into one record (worst lateness, count), sent when the window ends —
 * on the next tick, stall or not.
 */
export const startEventLoopWatch = (
  report: (lateMs: number, stallsInWindow: number) => void = reportStall,
  now: () => number = (): number => performance.now(),
): TEventLoopWatch => {
  let lastTickAt = now();
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let stalls = 0;
  let worst = 0;
  const flush = (at: number): void => {
    report(worst, stalls);
    lastReportAt = at;
    stalls = 0;
    worst = 0;
  };
  const timer = setInterval((): void => {
    const at = now();
    const late = timeoutCallbackLatenessMs(
      lastTickAt,
      at,
      EVENT_LOOP_WATCH_INTERVAL_MS,
    );
    lastTickAt = at;
    if (late >= EVENT_LOOP_STALL_MS && late < EVENT_LOOP_STALL_IGNORE_MS) {
      stalls += 1;
      worst = Math.max(worst, late);
    }
    if (stalls > 0 && at - lastReportAt >= EVENT_LOOP_STALL_REPORT_EVERY_MS) {
      flush(at);
    }
  }, EVENT_LOOP_WATCH_INTERVAL_MS);
  timer.unref?.();
  return { stop: (): void => clearInterval(timer) };
};
