/**
 * Cursor subscription delegate through the official `cursor-agent` CLI.
 *
 * Login URL stream and token store are live-verified; inference remains ACP-only
 * (`cursor-agent acp`). Auto `discoverModels` reuses native model metadata from
 * an already-authorized inference ACP session (real observation age, store
 * provenance, lifecycle invalidation) and never starts a standalone ACP client.
 * Manual `listModels` may still probe ACP.
 */
import { platform } from "node:os";
import { join } from "node:path";
import type {
  TDaemonProviderConnection,
  TProviderModelEntry,
  TProviderUsageSnapshot,
  TProviderUsageWindow,
} from "@openllmsh/protocol";
import { MODEL_LIST_FETCH_TIMEOUT_MS } from "@openllmsh/protocol";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliConfigDir, cliHome } from "../cli-paths";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import { listCursorModelsViaAcp } from "../native-runtime/cursor-acp";
import {
  clearCursorNativeModels,
  cursorNativeModelFingerprint,
  cursorNativeModelGeneration,
  entriesFromCursorModelRows,
  readCursorNativeModels,
  rememberCursorNativeModels,
} from "../native-runtime/cursor-model-observation";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { accountHashField, nonEmpty } from "./account-id";
import { resolveProviderUrl, resolveUpstreamUrl } from "./auth-config";
import { cliLaunch, loginWiring, nativeRefresher } from "./delegate-shared";
import { jwtExpiryMs, jwtSubject } from "./jwt";
import { makeStreamConnect } from "./login-direct";
import { makeCancelConnect } from "./login-flow";
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
import type {
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
  TProviderDelegate,
} from "./types";
import { resolveUsageCredential } from "./usage-credential";
import { statusForWindows } from "./usage-reduce";
import type { TStoreRead } from "./util";
import {
  connectedObservation,
  disconnectedObservation,
  ensureIsolatedKeychain,
  ensureKeychainReady,
  grantKeychainToolAccess,
  keychainStoreIdentity,
  readIsolatedKeychain,
  readJsonStore,
  runCapture,
  STATUS_CHECK_FAILED_DETAIL,
  storeReadValue,
  stripAnsi,
  unknownObservation,
} from "./util";

const PROVIDER = "cursor" as const;

/** Cursor subjects can be `issuer|account-id`; every consumer uses the account part. */
export const cursorAccountId = (token: string): string | null =>
  nonEmpty(jwtSubject(token)?.split("|").at(-1));

// Usage endpoint LEAF paths — the host comes from `resolveProviderUrl` (the
// auth-config CAPTURE default / captured origin), so the dashboard host lives
// in ONE place (`auth-config.ts`) like every other delegate.
const USAGE_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const PLAN_PATH = "/aiserver.v1.DashboardService/GetPlanInfo";
const REFRESH_LEEWAY_MS = 5 * 60_000;

const { bin, env } = cliLaunch(PROVIDER, { NO_OPEN_BROWSER: "1" });

// ─── Live model rows: one native observation cache (inference + manual) ─────
let cursorModelsInflight: Promise<ReadonlyArray<TProviderModelEntry> | null> | null =
  null;

const cursorModelProvenance = (
  accountHint: string | null,
): {
  readonly fingerprint: string;
  readonly accountHint: string | null;
} | null => {
  const fingerprint = cursorNativeModelFingerprint(cliHome(PROVIDER));
  if (fingerprint === null) return null;
  return { fingerprint, accountHint };
};

const redactUrls = (value: string): string =>
  value.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/** Live-verified: `cursor-agent login` prints a deep-control URL on stdout. */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/(?:www\.)?cursor\.com\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/(?:oauth\/)?authorize\S*/)?.[0] ??
    null
  );
};

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const percentFrom = (
  usage: Readonly<Record<string, unknown>>,
): number | null => {
  const direct = numberOf(usage.totalPercentUsed);
  if (direct !== null) return direct;
  const limit = numberOf(usage.limit);
  if (limit === null || limit <= 0) return null;
  const totalSpend = numberOf(usage.totalSpend);
  const remaining = numberOf(usage.remaining);
  const used = totalSpend ?? (remaining === null ? null : limit - remaining);
  return used === null ? null : (used / limit) * 100;
};

