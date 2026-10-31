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

type THold = {
  readonly nonce: string;
  /** Signed output budget of the held plan; null when the plan has none. */
  readonly maxOutputTokens: number | null;
};

const holdContext = new AsyncLocalStorage<THold>();

export const withHoldNonce = <T>(
  nonce: string,
  run: () => T,
  maxOutputTokens: number | null = null,
): T => holdContext.run({ nonce, maxOutputTokens }, run);

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
