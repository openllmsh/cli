/**
 * Event-loop stall watch. Every timeout in the daemon (keychain `security`,
 * status probes, spawn budgets) is a timer; when something blocks the loop —
 * a synchronous spawn, a long sync read — those timers fire late and their
 * operations report as timed out even though the real cause was the stall.
 * This makes the stall itself a doctor record, so a report of mass timeouts
 * can be told apart from a slow machine or a hung child.
 */
import { logWarn, safeDiagnosticMessage } from "./logger";

/** How often the watch ticks. */
export const EVENT_LOOP_WATCH_INTERVAL_MS = 500;
/** A tick this late (beyond its interval) counts as a stall. */
export const EVENT_LOOP_STALL_MS = 1_000;
/** At most one stall record per this window (the worst one in it). */
export const EVENT_LOOP_STALL_REPORT_EVERY_MS = 60_000;

export type TEventLoopWatch = { readonly stop: () => void };

export const startEventLoopWatch = (
  report: (lateMs: number, stallsInWindow: number) => void = (
    lateMs,
    stallsInWindow,
  ) => {
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
  },
  now: () => number = () => performance.now(),
): TEventLoopWatch => {
  let expected = now() + EVENT_LOOP_WATCH_INTERVAL_MS;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let stalls = 0;
  let worst = 0;
  const timer = setInterval(() => {
    const at = now();
    const late = at - expected;
    expected = at + EVENT_LOOP_WATCH_INTERVAL_MS;
    if (late < EVENT_LOOP_STALL_MS) return;
    stalls += 1;
    worst = Math.max(worst, late);
    if (at - lastReportAt < EVENT_LOOP_STALL_REPORT_EVERY_MS) return;
    report(worst, stalls);
    lastReportAt = at;
    stalls = 0;
    worst = 0;
  }, EVENT_LOOP_WATCH_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};