/** Reduce Cursor's dashboard usage and plan payloads into the common snapshot. */
export const parseCursorUsage = (
  usageBody: unknown,
  planBody: unknown,
): TProviderUsageSnapshot => {
  const usageRoot = objectOf(usageBody);
  const planRoot = objectOf(planBody);
  const planUsage = objectOf(usageRoot?.planUsage);
  const spendLimitUsage = objectOf(usageRoot?.spendLimitUsage);
  const planInfo = objectOf(planRoot?.planInfo);
  const planName = stringOf(planInfo?.planName);

  const planPercent = planUsage === null ? null : percentFrom(planUsage);
  const pooledLimit = numberOf(spendLimitUsage?.pooledLimit);
  const pooledUsed = numberOf(spendLimitUsage?.pooledUsed);
  const individualLimit = numberOf(spendLimitUsage?.individualLimit);
  const individualUsed = numberOf(spendLimitUsage?.individualUsed);
  const teamPlan =
    planName?.toLowerCase() === "team" ||
    stringOf(spendLimitUsage?.limitType)?.toLowerCase() === "team" ||
    (pooledLimit ?? 0) > 0;
  const spendPercent = teamPlan
    ? pooledLimit !== null && pooledLimit > 0 && pooledUsed !== null
      ? (pooledUsed / pooledLimit) * 100
      : null
    : individualLimit !== null && individualLimit > 0 && individualUsed !== null
      ? (individualUsed / individualLimit) * 100
      : null;
  const percent = spendPercent ?? planPercent;
  if (percent === null) {
    return {
      kind: "unavailable",
      reason: "Cursor reported no usable billing-cycle quota for this plan.",
      link: "https://cursor.com/dashboard",
    };
  }
  const end = numberOf(usageRoot?.billingCycleEnd);
  const window: TProviderUsageWindow = {
    label: "Billing cycle",
    percent_used: Math.max(0, Math.min(100, percent)),
    reset_at_ms: end,
  };
  return {
    kind: "quota",
    status: statusForWindows([window]),
    ...(planName !== null ? { plan: planName } : {}),
    windows: [window],
    note: "Cursor — read locally via cursor-agent",
  };
};

/**
 * Live-verified: macOS cursor-agent stores tokens as generic-password items
 * (services `cursor-access-token` / `cursor-refresh-token`, account `cursor-user`).
 *
 * Read them ONLY from the ISOLATED login keychain (the one under the CLI's
 * isolated HOME), exactly like claude_code: `readIsolatedKeychain` targets the
 * keychain by explicit path, never the user's real login keychain — so a
 * missing item is a quiet `null` ("not signed in"), never a "keychain not
 * found" error or a macOS GUI prompt, and nothing is created or mutated on a
 * read path beyond ensuring our own isolated keychain file exists.
 */
const readMacKeychainSecret = (
  service: string,
  signal?: AbortSignal,
  observeOnly = false,
): Promise<TStoreRead<string>> =>
  readIsolatedKeychain(
    cliHome(PROVIDER),
    service,
    undefined,
    signal,
    observeOnly,
  );

type TCursorFileStore = {
  readonly access_token?: string;
  readonly accessToken?: string;
  readonly refresh_token?: string;
  readonly refreshToken?: string;
};

/** Live-verified (cursor-agent 2026.07.23): Linux file store is the XDG path
 *  `$XDG_CONFIG_HOME/cursor/auth.json` (= `<home>/.config/cursor/auth.json` with
 *  HOME + XDG_CONFIG_HOME pinned to the isolated home), camelCase tokens.
 *  `cliConfigDir("cursor")` resolves to that dir. */
const readFileTokens = async (): Promise<
  TStoreRead<{
    readonly accessToken: string;
    readonly refreshTokenPresent: boolean;
  }>
