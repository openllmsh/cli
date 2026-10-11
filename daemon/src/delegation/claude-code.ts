/**
 * Anthropic Claude Code (Pro/Max) delegate.
 *
 * Native delegation: use the installed `claude` CLI's OWN OAuth
 * credential + identity. Replaces the server-side forging that lived in
 * `provider-usage.ts`. Lowest-risk of the three (proposal §5).
 *
 * ISOLATED install: the daemon runs its OWN `claude` under
 * `~/.openllm/cli/claude_code/` with an isolated HOME + `CLAUDE_CONFIG_DIR`
 * (see cli-paths.ts), so it never touches the user's `~/.claude`.
 *
 * Credential storage is PLATFORM-SPLIT (confirmed via the Claude Code
 * docs — there is no file-based override on macOS):
 *   - macOS → the login Keychain (service "Claude Code-credentials").
 *     Claude resolves the login keychain by HOME path, so we give the
 *     isolated HOME its own keychain (`ensureIsolatedKeychain`) before
 *     login and read the blob back from it (`readIsolatedKeychain`).
 *   - Linux/Windows → the FILE `<CLAUDE_CONFIG_DIR>/.credentials.json`.
 * Either way the payload wrapper key is `claudeAiOauth`
 * { accessToken (sk-ant-oat01-…), refreshToken, expiresAt, scopes }.
 *
 *   - Login: `claude auth login --claudeai`; `claude auth status` (JSON)
 *     is the authoritative connection check.
 *   - Upstream identity: `Authorization: Bearer sk-ant-oat01-…`,
 *     `anthropic-beta: oauth-2025-04-20`, `anthropic-version:
 *     2023-06-01`, `User-Agent: claude-cli/<version>`.
 *   - Usage: GET https://api.anthropic.com/api/oauth/usage.
 */
import { platform } from "node:os";
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderUsageSnapshot,
} from "@openllmsh/protocol";
import { MODEL_LIST_FETCH_TIMEOUT_MS } from "@openllmsh/protocol";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliConfigDir, cliHome } from "../cli-paths";
import { createDeadlineBudget, firstOfBudget } from "../deadline-budget";
import { logWarn, safeDiagnosticMessage } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
  pendingAuthWire,
} from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { accountHash, nonEmpty } from "./account-id";
import {
  resolveIdentityHeaders,
  resolveProviderUrl,
  resolveUpstreamUrl,
} from "./auth-config";
import { cliLaunch, loginWiring, nativeRefresher } from "./delegate-shared";
import {
  cachedCliSemver,
  credentialHasFetchLifetime,
  fetchModelList,
  modelDiscoveryFromList,
  parseClaudeModelList,
  skippedModelDiscovery,
} from "./fetch-model-list";
import {
  ensureIsolatedKeychain,
  ensureKeychainReady,
  grantKeychainToolAccess,
  keychainStoreIdentity,
  observeKeychainReady,
  readIsolatedKeychain,
} from "./keychain";
import { makePasteBackDevice } from "./login-device";
import { makeBlockingConnect } from "./login-direct";
import type { TLoginVerify } from "./login-flow";
import {
  currentLoginCommandCorrelation,
  loginOwnershipPending,
} from "./login-flow";
import type { TNativeAuthLifecycleTimings } from "./native-auth-lifecycle";
import { createNativeAuthLifecycle } from "./native-auth-lifecycle";
import {
  createPassiveObservationCache,
  fileStoreIdentity,
  fingerprintStoreIdentity,
  rememberIfFingerprintStable,
  waitFileStoreHint,
} from "./observation-cache";
import type { TRefreshErrorClass } from "./refresh";
import {
  credentialUnrefreshable,
  isStaleRefresh,
  keychainRefreshSpawnAllowed,
  refreshCredentialSnapshot,
  resolveToken,
  spawnRefresh,
  withRefreshCaller,
} from "./refresh";
import type { TRunCaptureResult } from "./spawn";
import { runCaptureResult } from "./spawn";
import type {
  TImageCredential,
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
  TProviderDelegate,
} from "./types";
import { resolveUsageCredential } from "./usage-credential";
import { reduceClaudeUsage, reduceQuotaStatus } from "./usage-reduce";
import type { TStoreRead } from "./util";
import {
  cliVersion,
  connectedObservation,
  disconnectedObservation,
  newNativeAuthOperationId,
  readJsonStore,
  STATUS_CHECK_FAILED_DETAIL,
  storeReadValue,
  toEpochMs,
  unknownObservation,
} from "./util";

const PROVIDER = "claude_code" as const;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Peer of the keychain lane (4s); below the 10s owner status budget. */
const AUTH_STATUS_TIMEOUT_MS = 4_000;
/**
 * Whole-operation logout budget (CLI + store verify). Not the 4s auth-status
 * probe and not the 5s capture default — that default killed legitimate logout.
 */
export const AUTH_LOGOUT_TIMEOUT_MS = 30_000;
let logoutTimeoutMsForTests: number | null = null;

export const setAuthLogoutTimeoutMsForTests = (ms: number | null): void => {
  logoutTimeoutMsForTests = ms;
};

const logoutTimeoutMs = (): number =>
  logoutTimeoutMsForTests ?? AUTH_LOGOUT_TIMEOUT_MS;
const OAUTH_BETA = "oauth-2025-04-20";
// Usage endpoint LEAF path — the host is derived from the captured inference
// endpoint (`resolveProviderUrl`), so a vendor host migration is auto-tracked.
const USAGE_PATH = "/api/oauth/usage";
const PROFILE_PATH = "/api/oauth/profile";

// `/api/oauth/profile` nests the tier under `organization` — NOT at the top
// level. The Claude Code CLI reads `organization.rate_limit_tier` (e.g.
// "default_claude_max_20x") and `organization.organization_type` (e.g.
// "claude_max"); see ref/claude oauth client.ts + upgrade.tsx.
type TClaudeProfile = {
  readonly organization?: {
    readonly rate_limit_tier?: unknown;
    readonly organization_type?: unknown;
  };
};

