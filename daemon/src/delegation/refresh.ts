/**
 * Native-CLI token refresh.
 *
 * The daemon does NOT refresh subscription OAuth tokens itself any more (no
 * `grant_type=refresh_token` calls, no extracted/hardcoded token endpoint or
 * client id). Instead each delegate's `readToken` checks expiry and, when the
 * access token is near or past expiry, TRIGGERS the official CLI's OWN native
 * refresh by running a bounded CLI invocation; the CLI refreshes + persists its
 * token to its own store, and the daemon just re-reads it. See each delegate's
 * `triggerRefresh` for the per-CLI command (claude/kimi: a minimal `-p` ping;
 * codex: `codex doctor`).
 *
 * Latency: a refresh spawn is seconds, so it must not block the serving hot
 * path. `makeRefresher` fires it in the BACKGROUND while the token is still
 * valid (within the leeway window) and only AWAITS it once the token is already
 * hard-expired — exactly "no latency unless the refresh is close".
 */

import type { TSubscriptionProviderSlug } from "@openllmsh/protocol";
import type { TSafeDiagnosticMessage } from "../doctor-report/message";
import { logDebug, logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import type { TRefreshCaller } from "../op-context";
import {
  currentRefreshCaller,
  currentTickId,
  refreshCallerBag,
  refreshSpawnBag,
  usageNativeRefreshAllowed,
} from "../op-context";
import type { TNativeAuthProducer } from "./spawn";
import { DEADLINE_CHECK_CAP_MS, spawnLogin, spawnLoginPty } from "./spawn";
import type { TLoginResult, TStoreRead } from "./util";

export type { TRefreshCaller } from "../op-context";

/** Local refresh behavior consumes these errnos; they are not report labels. */
export const REFRESH_NETWORK_ERRNOS = [
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
] as const;
const REFRESH_NETWORK_ERRNO_RE = new RegExp(
  `\\b(${REFRESH_NETWORK_ERRNOS.join("|")})\\b`,
  "i",
);
export const matchRefreshNetworkErrno = (text: string): string | null =>
  text.match(REFRESH_NETWORK_ERRNO_RE)?.[1]?.toUpperCase() ?? null;

/** Stamp the demand-path caller onto any nested `makeRefresher` fire. */
export const withRefreshCaller = <T>(
  caller: TRefreshCaller,
  fn: () => Promise<T>,
): Promise<T> => refreshCallerBag.run(caller, fn);

/** Bound on a refresh spawn — generous for a slow first call, short enough that
 *  a wedged child is reaped (the refresh already landed mid-request before the
 *  child's slow exit, so the timeout never costs correctness). */
export const REFRESH_SPAWN_TIMEOUT_MS = 60_000;

/**
 * Finite, operation-owned wait after a deadline when a validated newer store is
 * already visible. Chosen to stay well under the 10s/60s refresh watchdogs: long
 * enough for atexit flush, short enough that supervision still SIGTERM/SIGKILLs.
 * Child exit during this window is a clean settle; timeout still terminates.
 */
export const REFRESH_PERSISTENCE_GRACE_MS = 2_000;

/** Cap for every spawnRefresh store observation (pre-spawn, onDeadline, post-kill). */
export const REFRESH_STORE_OBSERVE_CAP_MS = DEADLINE_CHECK_CAP_MS;

const observeRefreshStore = async (
  read: () => Promise<TRefreshCredentialSnapshot | null>,
): Promise<TRefreshCredentialSnapshot | null> => {
  try {
    return await Promise.race([
      read(),
      new Promise<TRefreshCredentialSnapshot | null>((resolve) => {
        setTimeout(() => resolve(null), REFRESH_STORE_OBSERVE_CAP_MS);
      }),
    ]);
  } catch {
    return null;
  }
};

/** Pre/post spawn credential view. mtime is intentionally absent. */
export type TRefreshCredentialSnapshot = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly generation?: number;
  readonly accountId?: string | null;
};

export const refreshCredentialSnapshot = (opts: {
  readonly accessToken?: string | null;
  readonly refreshToken?: string | null;
  readonly generation?: number | null;
  readonly accountId?: string | null;
}): TRefreshCredentialSnapshot | null => {
  const accessToken = opts.accessToken ?? "";
  const refreshToken = opts.refreshToken ?? "";
  if (accessToken.length === 0) return null;
  return {
    accessToken,
    refreshToken,
    ...(opts.generation !== undefined &&
    opts.generation !== null &&
    Number.isFinite(opts.generation)
      ? { generation: opts.generation }
      : {}),
    ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
  };
};