> => {
  const store = await readJsonStore<TCursorFileStore>(
    join(cliConfigDir(PROVIDER), "auth.json"),
  );
  if (store.kind !== "present") return store;
  const accessToken = store.value.access_token ?? store.value.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { kind: "absent" };
  }
  const refreshToken = store.value.refresh_token ?? store.value.refreshToken;
  return {
    kind: "present",
    value: {
      accessToken,
      refreshTokenPresent:
        typeof refreshToken === "string" && refreshToken.length > 0,
    },
  };
};

const triggerRefresh = async (): Promise<void> => {
  // Mirror Claude: a locked/unusable isolated keychain must NOT reach
  // `cursor-agent status` (SecurityAgent dialog + 60s spawn). Skip when not
  // ready. Bound the spawn to the status budget so it cannot outlive the race.
  const keychain = await ensureKeychainReady(cliHome(PROVIDER));
  if (!keychainRefreshSpawnAllowed(PROVIDER, keychain)) return;
  clearCursorStatusObservationCache();
  await spawnRefresh([bin(), "status"], env(), {
    probe: unwrapKeychainSpawn(PROVIDER),
    timeoutMs: 10_000,
    ...(platform() === "darwin"
      ? {}
      : {
          readStore: async () => {
            const store = await readJsonStore<TCursorFileStore>(
              join(cliConfigDir(PROVIDER), "auth.json"),
            );
            const value = storeReadValue(store);
            return refreshCredentialSnapshot({
              accessToken: value?.access_token ?? value?.accessToken,
              refreshToken: value?.refresh_token ?? value?.refreshToken,
            });
          },
        }),
  });
  clearCursorStatusObservationCache();
};

// THE single refresher — single-flight + cooldown, no signal-aware bypass. See
// the claude-code delegate for why the bypass was removed (rotation race).
const refresh = nativeRefresher({
  slug: PROVIDER,
  label: "Cursor",
  leewayMs: REFRESH_LEEWAY_MS,
  trigger: triggerRefresh,
});

type TCursorStoredTokens = {
  readonly accessToken: string;
  readonly refreshTokenPresent: boolean;
};

/** Passive status needs presence only; refresh-token reads stay on request paths. */
const readStatusAccessToken = async (
  signal?: AbortSignal,
): Promise<TStoreRead<string>> => {
  if (platform() === "darwin") {
    return readMacKeychainSecret("cursor-access-token", signal, true);
  }
  const stored = await readFileTokens();
  if (stored.kind !== "present") return stored;
  return { kind: "present", value: stored.value.accessToken };
};

type TStatusAccessObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly accountHint: string | undefined };

const cursorStatusCache =
  createPassiveObservationCache<TStatusAccessObservation>();

let statusAccessInFlight: {
  readonly generation: number;
  readonly work: Promise<TStoreRead<string>>;
} | null = null;

/** Drop cached Cursor status presence. Login/logout/native refresh/auth
 *  mutations call this so the next status tick re-reads the store. */
export const clearCursorStatusObservationCache = (): void => {
  cursorStatusCache.invalidate();
  clearCursorNativeModels();
  noteAuthStoreIdentityChange(PROVIDER);
};

const cursorPassiveReuseAllowed = (): {
  readonly fingerprint: string;
  readonly reuse: boolean;
  readonly absentStore: boolean;
} => {
  if (platform() !== "darwin") {
    const identity = fileStoreIdentity(
      join(cliConfigDir(PROVIDER), "auth.json"),
    );
    return {
      fingerprint: fingerprintStoreIdentity(identity),
      reuse: identity.statOk,
      absentStore: identity.statOk && !identity.present,
    };
  }
  const id = keychainStoreIdentity(cliHome(PROVIDER));
  return {
    fingerprint: fingerprintStoreIdentity(id),
    reuse: id.statOk && (id.skipEligible || !id.present),
    absentStore: id.statOk && !id.present,
  };
};

