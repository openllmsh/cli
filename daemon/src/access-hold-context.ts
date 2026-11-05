/**
 * Per-request cap hold for a capped key. The cloud answers a capped key's
 * plan fetch with a one-hop plan bound to a token reservation (`hold_nonce`,
 * part of the signed payload). The listener runs the walk inside this
 * context so every signature check verifies against the nonce and every
 * usage record carries it, letting the cloud settle or refund the hold
 * exactly once. AsyncLocalStorage keeps concurrent requests apart, the same
 * way `team-request-context.ts` does for team grants.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TOutputLimitSurface } from "@openllmsh/sdk/wire/features/output-limit-clamp";
import { clampOutputLimitFields } from "@openllmsh/sdk/wire/features/output-limit-clamp";
import type { TAttemptOutcome } from "@openllmsh/sdk/wire/lib/attempt-outcome";
import { chargeForAttempt } from "@openllmsh/sdk/wire/lib/attempt-outcome";

/**
 * What the walk has reported for this hold. Hop paths (walker, native
 * runtime, local servers) report every attempt; only a success finalizes the
 * hold directly. Failures are logged without finalizing, and the listener's
 * hold session sends ONE terminal record once the walk, and any streamed
 * body, is over (`hold-session.ts`). That keeps a sibling-account retry, a mid-stream
 * failure or a client cancel from refunding work that ran.
 */
export type THoldOutcome = {
  settled: boolean;
  lastModel: string | null;
  lastProvider: string | null;
  /** Upstream sends started under this hold (retries and fallbacks count). */
  sends: number;
  /** Sends whose charge is known: complete usage, or a definite provider error. */
  accounted: number;
  /** Tokens reported by the accounted sends. */
  accountedTokens: number;
};

/** What the hold's terminal record reports beyond its own tokens. */
export type THoldCharge = {
  /** Tokens reported by earlier attempts of this request. */
  readonly priorTokens: number;
  /** Sends with no usage evidence: each is charged the full reservation. */
  readonly unknownAttempts: number;
};

export const holdCharge = (outcome: THoldOutcome): THoldCharge => ({
  priorTokens: outcome.accountedTokens,
  unknownAttempts: Math.max(0, outcome.sends - outcome.accounted),
});

type THold = {
  readonly nonce: string;
  /** Signed output budget of the held plan; null when the plan has none. */
  readonly maxOutputTokens: number | null;
  readonly outcome: THoldOutcome;
};

const holdContext = new AsyncLocalStorage<THold>();

export const newHoldOutcome = (): THoldOutcome => ({
  settled: false,
  lastModel: null,
  lastProvider: null,
  sends: 0,
  accounted: 0,
  accountedTokens: 0,
});

export const withHoldNonce = <T>(
  nonce: string,
  run: () => T,
  maxOutputTokens: number | null = null,
  outcome: THoldOutcome = newHoldOutcome(),
): T => holdContext.run({ nonce, maxOutputTokens, outcome }, run);

/**
 * Count an upstream send about to start. A held request walks the same
 * retries and fallbacks as an unheld one; every send is charged when the hold
 * settles (docs/plan/2026-10-31-hold-finalization.md).
 */
export const beginHeldAttempt = (): void => {
  const hold = holdContext.getStore();
  if (hold !== undefined) hold.outcome.sends += 1;
};

/**
 * Note what a hop record proves and decide whether it settles the hold.
 * Complete usage is accounted at its tokens; a definite provider error (the
 * provider's own non-2xx body was read) at 0; anything else stays unknown and
 * is charged the full reservation. A success with complete usage settles the
 * hold, carrying every earlier attempt's charge. Outside a hold (or for an
 * already settled one) the row is returned unchanged.
 */
export const holdFieldsForRecord = (
  row: {
    readonly status: string;
    readonly model: string;
    readonly provider: string;
    readonly tokens_in: number;
    readonly tokens_out: number;
  },
  attempt: TAttemptOutcome,
): {
  readonly hold_nonce?: string;
  readonly hold_prior_tokens?: number;
  readonly hold_unknown_attempts?: number;
} => {
  const hold = holdContext.getStore();
  if (hold === undefined || hold.outcome.settled) return {};
  const outcome = hold.outcome;
  outcome.lastModel = row.model;
  outcome.lastProvider = row.provider;
  if (
    attempt.sent &&
    (attempt.usage !== null || attempt.definiteProviderError)
  ) {
    outcome.accounted += 1;
    if (row.status === "success" && attempt.usage !== null) {
      const { priorTokens, unknownAttempts } = holdCharge(outcome);
      outcome.settled = true;
      // The cloud charges the row's tokens plus prior tokens. The row is the
      // analytics view and can differ from the observed usage (e.g. a
      // Claude message_delta revising input); carry the difference so the
      // hold settles at what this send actually used.
      const rowTokens =
        Math.max(0, Math.floor(row.tokens_in)) +
        Math.max(0, Math.floor(row.tokens_out));
      const observedGap = Math.max(0, chargeForAttempt(attempt, 0) - rowTokens);
      return {
        hold_nonce: hold.nonce,
        hold_prior_tokens: priorTokens + observedGap,
        hold_unknown_attempts: unknownAttempts,
      };
    }
    outcome.accountedTokens += chargeForAttempt(attempt, 0);
  }
  return {};
};

export const currentHoldNonce = (): string | null =>
  holdContext.getStore()?.nonce ?? null;

export const currentHoldOutputLimit = (): number | null =>
  holdContext.getStore()?.maxOutputTokens ?? null;

/** Clamp every provided wire spelling before any hop encodes or forwards it. */
export const clampHoldOutputLimit = (
  body: unknown,
  surface: TOutputLimitSurface,
  limit: number | null,
): unknown =>
  limit === null ||
  body === null ||
  typeof body !== "object" ||
  Array.isArray(body)
    ? body
    : clampOutputLimitFields(body as Record<string, unknown>, surface, limit);

const pendingRecords = new Map<string, Set<Promise<void>>>();

export const trackHoldRecord = (nonce: string, record: Promise<void>): void => {
  const pending = pendingRecords.get(nonce) ?? new Set<Promise<void>>();
  pendingRecords.set(nonce, pending);
  pending.add(record);
  void record.then(
    () => {
      pending.delete(record);
      if (pending.size === 0 && pendingRecords.get(nonce) === pending)
        pendingRecords.delete(nonce);
    },
    () => {
      pending.delete(record);
      if (pending.size === 0 && pendingRecords.get(nonce) === pending)
        pendingRecords.delete(nonce);
    },
  );
};

export const waitForHoldRecords = async (
  nonce: string,
  timeoutMs = 2000,
): Promise<void> => {
  const pending = pendingRecords.get(nonce);
  if (pending === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (pendingRecords.get(nonce) === pending) pendingRecords.delete(nonce);
  }
};