/**
 * A persisted rotation is proven only with required fields, a newer generation
 * (or a changed access token when generation is unavailable), and account
 * continuity when both sides carry an account id. Partial access-only writes
 * and mtime bumps are not success.
 */
export const isVerifiedRefreshPersist = (
  prior: TRefreshCredentialSnapshot | null,
  next: TRefreshCredentialSnapshot | null,
): boolean => {
  if (prior === null || next === null) return false;
  if (next.accessToken.length === 0 || next.refreshToken.length === 0) {
    return false;
  }
  const priorAccount = prior.accountId ?? null;
  const nextAccount = next.accountId ?? null;
  if (
    priorAccount !== null &&
    priorAccount.length > 0 &&
    nextAccount !== null &&
    nextAccount.length > 0 &&
    priorAccount !== nextAccount
  ) {
    return false;
  }
  if (prior.generation !== undefined && next.generation !== undefined) {
    return next.generation > prior.generation;
  }
  return next.accessToken !== prior.accessToken;
};

/**
 * Post-spawn refresh cooldown shared by every delegate. It prevents periodic
 * status observers from driving repeat spawns and remains smaller than the
 * shortest refresh leeway (60s, claude), so a genuinely near-expiry token
 * still gets a second attempt before it hard-expires. This is the knob that
 * makes "no redundant refresh ever" true across status + request + usage.
 */
export const REFRESH_COOLDOWN_MS = 30_000;

/** Separate retry schedule for failed refreshes. The first retry remains bounded
 * by the historical 30s cooldown; subsequent failures exponentially back off. */
export const REFRESH_FAILURE_BACKOFF_MS = 30_000;
const MAX_REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000;

export type TRefreshErrorClass =
  | "timeout"
  | "network"
  | "spawn_failed"
  | "abandoned"
  | "invalid_grant"
  | "keychain_unusable"
  | "rejected";

/** A redacted, structured failure from a vendor refresh child. */
export type TRefreshSpawnMeta = {
  readonly spawned_at_ms: number | null;
  readonly child_pid: number | null;
};

export class RefreshTriggerError extends Error {
  readonly errorClass: TRefreshErrorClass;
  readonly abandoned: boolean;
  readonly exitCode: number;
  readonly timeoutMs: number;
  readonly errno: string | null;
  readonly spawnedAtMs: number | null;
  readonly childPid: number | null;

  constructor(
    errorClass: TRefreshErrorClass,
    result: Pick<TLoginResult, "abandoned" | "code"> &
      Partial<Pick<TLoginResult, "spawned_at_ms" | "child_pid" | "output">>,
    timeoutMs = REFRESH_SPAWN_TIMEOUT_MS,
  ) {
    super(`native refresh ${errorClass}`);
    this.name = "RefreshTriggerError";
    this.errorClass = errorClass;
    this.abandoned = result.abandoned;
    this.exitCode = result.code;
    this.timeoutMs = timeoutMs;
    this.spawnedAtMs = result.spawned_at_ms ?? null;
    this.childPid = result.child_pid ?? null;
    const output =
      "output" in result && typeof result.output === "string"
        ? result.output
        : "";
    this.errno = matchRefreshNetworkErrno(output);
  }
}

const SETTLED_FALLBACK = safeDiagnosticMessage`Credential refresh settled.`;

/** Closed-enum doctor text only — no interpolation, no extra provider list. */
const SETTLED_BY_PROVIDER: Record<
  TSubscriptionProviderSlug,
  TSafeDiagnosticMessage
> = {
  claude_code: safeDiagnosticMessage`Credential refresh settled for claude_code.`,
  chatgpt: safeDiagnosticMessage`Credential refresh settled for chatgpt.`,
  kimi_code: safeDiagnosticMessage`Credential refresh settled for kimi_code.`,
  grok: safeDiagnosticMessage`Credential refresh settled for grok.`,
  cursor: safeDiagnosticMessage`Credential refresh settled for cursor.`,
  muse: safeDiagnosticMessage`Credential refresh settled for muse.`,
};

const SETTLED_BY_PROVIDER_CALLER: Record<
  TSubscriptionProviderSlug,
  Record<TRefreshCaller, TSafeDiagnosticMessage>