/** Best-effort private-client tier read. It must never affect quota availability. */
const readClaudePlan = async (
  headers: Readonly<Record<string, string>>,
): Promise<string | null> => {
  try {
    const response = await fetch(
      await resolveProviderUrl(PROVIDER, PROFILE_PATH),
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const profile = (await response.json()) as TClaudeProfile;
    const org = profile.organization;
    if (typeof org?.rate_limit_tier === "string") return org.rate_limit_tier;
    return typeof org?.organization_type === "string"
      ? org.organization_type
      : null;
  } catch {
    return null;
  }
};

// The daemon does NOT refresh the token itself. When the access token is within
// this window of expiry, `readToken` TRIGGERS the `claude` CLI's OWN native
// refresh (a minimal `claude -p` query — the CLI refreshes mid-request and
// persists the rotated token to its store); there is no `claude auth refresh`
// command. No token endpoint or client id lives here. See `triggerRefresh`.
const REFRESH_LEEWAY_MS = 60_000;

// Run the isolated `claude` binary with its isolated home/config env.
const { bin, env } = cliLaunch(PROVIDER);

type TClaudeOAuth = {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number | string;
  readonly scopes?: ReadonlyArray<string>;
};
type TClaudeStore = { readonly claudeAiOauth?: TClaudeOAuth };

const loadStore = async (
  signal?: AbortSignal,
  observeOnly = false,
): Promise<TStoreRead<TClaudeStore>> => {
  if (platform() === "darwin") {
    // macOS stores the blob in the isolated login keychain (not a file).
    const raw = await readIsolatedKeychain(
      cliHome(PROVIDER),
      KEYCHAIN_SERVICE,
      (p) => p.includes("claudeAiOauth"),
      signal,
      observeOnly,
    );
    if (raw.kind !== "present") return raw;
    try {
      return { kind: "present", value: JSON.parse(raw.value) as TClaudeStore };
    } catch {
      return { kind: "indeterminate", cause: "SyntaxError" };
    }
  }
  return readJsonStore<TClaudeStore>(
    join(cliConfigDir(PROVIDER), ".credentials.json"),
  );
};

/**
 * Stable Anthropic account identity, hashed (`account_hash` — see
 * `account-id.ts`). The CLI records the signed-in account in its config file
 * (`<CLAUDE_CONFIG_DIR>/.claude.json` → `oauthAccount.accountUuid`), which
 * survives token refresh. NOT `machineID`/`userID` — those are per-device.
 */
const readAccountId = async (): Promise<string | null> => {
  const cfg = storeReadValue(
    await readJsonStore<{
      readonly oauthAccount?: { readonly accountUuid?: string };
    }>(join(cliConfigDir(PROVIDER), ".claude.json")),
  );
  return nonEmpty(cfg?.oauthAccount?.accountUuid);
};

const readAccountHash = async (): Promise<string | null> => {
  const id = await readAccountId();
  return id === null ? null : accountHash(PROVIDER, id);
};

/**
 * Trigger the `claude` CLI's OWN native token refresh: a minimal headless
 * query. The CLI refreshes its OAuth access token mid-request and PERSISTS the
 * rotated token to its store — the daemon never touches the token. macOS: the
 * isolated login keychain must be unlocked first so the CLI can READ the
 * credential to make the call (and WRITE the rotated one back). Output ignored;
 * bounded. Rotating the refresh token here is fine — this is now the SINGLE
 * refresher (no race with a daemon-side refresh), which is why claude's URL
 * capture stays disabled (`liveCapture:false`).
 */
const triggerRefresh = async (): Promise<void> => {
  // A locked/unusable isolated keychain must NOT reach `claude -p ping`: the
  // vendor CLI would open it and pop the SecurityAgent dialog (and it can't
  // refresh a credential it can't read). Skip when not ready.
  const operationId = newNativeAuthOperationId();
  const keychain = await ensureKeychainReady(cliHome(PROVIDER));
  if (!keychainRefreshSpawnAllowed(PROVIDER, keychain)) return;
  clearAuthStatusCache();
  // The refresh persists the rotated token into the macOS keychain via
  // securityd, which refuses a Seatbelt-confined caller; unconfined on macOS,
  // confined on Linux (file-backed store) — `sandbox/policy.ts`.
  await spawnRefresh([bin(), "-p", "ping"], env(), {
    probe: unwrapKeychainSpawn(PROVIDER),
    timeoutMs: 10_000,
    producer: "claude-refresh",
    operationId,
    // Darwin keychain snapshots are not a verified generation/account fence
    // without extra security(1) work; retain bounded abandoned failure there.
    ...(platform() === "darwin"
      ? {}
      : {
          readStore: async () => {
            const oauth = storeReadValue(await loadStore())?.claudeAiOauth;
            return refreshCredentialSnapshot({
              accessToken: oauth?.accessToken,
              refreshToken: oauth?.refreshToken,
              accountId: await readAccountHash(),
            });
          },
        }),
  });
  clearAuthStatusCache();
};

// THE single refresher. Within the leeway window → fire the CLI refresh in the
// background (still valid, no stall); hard-expired → await it. Single-flight +
// post-spawn cooldown per provider (`refresh.ts`). There is deliberately NO
// signal-aware bypass: the old wrapper spawned a second concurrent `claude -p
// ping` off the status path, racing the single-use refresh token (audit
// 2026-08-27 §7.3). A refresh spawn is already bounded by its own 10s timeout,
// so status callers don't need to cancel it — they share this one spawn.
const refresh = nativeRefresher({
  slug: PROVIDER,
  label: "Claude Code",
  leewayMs: REFRESH_LEEWAY_MS,
  trigger: triggerRefresh,
});

type TStoredClaudeToken =
  | {
      readonly kind: "live";
      readonly accessToken: string;
      readonly expiresAtMs: number | null;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

/** Stored access token only — never native-refreshes. Usage reads this. */
const readStoredToken = async (
  signal?: AbortSignal,
): Promise<TStoredClaudeToken> => {
  const oauth = storeReadValue(await loadStore(signal))?.claudeAiOauth;
  if (oauth?.accessToken === undefined || oauth.accessToken.length === 0) {
    return { kind: "missing" };
  }
  const expiresAtMs = toEpochMs(oauth.expiresAt);
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    return { kind: "expired" };
  }
  return { kind: "live", accessToken: oauth.accessToken, expiresAtMs };
};

/**
 * The current access token, triggering the CLI's native refresh if it's within
 * the leeway of expiry. Used by `credentialForUpstream` (inference) so the
 * request carries a live token. `usage()` uses {@link readStoredToken} instead.
 */
const readToken = async (
  signal?: AbortSignal,
): Promise<{
  accessToken: string;
  expiresAtMs: number | null;
  staleRefresh?: TRefreshErrorClass;
} | null> => {
  const oauth = storeReadValue(await loadStore(signal))?.claudeAiOauth;
  if (oauth?.accessToken === undefined || oauth.accessToken.length === 0) {
    return null;
  }
  const expiresAtMs = toEpochMs(oauth.expiresAt);
  // Only trigger when the credential CAN be refreshed — an empty/missing refresh
  // token can't (and the CLI can't either), so don't waste a spawn.
  if (!oauth.refreshToken) credentialUnrefreshable(PROVIDER);
  const outcome = oauth.refreshToken ? await refresh(expiresAtMs) : "fresh";
  if (isStaleRefresh(outcome)) {
    logWarn(
      "refresh",
      safeDiagnosticMessage`returning stale expired credential`,
      {
        provider: PROVIDER,
        phase: "refresh_fallback",
        error_class: outcome.reason,
      },
    );
    return {
      accessToken: oauth.accessToken,
      expiresAtMs,
      staleRefresh: outcome.reason,
    };
  }
  if (outcome !== "awaited") {
    return { accessToken: oauth.accessToken, expiresAtMs };
  }
  // Hard-expired path: the CLI refresh was awaited — re-read the (now-rotated)
  // store. Falls back to the stale token if it failed (the upstream then 401s
  // and the UI says re-sign-in).
  const fresh = storeReadValue(await loadStore(signal))?.claudeAiOauth;
  const resolved = resolveToken({
    provider: PROVIDER,
    prior: oauth,
    refreshed:
      fresh?.accessToken !== undefined && fresh.accessToken.length > 0
        ? fresh
        : null,
    hasRefreshToken: (token) => Boolean(token.refreshToken),
  });
  return {
    accessToken: resolved.token.accessToken ?? oauth.accessToken,
    expiresAtMs: toEpochMs(resolved.token.expiresAt),
  };
};

const userAgent = async (): Promise<string> => {
  const v = await cliVersion(bin(), env());
  // `claude --version` prints e.g. "2.0.55 (Claude Code)"; take the
  // leading semver. Falls back to a generic CLI UA when unavailable.
  const semver = v?.match(/\d+\.\d+\.\d+/)?.[0];
  return semver !== undefined ? `claude-cli/${semver}` : "claude-cli/2.0.0";
};

type TClaudeStatusObservation = {
  readonly connected: boolean;
};

const claudeStatusCache =
  createPassiveObservationCache<TClaudeStatusObservation>();

type TAuthStatusProbe =
  | { readonly kind: "timeout" }
  | { readonly kind: "value"; readonly result: boolean | null };

type TAuthStatusFlight = {
  readonly generation: number;
  readonly startFingerprint: string;
  readonly work: Promise<TAuthStatusProbe>;
  liveObservers: number;
  abandonedObservers: number;
  consumedObservers: number;
  settled: TAuthStatusProbe | undefined;
  lateAdmitted: boolean;
};

let authStatusInFlight: TAuthStatusFlight | null = null;

const maybeAdmitInnerAuthLate = (flight: TAuthStatusFlight): void => {
  if (flight.lateAdmitted) return;
  if (flight.settled === undefined) return;
  if (flight.liveObservers > 0) return;
  if (flight.consumedObservers > 0) return;
  if (flight.abandonedObservers === 0) return;
  flight.lateAdmitted = true;
  admitInnerAuthLate({
    probe: flight.settled,
    generation: flight.generation,
    startFingerprint: flight.startFingerprint,
  });
};

const releaseAuthStatusObserver = (
  flight: TAuthStatusFlight,
  abandoned: boolean,
): void => {
  flight.liveObservers -= 1;
  if (abandoned) flight.abandonedObservers += 1;
  else flight.consumedObservers += 1;
  maybeAdmitInnerAuthLate(flight);
};

/**
 * After the only observer aborted, a determinate inner `auth status` may still
 * settle. Admit only with matching generation + start/end store fingerprint so
 * logout, a newer login, or a replaced store cannot be overwritten. Cached
 * first so a follow-up status push cannot spawn an unbounded re-probe loop.
 * Keychain late `present` re-admit is deferred (shared unlock already ignores
 * observer abort; no fenced status re-entry in source).
 */
const admitInnerAuthLate = (opts: {
  readonly probe: TAuthStatusProbe;
  readonly generation: number;
  readonly startFingerprint: string;
}): void => {
  if (opts.generation !== claudeStatusCache.generation()) return;
  const end = claudePassiveReuseAllowed();
  if (end.fingerprint !== opts.startFingerprint) return;
  const probe = opts.probe;
  if (probe.kind !== "value") return;
  let connected: boolean;
  if (probe.result === true) {
    connected = true;
  } else if (probe.result === false && end.absentStore) {
    connected = false;
  } else {
    return;
  }
  void (async (): Promise<void> => {
    const { admitLateProviderConnection, lateProviderAdmitBlocked } =
      await import("../status");
    if (opts.generation !== claudeStatusCache.generation()) return;
    if (lateProviderAdmitBlocked(PROVIDER)) return;
    if (
      fingerprintStoreIdentity(claudePassiveStoreIdentity()) !==
      opts.startFingerprint
    ) {
      return;
    }
    rememberIfFingerprintStable(
      claudeStatusCache,
      opts.startFingerprint,
      end.fingerprint,
      { connected },
      opts.generation,
    );
    if (claudeStatusCache.get(end.fingerprint) === undefined) return;
    const { version } = await cliInstallState(PROVIDER);
    const raw = await claudeStatusPayload(connected, version);
    admitLateProviderConnection(PROVIDER, raw);
  })().catch(() => {});
};

/**
 * Drop cached idle status. Called on every auth MUTATION (login, logout,
 * native refresh) so a state change is visible immediately. Exported for tests
 * that drive login/logout out of band.
 */
export const clearAuthStatusCache = (): void => {
  claudeStatusCache.invalidate();
  noteAuthStoreIdentityChange(PROVIDER);
};

/**
 * Authoritative connection check via `claude auth status` (JSON):
 *   { loggedIn: bool, authMethod: "claudeai" | "api_key" | …, … }
 * We require loggedIn AND a subscription auth method (not `api_key` —
 * the daemon serves the subscription path, not a console key). Returns
 * null when the CLI is absent or the JSON is unparseable, so the caller
 * falls back to the credential-store read.
 *
 * Idle reuse is the metadata-keyed cache on `status()`, not this probe.
 */
type TAuthStatusWait =
  | { readonly kind: "aborted" }
  | { readonly kind: "invalidated" }
  | { readonly kind: "timeout" }
  | { readonly kind: "value"; readonly result: boolean | null };

/**
 * Typed login verify shared by blocking connect, paste-back, and finishInBackground.
 * `loggedIn:false` + present store is unavailable (matches `status()`). Timeout
 * with a live token is connected so an unread CLI probe cannot fail a landed login.
 */
export const classifyClaudeLoginVerify = (opts: {
  readonly viaAuth: TAuthStatusWait;
  readonly tokenPresent: boolean;
}): TLoginVerify => {
  const { viaAuth, tokenPresent } = opts;
  if (viaAuth.kind !== "value") {
    return { state: tokenPresent ? "connected" : "unavailable" };
  }
  if (viaAuth.result === true) return { state: "connected" };
  if (viaAuth.result === false) {
    return { state: tokenPresent ? "unavailable" : "absent" };
  }
  return { state: tokenPresent ? "connected" : "unavailable" };
};

export type TClaudeLogoutCapture =
  | TRunCaptureResult
  | { readonly kind: "skipped" };

/**
 * Logout verification. Timeout/abort is never success, even if the store
 * looks absent (unread vs cleared). Remaining credentials fail and keep the
 * capture timeout/failure note. Empty-stdout success is `kind: "ok"`.
 * Unknown/indeterminate is never signed-out.
 */
export const classifyClaudeLogout = (opts: {
  readonly capture: TClaudeLogoutCapture;
  readonly store: TStoreRead<{
    readonly claudeAiOauth?: { readonly accessToken?: string };
  }>;
}): { readonly ok: boolean; readonly detail: string } => {
  const captureNote =
    opts.capture.kind === "timeout"
      ? "logout timed out; "
      : opts.capture.kind === "failed"
        ? "logout command failed; "
        : opts.capture.kind === "aborted"
          ? "logout aborted; "
          : "";
  const token =
    opts.store.kind === "present"
      ? opts.store.value.claudeAiOauth?.accessToken
      : undefined;
  const remaining = typeof token === "string" && token.length > 0;
  if (opts.capture.kind === "timeout" || opts.capture.kind === "aborted") {
    return {
      ok: false,
      detail: remaining
        ? `${captureNote}credential still present after logout`
        : `${captureNote}could not verify credential store after logout`,
    };
  }
  if (opts.store.kind === "indeterminate") {
    return {
      ok: false,
      detail: `${captureNote}could not verify credential store after logout`,
    };
  }
  if (remaining) {
    return {
      ok: false,
      detail: `${captureNote}credential still present after logout`,
    };
  }
  return { ok: true, detail: "signed out of Claude Code" };
};

const awaitAuthStatus = async (
  work: Promise<TAuthStatusProbe>,
  signal?: AbortSignal,
): Promise<TAuthStatusWait> => {
  if (signal === undefined) return await work;
  if (signal.aborted) return { kind: "aborted" };

  let onAbort = (): void => {};
  const aborted = new Promise<TAuthStatusWait>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const raced = await Promise.race([work, aborted]);
    return raced;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const authStatusLoggedIn = async (
  signal?: AbortSignal,
): Promise<TAuthStatusWait> => {
  const generation = claudeStatusCache.generation();
  const startFingerprint = claudePassiveReuseAllowed().fingerprint;
  let flight = authStatusInFlight;
  if (flight === null || flight.generation !== generation) {
    if (signal?.aborted === true) return { kind: "aborted" };
    const work = (async (): Promise<TAuthStatusProbe> => {
      // macOS securityd refuses keychain reads for a Seatbelt-confined caller,
      // so this shared producer is unconfined on macOS and bounded internally by
      // runCapture. Observer cancellation must not kill another status waiter's
      // probe.
      const out = await runCaptureResult([bin(), "auth", "status"], env(), {
        probe: unwrapKeychainSpawn(PROVIDER),
        timeoutMs: AUTH_STATUS_TIMEOUT_MS,
        producer: "claude-auth-status",
        operationId: newNativeAuthOperationId(),
      });
      if (out.kind === "timeout") return { kind: "timeout" };
      if (out.kind !== "ok") return { kind: "value", result: null };
      try {
        const parsed = JSON.parse(out.text) as {
          loggedIn?: boolean;
          authMethod?: string;
        };
        if (parsed.loggedIn !== true) return { kind: "value", result: false };
        return { kind: "value", result: parsed.authMethod !== "api_key" };
      } catch {
        return { kind: "value", result: null };
      }
    })();
    flight = {
      generation,
      startFingerprint,
      work,
      liveObservers: 0,
      abandonedObservers: 0,
      consumedObservers: 0,
      settled: undefined,
      lateAdmitted: false,
    };
    authStatusInFlight = flight;
    const captured = flight;
    const clearFlight = (): void => {
      if (authStatusInFlight?.work === work) authStatusInFlight = null;
    };
    void work.then(
      (probe) => {
        clearFlight();
        captured.settled = probe;
        maybeAdmitInnerAuthLate(captured);
      },
      () => {
        clearFlight();
      },
    );
  }

  if (signal?.aborted === true) return { kind: "aborted" };
  flight.liveObservers += 1;
  let abandoned = false;
  try {
    const result = await awaitAuthStatus(flight.work, signal);
    abandoned = result.kind === "aborted";
    if (generation !== claudeStatusCache.generation()) {
      return { kind: "invalidated" };
    }
    return result;
  } catch (error) {
    abandoned = false;
    throw error;
  } finally {
    releaseAuthStatusObserver(flight, abandoned);
  }
};

const claudePassiveStoreIdentity = (): ReturnType<typeof fileStoreIdentity> => {
  if (platform() === "darwin") {
    const id = keychainStoreIdentity(cliHome(PROVIDER));
    return {
      path: id.path,
      present: id.present,
      mtimeMs: id.mtimeMs,
      size: id.size,
      ino: id.ino,
      statOk: id.statOk,
    };
  }
  return fileStoreIdentity(join(cliConfigDir(PROVIDER), ".credentials.json"));
};

const claudePassiveReuseAllowed = (): {
  readonly fingerprint: string;
  readonly reuse: boolean;
  readonly absentStore: boolean;
} => {
  if (platform() === "darwin") {
    const id = keychainStoreIdentity(cliHome(PROVIDER));
    return {
      fingerprint: fingerprintStoreIdentity(id),
      reuse: id.statOk && (id.skipEligible || !id.present),
      absentStore: id.statOk && !id.present,
    };
  }
  const identity = claudePassiveStoreIdentity();
  return {
    fingerprint: fingerprintStoreIdentity(identity),
    reuse: identity.statOk,
    absentStore: identity.statOk && !identity.present,
  };
};

const claudeStatusPayload = async (
  connected: boolean,
  version: string | null,
): Promise<TDaemonProviderConnection> => {
  if (connected) clearPendingAuth(PROVIDER);
  const pending = connected ? null : getPendingAuth(PROVIDER);
  const acct = connected ? await readAccountHash() : null;
  return {
    provider: PROVIDER,
    status: connected ? "connected" : "disconnected",
    ...(connected
      ? connectedObservation()
      : pending !== null
        ? {}
        : disconnectedObservation()),
    cli_installed: true,
    ...(version !== null ? { cli_version: version } : {}),
    ...(connected
      ? {
          last_login_at_ms: null,
          ...(acct !== null ? { account_hash: acct } : {}),
        }
      : pending !== null
        ? {
            pending_auth: pendingAuthWire(pending, {
              cancel_requested:
                loginOwnershipPending(PROVIDER)?.cancel_requested === true,
            }),
            detail: pendingAuthDetail(pending),
          }
        : { detail: "claude CLI installed but not signed in" }),
  };
};

/**
 * Whether the stored credential can AUTO-REFRESH — i.e. it carries a non-empty
 * refresh token. The hosted paste-back login grant has been observed to land an
 * EMPTY refresh token; the daemon then (correctly) refuses to refresh it, so the
 * ~8h access token silently dies and the user must re-login. Surfacing this at
 * login turns an invisible, delayed failure into an explicit one. Returns null
 * when there is no credential at all.
 */
const credentialRefreshable = async (
  signal?: AbortSignal,
): Promise<boolean | null> => {
  const oauth = storeReadValue(await loadStore(signal))?.claudeAiOauth;
  if (oauth?.accessToken === undefined || oauth.accessToken.length === 0) {
    return null;
  }
  return (
    typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0
  );
};

// Logged + returned when a login lands a credential that can't self-refresh.
const NO_REFRESH_HINT =
  "signed in via Claude Code — warning: this credential has no refresh token and can't auto-refresh; you may need to re-sign in when it expires";

// ─── Login wiring ────────────────────────────────────────────────────────
//
// Direct and paste-back share one slot. All paths flag a credential that
// can't auto-refresh (no refresh token) at sign-in.

const LOGIN_ARGV = (): ReadonlyArray<string> => [
  bin(),
  "auth",
  "login",
  "--claudeai",
];

// Authoritative connection check: prefer `claude auth status`, fall back to the
// store read when it's unavailable (the store read is fragile on macOS).
const {
  installHint: INSTALL_HINT,
  connectedDetail: CONNECTED_DETAIL,
  isInstalled,
  isConnected,
  refreshConfig,
  slot,
} = loginWiring({
  provider: PROVIDER,
  installHint:
    "Claude Code CLI not found — re-run the OpenLLM daemon installer to add it.",
  connectedDetail: "signed in via Claude Code",
  readToken,
  isConnected: async (): Promise<boolean> =>
    (await verifyClaudeLogin()).state === "connected",
});

const verifyClaudeLogin = async (): Promise<TLoginVerify> => {
  const viaAuth = await authStatusLoggedIn();
  return classifyClaudeLoginVerify({
    viaAuth,
    tokenPresent: (await readToken()) !== null,
  });
};
// The success `detail`: a credential with no refresh token works now but can't
// be renewed — log `warning` + return the persistent NO_REFRESH_HINT so the
// dashboard shows a "re-sign in" hint instead of a card that dies at expiry.
const signedInDetail = async (warning: string): Promise<string> => {
  if ((await credentialRefreshable()) === false) {
    logWarn("claude-code", warning);
    return NO_REFRESH_HINT;
  }
  return CONNECTED_DETAIL;
};

// Native browser login: `claude auth login --claudeai` opens the browser and
// BLOCKS until its own localhost callback completes; the token then lands in
// the isolated CLI's store. (macOS keychain ensured before / granted after.)
const connectDirect = makeBlockingConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  nativeAuth: { producer: "claude-login" },
  beforeLogin: () => ensureIsolatedKeychain(cliHome(PROVIDER)),
  argv: LOGIN_ARGV,
  env,
  // Drop the cached status BEFORE `verifyConnected` runs: the pre-login
  // `installed`/status reads may have cached a signed-OUT answer that would
  // otherwise make the post-login verification falsely fail.
  afterLogin: async () => {
    clearAuthStatusCache();
    return grantKeychainToolAccess(cliHome(PROVIDER));
  },
  verifyConnected: verifyClaudeLogin,
  // Darwin credentials live in the isolated keychain — no safe file event.
  waitStoreHint:
    platform() === "darwin"
      ? undefined
      : (signal) =>
          waitFileStoreHint(
            join(cliConfigDir(PROVIDER), ".credentials.json"),
            signal,
          ),
  onConnected: refreshConfig,
  successDetail: () =>
    signedInDetail(
      "signed in (browser) but the stored credential has NO refresh token — it cannot auto-refresh; re-login will be needed at access-token expiry",
    ),
  failDetail: (result) =>
    result.output.length > 0
      ? result.output.slice(0, 300)
      : `claude auth login exited ${result.code} without a stored credential`,
});