const awaitStatusAccessRead = async (
  work: Promise<TStoreRead<string>>,
  signal?: AbortSignal,
): Promise<TStoreRead<string>> => {
  if (signal === undefined) return work;
  if (signal.aborted) {
    return { kind: "indeterminate", cause: "keychain_read_aborted" };
  }
  let onAbort = (): void => {};
  const aborted = new Promise<TStoreRead<string>>((resolve) => {
    onAbort = () =>
      resolve({ kind: "indeterminate", cause: "keychain_read_aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const observationFromAccessRead = (
  read: TStoreRead<string>,
): TStoreRead<{ readonly accountHint: string | undefined }> => {
  if (read.kind !== "present") return read;
  return {
    kind: "present",
    value: {
      accountHint: cursorAccountId(read.value) ?? undefined,
    },
  };
};

const mappedObservation = (
  observation: TStatusAccessObservation,
): TStoreRead<{ readonly accountHint: string | undefined }> =>
  observation.kind === "present"
    ? {
        kind: "present",
        value: { accountHint: observation.accountHint },
      }
    : { kind: "absent" };

const readCachedStatusAccess = async (
  signal?: AbortSignal,
): Promise<TStoreRead<{ readonly accountHint: string | undefined }>> => {
  const { fingerprint, reuse, absentStore } = cursorPassiveReuseAllowed();
  const startFingerprint = fingerprint;
  const generation = cursorStatusCache.generation();
  if (reuse) {
    const cached = cursorStatusCache.get(fingerprint);
    if (cached !== undefined) return mappedObservation(cached);
    if (absentStore) {
      cursorStatusCache.set(fingerprint, { kind: "absent" }, generation);
      return { kind: "absent" };
    }
  }

  let flight = statusAccessInFlight;
  if (flight === null || flight.generation !== generation) {
    if (signal?.aborted === true) {
      return { kind: "indeterminate", cause: "keychain_read_aborted" };
    }
    // Shared producer is not observer-signal-bound — one aborted status
    // waiter must not cancel another tick's in-flight store read.
    const work = readStatusAccessToken();
    flight = { generation, work };
    statusAccessInFlight = flight;
    const clearFlight = (): void => {
      if (statusAccessInFlight?.work === work) statusAccessInFlight = null;
    };
    void work.then(clearFlight, clearFlight);
  }

  const read = await awaitStatusAccessRead(flight.work, signal);
  if (read.kind === "indeterminate") return read;
  // Logout/refresh bumped generation while this producer was in flight —
  // do not hand a stale determinate presence to the waiter. Last-known
  // overlay treats unknown as probe failure until the next tick re-reads.
  if (generation !== cursorStatusCache.generation()) {
    return {
      kind: "indeterminate",
      cause: "status_observation_invalidated",
    };
  }
  const mapped = observationFromAccessRead(read);
  if (mapped.kind === "indeterminate") return mapped;
  const observation: TStatusAccessObservation =
    mapped.kind === "present"
      ? { kind: "present", accountHint: mapped.value.accountHint }
      : { kind: "absent" };
  rememberIfFingerprintStable(
    cursorStatusCache,
    startFingerprint,
    fingerprintStoreIdentity(
      platform() === "darwin"
        ? keychainStoreIdentity(cliHome(PROVIDER))
        : fileStoreIdentity(join(cliConfigDir(PROVIDER), "auth.json")),
    ),
    observation,
    generation,
  );
  return mapped;
};

const readStoredTokens = async (
  signal?: AbortSignal,
): Promise<TStoreRead<TCursorStoredTokens>> => {
  if (platform() !== "darwin") return readFileTokens();
  const accessToken = await readMacKeychainSecret(
    "cursor-access-token",
    signal,
  );
  if (accessToken.kind !== "present") return accessToken;
  const refreshToken = await readMacKeychainSecret(
    "cursor-refresh-token",
    signal,
  );
  // An indeterminate refresh-token read (locked/denied keychain item) must not
  // be collapsed to "no refresh token" — that would assert absence from an
  // uncertain read and skip refresh. Propagate indeterminate so status maps it
  // to STATUS_CHECK_FAILED_DETAIL and last-known is preserved (C1). Only a
  // definite `absent` sets refreshTokenPresent: false.
  if (refreshToken.kind === "indeterminate") return refreshToken;
  return {
    kind: "present",
    value: {
      accessToken: accessToken.value,
      refreshTokenPresent: refreshToken.kind === "present",
    },
  };
};

type TStoredCursorToken =
  | { readonly kind: "live"; readonly stored: TCursorStoredTokens }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

/** Stored access token only — never native-refreshes. Usage reads this. */
const readStoredToken = async (
  signal?: AbortSignal,
): Promise<TStoredCursorToken> => {
  const stored = storeReadValue(await readStoredTokens(signal));
  if (stored === null) return { kind: "missing" };
  const expiresAtMs = jwtExpiryMs(stored.accessToken);
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    return { kind: "expired" };
  }
  return { kind: "live", stored };
};

const readToken = async (
  signal?: AbortSignal,
  storedRead?: TStoreRead<TCursorStoredTokens>,
): Promise<
  (TCursorStoredTokens & { staleRefresh?: TRefreshErrorClass }) | null
> => {
  const stored = storeReadValue(storedRead ?? (await readStoredTokens(signal)));
  if (stored === null) return null;
  if (!stored.refreshTokenPresent) credentialUnrefreshable(PROVIDER);
  const outcome = stored.refreshTokenPresent
    ? await refresh(jwtExpiryMs(stored.accessToken))
    : "fresh";
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
    return { ...stored, staleRefresh: outcome.reason };
  }
  if (outcome !== "awaited") return stored;
  // CLI remains the sole token-store owner. Re-read after a hard-expiry refresh.
  const resolved = resolveToken({
    provider: PROVIDER,
    prior: stored,
    refreshed: storeReadValue(await readStoredTokens(signal)),
    hasRefreshToken: (token) => token.refreshTokenPresent,
  });
  return resolved.token;
};

const {
  installHint: INSTALL_HINT,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  isInstalled,
  isConnected,
  slot,
} = loginWiring({
  provider: PROVIDER,
  installHint:
    "Cursor Agent not found — re-run the OpenLLM daemon installer to add it.",
  connectedDetail: "signed in via Cursor Agent",
  inProgressDetail:
    "Cursor sign-in already in progress — finish authorizing in your browser; this updates automatically.",
  readToken,
});

const connectDirect = makeStreamConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  connected: isConnected,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  argv: () => [bin(), "login"],
  env,
  waitStoreHint:
    platform() === "darwin"
      ? undefined
      : (signal) =>
          waitFileStoreHint(join(cliConfigDir(PROVIDER), "auth.json"), signal),
  beforeLogin: () => ensureIsolatedKeychain(cliHome(PROVIDER)),
  stream: "stdout",
  parse: (buffer) => {
    const url = parseAuthUrl(buffer);
    return url === null ? null : { url, code: "" };
  },
  // After a successful login lands the tokens, grant command-line tools
  // prompt-free access to the isolated keychain items (claude_code parity) so
  // the daemon's later `security` reads never pop a GUI prompt.
  // A refused grant FAILS the login (retryable) rather than reporting success
  // the daemon can't act on — a later `security` read would pop a GUI prompt.
  onConnected: (): Promise<boolean> => {
    clearCursorStatusObservationCache();
    return grantKeychainToolAccess(cliHome(PROVIDER));
  },
  onStart: () => {
    logInfo("cursor-connect", "spawning `cursor-agent login`");
  },
  onParsed: (url) =>
    logInfo("cursor-connect", "parsed authorize URL; surfacing to dashboard", {
      urlLen: url.length,
    }),
  onParseFail: (captured) =>
    logError(
      "cursor-connect",
      safeDiagnosticMessage`no authorize URL parsed from cursor-agent login`,
      {
        stderrLen: captured.length,
        stderrSample: redactUrls(captured.slice(0, 400)),
      },
    ),
  pendingDetail: (url) =>
    `Authorize Cursor in the browser window that opened — or open ${url}. This page updates automatically once you're done.`,
  failDetail:
    "Couldn't start Cursor sign-in. Retry, or run `cursor-agent login` on the box.",
});

