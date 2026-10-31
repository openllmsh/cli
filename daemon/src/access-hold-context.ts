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
import type { TOutputLimitSurface } from "@openllmsh/wire/features/output-limit-clamp";
import { clampOutputLimitFields } from "@openllmsh/wire/features/output-limit-clamp";

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
  ambiguous: boolean;
  partialUsageReported: boolean;
  /** Largest usage any failed attempt reported (partial output). */
  partialTokensIn: number;
  partialTokensOut: number;
  lastModel: string | null;
  lastProvider: string | null;
};

type THold = {
  readonly nonce: string;
  /** Signed output budget of the held plan; null when the plan has none. */
  readonly maxOutputTokens: number | null;
  readonly outcome: THoldOutcome;
};

const holdContext = new AsyncLocalStorage<THold>();

export const newHoldOutcome = (): THoldOutcome => ({
  settled: false,
  ambiguous: false,
  partialUsageReported: false,
  partialTokensIn: 0,
  partialTokensOut: 0,
  lastModel: null,
  lastProvider: null,
});

export const withHoldNonce = <T>(
  nonce: string,
  run: () => T,
  maxOutputTokens: number | null = null,
  outcome: THoldOutcome = newHoldOutcome(),
): T => holdContext.run({ nonce, maxOutputTokens, outcome }, run);

/**
 * Decide whether a hop record may carry the hold nonce, and note what it
 * says. Success → yes (it settles the hold with real usage). Anything else →
 * no; its usage is remembered for the terminal record. Outside a hold (or for
 * an already settled one) the row is returned unchanged.
 */
export const holdFieldsForRecord = (row: {
  readonly status: string;
  readonly model: string;
  readonly provider: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
}): { readonly hold_nonce?: string } => {
  const hold = holdContext.getStore();
  if (hold === undefined || hold.outcome.settled) return {};
  hold.outcome.lastModel = row.model;
  hold.outcome.lastProvider = row.provider;
  if (row.status === "success") {
    hold.outcome.settled = true;
    return { hold_nonce: hold.nonce };
  }
  hold.outcome.partialTokensIn = Math.max(
    hold.outcome.partialTokensIn,
    Math.max(0, Math.floor(row.tokens_in)),
  );
  hold.outcome.partialTokensOut = Math.max(
    hold.outcome.partialTokensOut,
    Math.max(0, Math.floor(row.tokens_out)),
  );
  return {};
};

export const markHoldUsageReported = (): void => {
  const hold = holdContext.getStore();
  if (hold !== undefined) hold.outcome.partialUsageReported = true;
};

export const markHoldAmbiguous = (): void => {
  const hold = holdContext.getStore();
  if (hold !== undefined) hold.outcome.ambiguous = true;
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
