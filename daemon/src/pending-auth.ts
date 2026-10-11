/**
 * In-memory pending device-code auth, per provider.
 *
 * When a delegate starts a device-code flow on a REMOTE daemon (codex /
 * kimi), the box that runs it isn't where the user's browser is — so the
 * verification URL + one-time code must reach the dashboard. The delegate
 * stashes them here; the daemon's STATUS push surfaces them (as the
 * connection `detail`) so the user can open the URL and authorize from their
 * own machine. Cleared when the credential lands (status sees `connected`) or
 * the flow is abandoned/expires.
 *
 * In-memory only — a daemon restart drops it and a fresh Connect re-creates
 * it. Not a secret (a device code is single-use + short-lived), so no
 * persistence and nothing sensitive is held.
 */
import { PENDING_AUTH_TTL_MS } from "@openllmsh/protocol";

export type TPendingAuth = {
  /** Local initiation: never include prompt material in shared status or relay events. */
  readonly localOnly?: boolean;
  /** Absent/empty on a marker-only owner snapshot — never a fake prompt. */
  readonly url?: string;
  readonly code?: string;
  readonly kind?: "marker" | "prompt";
  /** `device_code` (codex/kimi: the user enters `code` in their browser at
   *  `url`, the daemon polls) or `paste_code` (claude headless login: the user
   *  signs in at `url`, the hosted page shows a code, the user pastes it back
   *  — `code` is empty, the dashboard renders a paste input). Absent ⇒
   *  `device_code`. See `docs/proposals/headless-claude-login-paste-back.md`. */
  readonly mode?: "device_code" | "paste_code";
  /** Browser/relay command id of the login that produced this snapshot.
   *  Surfaced on the wire as `flow_id` so a cold status still correlates to
   *  an in-flight `auth.login.*` flow. */
  readonly flowId?: string;
  /** Epoch ms this flow was created — stamped by {@link setPendingAuth} (callers
   *  need not pass it). Drives TTL expiry (see {@link PENDING_AUTH_TTL_MS}) and
   *  is surfaced on the wire as `started_at_ms` so the browser mirrors the same
   *  expiry against the PERSISTED status. */
  readonly startedAt?: number;
};

type TStoredAuth = TPendingAuth & { readonly startedAt: number };

const pending = new Map<string, TStoredAuth>();

let loginOwnerLive: (slug: string) => boolean = () => false;
let anyLoginOwnerLive: () => boolean = () => false;

/** Bound from login-flow to avoid a module cycle. */
export const setPendingAuthOwnerLive = (
  ownerLive: (slug: string) => boolean,
  anyOwnerLive: () => boolean,
): void => {
  loginOwnerLive = ownerLive;
  anyLoginOwnerLive = anyOwnerLive;
};

const isExpired = (auth: TStoredAuth): boolean =>
  Date.now() - auth.startedAt > PENDING_AUTH_TTL_MS;

export const setPendingAuth = (slug: string, auth: TPendingAuth): void => {
  pending.set(slug, { ...auth, startedAt: auth.startedAt ?? Date.now() });
};

/** The live pending flow for a provider, or null. A STALE entry (older than the
 *  TTL — its login was abandoned, or the daemon restarted and dropped the live
 *  child without the background-exit cleanup running) is treated as absent and
 *  evicted, so a dead flow can never be re-surfaced or persisted. */
export const isPromptPending = (auth: TPendingAuth): boolean =>
  auth.kind !== "marker" && typeof auth.url === "string" && auth.url.length > 0;

export const getPendingAuth = (slug: string): TPendingAuth | null => {
  const auth = pending.get(slug);
  if (auth === undefined) return null;
  if (isExpired(auth)) {
    if (loginOwnerLive(slug)) return auth;
    pending.delete(slug);
    return null;
  }
  return auth;
};

/**
 * Drop pending auth for `slug`. When `flowId` is set, leave a newer overlapping
 * flow's snapshot in place — stale finalizers must not wipe a retry.
 */
export const clearPendingAuth = (slug: string, flowId?: string): void => {
  if (flowId !== undefined) {
    const auth = pending.get(slug);
    if (
      auth !== undefined &&
      auth.flowId !== undefined &&
      auth.flowId !== flowId
    ) {
      return;
    }
  }
  pending.delete(slug);
};

/** Any provider awaiting device-code authorization — gates the status-change
 *  watcher so a background login completing flips the card without a manual
 *  refresh. See `docs/proposals/daemon-browser-status-sync.md` §2.2. Expired
 *  entries are evicted here too, so a stale one can't keep the watcher hot. */
export const hasPendingAuth = (): boolean => {
  if (anyLoginOwnerLive()) return true;
  for (const [slug, auth] of pending) {
    if (isExpired(auth) && !loginOwnerLive(slug)) {
      pending.delete(slug);
      continue;
    }
    return true;
  }
  return false;
};

/** A human-facing one-liner for the dashboard `detail` while a pending auth is
 *  live. `paste_code` (claude headless) asks the user to paste the code the
 *  hosted page shows; device-code flows that carry a `code` ask the user to
 *  enter it in the browser; the browser-OAuth flow (codex) has none (the
 *  localhost callback completes it), so the code clause is omitted. */
export const pendingAuthDetail = (auth: TPendingAuth): string => {
  if (
    auth.localOnly === true ||
    !isPromptPending(auth) ||
    auth.url === undefined
  ) {
    return "Sign-in is running on this machine.";
  }
  if (auth.mode === "paste_code") {
    return `Open ${auth.url} in your browser, sign in, then paste the code it shows back here to authorize.`;
  }
  return (auth.code ?? "").length > 0
    ? `Open ${auth.url} in your browser and enter the code ${auth.code} to authorize. This updates automatically once you're done.`
    : `Open ${auth.url} in your browser to authorize. This updates automatically once you're done.`;
};

export const pendingAuthWire = (
  auth: TPendingAuth,
  extras?: { readonly cancel_requested?: boolean },
): {
  readonly url?: string;
  readonly code?: string;
  readonly pending?: true;
  readonly mode?: TPendingAuth["mode"];
  readonly flow_id?: string;
  readonly started_at_ms?: number;
  readonly cancel_requested?: boolean;
} => {
  const prompt = auth.localOnly !== true && isPromptPending(auth);
  return {
    ...(prompt && auth.url !== undefined
      ? { url: auth.url }
      : { pending: true }),
    ...(prompt && auth.code !== undefined ? { code: auth.code } : {}),
    ...(auth.mode !== undefined ? { mode: auth.mode } : {}),
    started_at_ms: auth.startedAt,
    ...(auth.flowId !== undefined ? { flow_id: auth.flowId } : {}),
    ...(extras?.cancel_requested === true ? { cancel_requested: true } : {}),
  };
};