const cancelConnect = makeCancelConnect(PROVIDER, slot, {
  cancelled: "Cursor sign-in cancelled",
  none: "no sign-in was in progress",
});

const dashboardHeaders = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  "content-type": "application/json",
  "connect-protocol-version": "1",
});

export const cursorDelegate: TProviderDelegate = {
  slug: PROVIDER,
  statusCancellable: true,
  invalidateStatusObservation: clearCursorStatusObservationCache,
  connect: connectDirect,
  cancelConnect,

  status: async (signal?: AbortSignal): Promise<TDaemonProviderConnection> => {
    const { installed, version } = await cliInstallState(PROVIDER);
    const accessRead = installed
      ? await readCachedStatusAccess(signal)
      : undefined;
    if (accessRead?.kind === "indeterminate") {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("store_unreadable"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        detail: STATUS_CHECK_FAILED_DETAIL,
      };
    }
    const accountHint =
      accessRead?.kind === "present" ? accessRead.value.accountHint : null;
    const connected = accessRead?.kind === "present";
    if (connected) clearPendingAuth(PROVIDER);
    const pending = connected ? null : getPendingAuth(PROVIDER);
    return {
      provider: PROVIDER,
      status: connected ? "connected" : "disconnected",
      ...(connected
        ? connectedObservation()
        : pending !== null
          ? {}
          : installed
            ? disconnectedObservation()
            : unknownObservation("cli_unavailable")),
      cli_installed: installed,
      ...(version !== null ? { cli_version: version } : {}),
      ...(pending !== null
        ? {
            pending_auth: {
              url: pending.url,
              code: pending.code,
              started_at_ms: pending.startedAt,
              ...(pending.flowId !== undefined
                ? { flow_id: pending.flowId }
                : {}),
            },
          }
        : {}),
      ...(!connected
        ? {
            detail:
              pending !== null
                ? pendingAuthDetail(pending)
                : installed
                  ? "cursor-agent installed but not signed in"
                  : "cursor-agent not installed",
          }
        : {
            last_login_at_ms: null,
            ...accountHashField(PROVIDER, accountHint ?? undefined),
          }),
    };
  },

  usage: (): Promise<TProviderUsageSnapshot> =>
    withRefreshCaller("usage", async (): Promise<TProviderUsageSnapshot> => {
      const storedToken = await readStoredToken();
      const cred = await resolveUsageCredential({
        provider: PROVIDER,
        stored:
          storedToken.kind === "live"
            ? { kind: "live", value: storedToken.stored }
            : storedToken,
        missingReason: "not signed in to Cursor",
        accountIdOf: (value) => cursorAccountId(value.accessToken),
        priorAccountIdWhenExpired: async () =>
          cursorAccountId(
            storeReadValue(await readStoredTokens())?.accessToken ?? "",
          ),
        readNative: async () => {
          await readToken();
          const fresh = await readStoredToken();
          return fresh.kind === "live" ? fresh.stored : null;
        },
      });
      if (cred.kind === "unavailable") return cred;
      const stored = cred.value;
      try {
        const [usage, plan] = await Promise.all([
          fetch(await resolveProviderUrl(PROVIDER, USAGE_PATH), {
            method: "POST",
            headers: dashboardHeaders(stored.accessToken),
            body: "{}",
            signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
          }),
          fetch(await resolveProviderUrl(PROVIDER, PLAN_PATH), {
            method: "POST",
            headers: dashboardHeaders(stored.accessToken),
            body: "{}",
            signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
          }),
        ]);
        if (!usage.ok || !plan.ok) {
          const failed = !usage.ok ? usage : plan;
          if (failed.status === 401) clearCursorStatusObservationCache();
          return {
            kind: "unavailable",
            reason:
              failed.status === 401
                ? "Cursor authorization was rejected — re-sign in via `cursor-agent login`."
                : failed.status === 403
                  ? "No active Cursor subscription on this account."
                  : `Cursor couldn't report usage (HTTP ${failed.status}).`,
            link: "https://cursor.com/dashboard",
          };
        }
        return parseCursorUsage(await usage.json(), await plan.json());
      } catch (error) {
        return {
          kind: "unavailable",
          reason:
            error instanceof Error
              ? error.message
              : "Cursor usage fetch failed",
          link: "https://cursor.com/dashboard",
        };
      }
    }),

  // Automatic discovery reads native observations captured during a real
  // inference ACP session (or a prior manual probe). Never constructs ACP,
  // never refreshes tokens, never probes CLI version.
  discoverModels: async (
    _options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    const accessRead = await readStatusAccessToken();
    if (accessRead.kind !== "present") return { kind: "skipped" };
    const expiryMs = jwtExpiryMs(accessRead.value);
    if (expiryMs === null || expiryMs <= Date.now()) {
      return { kind: "skipped" };
    }
    const accountHint = cursorAccountId(accessRead.value);
    const provenance = cursorModelProvenance(accountHint);
    if (provenance === null) return { kind: "skipped" };
    const cached = readCursorNativeModels(provenance);
    if (cached === null) return { kind: "skipped" };
    return { kind: "success", models: cached };
  },

  // Manual list still may spawn a short-lived ACP session. The same native
  // observation cache stores the result (and inference-captured rows).
  listModels: (): Promise<ReadonlyArray<TProviderModelEntry> | null> =>
    withRefreshCaller(
      "models",
      async (): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
        const token = await readToken();
        const expiryMs = token === null ? null : jwtExpiryMs(token.accessToken);
        const accountHint =
          token === null ? null : cursorAccountId(token.accessToken);
        const provenance = cursorModelProvenance(accountHint);
        if (provenance !== null) {
          const cached = readCursorNativeModels(provenance);
          if (cached !== null) return cached;
        }
        if (expiryMs === null || expiryMs <= Date.now()) return null;
        if (cursorModelsInflight === null) {
          const observedGeneration = cursorNativeModelGeneration();
          cursorModelsInflight =
            (async (): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
              const rows = await listCursorModelsViaAcp({
                bin: bin(),
                env: env(),
              });
              if (rows === null) return null;
              const live = cursorModelProvenance(accountHint);
              if (live !== null) {
                rememberCursorNativeModels(
                  live,
                  rows,
                  Date.now(),
                  observedGeneration,
                );
                const cached = readCursorNativeModels(live);
                if (cached !== null) return cached;
              }
              return entriesFromCursorModelRows(rows);
            })().finally(() => {
              cursorModelsInflight = null;
            });
        }
        return cursorModelsInflight;
      },
    ),

  credentialForUpstream: () =>
    withRefreshCaller("upstream", async () => {
      const token = await readToken();
      if (token === null)
        throw new Error("cursor: not signed in (no stored credential)");
      // Cursor has no manual HTTP inference path — the ACP bridge
      // (native-runtime/cursor-acp.ts) serves inference and never calls this.
      // Resolve the auth-config default target for diagnostics/contract parity,
      // then reject before any request can be issued to the dashboard endpoint.
      const url = await resolveUpstreamUrl(PROVIDER);
      if (token.staleRefresh !== undefined) {
        return {
          access_token: token.accessToken,
          headers: {},
          url,
          stale_refresh: token.staleRefresh,
        };
      }
      throw new Error(
        `cursor is served by the ACP bridge (cursor-agent acp); there is no manual upstream transport (configured target: ${new URL(url).origin})`,
      );
    }),

  logout: async () => {
    clearCursorStatusObservationCache();
    if ((await cliInstallState(PROVIDER, { demand: true })).installed) {
      await runCapture([bin(), "logout"], env(), {
        probe: unwrapKeychainSpawn(PROVIDER),
      });
    }
    // CLI owns its Keychain/file credentials; never delete them directly.
    const cleared = (await readToken()) === null;
    clearCursorStatusObservationCache();
    return cleared
      ? { ok: true, detail: "signed out of Cursor" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
