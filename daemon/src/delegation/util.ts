/**
 * Shared helpers for official-CLI delegation — now a BARREL over the
 * single-topic modules it used to open-code (split per
 * `docs/proposals/sub-method-simplified-execution.md` §3):
 *
 *   - `spawn.ts`          capture runs, login spawns (pipe + PTY), ANSI strip,
 *                         browser open, spawn env/cwd hygiene
 *   - `headless-login.ts` Claude remote paste-back login
 *   - `keychain.ts`       isolated macOS login keychain
 *
 * Every existing `./util` import keeps working; new code may import the
 * specific module directly.
 *
 * ⚠️ UNVERIFIED AGAINST LIVE CLIs. The credential-store paths, file
 * shapes, and login commands are derived from public docs + upstream
 * source research (2025-2026); each delegate is marked accordingly. See
 * the per-delegate `RESEARCH` notes.
 *
 * Bright line (proposal §6): nothing read from a CLI's store may be sent
 * off-box. These helpers feed the LOCAL runner + the local usage panel
 * only.
 */

import type {
  TDaemonProviderObservationResult,
  TDaemonProviderReasonCode,
} from "@openllmsh/protocol";

export * from "./headless-login";
export * from "./keychain";
export * from "./spawn";

/**
 * Result of reading a credential store. Callers must not treat
 * `indeterminate` as "signed out" — that is a transient I/O or parse
 * failure, not an authoritative absence.
 */
export type TStoreRead<T> =
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate"; readonly cause: string };

export type {
  TDaemonProviderObservation,
  TDaemonProviderObservationResult,
  TDaemonProviderReasonCode,
} from "@openllmsh/protocol";
/** Shared daemon-status wire sentinel; preserves existing daemon import paths. */
export { STATUS_CHECK_FAILED_DETAIL } from "@openllmsh/protocol";

export const unknownObservation = (
  reason: TDaemonProviderReasonCode = "probe_failed",
): TDaemonProviderObservationResult => ({
  observation: "unknown",
  reason_code: reason,
});

export const disconnectedObservation =
  (): TDaemonProviderObservationResult => ({
    observation: "disconnected",
    reason_code: "credential_absent",
  });

export const connectedObservation = (): TDaemonProviderObservationResult => ({
  observation: "connected",
});

export const storeReadValue = <T>(read: TStoreRead<T>): T | null =>
  read.kind === "present" ? read.value : null;

const errorCause = (err: unknown): string => {
  if (err instanceof Error) {
    const code =
      "code" in err && typeof err.code === "string" ? err.code : undefined;
    return code !== undefined && code.length > 0
      ? `${err.name}:${code}`
      : err.name;
  }
  return "read_failed";
};

const isEnoent = (err: unknown): boolean =>
  err instanceof Error && "code" in err && err.code === "ENOENT";

/**
 * Read + JSON-parse a file as a tri-state. `absent` is ONLY a genuine missing
 * file (ENOENT). Everything else — a directory at the path (EISDIR), a
 * permission/I/O failure, or a parse error — is `indeterminate`. Read directly
 * rather than pre-checking `exists()`: the extra syscall is racy, and a
 * directory would pass `exists()` as `false` and be misreported as `absent`.
 */
export const readJsonStore = async <T>(
  path: string,
): Promise<TStoreRead<T>> => {
  try {
    return { kind: "present", value: (await Bun.file(path).json()) as T };
  } catch (err) {
    if (isEnoent(err)) return { kind: "absent" };
    return { kind: "indeterminate", cause: errorCause(err) };
  }
};

/**
 * Collapsing wrapper for callers that only need present-or-null.
 * MUST NOT be used as an auth-presence check: I/O/`indeterminate` collapses
 * to `null` the same as `absent`. Remaining caller is auth-config sidecar
 * (optional JSON; null → `{}`), not a login/logout edge.
 */
export const readJsonFile = async <T>(path: string): Promise<T | null> =>
  storeReadValue(await readJsonStore<T>(path));

/** Tolerant epoch parser — accepts ms-int, sec-float, or ISO string. */
export const toEpochMs = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: < 1e12 is seconds, else ms.
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};
