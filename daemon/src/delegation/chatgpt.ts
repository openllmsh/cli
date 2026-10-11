/**
 * ChatGPT (Codex) delegate.
 *
 * Native delegation: use the installed Codex CLI's OWN bearer, under OUR OWN
 * client identity (`user-agent: openllm/<ver>`, `originator: openllm`) — we do
 * NOT synthesize the Codex CLI's `codex_cli_rs` identity. A genuine `codex`
 * request proxied through the daemon keeps its OWN identity byte-for-byte; only
 * a NON-codex caller gets our openllm identity. Codex rides the private
 * `backend-api/codex` API (proposal §5).
 *
 * ISOLATED install: the daemon runs its OWN `codex` under
 * `~/.openllm/cli/chatgpt/` with `CODEX_HOME` pointed inside it (see
 * cli-paths.ts), so it never touches the user's `~/.codex`.
 *   - Store: `<CODEX_HOME>/auth.json`, shape { tokens: { id_token (JWT),
 *     access_token, refresh_token, account_id? }, auth_mode? }.
 *   - Login: `codex login` (browser) — writes auth.json with
 *     auth_mode:"chatgpt".
 *   - Upstream identity: originator `codex_cli_rs`, User-Agent
 *     `codex_cli_rs/<ver> (<os>; <arch>) <terminal>`, plus
 *     `ChatGPT-Account-Id: <account_id>`. On inference, a genuine codex
 *     caller's identity flows through verbatim; a non-codex caller is served
 *     under our own `openllm/<ver>` identity (a 2026-07-14 live probe found
 *     luna 200s with a generic originator, so the old codex-identity gate is
 *     lifted/moved).
 *   - Usage: GET https://chatgpt.com/backend-api/wham/usage.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@openllmsh/protocol";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliConfigDir } from "../cli-paths";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { DAEMON_VERSION } from "../version";
import { accountHash, nonEmpty } from "./account-id";
import { resolveProviderUrl, resolveUpstreamUrl } from "./auth-config";
import { cliLaunch, loginWiring, nativeRefresher } from "./delegate-shared";
import {
  cachedCliSemver,
  credentialHasFetchLifetime,
  fetchModelList,
  modelDiscoveryFromList,
  parseChatgptModelList,
  skippedModelDiscovery,
} from "./fetch-model-list";
import { jwtExpiryMs } from "./jwt";
import { makeStreamDeviceConnect } from "./login-device";
import { makeStreamConnect } from "./login-direct";
import { waitFileStoreHint } from "./observation-cache";
import type { TRefreshErrorClass } from "./refresh";
import {
  credentialUnrefreshable,
  isStaleRefresh,
  lastRefreshErrorClass,
  refreshCredentialSnapshot,
  resolveToken,
  spawnRefresh,
  withRefreshCaller,
} from "./refresh";
import type {
  TImageCredential,
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
  TProviderDelegate,
} from "./types";
import { resolveUsageCredential } from "./usage-credential";
import {
  reduceChatgptCredits,
  reduceChatgptPools,
  reduceChatgptWindows,
  reduceQuotaStatus,
} from "./usage-reduce";
import type { TStoreRead } from "./util";
import {
  connectedObservation,
  disconnectedObservation,
  readJsonStore,
  runCapture,
  STATUS_CHECK_FAILED_DETAIL,
  storeReadValue,
  stripAnsi,
  unknownObservation,
} from "./util";

const PROVIDER = "chatgpt" as const;
// Usage endpoint LEAF path — the host is derived from the captured inference
// endpoint (`resolveProviderUrl`), so a vendor host migration is auto-tracked.
const USAGE_PATH = "/backend-api/wham/usage";

// The daemon does NOT refresh the token itself. When the access-token JWT `exp`
// is within this window, `readToken` TRIGGERS the codex CLI's OWN native refresh
// (`codex doctor`, whose websocket reachability check forces the proactive
// refresh — no inference) and the CLI persists the rotated token to `auth.json`.
// Matches codex's own 5-min `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`, so the
// daemon's window aligns with when codex will actually refresh. No token endpoint
// or client id lives here. See `triggerRefresh`.
const REFRESH_LEEWAY_MS = 5 * 60_000;

const { bin, env } = cliLaunch(PROVIDER);

/**
 * Strip query strings from any URL in a diagnostic string, so OAuth authorize
 * params (client_id / code_challenge / state) are never persisted to the local
 * log. Keeps the scheme+host+path for debugging.
 */
