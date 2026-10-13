/**
 * One monotonic operation budget for daemon-local external process work
 * (status owner, keychain `security` lane, login/PTY child lifecycle).
 *
 * Timebase is {@link deadlineNowMs} (`performance.now()` in production).
 * Expiry is typed unavailability, never auth truth. Observer cancellation must
 * not be passed as `parent` of a producer budget the observer does not own.
 */
import {
  DEFAULT_FINAL_REAP_MS,
  DEFAULT_TERMINATE_GRACE_MS,
} from "./child-supervisor/posix";

export type TDeadlineBudget = {
  readonly signal: AbortSignal;
  remainingMs(): number;
  expired(): boolean;
  child(maxMs: number): TDeadlineBudget;
  /** Clear the deadline timer. Safe to call more than once. */
  release(): void;
};

const attached = new WeakMap<AbortSignal, TDeadlineBudget>();

export type TDeadlineBudgetScheduler = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;

export type TDeadlineBudgetDeps = {
  readonly nowMs?: () => number;
  readonly schedule?: TDeadlineBudgetScheduler;
};

export type TDeadlineTimebase = {
  readonly nowMs: () => number;
  readonly schedule: TDeadlineBudgetScheduler;
};

const defaultSchedule: TDeadlineBudgetScheduler = (
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs);

/** Build a deadline clock/scheduler pair (production defaults: performance.now + setTimeout). */
export const createDeadlineTimebase = (
  deps: TDeadlineBudgetDeps = {},
): TDeadlineTimebase => ({
  nowMs: deps.nowMs ?? ((): number => performance.now()),
  schedule: deps.schedule ?? defaultSchedule,
});

let activeTimebase: TDeadlineTimebase = createDeadlineTimebase();

/** Replace the process-wide deadline timebase (tests / embedding hosts). */
export const installDeadlineTimebase = (timebase: TDeadlineTimebase): void => {
  activeTimebase = timebase;
};

/** Monotonic now for deadline budgets (and callers that must share the clock). */
export const deadlineNowMs = (): number => activeTimebase.nowMs();

export const budgetFromSignal = (
  signal: AbortSignal | undefined,
): TDeadlineBudget | undefined =>
  signal === undefined ? undefined : attached.get(signal);

export const createDeadlineBudget = (
  durationMs: number,
  parent?: AbortSignal,
  deps?: TDeadlineBudgetDeps,
): TDeadlineBudget => {
  const nowMs = deps?.nowMs ?? activeTimebase.nowMs;
  const schedule: TDeadlineBudgetScheduler =
    deps?.schedule ?? activeTimebase.schedule;
  const cap = Math.max(0, durationMs);
  const expiresAt = nowMs() + cap;
  const ac = new AbortController();

  // Once aborted/released, remaining is zero even if a host-injected clock
  // is frozen — callers (reap splits, child budgets) must not see a live budget.
  const remainingMs = (): number =>
    ac.signal.aborted ? 0 : Math.max(0, expiresAt - nowMs());
  const expired = (): boolean => remainingMs() === 0 || ac.signal.aborted;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortFromDeadline = (): void => {
    parent?.removeEventListener("abort", abortFromDeadline);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!ac.signal.aborted) ac.abort();
  };

  if (cap === 0) {
    abortFromDeadline();
  } else {
    timer = schedule(abortFromDeadline, cap);
  }

  if (parent !== undefined) {
    if (parent.aborted) abortFromDeadline();
    else if (!ac.signal.aborted)
      parent.addEventListener("abort", abortFromDeadline, { once: true });
  }

  const childDeps: TDeadlineBudgetDeps = {
    nowMs,
    schedule,
  };
  const budget: TDeadlineBudget = {
    signal: ac.signal,
    remainingMs,
    expired,
    child(maxMs: number): TDeadlineBudget {
      return createDeadlineBudget(
        Math.min(Math.max(0, maxMs), remainingMs()),
        undefined,
        childDeps,
      );
    },
    release: abortFromDeadline,
  };
  attached.set(ac.signal, budget);
  return budget;
};

export const waitUntilExpired = (budget: TDeadlineBudget): Promise<void> => {
  if (budget.expired()) return Promise.resolve();
  return new Promise((resolve) => {
    budget.signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

/** Race work against the budget. Expired wins; work is not cancelled unless it honors `budget.signal`. */
export const firstOfBudget = async <T>(
  budget: TDeadlineBudget,
  work: Promise<T>,
): Promise<
  { readonly kind: "value"; readonly value: T } | { readonly kind: "expired" }
> => {
  if (budget.expired()) return { kind: "expired" };
  let onAbort: () => void = () => {};
  const expired = new Promise<{ readonly kind: "expired" }>((resolve) => {
    onAbort = (): void => resolve({ kind: "expired" });
    budget.signal.addEventListener("abort", onAbort, { once: true });
    if (budget.expired()) onAbort();
  });
  try {
    return await Promise.race([
      work.then((value) => ({ kind: "value" as const, value })),
      expired,
    ]);
  } finally {
    // A caller may race several stages against one operation budget. Remove
    // only this waiter's listener; the owner releases the shared deadline.
    budget.signal.removeEventListener("abort", onAbort);
  }
};

/**
 * How late a `setTimeout(delayMs)` callback ran relative to arming, using the
 * same {@link deadlineNowMs} clock as {@link createDeadlineBudget}. Negative
 * (early fire) is preserved; callers must not treat this as host-sleep proof.
 */
export const timeoutCallbackLatenessMs = (
  timerArmedAtMs: number,
  timerFiredAtMs: number,
  delayMs: number,
): number => timerFiredAtMs - timerArmedAtMs - delayMs;

export const splitReapBudget = (
  remainingMs: number,
): { graceMs: number; finalReapMs: number } => {
  if (remainingMs <= 0) {
    return { graceMs: 0, finalReapMs: Math.min(50, DEFAULT_FINAL_REAP_MS) };
  }
  const graceMs = Math.min(
    DEFAULT_TERMINATE_GRACE_MS,
    Math.floor(remainingMs / 2),
  );
  return {
    graceMs,
    finalReapMs: Math.min(
      DEFAULT_FINAL_REAP_MS,
      Math.max(0, remainingMs - graceMs),
    ),
  };
};