> = {
  claude_code: {
    upstream: safeDiagnosticMessage`Credential refresh settled for claude_code (upstream).`,
    usage: safeDiagnosticMessage`Credential refresh settled for claude_code (usage).`,
    models: safeDiagnosticMessage`Credential refresh settled for claude_code (models).`,
    login: safeDiagnosticMessage`Credential refresh settled for claude_code (login).`,
  },
  chatgpt: {
    upstream: safeDiagnosticMessage`Credential refresh settled for chatgpt (upstream).`,
    usage: safeDiagnosticMessage`Credential refresh settled for chatgpt (usage).`,
    models: safeDiagnosticMessage`Credential refresh settled for chatgpt (models).`,
    login: safeDiagnosticMessage`Credential refresh settled for chatgpt (login).`,
  },
  kimi_code: {
    upstream: safeDiagnosticMessage`Credential refresh settled for kimi_code (upstream).`,
    usage: safeDiagnosticMessage`Credential refresh settled for kimi_code (usage).`,
    models: safeDiagnosticMessage`Credential refresh settled for kimi_code (models).`,
    login: safeDiagnosticMessage`Credential refresh settled for kimi_code (login).`,
  },
  grok: {
    upstream: safeDiagnosticMessage`Credential refresh settled for grok (upstream).`,
    usage: safeDiagnosticMessage`Credential refresh settled for grok (usage).`,
    models: safeDiagnosticMessage`Credential refresh settled for grok (models).`,
    login: safeDiagnosticMessage`Credential refresh settled for grok (login).`,
  },
  cursor: {
    upstream: safeDiagnosticMessage`Credential refresh settled for cursor (upstream).`,
    usage: safeDiagnosticMessage`Credential refresh settled for cursor (usage).`,
    models: safeDiagnosticMessage`Credential refresh settled for cursor (models).`,
    login: safeDiagnosticMessage`Credential refresh settled for cursor (login).`,
  },
  muse: {
    upstream: safeDiagnosticMessage`Credential refresh settled for muse (upstream).`,
    usage: safeDiagnosticMessage`Credential refresh settled for muse (usage).`,
    models: safeDiagnosticMessage`Credential refresh settled for muse (models).`,
    login: safeDiagnosticMessage`Credential refresh settled for muse (login).`,
  },
};

const isSubscriptionProviderSlug = (
  slug: string,
): slug is TSubscriptionProviderSlug =>
  Object.hasOwn(SETTLED_BY_PROVIDER, slug);

const settledDoctorMessage = (
  slug: string,
  caller: TRefreshCaller | null,
): TSafeDiagnosticMessage => {
  if (!isSubscriptionProviderSlug(slug)) return SETTLED_FALLBACK;
  if (caller === null) return SETTLED_BY_PROVIDER[slug];
  return SETTLED_BY_PROVIDER_CALLER[slug][caller];
};

const refreshClocks = (
  started: number,
  spawn: TRefreshSpawnMeta | undefined,
): {
  readonly elapsed_ms: number;
  readonly queued_ms: number;
  readonly spawn_elapsed_ms: number | null;
  readonly spawned: boolean;
  readonly child_pid: number | null;
} => {
  const settled = Date.now();
  const elapsed_ms = settled - started;
  const spawnedAt = spawn?.spawned_at_ms ?? null;
  const spawned = spawnedAt !== null;
  return {
    elapsed_ms,
    queued_ms: spawned ? spawnedAt - started : elapsed_ms,
    spawn_elapsed_ms: spawned ? settled - spawnedAt : null,
    spawned,
    child_pid: spawn?.child_pid ?? null,
  };
};

/** Per-provider refresh counters. `cooldown_skips` (post-success 30s window) and
 *  `backoff_skips` (post-failure escalating window) are kept DISTINCT so a healthy
 *  cooldown-dominated ratio can be told apart from a broken provider backing off. */
type TRefreshCounters = {
  attempts: number;
  ok: number;
  fail: number;
  abandoned: number;
  cooldown_skips: number;
  backoff_skips: number;
  fallbacks: number;
  lost: number;
};

const refreshCounters = new Map<string, TRefreshCounters>();

export type TRefreshLast = {
  readonly caller: TRefreshCaller | null;
  readonly error_class: TRefreshErrorClass | null;
  readonly exit_code: number | null;
  readonly spawn_elapsed_ms: number | null;
  readonly queued_ms: number | null;
  readonly timeout_ms: number | null;
  readonly in_flight: boolean;
};

const emptyLast = (): TRefreshLast => ({
  caller: null,
  error_class: null,
  exit_code: null,
  spawn_elapsed_ms: null,
  queued_ms: null,
  timeout_ms: null,
  in_flight: false,
});

const refreshLast = new Map<string, TRefreshLast>();

const lastFor = (provider: string): TRefreshLast => {
  const current = refreshLast.get(provider);
  if (current !== undefined) return current;
  const next = emptyLast();
  refreshLast.set(provider, next);
  return next;
};