const redactUrls = (s: string): string =>
  s.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/**
 * Parse the verification URL + one-time code from `codex login --device-auth`
 * stdout. ⚠️ RESEARCH: format inferred from ref/codex
 * `login/src/device_code_auth.rs` (an ANSI-wrapped prompt — a `…/codex/device`
 * URL line, then a "one-time code" line). Matched leniently; confirm live.
 */
const parseDevicePrompt = (
  raw: string,
): { url: string; code: string } | null => {
  const clean = stripAnsi(raw);
  const url =
    clean.match(/https?:\/\/\S+\/codex\/device\b/)?.[0] ??
    clean.match(/https?:\/\/\S+/)?.[0];
  const code = clean.match(
    /one-time code[^\n]*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  )?.[1];
  return url !== undefined && code !== undefined ? { url, code } : null;
};

/**
 * Parse the browser authorize URL `codex login` prints to STDERR ("…navigate to
 * this URL to authenticate: https://auth.openai.com/oauth/authorize?…").
 * Confirmed against codex 0.136.0. Matched leniently (any `/oauth/authorize`
 * URL) so an issuer tweak doesn't break it.
 */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/auth\.openai\.com\/oauth\/authorize\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/oauth\/authorize\S+/)?.[0] ??
    null
  );
};

type TCodexTokens = {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly account_id?: string;
};
type TCodexStore = {
  readonly tokens?: TCodexTokens;
  readonly auth_mode?: string;
};

const authPath = (): string => join(cliConfigDir(PROVIDER), "auth.json");

const waitAuthStoreHint = (signal: AbortSignal): Promise<void> =>
  waitFileStoreHint(authPath(), signal);

const loadStore = (): Promise<TStoreRead<TCodexStore>> =>
  // Isolated CODEX_HOME → auth.json lives there.
  readJsonStore<TCodexStore>(authPath());

/**
 * Trigger the codex CLI's OWN native token refresh: `codex doctor`. Its websocket
 * reachability check routes through the auth manager, which proactively refreshes
 * the ChatGPT access token when it's within codex's 5-min window and persists the
 * rotated token to `auth.json` — NO inference, and the daemon never touches the
 * token. Output ignored; bounded.
 */
const triggerRefresh = async (): Promise<void> => {
  await spawnRefresh([bin(), "doctor"], env(), {
    readStore: async () => {
      const tokens = storeReadValue(await loadStore())?.tokens;
      return refreshCredentialSnapshot({
        accessToken: tokens?.access_token,
        refreshToken: tokens?.refresh_token,
        accountId: tokens?.account_id ?? null,
      });
    },
  });
};

// Within the leeway window → fire the CLI refresh in the background (still
// valid, no stall); hard-expired → await it. Single-flight per provider.
const refresh = nativeRefresher({
  slug: PROVIDER,
  label: "ChatGPT",
  leewayMs: REFRESH_LEEWAY_MS,
  trigger: triggerRefresh,
});

/** Preserve the account identity when Codex rotates only the access token. */
export const resolveChatgptAccountId = (
  resolved: Pick<TCodexTokens, "account_id">,
  prior: Pick<TCodexTokens, "account_id">,
): string | null => resolved.account_id ?? prior.account_id ?? null;

type TStoredChatgptToken =
  | {
      readonly kind: "live";
      readonly accessToken: string;
      readonly accountId: string | null;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

/** Stored access token only — never native-refreshes. Usage reads this. */
const readStoredToken = async (): Promise<TStoredChatgptToken> => {
  const tokens = storeReadValue(await loadStore())?.tokens;
  if (tokens?.access_token === undefined || tokens.access_token.length === 0) {
    return { kind: "missing" };
  }
  const expiresAtMs = jwtExpiryMs(tokens.access_token);
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    return { kind: "expired" };
  }
  return {
    kind: "live",
    accessToken: tokens.access_token,
    accountId: tokens.account_id ?? null,
  };
};