// Headless paste-back login (remote box): spawn `claude auth login --claudeai`
// with the browser suppressed, surface the hosted-callback URL (paste mode),
// and hold the process open on stdin until the user pastes the code.
const device = makePasteBackDevice({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  // Authoritative check: `claude auth status` first, the (fragile, macOS-shape-
  // sensitive) store read only as fallback — same as `status()`/`connect()`.
  connected: isConnected,
  verify: verifyClaudeLogin,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail:
    "Claude sign-in already in progress — finish in your browser, then paste the code.",
  beforeLogin: () => ensureIsolatedKeychain(cliHome(PROVIDER)),
  argv: LOGIN_ARGV,
  env,
  onConnected: async () => {
    if ((await credentialRefreshable()) === false) {
      logWarn(
        "claude-code",
        safeDiagnosticMessage`headless login landed a credential with NO refresh token — it cannot auto-refresh (re-login will be needed at access-token expiry)`,
      );
    }
    refreshConfig();
  },
  onCodeAccepted: () => grantKeychainToolAccess(cliHome(PROVIDER)),
  // Same ordering rule as the browser flow: invalidate first, so the verify
  // below observes the post-paste credential rather than a stale signed-out
  // answer cached by the pre-login `connected` probe.
  waitStoreHint:
    platform() === "darwin"
      ? undefined
      : (signal) =>
          waitFileStoreHint(
            join(cliConfigDir(PROVIDER), ".credentials.json"),
            signal,
          ),
  verifyAfterSubmit: async () => {
    clearAuthStatusCache();
    return verifyClaudeLogin();
  },
  submitSuccessDetail: () =>
    signedInDetail(
      "signed in but the stored credential has NO refresh token — it cannot auto-refresh; the access token will expire (~8h) and require re-login",
    ),
});