const patchLast = (
  provider: string,
  patch: Partial<TRefreshLast>,
): TRefreshLast => {
  const next: TRefreshLast = { ...lastFor(provider), ...patch };
  refreshLast.set(provider, next);
  return next;
};

const counterFor = (provider: string): TRefreshCounters => {
  const current = refreshCounters.get(provider);
  if (current !== undefined) return current;
  const next: TRefreshCounters = {
    attempts: 0,
    ok: 0,
    fail: 0,
    abandoned: 0,
    cooldown_skips: 0,
    backoff_skips: 0,
    fallbacks: 0,
    lost: 0,
  };
  refreshCounters.set(provider, next);
  lastFor(provider);
  return next;
};

export type TRefreshTelemetryEntry = TRefreshCounters & {
  readonly last: TRefreshLast;
};

/** Metadata-only refresh telemetry for `openllmd status` consumers. */
export const refreshTelemetrySnapshot = (): Readonly<
  Record<string, Readonly<TRefreshTelemetryEntry>>
> =>
  Object.fromEntries(
    [...refreshCounters.entries()].map(([provider, counters]) => [
      provider,
      { ...counters, last: lastFor(provider) },
    ]),
  );

export const noteRefreshTokenLost = (provider: string): void => {
  counterFor(provider).lost++;
};

/** Shared post-refresh credential decision. A new access token without its
 * refresh companion is intentionally not treated as healthy: it can serve only
 * until expiry and must prompt re-auth before that deadline.
 *
 * The lost-refresh case is currently OBSERVABLE via the `refresh_token_lost`
 * warn + counter emitted here. `reauthRequired` is the shared shape ready for
 * the daemon status/pending-auth surface to render a PRE-expiry re-auth prompt;
 * wiring it through the status protocol is the tracked follow-up (see the plan's
 * "telemetry→protocol / reauthRequired→UI" deferral). Delegates use `token`
 * today and pass the flag through unchanged. */
export type TResolvedToken<T> = {
  readonly token: T;
  readonly reauthRequired: boolean;
};

export const resolveToken = <T>(opts: {
  readonly provider: string;
  readonly prior: T;
  readonly refreshed: T | null;
  readonly hasRefreshToken: (token: T) => boolean;
}): TResolvedToken<T> => {
  const token = opts.refreshed ?? opts.prior;
  if (!opts.hasRefreshToken(token)) {
    noteRefreshTokenLost(opts.provider);
    logWarn("refresh", safeDiagnosticMessage`refresh token lost`, {
      provider: opts.provider,
      phase: "refresh_token_lost",
    });
    return { token, reauthRequired: true };
  }
  return { token, reauthRequired: false };
};

const unrefreshableCredentialProviders = new Set<string>();

export const credentialUnrefreshable = (provider: string): void => {
  if (unrefreshableCredentialProviders.has(provider)) return;
  unrefreshableCredentialProviders.add(provider);
  logWarn("refresh", safeDiagnosticMessage`credential cannot be refreshed`, {
    provider,
    phase: "credential_unrefreshable",
  });
};

export const keychainUnusable = (provider: string): never => {
  logWarn(
    "refresh",
    safeDiagnosticMessage`keychain is unusable; re-authentication required`,
    {
      provider,
      phase: "keychain_unusable",
    },
  );
  throw new RefreshTriggerError("keychain_unusable", {
    abandoned: false,
    code: -1,
    spawned_at_ms: null,
    child_pid: null,
  });
};

/**
 * Decide whether a native refresh may spawn after a keychain readiness check.
 * Only `present` may spawn. Every other result is a benign skip: a refresh
 * CLI must not create, unlock, or probe an uncertain keychain. Recoverable
 * backoff is owned by keychain readiness, not a permanent refresh failure.
 */
export const keychainRefreshSpawnAllowed = (
  _provider: string,
  readiness: TStoreRead<void>,
): boolean => readiness.kind === "present";

const networkErrorPattern =
  /\b(?:ehostunreach|enetunreach|econnrefused|enotfound|eai_again|etimedout|econnreset)\b|fetch failed|\b(?:getaddrinfo|dns|network error|socket hang up)\b|\b(?:tls|ssl)\b|certificate verify failed|self[- ]signed certificate|unable to verify/i;

const errorText = (err: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.name, current.message);
    current = current.cause;
  }
  return parts.join(" ");
};

const isNetworkErrorText = (text: string): boolean =>
  networkErrorPattern.test(text);