const readToken = async (): Promise<{
  accessToken: string;
  accountId: string | null;
  staleRefresh?: TRefreshErrorClass;
} | null> => {
  const tokens = storeReadValue(await loadStore())?.tokens;
  if (tokens?.access_token === undefined || tokens.access_token.length === 0) {
    return null;
  }
  const expiresAtMs = jwtExpiryMs(tokens.access_token);
  // Only trigger when the credential CAN be refreshed — an empty/missing refresh
  // token can't (and the CLI can't either), so don't waste a spawn.
  if (!tokens.refresh_token) credentialUnrefreshable(PROVIDER);
  const outcome = tokens.refresh_token ? await refresh(expiresAtMs) : "fresh";
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
      accessToken: tokens.access_token,
      accountId: tokens.account_id ?? null,
      staleRefresh: outcome.reason,
    };
  }
  if (outcome !== "awaited") {
    return {
      accessToken: tokens.access_token,
      accountId: tokens.account_id ?? null,
    };
  }
  // Hard-expired path: the CLI refresh was awaited — re-read the (now-rotated)
  // store. Falls back to the stale token if it failed (the upstream then 401s
  // and the UI says re-sign-in).
  const fresh = storeReadValue(await loadStore())?.tokens;
  const resolved = resolveToken({
    provider: PROVIDER,
    prior: tokens,
    refreshed:
      fresh?.access_token !== undefined && fresh.access_token.length > 0
        ? fresh
        : null,
    hasRefreshToken: (token) => Boolean(token.refresh_token),
  });
  return {
    accessToken: resolved.token.access_token ?? tokens.access_token,
    accountId: resolveChatgptAccountId(resolved.token, tokens),
  };
};

// We identify as OURSELVES, not the Codex CLI (mirroring the grok delegate).
// A NON-codex caller's request is served under `openllm/<ver>` + `originator:
// openllm`; a genuine codex request keeps its own identity (see the backfill
// guards below). Verified posture: a 2026-07-14 live probe found luna 200s with
// a generic originator, so self-identifying no longer trips the old gate.
const OPENLLM_USER_AGENT = `openllm/${DAEMON_VERSION}`;
const OPENLLM_ORIGINATOR = "openllm";

/** The originator string the Codex CLI stamps on its own requests. */
const CODEX_ORIGINATOR = "codex_cli_rs";
/** A Codex user-agent is `codex_cli_rs/<ver> …` — the product token is the gate;
 *  a codex originator paired with a generic UA is still rejected upstream. */
const CODEX_UA_PREFIX = /^codex_cli_rs\//;

/** The originator already identifies itself as codex (a real `codex` request
 *  proxied through the daemon) — nothing to backfill. */
const hasCodexOriginator = (inbound?: Headers): boolean =>
  inbound?.get("originator") === CODEX_ORIGINATOR;

const hasCodexUserAgent = (inbound?: Headers): boolean =>
  CODEX_UA_PREFIX.test(inbound?.get("user-agent") ?? "");

// ─── Login wiring ────────────────────────────────────────────────────────
//
// codex's browser `connect` and device-code `connectDeviceCode` share ONE
// `loginSlot` so only one `codex login` runs at a time (each binds a localhost
// callback / polls), and `cancelConnect` kills whichever is live.

const {
  installHint: INSTALL_HINT,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  isInstalled,
  isConnected,
  refreshConfig,
  slot,
} = loginWiring({
  provider: PROVIDER,
  installHint:
    "Codex CLI not found — re-run the OpenLLM daemon installer to add it.",
  connectedDetail: "signed in via Codex",
  inProgressDetail:
    "Codex sign-in already in progress — finish authorizing in your browser; this updates automatically.",
  readToken,
});

/** Explain a transient near-expiry refresh failure without treating its token as a logout. */
export const chatgptRefreshDetail = (accessToken: string): string | null => {
  const expiresAtMs = jwtExpiryMs(accessToken);
  if (expiresAtMs === null || expiresAtMs - Date.now() > REFRESH_LEEWAY_MS) {
    return null;
  }
  const errorClass = lastRefreshErrorClass(PROVIDER);
  if (errorClass === "network" || errorClass === "timeout") {
    return `signed in; token refresh failing (${errorClass}) — retrying`;
  }
  return null;
};

