/**
 * §4.1 cache-race probe — telemetry for
 * docs/proposals/claude-code-cache-rebuild-waste.md.
 *
 * Confirms or refutes the "concurrent-request cache racing" hypothesis for the
 * repeated ~330k `cache_creation_tokens` rebuilds seen in dev-DB usage: two
 * requests that share a prompt-cache prefix dispatch within seconds of each
 * other, each sees the prefix's cache write uncommitted, and BOTH pay the full
 * write. The probe is METADATA ONLY — it hashes a canonical-serialised body
 * prefix (never logs content) and counts how many requests sharing that
 * prefix were already awaiting upstream when this one dispatched. It wraps
 * ONLY the manual Anthropic transport dispatch (the claude_code manual path);
 * the native runtime is upstream of the hop and never reaches it, and
 * non-Anthropic wires are excluded.
 *
 * OFF by default — gated on `OPENLLM_CACHE_PROBE=1` so a production daemon is
 * completely unaffected; flip it only while collecting the race correlation,
 * then delete the probe once the hypothesis is settled.
 */
import { createHash } from "node:crypto";
import { logInfo } from "./logger";
import type { TNativeTokens } from "./native-runtime/types";

/** Whether the §4.1 cache-race probe is collecting (opt-in via env). */
export const cacheProbeEnabled = (): boolean =>
  process.env.OPENLLM_CACHE_PROBE === "1";

/**
 * A short hash of the cache-relevant PREFIX of a built upstream body — the
 * `system` prompt + every `messages` turn except the last (the "everything
 * already sent" prefix Anthropic would serve from cache). The last turn is
 * excluded because it is the fresh, uncached delta. For a chatgpt/Responses
 * body the analog is `instructions` + all-but-last `input` item. Hashing the
 * JSON of those fields means: two requests that share their stable prefix
 * collide on `prefix_hash`; a request whose prefix grew/diverged does not.
 * Returns null when the body has no recognisable prefix (nothing to race on).
 */
export const cacheProbePrefixHash = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  let prefix: unknown;
  if (Array.isArray(record.messages)) {
    const messages = record.messages as unknown[];
    prefix = {
      system: record.system ?? null,
      messages: messages.slice(0, -1),
    };
  } else if (Array.isArray(record.input)) {
    const input = record.input as unknown[];
    prefix = {
      instructions: record.instructions ?? null,
      input: input.slice(0, -1),
    };
  } else {
    return null;
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(prefix) ?? "";
  } catch {
    return null;
  }
  if (serialised.length === 0) return null;
  return createHash("sha256").update(serialised).digest("hex").slice(0, 16);
};

/** In-flight registry: scope key → count of requests awaiting upstream.
 *  Anthropic's prompt cache is per-ACCOUNT and per-MODEL, so a bare
 *  `prefixHash` key would report phantom races between requests that can
 *  never share a cache entry (same prefix bytes, different account or
 *  model). The key is a composite of providerModelId + accountHash +
 *  prefixHash; it never leaves the process — the LOGGED fields stay the
 *  human-readable model / prefix_hash / account_hash. */
const cacheProbeInFlight = new Map<string, number>();

/** The in-flight scope key: upstream model + account + prefix. */
const cacheProbeKey = (probe: TCacheProbe): string =>
  `${probe.providerModelId} ${probe.accountHash ?? ""} ${probe.prefixHash}`;

/** Register a dispatch; returns the count of same-scope requests already in
 *  flight when this one left (the race signal). */
const cacheProbeAcquire = (key: string): number => {
  const current = cacheProbeInFlight.get(key) ?? 0;
  cacheProbeInFlight.set(key, current + 1);
  return current;
};

/** Deregister once a request settles (success, error, or abort). */
const cacheProbeRelease = (key: string): void => {
  const current = cacheProbeInFlight.get(key) ?? 0;
  if (current <= 1) cacheProbeInFlight.delete(key);
  else cacheProbeInFlight.set(key, current - 1);
};

/** Mutable probe handle threaded from dispatch to the outcome logger. */
export type TCacheProbe = {
  readonly prefixHash: string;
  readonly model: string;
  /** Concrete upstream model id — part of the in-flight scope key only (the
   *  vendor cache is per-model); NOT logged (the log keeps the plan
   *  `model`). */
  readonly providerModelId: string;
  readonly accountHash: string | null;
  /** Set at dispatch: same-prefix twins in flight. */
  lastInFlight: number;
};

/**
 * Telemetry around ONE manual-transport dispatch: register the prefix as
 * in-flight (recording how many twins were already racing), run the send, and
 * always release — so `in_flight` in the emitted log line is the count of
 * overlapping same-prefix dispatches. `outcome` (committed + cache split) is
 * emitted by the caller, which owns the response token accounting.
 */
export const cacheProbeWrap = async <T>(
  probe: TCacheProbe,
  send: () => Promise<T>,
): Promise<T> => {
  const key = cacheProbeKey(probe);
  const inFlight = cacheProbeAcquire(key);
  // Stash the dispatch-time race count for the caller to attach to its outcome.
  probe.lastInFlight = inFlight;
  logInfo("cache-probe", "dispatch", {
    model: probe.model,
    prefix_hash: probe.prefixHash,
    in_flight: inFlight,
    ...(probe.accountHash !== null ? { account_hash: probe.accountHash } : {}),
  });
  try {
    return await send();
  } finally {
    cacheProbeRelease(key);
  }
};

/** Emit the outcome correlation: a large cache write with `in_flight > 0`
 *  confirms the race (two twins both writing the prefix); a large write with
 *  `in_flight === 0` refutes it (points back at prefix mutation). */
export const cacheProbeOutcome = (
  probe: TCacheProbe,
  tokens: TNativeTokens,
): void => {
  logInfo("cache-probe", "outcome", {
    model: probe.model,
    prefix_hash: probe.prefixHash,
    in_flight: probe.lastInFlight,
    cache_read: tokens.cached_tokens,
    cache_write: tokens.cache_creation_tokens,
    raced: probe.lastInFlight > 0,
    ...(probe.accountHash !== null ? { account_hash: probe.accountHash } : {}),
  });
};