const inspectRefreshResult = (
  result: TLoginResult,
  timeoutMs: number,
): void => {
  const output = result.output.toLowerCase();
  // `abandoned` is the deadline/abort SIGTERM — the exact mid-rotation kill that
  // strands a single-use refresh token (the B1 bug). It is the primary failure.
  if (result.abandoned) {
    throw new RefreshTriggerError("abandoned", result, timeoutMs);
  }
  // An explicit OAuth error means the credential is genuinely un-refreshable.
  if (output.includes("invalid_grant") || output.includes("invalid_request")) {
    throw new RefreshTriggerError("invalid_grant", result, timeoutMs);
  }
  // Codex doctor reports its reachability failure on stderr but intentionally
  // returns a non-zero code for other harmless diagnostics. Preserve that bare
  // non-zero behavior while recognizing its explicit network vocabulary.
  if (result.code !== 0 && isNetworkErrorText(result.output)) {
    throw new RefreshTriggerError("network", result, timeoutMs);
  }
  // A BARE non-zero exit is deliberately NOT a failure: the refresh commands are
  // diagnostic-style (`codex doctor`, `grok models`, `cursor status`) that can
  // exit non-zero on a benign warning while still rotating the token as a side
  // effect. Classifying that as failure would escalate the backoff and serve
  // stale tokens on every tick. Persistence-aware success is decided by
  // {@link isVerifiedRefreshPersist} in {@link spawnRefresh}, not by exit code.
};

/**
 * Run a bounded CLI invocation whose SIDE EFFECT is the CLI refreshing +
 * persisting its own OAuth token. Output is ignored; the daemon never writes the
 * store (the CLI owns it). `pty` runs it under a pseudo-terminal for a CLI whose
 * print mode is TTY-gated (kimi's `-p`).
 */
export const spawnRefresh = async (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  opts?: {
    readonly pty?: boolean;
    readonly probe?: boolean;
    readonly timeoutMs?: number;
    /**
     * Observer abort is accepted for API compatibility and ignored for the
     * child. Shared refresh must not die when a status waiter aborts (T11).
     */
    readonly signal?: AbortSignal;
    readonly readStore?: () => Promise<TRefreshCredentialSnapshot | null>;
    readonly persistenceGraceMs?: number;
    readonly producer?: TNativeAuthProducer;
    readonly operationId?: string;
  },
): Promise<void> => {
  const run = opts?.pty === true ? spawnLoginPty : spawnLogin;
  const timeoutMs = opts?.timeoutMs ?? REFRESH_SPAWN_TIMEOUT_MS;
  const graceMs = opts?.persistenceGraceMs ?? REFRESH_PERSISTENCE_GRACE_MS;
  const prior =
    opts?.readStore === undefined
      ? null
      : await observeRefreshStore(opts.readStore);
  const result = await run([...argv], env, {
    timeoutMs,
    probe: opts?.probe,
    ...(opts?.producer !== undefined ? { producer: opts.producer } : {}),
    ...(opts?.operationId !== undefined
      ? { operationId: opts.operationId }
      : {}),
    ...(opts?.readStore !== undefined
      ? {
          persistenceGraceMs: graceMs,
          onDeadline: async (): Promise<boolean> => {
            const readStore = opts.readStore;
            if (readStore === undefined) return false;
            const next = await observeRefreshStore(readStore);
            return isVerifiedRefreshPersist(prior, next);
          },
        }
      : {}),
  });
  // spawnLogin intentionally resolves after its deadline/non-zero child exit.
  // A refresh must turn those resolved outcomes into a classified rejection so
  // makeRefresher cannot record a killed rotation as a clean success — unless
  // a fenced store re-read proves a newer complete credential.
  if (result.abandoned && opts?.readStore !== undefined) {
    const next = await observeRefreshStore(opts.readStore);
    if (isVerifiedRefreshPersist(prior, next)) {
      const bagOk = refreshSpawnBag.getStore();
      if (bagOk !== undefined) {
        bagOk.meta = {
          spawned_at_ms: result.spawned_at_ms,
          child_pid: result.child_pid,
        };
        bagOk.timeoutMs = timeoutMs;
      }
      return;
    }
  }
  inspectRefreshResult(result, timeoutMs);
  // T4 pins spawnRefresh resolving to `undefined`. Stamp clocks onto the
  // in-flight fire() bag so the success path still carries them.
  const bag = refreshSpawnBag.getStore();
  if (bag !== undefined) {
    bag.meta = {
      spawned_at_ms: result.spawned_at_ms,
      child_pid: result.child_pid,
    };
    bag.timeoutMs = timeoutMs;
  }
};