// Browser flow: `codex login` prints the authorize URL to STDERR. Its OWN
// browser-open reaches the user, so we do NOT open a second tab — only surface
// the URL (so a remote/headless box can click it from the dashboard).
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
  waitStoreHint: waitAuthStoreHint,
  parse: (buf) => {
    const url = parseAuthUrl(buf);
    return url !== null ? { url, code: "" } : null;
  },
  onConnected: refreshConfig,
  onStart: () =>
    logInfo("chatgpt-connect", "spawning `codex login` (browser flow)"),
  onParsed: (url) =>
    logInfo("chatgpt-connect", "parsed authorize URL; surfacing to dashboard", {
      urlLen: url.length,
    }),
  onParseFail: (captured) =>
    logError(
      "chatgpt-connect",
      safeDiagnosticMessage`no authorize URL parsed from codex login`,
      {
        stderrLen: captured.length,
        // Redact URL query strings so OAuth params can't land in the local log,
        // while keeping the sample useful for diagnosing a parse miss.
        stderrSample: redactUrls(captured.slice(0, 400)),
      },
    ),
  pendingDetail: (url) =>
    `Authorize Codex in the browser window that opened — or open ${url}. This page updates automatically once you're done.`,
  failDetail:
    "Couldn't start Codex sign-in. Retry, or run `codex login` on the box.",
  crashDetail: (captured, exitCode) => {
    const err = redactUrls(captured.slice(0, 400)).trim();
    const code = exitCode === null ? "" : ` (exit ${exitCode})`;
    return err.length > 0
      ? `\`codex login\` exited before starting sign-in${code} — retrying won't help until it's fixed. It reported:\n${err}\nRun \`codex login\` on the box for the full output.`
      : `\`codex login\` exited without starting sign-in${code} — retrying won't help. Run \`codex login\` on the box to see why.`;
  },
});

// Device-code flow: `codex login --device-auth` prints the verification URL +
// one-time code to STDOUT; we surface them + open the URL locally.
const deviceLogin = makeStreamDeviceConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  connected: isConnected,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  argv: () => [bin(), "login", "--device-auth"],
  env,
  waitStoreHint: waitAuthStoreHint,
  parse: parseDevicePrompt,
  onConnected: refreshConfig,
  pendingDetail: (found) => pendingAuthDetail(found),
  failDetail:
    "Couldn't start Codex device sign-in. Retry, or run `codex login --device-auth` on the box.",
  crashDetail: (captured, exitCode) => {
    const err = redactUrls(captured.slice(0, 400)).trim();
    const code = exitCode === null ? "" : ` (exit ${exitCode})`;
    return err.length > 0
      ? `\`codex login --device-auth\` exited before starting sign-in${code} — retrying won't help until it's fixed. It reported:\n${err}\nRun \`codex login --device-auth\` on the box for the full output.`
      : `\`codex login --device-auth\` exited without starting sign-in${code} — retrying won't help. Run \`codex login --device-auth\` on the box to see why.`;
  },
  cancelMessages: {
    cancelled: "Codex sign-in cancelled",
    none: "no sign-in was in progress",
  },
});

