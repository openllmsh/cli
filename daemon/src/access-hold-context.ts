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

/**
 * What the walk has reported for this hold. Hop paths (walker, native
 * runtime, local servers) report every attempt; only a success finalizes the
 * hold directly. Failures are logged without finalizing, and the listener
 * sends ONE terminal record once the walk, and any streamed body, is over
 * (`holdTerminalRecord`). That keeps a sibling-account retry, a mid-stream
 * failure or a client cancel from refunding work that ran.
 */
export type THoldOutcome = {
  settled: boolean;
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

/**
 * The one record that finalizes an unsettled hold. `committed` means the
 * client already received a response (a streamed body was returned), so the
 * provider ran; otherwise the request is dispatched only if a failed attempt
 * reported usage. Null when the hold already settled.
 */
export const holdTerminalRecord = (args: {
  readonly nonce: string;
  readonly outcome: THoldOutcome;
  readonly committed: boolean;
  readonly fallbackModel: string;
}): {
  readonly model: string;
  readonly provider: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly hold_nonce: string;
  readonly dispatched: boolean;
} | null => {
  if (args.outcome.settled) return null;
  args.outcome.settled = true;
  const model = args.outcome.lastModel ?? args.fallbackModel;
  const dispatched =
    args.committed ||
    args.outcome.partialTokensIn + args.outcome.partialTokensOut > 0;
  return {
    model,
    provider: args.outcome.lastProvider ?? model.split("/")[0] ?? "",
    tokens_in: args.outcome.partialTokensIn,
    tokens_out: args.outcome.partialTokensOut,
    hold_nonce: args.nonce,
    dispatched,
  };
};

export const currentHoldNonce = (): string | null =>
  holdContext.getStore()?.nonce ?? null;

export const currentHoldOutputLimit = (): number | null =>
  holdContext.getStore()?.maxOutputTokens ?? null;

/** Clamp every provided wire spelling before any hop encodes or forwards it. */
export const clampHoldOutputLimit = (
  body: unknown,
  surface: "chat_completions" | "messages" | "responses",
  limit: number | null,
): unknown => {
  if (
    limit === null ||
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body)
  )
    return body;
  const result: Record<string, unknown> = { ...body };
  const keys = [
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
  ] as const;
  let lowest = limit;
  for (const key of keys) {
    if (result[key] !== undefined && result[key] !== null) {
      const value = result[key];
      const clamped =
        typeof value === "number" && Number.isFinite(value)
          ? Math.min(value, limit)
          : limit;
      result[key] = clamped;
      lowest = Math.min(lowest, clamped);
    }
  }
  const target = surface === "responses" ? "max_output_tokens" : "max_tokens";
  const hasTarget =
    result[target] != null ||
    (surface === "chat_completions" && result.max_completion_tokens != null);
  if (!hasTarget) result[target] = lowest;
  return result;
};

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