/** What `makeRefresher` did for this read — tells the caller whether the store
 *  was (synchronously) refreshed and should be re-read. */
export type TRefreshOutcome =
  /** Not near expiry, or no expiry known — nothing triggered. */
  | "fresh"
  /** Within the window but still valid — refresh KICKED in the background; the
   *  current token is returned as-is (the store updates before it's next used). */
  | "kicked"
  /** Hard-expired — the refresh was AWAITED and the trigger settled cleanly;
   *  re-read the store for the new token. */
  | "awaited"
  /** Hard-expired — the trigger rejected; keep the stale credential (the
   *  upstream then 401s → re-login). */
  | { readonly kind: "stale"; readonly reason: TRefreshErrorClass };

export const isStaleRefresh = (
  outcome: TRefreshOutcome,
): outcome is { readonly kind: "stale"; readonly reason: TRefreshErrorClass } =>
  typeof outcome === "object" && outcome.kind === "stale";

export const classifyRefreshError = (err: unknown): TRefreshErrorClass => {
  if (err instanceof RefreshTriggerError) return err.errorClass;
  const text = errorText(err);
  if (isNetworkErrorText(text)) return "network";
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      text.toLowerCase().includes("timeout") ||
      text.toLowerCase().includes("timed out"))
  ) {
    return "timeout";
  }
  const normalized = text.toLowerCase();
  if (
    normalized.includes("spawn") ||
    normalized.includes("enoent") ||
    normalized.includes("eacces") ||
    normalized.includes("eperm") ||
    normalized.includes("eagain")
  ) {
    return "spawn_failed";
  }
  return "rejected";
};

const lastRefreshErrorClasses = new Map<string, TRefreshErrorClass | null>();

/** In-memory result of the most recently settled refresh for one provider. */
export const lastRefreshErrorClass = (
  provider: string,
): TRefreshErrorClass | null => lastRefreshErrorClasses.get(provider) ?? null;

export const authReasonCodeForRefreshError = (
  errorClass: TRefreshErrorClass,
): "refresh_abandoned" | "refresh_failed" =>
  errorClass === "abandoned" || errorClass === "timeout"
    ? "refresh_abandoned"
    : "refresh_failed";

const networkErrno = (err: unknown): string | null =>
  matchRefreshNetworkErrno(errorText(err));

/**
 * Build a per-provider refresher around its `trigger` (the CLI-refresh spawn).
 *
 * Two invariants make "correct token, no redundant refresh" hold for EVERY
 * caller (a periodic status observer, the request hot path, usage reads) because
 * all of them funnel through this one function:
 *   - **Single-flight:** concurrent callers that all see a stale token share
 *     ONE spawn (refresh-token rotation means parallel refreshes would
 *     invalidate each other — a second concurrent `claude -p ping` is exactly
 *     the rotation race that logs users out). This is why NO delegate may wrap
 *     this with its own signal-aware bypass.
 *   - **Post-spawn cooldown** (`cooldownMs`, optional): once a trigger has
 *     COMPLETED (success OR failure), no new spawn fires for `cooldownMs`. A
 *     success rotates the token so its new expiry is far out and `"fresh"`
 *     suppresses re-fires on its own; the cooldown additionally bounds the
 *     near-expiry window and, on failure, stops a per-observer hammer on a broken
 *     refresh. Net: ≤1 spawn per `cooldownMs` per provider.
 *
 * Returns a function the delegate's `readToken` calls with the token's
 * `expiresAtMs`:
 *   - `>= leewayMs` remaining, or inside the cooldown → `"fresh"` (no trigger).
 *   - within the window but still valid → fire the trigger in the BACKGROUND,
 *     return `"kicked"` (caller returns the current still-valid token — no stall).
 *   - hard-expired → AWAIT the trigger, return `"awaited"` (caller re-reads)
 *     or `{ kind: "stale" }` if the trigger rejected (caller keeps the current
 *     token).
 */