export const claudeCodeDelegate: TProviderDelegate = {
  slug: "claude_code",
  statusCancellable: true,
  invalidateStatusObservation: clearAuthStatusCache,

  connect: connectDirect,
  connectDeviceCode: device.connectDeviceCode,
  submitLoginCode: device.submitLoginCode,
  cancelConnect: device.cancelConnect,

  status: async (signal?: AbortSignal): Promise<TDaemonProviderConnection> => {
    const { installed, version } = await cliInstallState(PROVIDER);
    if (!installed) {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("cli_unavailable"),
        cli_installed: false,
        detail: "claude CLI not installed",
      };
    }
    const observedGeneration = claudeStatusCache.generation();
    let { fingerprint, reuse, absentStore } = claudePassiveReuseAllowed();
    if (reuse) {
      const cached = claudeStatusCache.get(fingerprint);
      if (cached !== undefined) {
        return claudeStatusPayload(cached.connected, version);
      }
      if (absentStore) {
        claudeStatusCache.set(
          fingerprint,
          { connected: false },
          observedGeneration,
        );
        return claudeStatusPayload(false, version);
      }
    }
    // macOS: unlock an EXISTING isolated chain so `claude auth status` can
    // read it. Observe-only — no create/recreate/ACL. Locked/drifted/missing
    // is a status-check failure (NOT signed-out). Repair stays on login /
    // inference. Skip-ineligible present stores keep this guarded unlock.
    if (
      (await observeKeychainReady(cliHome(PROVIDER), signal)).kind !== "present"
    ) {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("keychain_unavailable"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        detail: STATUS_CHECK_FAILED_DETAIL,
      };
    }
    ({ fingerprint, reuse } = claudePassiveReuseAllowed());
    const reusedAfterReady = claudeStatusCache.get(fingerprint);
    if (reuse && reusedAfterReady !== undefined) {
      return claudeStatusPayload(reusedAfterReady.connected, version);
    }
    // Prefer the CLI's own `auth status`; fall back to the store read
    // when it's unavailable / unparseable. A definite `loggedIn: false` on
    // a still-present store (bad unwrap / confined spawn) is inconclusive —
    // never overwrite last-known with "not signed in".
    const viaWait = await authStatusLoggedIn(signal);
    if (viaWait.kind === "aborted" || viaWait.kind === "invalidated") {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("probe_failed"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        detail: STATUS_CHECK_FAILED_DETAIL,
      };
    }
    if (viaWait.kind === "timeout") {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("probe_timeout"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        detail: STATUS_CHECK_FAILED_DETAIL,
      };
    }
    const viaAuth = viaWait.result;
    let connected = viaAuth === true;
    let determinate = viaAuth === true;
    if (!connected) {
      // A conclusive positive CLI result is sufficient for the passive watcher.
      // Only consult the secret store as a null/false fallback; refreshability,
      // account identity, and token refresh belong to explicit/inference paths.
      const store = await loadStore(signal, true);
      if (store.kind === "indeterminate") {
        return {
          provider: PROVIDER,
          status: "disconnected",
          ...unknownObservation("store_unreadable"),
          cli_installed: true,
          ...(version !== null ? { cli_version: version } : {}),
          detail: STATUS_CHECK_FAILED_DETAIL,
        };
      }
      if (viaAuth === false && store.kind !== "absent") {
        return {
          provider: PROVIDER,
          status: "disconnected",
          ...unknownObservation("probe_failed"),
          cli_installed: true,
          ...(version !== null ? { cli_version: version } : {}),
          detail: STATUS_CHECK_FAILED_DETAIL,
        };
      }
      const accessToken = storeReadValue(store)?.claudeAiOauth?.accessToken;
      connected = viaAuth === null && nonEmpty(accessToken) !== null;
      determinate = viaAuth === false || store.kind === "absent" || connected;
    }
    if (determinate) {
      rememberIfFingerprintStable(
        claudeStatusCache,
        fingerprint,
        fingerprintStoreIdentity(claudePassiveStoreIdentity()),
        { connected },
        observedGeneration,
      );
    }
    return claudeStatusPayload(connected, version);
  },

  usage: (): Promise<TProviderUsageSnapshot> =>
    withRefreshCaller("usage", async (): Promise<TProviderUsageSnapshot> => {
      const stored = await readStoredToken();
      const cred = await resolveUsageCredential({
        provider: PROVIDER,
        stored:
          stored.kind === "live"
            ? { kind: "live", value: stored.accessToken }
            : stored,
        missingReason: "not signed in to Claude Code",
        accountIdOf: readAccountId,
        priorAccountIdWhenExpired: readAccountId,
        readNative: async () => {
          await readToken();
          const fresh = await readStoredToken();
          return fresh.kind === "live" ? fresh.accessToken : null;
        },
      });
      if (cred.kind === "unavailable") return cred;
      const accessToken = cred.value;
      try {
        const headers = {
          authorization: `Bearer ${accessToken}`,
          "user-agent": await userAgent(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        };
        const resp = await fetch(
          await resolveProviderUrl(PROVIDER, USAGE_PATH),
          {
            method: "GET",
            headers,
          },
        );
        if (!resp.ok) {
          const reason =
            resp.status === 401
              ? "Claude authorization was rejected — re-sign in via the Claude Code CLI."
              : resp.status === 403
                ? "No active Claude Pro/Max subscription on this account."
                : resp.status === 429
                  ? // The usage cache serves the last known good figures (stamped
                    // `stale`) when one exists, so this bare reason only ever
                    // surfaces when there's NOTHING cached to fall back to — don't
                    // promise figures we may not have. See `usage-cache.ts`.
                    "Claude usage is rate-limited right now."
                  : `Claude couldn't report usage (HTTP ${resp.status}).`;
          return { kind: "unavailable", reason };
        }
        const data: unknown = await resp.json();
        // Shared plan meters → `windows` (status + tightest-window +
        // calibration). Model-scoped caps (Fable / Opus / Sonnet) →
        // `extra_pools`, same contract as Codex Spark: display-only, never
        // flip overall status when only a single model family is exhausted.
        const { windows, extra_pools } = reduceClaudeUsage(data);
        const plan = await readClaudePlan(headers);
        return {
          kind: "quota",
          status: reduceQuotaStatus(undefined, windows),
          ...(plan !== null ? { plan, plan_source: "private-client" } : {}),
          windows,
          ...(extra_pools.length > 0 ? { extra_pools } : {}),
          note: "Pro/Max subscription — read locally via Claude Code",
        };
      } catch (err) {
        return {
          kind: "unavailable",
          reason: err instanceof Error ? err.message : "usage fetch failed",
        };
      }
    }),

  listModels: () =>
    withRefreshCaller("models", async () => {
      // Anthropic's `GET /v1/models` accepts the subscription OAuth bearer
      // (same auth shape as the usage read above). Host derived from the
      // CAPTURED inference URL via `resolveProviderUrl` — no hardcoded
      // origin; only the stable leaf path is a constant. Metadata only;
      // bounded + null on any failure via `fetchModelList`.
      const token = await readToken();
      if (token === null) return null;
      return fetchModelList(
        await resolveProviderUrl(PROVIDER, "/v1/models?limit=1000"),
        {
          authorization: `Bearer ${token.accessToken}`,
          "user-agent": await userAgent(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        parseClaudeModelList,
      );
    }),

  discoverModels: async (
    options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    // Cached CLI version only — never probe, never a generic UA fallback.
    // Skip before any keychain/store read when the version is missing.
    const semver = cachedCliSemver(options.cliVersion);
    if (semver === null) return skippedModelDiscovery();
    // Observe-only store: no keychain repair, no native refresh. Missing
    // / expired / unknown lifetime / near-leeway → skipped, not failed.
    const store = await loadStore(undefined, true);
    if (store.kind !== "present") return skippedModelDiscovery();
    const oauth = store.value.claudeAiOauth;
    if (oauth === undefined) return skippedModelDiscovery();
    const accessToken = oauth.accessToken;
    if (accessToken === undefined || accessToken.length === 0) {
      return skippedModelDiscovery();
    }
    const expiresAtMs = toEpochMs(oauth.expiresAt);
    if (!credentialHasFetchLifetime(expiresAtMs, REFRESH_LEEWAY_MS)) {
      return skippedModelDiscovery();
    }
    const ua = `claude-cli/${semver}`;
    return modelDiscoveryFromList(
      await fetchModelList(
        await resolveProviderUrl(PROVIDER, "/v1/models?limit=1000"),
        {
          authorization: `Bearer ${accessToken}`,
          "user-agent": ua,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        parseClaudeModelList,
      ),
    );
  },

  credentialForUpstream: () =>
    withRefreshCaller("upstream", async () => {
      const token = await readToken();
      if (token === null) {
        throw new Error("claude_code: not signed in (no stored credential)");
      }
      // Resolve the request TARGET URL (captured from the genuine `claude`
      // request, or the default) + the isolated CLI's own IDENTITY HEADERS
      // (handrolled/bridge parity — active-sub-method.md): the walker layers
      // them over the originator's headers so the vendor sees the same identity
      // whether the hop ran through the native CLI (bridge) or this manual
      // transport, and the wire builder still layers the OAuth `anthropic-beta`
      // + `anthropic-version` last (isOAuth). Identity comes from the shape-only
      // fixture capture (never `authorization`); an absent fixture serves
      // originator-only, the pre-parity behavior.
      const url = await resolveUpstreamUrl(PROVIDER, {
        captureIfMissing: true,
      });
      const identity = await resolveIdentityHeaders(PROVIDER);
      const acct = await readAccountHash();
      return {
        access_token: token.accessToken,
        headers: identity ?? {},
        url,
        // Which account this hop's cost attributes to (recorded on the row).
        ...(acct !== null ? { account_hash: acct } : {}),
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
      };
    }),

  // Local-only credential for the native dictation WebSocket
  // (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` —
  // verified live, foundation research ac06f4cb). The HOST is derived from
  // the captured `/v1/messages` upstream (same origin, `resolveProviderUrl`)
  // so a vendor host migration is auto-tracked; only the leaf path + fixed
  // query params (the verified recipe) are constants. `headers` carries the
  // same OAuth identity `credentialForUpstream` presents — no `authorization`
  // (the walker/session layers the bearer separately).
  credentialForTranscription: (): Promise<TImageCredential> =>
    withRefreshCaller("upstream", async (): Promise<TImageCredential> => {
      const token = await readToken();
      if (token === null) {
        throw new Error("claude_code: not signed in (no stored credential)");
      }
      const base = await resolveProviderUrl(
        PROVIDER,
        "/api/ws/speech_to_text/voice_stream",
      );
      const url = `${base.replace(/^https:/, "wss:")}?encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=en&use_conversation_engine=true`;
      const acct = await readAccountHash();
      return {
        access_token: token.accessToken,
        headers: {
          "user-agent": await userAgent(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": OAUTH_BETA,
        },
        url,
        ...(acct !== null ? { account_hash: acct } : {}),
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
      };
    }),

  logout: async () => {
    const budget = createDeadlineBudget(logoutTimeoutMs());
    const correlation = currentLoginCommandCorrelation();
    const lifecycle = createNativeAuthLifecycle({
      scope: "logout",
      producer: "claude-logout",
      provider: PROVIDER,
      ...(correlation !== undefined ? { operationId: correlation } : {}),
    });
    // The credential is about to disappear — drop the cached status so no
    // caller can read a stale "connected" for up to the TTL.
    clearAuthStatusCache();
    let capture: TClaudeLogoutCapture = { kind: "skipped" };
    let terminalLedger: TNativeAuthLifecycleTimings | undefined;
    const timedOut = async (): Promise<{
      readonly ok: boolean;
      readonly detail: string;
    }> =>
      classifyClaudeLogout({
        capture: { kind: "timeout" },
        store: await loadStore(budget.signal),
      });
    try {
      // `claude auth logout` clears the isolated login credential. Do not
      // spawn it after the operation deadline, and do not delete the store
      // as a fallback if the CLI times out or fails.
      const readyMark = lifecycle.mark();
      lifecycle.record("readiness_wait", readyMark);
      const installed = await firstOfBudget(
        budget,
        cliInstallState(PROVIDER, { demand: true, signal: budget.signal }),
      );
      if (installed.kind === "expired") {
        lifecycle.record("readiness", readyMark);
        terminalLedger = {
          outcome: "timeout",
          observation: "unknown",
          reason_code: "probe_timeout",
        };
        return await timedOut();
      }
      if (installed.value.installed) {
        const ready = await firstOfBudget(
          budget,
          ensureKeychainReady(cliHome(PROVIDER), budget.signal),
        );
        lifecycle.record("readiness", readyMark);
        if (ready.kind === "expired") {
          terminalLedger = {
            outcome: "timeout",
            observation: "unknown",
            reason_code: "probe_timeout",
          };
          return await timedOut();
        }
        if (ready.value.kind !== "present") {
          terminalLedger = {
            outcome: "failed",
            observation: "unknown",
            reason_code: "store_unreadable",
          };
          return {
            ok: false,
            detail: "could not reach the credential store to sign out",
          };
        }
        if (budget.expired()) {
          terminalLedger = {
            outcome: "timeout",
            observation: "unknown",
            reason_code: "probe_timeout",
          };
          return await timedOut();
        }
        lifecycle.record("start");
        const childMark = lifecycle.mark();
        lifecycle.record("child_wait", childMark);
        capture = await runCaptureResult([bin(), "auth", "logout"], env(), {
          probe: unwrapKeychainSpawn(PROVIDER),
          timeoutMs: budget.remainingMs(),
          signal: budget.signal,
          allowEmpty: true,
          producer: "claude-logout",
          ...(correlation !== undefined ? { operationId: correlation } : {}),
        });
        lifecycle.record("child", childMark);
      } else {
        lifecycle.record("readiness", readyMark);
      }
      if (budget.expired() && capture.kind !== "timeout") {
        capture = { kind: "timeout" };
      }
      // Invalidate AGAIN after the mutation: a probe that raced the pre-logout
      // clear could have completed mid-logout and installed a "connected"
      // result under the new generation. The post-clear leaves the cache empty
      // so the next read re-probes against the now-cleared credential.
      clearAuthStatusCache();
      const verifyMark = lifecycle.mark();
      lifecycle.record("verify_wait", verifyMark);
      const storeWait = await firstOfBudget(budget, loadStore(budget.signal));
      lifecycle.record("verify", verifyMark);
      if (storeWait.kind === "expired" || budget.expired()) {
        capture = { kind: "timeout" };
      }
      const store =
        storeWait.kind === "value"
          ? storeWait.value
          : { kind: "indeterminate" as const, cause: "timeout" };
      const classified = classifyClaudeLogout({ capture, store });
      terminalLedger = {
        outcome:
          capture.kind === "timeout" || capture.kind === "aborted"
            ? "timeout"
            : classified.ok
              ? "succeeded"
              : "failed",
        observation: classified.ok ? "signed_out" : "unknown",
        ...(classified.ok
          ? {}
          : {
              reason_code:
                capture.kind === "timeout" || capture.kind === "aborted"
                  ? "probe_timeout"
                  : "store_unreadable",
            }),
      };
      return classified;
    } finally {
      lifecycle.record("terminal", undefined, terminalLedger);
    }
  },
};