export const chatgptDelegate: TProviderDelegate = {
  slug: PROVIDER,
  statusCancellable: false,

  connect: connectDirect,
  connectDeviceCode: deviceLogin.connectDeviceCode,
  cancelConnect: deviceLogin.cancelConnect,

  // Passive observation from ONE typed `auth.json` snapshot. Do not call
  // `readToken()` here — that native-refreshes via `codex doctor`.
  status: async () => {
    const { installed, version } = await cliInstallState(PROVIDER);
    const store = installed ? await loadStore() : null;
    if (store?.kind === "indeterminate") {
      return {
        provider: PROVIDER,
        status: "disconnected",
        ...unknownObservation("store_unreadable"),
        cli_installed: true,
        ...(version !== null ? { cli_version: version } : {}),
        detail: STATUS_CHECK_FAILED_DETAIL,
      };
    }
    const tokens = store?.kind === "present" ? store.value.tokens : undefined;
    const accessToken =
      tokens?.access_token !== undefined && tokens.access_token.length > 0
        ? tokens.access_token
        : null;
    const accountId = tokens?.account_id ?? null;
    if (accessToken !== null) clearPendingAuth(PROVIDER);
    const connectedDetail =
      accessToken !== null ? chatgptRefreshDetail(accessToken) : null;
    const pending = accessToken === null ? getPendingAuth(PROVIDER) : null;
    return {
      provider: PROVIDER,
      status: accessToken !== null ? "connected" : "disconnected",
      ...(accessToken !== null
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
      ...(accessToken === null
        ? {
            detail:
              pending !== null
                ? pendingAuthDetail(pending)
                : installed
                  ? "codex CLI installed but not signed in"
                  : "codex CLI not installed",
          }
        : {
            last_login_at_ms: null,
            ...(connectedDetail !== null ? { detail: connectedDetail } : {}),
            // Stable ChatGPT account identity, hashed (`account-id.ts`) —
            // `tokens.account_id` in auth.json (the same uuid as the
            // id_token's `chatgpt_account_id` claim; survives refresh).
            ...(accountId !== null
              ? { account_hash: accountHash(PROVIDER, accountId) }
              : {}),
          }),
    };
  },

  usage: (): Promise<TProviderUsageSnapshot> =>
    withRefreshCaller("usage", async (): Promise<TProviderUsageSnapshot> => {
      const stored = await readStoredToken();
      const cred = await resolveUsageCredential({
        provider: PROVIDER,
        stored:
          stored.kind === "live" ? { kind: "live", value: stored } : stored,
        missingReason: "not signed in to Codex",
        accountIdOf: (value) => nonEmpty(value.accountId),
        priorAccountIdWhenExpired: async () =>
          nonEmpty(
            storeReadValue(await loadStore())?.tokens?.account_id ?? null,
          ),
        readNative: async () => {
          await readToken();
          const fresh = await readStoredToken();
          return fresh.kind === "live" ? fresh : null;
        },
      });
      if (cred.kind === "unavailable") return cred;
      const { accessToken, accountId } = cred.value;
      try {
        const resp = await fetch(
          await resolveProviderUrl(PROVIDER, USAGE_PATH),
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${accessToken}`,
              ...(accountId !== null
                ? { "chatgpt-account-id": accountId }
                : {}),
              "user-agent": OPENLLM_USER_AGENT,
              originator: OPENLLM_ORIGINATOR,
              accept: "application/json",
            },
          },
        );
        if (!resp.ok) {
          const reason =
            resp.status === 401
              ? "ChatGPT authorization was rejected — re-sign in via the Codex CLI."
              : resp.status === 403
                ? "No active ChatGPT subscription on this account."
                : `ChatGPT couldn't report usage (HTTP ${resp.status}).`;
          return { kind: "unavailable", reason };
        }
        // Reduced by the pure, payload-shape-agnostic reducers — OpenAI has
        // already reshaped `rate_limit` once (5h primary + weekly secondary
        // → a single weekly primary with `limit_window_seconds`), and the
        // generic reduction absorbs the next reshape without a code change.
        // Per-feature pools + credits ride along display-only.
        const data = (await resp.json()) as {
          plan_type?: string;
          rate_limit?: unknown;
          additional_rate_limits?: unknown;
        };
        const windows = reduceChatgptWindows(data.rate_limit);
        const extraPools = reduceChatgptPools(data.additional_rate_limits);
        const credits = reduceChatgptCredits(data);
        return {
          kind: "quota",
          status: reduceQuotaStatus(data.rate_limit, windows),
          ...(typeof data.plan_type === "string"
            ? { plan: data.plan_type }
            : {}),
          windows,
          ...(extraPools.length > 0 ? { extra_pools: extraPools } : {}),
          ...(credits !== undefined ? { credits } : {}),
          note: "ChatGPT Codex — read locally via Codex CLI",
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
      // Codex's own models endpoint (`GET <base>/models?client_version=…` —
      // `ref/codex/codex-rs/codex-api/src/endpoint/models.rs`), returning
      // `{ models: [{ slug, display_name, visibility, context_window }] }`.
      // Host derived from the CAPTURED inference URL via
      // `resolveProviderUrl`; only the stable leaf path is a constant. The
      // `client_version` query mirrors the CLI's own call (the installed
      // codex version). Picker-visible models only (`visibility: "list"`)
      // — same filter the CLI's model picker applies. Metadata only; null
      // on any failure (never an empty list).
      const token = await readToken();
      if (token === null) return null;
      // The backend wants a BARE semver (the CLI's own cache stores `"0.142.0"`).
      // Read it from `cliInstallState` — the SAME source `status()` reports and
      // `model-report` tags the list with — so the `client_version` we query with
      // and the `cli_version` stamped on the resulting report can never disagree
      // (which would let the cloud's older-semver guard drop a freshly-fetched
      // list). `cliInstallState` already extracts the bare x.y.z; `0.0.0` fallback
      // keeps the query well-formed when the version can't be read.
      const ver =
        (await cliInstallState(PROVIDER, { demand: true })).version ?? "0.0.0";
      return fetchModelList(
        await resolveProviderUrl(
          PROVIDER,
          `/backend-api/codex/models?client_version=${encodeURIComponent(ver)}`,
        ),
        {
          authorization: `Bearer ${token.accessToken}`,
          ...(token.accountId !== null
            ? { "chatgpt-account-id": token.accountId }
            : {}),
          accept: "application/json",
        },
        parseChatgptModelList,
      );
    }),

  discoverModels: async (
    options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    const ver = cachedCliSemver(options.cliVersion);
    if (ver === null) return skippedModelDiscovery();
    const store = await loadStore();
    if (store.kind !== "present") return skippedModelDiscovery();
    const tokens = store.value.tokens;
    if (tokens === undefined) return skippedModelDiscovery();
    const accessToken = tokens.access_token;
    if (accessToken === undefined || accessToken.length === 0) {
      return skippedModelDiscovery();
    }
    if (
      !credentialHasFetchLifetime(jwtExpiryMs(accessToken), REFRESH_LEEWAY_MS)
    ) {
      return skippedModelDiscovery();
    }
    return modelDiscoveryFromList(
      await fetchModelList(
        await resolveProviderUrl(
          PROVIDER,
          `/backend-api/codex/models?client_version=${encodeURIComponent(ver)}`,
        ),
        {
          authorization: `Bearer ${accessToken}`,
          ...(tokens.account_id !== undefined && tokens.account_id.length > 0
            ? { "chatgpt-account-id": tokens.account_id }
            : {}),
          accept: "application/json",
        },
        parseChatgptModelList,
      ),
    );
  },

  credentialForUpstream: (inbound?: Headers) =>
    withRefreshCaller("upstream", async () => {
      const token = await readToken();
      if (token === null) {
        throw new Error("chatgpt: not signed in (no stored credential)");
      }
      // Resolve only the request TARGET URL (captured from the genuine `codex`
      // request, or the default). `chatgpt-account-id` is the credential-intrinsic
      // header — the user's OWN account, read from the store, which routes the
      // request to their subscription.
      const url = await resolveUpstreamUrl(PROVIDER);
      const headers: Record<string, string> =
        token.accountId !== null
          ? { "chatgpt-account-id": token.accountId }
          : {};

      // Client identity. A genuine `codex` request (the real CLI proxied through
      // the daemon) already presents `originator: codex_cli_rs` + a
      // `codex_cli_rs/<ver>` user-agent — we leave those untouched so it reaches
      // the vendor byte-for-byte. A NON-codex caller is served under OUR OWN
      // identity (`openllm/<ver>`, `originator: openllm`); we do NOT fabricate the
      // codex identity. The old model gate (`gpt-5.6-luna` 404'd without codex
      // identity) was found lifted by a 2026-07-14 live probe (luna 200s with a
      // generic originator), so self-identifying no longer trips it.
      if (!hasCodexOriginator(inbound)) headers.originator = OPENLLM_ORIGINATOR;
      if (!hasCodexUserAgent(inbound))
        headers["user-agent"] = OPENLLM_USER_AGENT;

      return {
        access_token: token.accessToken,
        headers,
        url,
        // Which account this hop's cost attributes to (recorded on the row).
        ...(token.accountId !== null
          ? { account_hash: accountHash(PROVIDER, token.accountId) }
          : {}),
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
      };
    }),

  credentialForImage: (inbound?: Headers): Promise<TImageCredential> =>
    withRefreshCaller("upstream", async (): Promise<TImageCredential> => {
      const token = await readToken();
      if (token === null) {
        throw new Error("chatgpt: not signed in (no stored credential)");
      }
      // Image endpoint is a sibling of the captured `/responses` endpoint,
      // so `resolveProviderUrl` keeps host drift from CLI version changes while
      // enforcing same-host origin.
      const url = await resolveProviderUrl(
        PROVIDER,
        "/backend-api/codex/images/generations",
      );
      const headers: Record<string, string> =
        token.accountId !== null
          ? { "chatgpt-account-id": token.accountId }
          : {};

      // Codex-CLI identity BACKFILL. Keep parity with
      // `credentialForUpstream`.
      if (!hasCodexOriginator(inbound)) headers.originator = OPENLLM_ORIGINATOR;
      if (!hasCodexUserAgent(inbound))
        headers["user-agent"] = OPENLLM_USER_AGENT;

      return {
        access_token: token.accessToken,
        headers,
        url,
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
        ...(token.accountId !== null
          ? { account_hash: accountHash(PROVIDER, token.accountId) }
          : {}),
      };
    }),

  // Local-only credential for `/backend-api/codex/images/edits` — a sibling
  // of the generation endpoint (same host, same identity backfill), but a
  // DISTINCT path so a walker never conflates edit and generation targets.
  // Verified live (foundation research, ac06f4cb).
  credentialForImageEdit: (inbound?: Headers): Promise<TImageCredential> =>
    withRefreshCaller("upstream", async (): Promise<TImageCredential> => {
      const token = await readToken();
      if (token === null) {
        throw new Error("chatgpt: not signed in (no stored credential)");
      }
      const url = await resolveProviderUrl(
        PROVIDER,
        "/backend-api/codex/images/edits",
      );
      const headers: Record<string, string> =
        token.accountId !== null
          ? { "chatgpt-account-id": token.accountId }
          : {};
      if (!hasCodexOriginator(inbound)) headers.originator = OPENLLM_ORIGINATOR;
      if (!hasCodexUserAgent(inbound))
        headers["user-agent"] = OPENLLM_USER_AGENT;
      return {
        access_token: token.accessToken,
        headers,
        url,
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
        ...(token.accountId !== null
          ? { account_hash: accountHash(PROVIDER, token.accountId) }
          : {}),
      };
    }),

  // Local-only credential for `POST /backend-api/transcribe` (batch
  // speech-to-text, multipart `file`+`language`). Verified live (foundation
  // research, ac06f4cb) — the route is OUTSIDE `/backend-api/codex`, unlike
  // images/generations.
  credentialForTranscription: (inbound?: Headers): Promise<TImageCredential> =>
    withRefreshCaller("upstream", async (): Promise<TImageCredential> => {
      const token = await readToken();
      if (token === null) {
        throw new Error("chatgpt: not signed in (no stored credential)");
      }
      const url = await resolveProviderUrl(PROVIDER, "/backend-api/transcribe");
      const headers: Record<string, string> =
        token.accountId !== null
          ? { "chatgpt-account-id": token.accountId }
          : {};
      if (!hasCodexOriginator(inbound)) headers.originator = OPENLLM_ORIGINATOR;
      if (!hasCodexUserAgent(inbound))
        headers["user-agent"] = OPENLLM_USER_AGENT;
      return {
        access_token: token.accessToken,
        headers,
        url,
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
        ...(token.accountId !== null
          ? { account_hash: accountHash(PROVIDER, token.accountId) }
          : {}),
      };
    }),

  // Local-only credential for `POST /backend-api/pronunciation/synthesize`
  // (standalone text-to-speech; JSON in, raw MP3 bytes out; no voice
  // selector). Verified live (foundation research, ac06f4cb).
  credentialForSpeech: (inbound?: Headers): Promise<TImageCredential> =>
    withRefreshCaller("upstream", async (): Promise<TImageCredential> => {
      const token = await readToken();
      if (token === null) {
        throw new Error("chatgpt: not signed in (no stored credential)");
      }
      const url = `${await resolveProviderUrl(
        PROVIDER,
        "/backend-api/pronunciation/synthesize",
      )}?format=mp3`;
      const headers: Record<string, string> =
        token.accountId !== null
          ? { "chatgpt-account-id": token.accountId }
          : {};
      if (!hasCodexOriginator(inbound)) headers.originator = OPENLLM_ORIGINATOR;
      if (!hasCodexUserAgent(inbound))
        headers["user-agent"] = OPENLLM_USER_AGENT;
      return {
        access_token: token.accessToken,
        headers,
        url,
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
        ...(token.accountId !== null
          ? { account_hash: accountHash(PROVIDER, token.accountId) }
          : {}),
      };
    }),

  logout: async () => {
    // `codex logout` revokes the token server-side; then ensure the isolated
    // auth.json is gone regardless of CLI version.
    if ((await cliInstallState(PROVIDER, { demand: true })).installed) {
      await runCapture([bin(), "logout"], env());
    }
    await rm(join(cliConfigDir(PROVIDER), "auth.json"), {
      force: true,
    }).catch(() => {});
    noteAuthStoreIdentityChange(PROVIDER);
    const cleared = (await readToken()) === null;
    return cleared
      ? { ok: true, detail: "signed out of Codex" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