export const makeRefresher = (opts: {
  readonly slug: string;
  readonly label: string;
  readonly leewayMs: number;
  readonly cooldownMs?: number;
  /** Every provider's trigger is `async () => { … }`, i.e. `Promise<void>`, so
   *  `void` here means "may return nothing" — exactly the contract. Narrowing
   *  it to `undefined` makes all five providers unassignable (TS2322) for no
   *  gain; that swap was tried and reverted. */
  // biome-ignore lint/suspicious/noConfusingVoidType: providers return Promise<void>
  readonly trigger: () => Promise<void | TRefreshSpawnMeta>;
}): ((expiresAtMs: number | null) => Promise<TRefreshOutcome>) => {
  let inFlight: Promise<void> | null = null;
  let lastErrorClass: TRefreshErrorClass | null = null;
  let cooldownUntil = 0;
  let failureBackoffUntil = 0;
  let consecutiveFailures = 0;
  const cooldownMs = opts.cooldownMs ?? 0;
  const fire = (): Promise<void> => {
    if (inFlight === null) {
      const started = Date.now();
      // Three clocks, not one: `elapsed_ms` is the whole trigger() wall from
      // this first waiter's `started` (queue + spawn). `queued_ms` is
      // spawned_at − started, or the wall-to-failure when no child ran.
      // `spawn_elapsed_ms` is settled − spawned_at and is the ONLY number
      // comparable to `timeout_ms`; it is null when no child ran. A failed
      // trigger is still best-effort: rejecting would (a) leak an unhandled
      // rejection from the background `void fire()` path and (b) throw out of
      // the awaited hard-expired path — both wrong. On failure the store
      // simply isn't refreshed and `readToken` falls back to the stale token
      // (surfacing the vendor's own 401 → re-login). Log a REDACTED class
      // only — never the raw error / token.
      // NOTE (telemetry semantics, tracked follow-up): `attempts`/`ok` count a
      // trigger INVOCATION that resolved, which includes a benign keychain skip
      // or a non-zero-but-unverified exit where no rotation is proven. Making
      // `ok` mean "rotation confirmed" needs the Stage 8 store-newer-than-
      // pre-spawn predicate; until then `refreshTelemetrySnapshot` (now
      // surfaced on GET /status as `refresh_spawns`) slightly over-counts
      // `ok` on those benign paths.
      const counters = counterFor(opts.slug);
      counters.attempts++;
      const caller = currentRefreshCaller();
      patchLast(opts.slug, {
        caller,
        error_class: null,
        exit_code: null,
        spawn_elapsed_ms: null,
        queued_ms: null,
        timeout_ms: null,
        in_flight: true,
      });
      const bag: {
        meta: TRefreshSpawnMeta | undefined;
        timeoutMs: number | undefined;
      } = { meta: undefined, timeoutMs: undefined };
      inFlight = refreshSpawnBag
        .run(bag, () => opts.trigger())
        .then((meta) => {
          lastErrorClass = null;
          lastRefreshErrorClasses.set(opts.slug, null);
          consecutiveFailures = 0;
          counters.ok++;
          if (cooldownMs > 0) cooldownUntil = Date.now() + cooldownMs;
          const spawn =
            meta !== undefined && meta !== null
              ? {
                  spawned_at_ms: meta.spawned_at_ms,
                  child_pid: meta.child_pid,
                }
              : bag.meta;
          const clocks = refreshClocks(started, spawn);
          const timeout_ms = bag.timeoutMs ?? REFRESH_SPAWN_TIMEOUT_MS;
          patchLast(opts.slug, {
            caller,
            error_class: null,
            exit_code: null,
            spawn_elapsed_ms: clocks.spawn_elapsed_ms,
            queued_ms: clocks.queued_ms,
            timeout_ms,
            in_flight: false,
          });
          logInfo(
            "refresh",
            settledDoctorMessage(opts.slug, caller),
            {
              provider: opts.slug,
              phase: "refresh_trigger",
              caller,
              elapsed_ms: clocks.elapsed_ms,
              queued_ms: clocks.queued_ms,
              spawn_elapsed_ms: clocks.spawn_elapsed_ms,
              spawned: clocks.spawned,
              timeout_ms,
            },
            {
              timings: {
                elapsed_ms: clocks.elapsed_ms,
                configured_timeout_ms: timeout_ms,
                ...(clocks.spawn_elapsed_ms !== null
                  ? { spawn_elapsed_ms: clocks.spawn_elapsed_ms }
                  : {}),
              },
            },
          );
        })
        .catch((err: unknown) => {
          lastErrorClass = classifyRefreshError(err);
          lastRefreshErrorClasses.set(opts.slug, lastErrorClass);
          consecutiveFailures++;
          counters.fail++;
          const triggerError =
            err instanceof RefreshTriggerError ? err : undefined;
          if (triggerError?.abandoned === true) counters.abandoned++;
          const failureBackoffMs = Math.min(
            REFRESH_FAILURE_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
            MAX_REFRESH_FAILURE_BACKOFF_MS,
          );
          failureBackoffUntil = Date.now() + failureBackoffMs;
          const spawn: TRefreshSpawnMeta | undefined =
            triggerError === undefined
              ? undefined
              : {
                  spawned_at_ms: triggerError.spawnedAtMs,
                  child_pid: triggerError.childPid,
                };
          const clocks = refreshClocks(started, spawn);
          const timeout_ms =
            triggerError?.timeoutMs ?? REFRESH_SPAWN_TIMEOUT_MS;
          patchLast(opts.slug, {
            caller,
            error_class: lastErrorClass,
            exit_code: triggerError?.exitCode ?? null,
            spawn_elapsed_ms: clocks.spawn_elapsed_ms,
            queued_ms: clocks.queued_ms,
            timeout_ms,
            in_flight: false,
          });
          if (lastErrorClass === "network") {
            logWarn(
              "refresh",
              safeDiagnosticMessage`Credential refresh failed.`,
              {
                provider: opts.slug,
                errno: triggerError?.errno ?? networkErrno(err),
                retry_in_ms: failureBackoffMs,
                ...clocks,
                timeout_ms,
                tick_id: currentTickId(),
                caller,
              },
              {
                timings: {
                  ...(clocks.spawn_elapsed_ms !== null
                    ? { spawn_elapsed_ms: clocks.spawn_elapsed_ms }
                    : {}),
                  configured_timeout_ms: timeout_ms,
                  ...(triggerError?.exitCode !== undefined
                    ? { root_exit_code: triggerError.exitCode }
                    : {}),
                },
              },
            );

            return;
          }
          logWarn(
            "refresh",
            safeDiagnosticMessage`Credential refresh failed.`,
            {
              provider: opts.slug,
              label: opts.label,
              phase: "refresh_trigger",
              error_class: lastErrorClass,
              ...clocks,
              timeout_ms,
              abandoned: triggerError?.abandoned ?? false,
              exit_code: triggerError?.exitCode ?? null,
              tick_id: currentTickId(),
              caller,
            },
            {
              timings: {
                ...(clocks.spawn_elapsed_ms !== null
                  ? { spawn_elapsed_ms: clocks.spawn_elapsed_ms }
                  : {}),
                configured_timeout_ms: timeout_ms,
                ...(triggerError?.exitCode !== undefined
                  ? { root_exit_code: triggerError.exitCode }
                  : {}),
              },
            },
          );
        })
        .finally(() => {
          inFlight = null;
          patchLast(opts.slug, { in_flight: false });
        });
    }
    return inFlight;
  };
  return async (expiresAtMs) => {
    if (expiresAtMs === null) return "fresh";
    const remaining = expiresAtMs - Date.now();
    // Usage is stored-only unless the manual Refresh-usage ALS is set.
    // Honour that here so a nested `readToken` cannot spawn on a passive
    // usage() even if a caller forgets the stored-token branch.
    if (currentRefreshCaller() === "usage" && !usageNativeRefreshAllowed()) {
      if (remaining > 0) return "fresh";
      if (lastErrorClass === null) return "fresh";
      counterFor(opts.slug).fallbacks++;
      return { kind: "stale", reason: lastErrorClass };
    }
    if (remaining >= opts.leewayMs) return "fresh";
    // A recent spawn already gathered current info — don't spawn again until the
    // cooldown lapses. Serving the current token for at most `cooldownMs` is the
    // right backoff; it never serves a WORSE token than one spawn ago.
    const now = Date.now();
    if (cooldownMs > 0 && now < cooldownUntil) {
      counterFor(opts.slug).cooldown_skips++;
      logDebug("refresh", "native refresh skipped (cooldown)", {
        provider: opts.slug,
        phase: "refresh_skipped",
        reason: "cooldown",
      });
      return "fresh";
    }
    if (now < failureBackoffUntil) {
      counterFor(opts.slug).backoff_skips++;
      logDebug("refresh", "native refresh skipped (failure backoff)", {
        provider: opts.slug,
        phase: "refresh_skipped",
        reason: "failure_backoff",
      });
      // Still-valid token: serve it, do not re-spawn. Hard-expired: typed stale
      // so the walker cools the hop instead of spending the request on a 401.
      if (remaining > 0 || lastErrorClass === null) return "fresh";
      counterFor(opts.slug).fallbacks++;
      return { kind: "stale", reason: lastErrorClass };
    }
    if (remaining > 0) {
      void fire();
      return "kicked";
    }
    await fire();
    if (lastErrorClass !== null) {
      // The caller will serve the stale credential — count it centrally so no
      // delegate has to remember to (they all log `refresh_fallback` already).
      counterFor(opts.slug).fallbacks++;
      return { kind: "stale", reason: lastErrorClass };
    }
    return "awaited";
  };
};
