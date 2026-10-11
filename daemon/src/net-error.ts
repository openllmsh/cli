/**
 * Classify thrown fetch/connect failures for the daemon's cloud origin
 * (plan fetch + passthrough). Distinct from hop-error classification in
 * `@openllmsh/wire`, which needs an HTTP status.
 *
 * Transport identity is errno/`code` on the error or its `cause` (reuse
 * {@link TRANSIENT_NETWORK_CODES} / {@link isTransientNetworkError}), plus
 * DNS resolver codes the crash-policy set does not cover. Prose is not
 * matched: a TypeError mentioning "dns" in a property path is a bug.
 */
import {
  isTransientNetworkError,
  TRANSIENT_NETWORK_CODES,
} from "./crash-policy";
import type { TSafeDiagnosticMessage } from "./doctor-report/message";
import { safeDiagnosticMessage } from "./doctor-report/message";

/** Resolver failures are transport for origin fetch; they are not process-fatal
 *  crash-policy codes (those are connect/reset/unreachable). */
const DNS_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN"]);

export type TOriginFailureKind = "abort" | "timeout" | "transport";

const nodeCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : null;
};

const walkCauses = (err: unknown): ReadonlyArray<unknown> => {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current =
      current instanceof Error
        ? current.cause
        : typeof current === "object" && "cause" in current
          ? (current as { cause: unknown }).cause
          : undefined;
  }
  return out;
};

const errorName = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
};

const errorMessage = (err: unknown): string => {
  if (typeof err !== "object" || err === null) return "";
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
};

const isTimeoutError = (err: unknown): boolean => {
  if (nodeCode(err) === "ETIMEDOUT") return true;
  const name = errorName(err);
  if (name === "TimeoutError") return true;
  if (name === "AbortError") {
    const msg = errorMessage(err).toLowerCase();
    return msg.includes("timeout") || msg.includes("timed out");
  }
  return false;
};

const isCallerAbort = (err: unknown): boolean => {
  if (errorName(err) !== "AbortError") return false;
  return !isTimeoutError(err);
};

const isDnsCode = (code: string | null): boolean =>
  code !== null && DNS_CODES.has(code);

const isTransportError = (err: unknown): boolean => {
  if (err instanceof Error && /^plan fetch failed:\s*\d+/.test(err.message)) {
    return false;
  }
  for (const node of walkCauses(err)) {
    if (isTransientNetworkError(node)) return true;
    const code = nodeCode(node);
    if (isDnsCode(code)) return true;
    if (code !== null && TRANSIENT_NETWORK_CODES.has(code)) return true;
    if (
      node instanceof TypeError &&
      node.message === "fetch failed" &&
      node.cause !== undefined
    ) {
      if (
        isTransientNetworkError(node.cause) ||
        isDnsCode(nodeCode(node.cause))
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Classify a thrown origin/cloud fetch failure.
 * Returns `null` for programming / unexpected errors — callers must not
 * flatten those into a network envelope.
 *
 * When `signal` is the caller's `Request.signal` and it is aborted, that
 * wins over a custom abort reason that is not an `AbortError`.
 */
export const classifyOriginThrow = (
  err: unknown,
  signal?: AbortSignal,
): TOriginFailureKind | null => {
  if (signal?.aborted) {
    if (isTimeoutError(signal.reason) || isTimeoutError(err)) return "timeout";
    return "abort";
  }
  if (isCallerAbort(err)) return "abort";
  if (isTimeoutError(err)) return "timeout";
  if (isTransportError(err)) return "transport";
  return null;
};

/** HTTP/contract plan-fetch failures that may still passthrough to origin. */
export const isPlanPassthroughEligible = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (err.name === "InvalidApiKeyError" || err.name === "NoApiKeyError") {
    return true;
  }
  if (/^plan fetch failed:\s*\d+/.test(err.message)) return true;
  if (err.name === "ParseError" || /^(?:ParseError|decode)/i.test(err.name)) {
    return true;
  }
  return false;
};

export const originFailureStatus = (kind: TOriginFailureKind): number => {
  if (kind === "abort") return 499;
  if (kind === "timeout") return 503;
  return 502;
};

export const originFailureMessage = (kind: TOriginFailureKind): string => {
  if (kind === "abort") return "client aborted request";
  if (kind === "timeout") return "origin timed out before headers";
  return "origin is unreachable";
};

/** Upload-safe (closed) diagnostic for an origin failure kind. */
export const originFailureDiagnostic = (
  kind: TOriginFailureKind,
): TSafeDiagnosticMessage => {
  if (kind === "abort")
    return safeDiagnosticMessage`Origin request aborted by client.`;
  if (kind === "timeout")
    return safeDiagnosticMessage`Origin timed out before headers.`;
  return safeDiagnosticMessage`Origin is unreachable.`;
};

export const originFailureType = (kind: TOriginFailureKind): string => {
  if (kind === "abort") return "aborted";
  return "network";
};

export type TPlanFetchFailureAction =
  | { readonly action: "origin-error"; readonly kind: TOriginFailureKind }
  | { readonly action: "passthrough" }
  | { readonly action: "throw" };

/** Decide whether a failed plan fetch may hit the same origin again. */
export const planFetchFailureAction = (
  err: unknown,
  signal?: AbortSignal,
): TPlanFetchFailureAction => {
  const kind = classifyOriginThrow(err, signal);
  if (kind !== null) return { action: "origin-error", kind };
  if (isPlanPassthroughEligible(err)) return { action: "passthrough" };
  return { action: "throw" };
};
