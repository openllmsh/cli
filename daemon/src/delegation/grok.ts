/**
 * xAI Grok ("Grok Build", x.ai/cli) delegate.
 *
 * Native delegation: use the installed `grok` CLI's OWN bearer, under OUR OWN
 * client identity (`user-agent: openllm/<ver>`, mirroring the OpenClaw client's
 * `openclaw/<ver>`) — we do NOT present the Grok CLI's `x-grok-client-identifier`.
 * Grok Build is a subscription-OAuth coding agent (SuperGrok / X Premium+). We
 * never mint/forge/export the token — the daemon reads the CLI's own store and
 * injects the bearer for ONE inference call.
 *
 * Wire format: the OpenAI Responses API at the CLI chat proxy
 * (`cli-chat-proxy.grok.com/v1/responses`) — both Grok Build models report
 * `api_backend: "responses"` via `/v1/models`. The coreless walker maps
 * `grok → "chatgpt"` (the shared Responses adapter).
 *
 * ISOLATED install under `~/.openllm/cli/grok/` (HOME-pinned), so it never
 * touches the user's personal `~/.grok`.
 *
 * VERIFIED against grok CLI 0.2.73 (its bundled `docs/user-guide/` + a real
 * login):
 *   - Store: `<HOME>/.grok/auth.json` — a MAP of session entries keyed by
 *     `"<issuer>::<session-id>"`; each entry's `key` is the access token,
 *     alongside `refresh_token` + `expires_at` (ISO-8601).
 *   - Login: `grok login` / `grok login --oauth` (browser at accounts.x.ai);
 *     `grok login --device-auth` (device-code, headless/remote) — both native.
 *   - Logout: `grok logout`.
 *   - Refresh: the CLI refreshes its own token on any authenticated run; the
 *     daemon TRIGGERS that (a bounded `grok models`) when near `expires_at`.
 *   - Usage: available at `cli-chat-proxy.grok.com/v1/billing` (the CLI chat
 *     proxy's OWN billing route — SAME host as inference — which the CLI's
 *     `billing.rs` reads for "View credit usage"). Bearer-authed with the CLI
 *     OAuth token (401 on a bad/absent token; the extra `x-grok-client-version`
 *     header isn't required here but is sent for gate parity). Returns
 *     `{ config: { monthlyLimit:{val}, used:{val}, billingPeriodStart/End, … } }`
 *     for the MONTHLY view, and `?format=credits` for the WEEKLY Grok Build pool
 *     (`creditUsagePercent` / `productUsage[GrokBuild]` / `currentPeriod`) — the
 *     primary limit `grok /usage` shows. We surface BOTH windows (weekly first;
 *     see {@link parseGrokUsage}). Verified live against a SuperGrok / X Premium+
 *     session. (An earlier probe wrongly concluded usage was forbidden — it hit
 *     `grok.com/rest/rate-limits`, a DIFFERENT grpc gateway that 404/501s these
 *     routes regardless of token; that was a wrong host, not a tier limit.)
 *
 * ⚠️ STILL UNVALIDATED LIVE: the `grok login --device-auth` prompt shape
 * ({@link parseDevicePrompt}); that `grok models` actually rotates+persists the
 * token (the refresh trigger); and whether Grok's Responses endpoint tolerates
 * the Codex `instructions` preamble the shared chatgpt request builder injects
 * (it may need a grok-specific builder).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  TProviderUsageSnapshot,
  TProviderUsageWindow,
} from "@openllmsh/protocol";
import { MODEL_LIST_FETCH_TIMEOUT_MS } from "@openllmsh/protocol";
import { REALTIME_DEFAULT_MODEL_BY_PROVIDER } from "@openllmsh/protocol/realtime-generated";
import { Option, Schema as S } from "effect";
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
import { accountHashField, nonEmpty } from "./account-id";
import { resolveProviderUrl, resolveUpstreamUrl } from "./auth-config";
import { cliLaunch, loginWiring, nativeRefresher } from "./delegate-shared";
import {
  cachedCliSemver,
  credentialHasFetchLifetime,
  fetchModelList,
  modelDiscoveryFromList,
  parseGrokModelList,
  parseGrokModelRows,
  skippedModelDiscovery,
} from "./fetch-model-list";
import { makeStreamDeviceConnect } from "./login-device";
import { makeStreamConnect } from "./login-direct";
import { waitFileStoreHint } from "./observation-cache";
import type { TRefreshErrorClass } from "./refresh";
import {
  credentialUnrefreshable,
  isStaleRefresh,
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
import { statusForWindows } from "./usage-reduce";
import type { TStoreRead } from "./util";
import {
  cliVersion,
  connectedObservation,
  disconnectedObservation,
  readJsonStore,
  redactUrls,
  runCapture,
  STATUS_CHECK_FAILED_DETAIL,
  storeReadValue,
  stripAnsi,
  unknownObservation,
} from "./util";

const PROVIDER = "grok" as const;

// Image/audio/realtime endpoints all differ from the chat/proxy host.
// These requests must go directly to `api.x.ai`, so we don't try to
// resolve from the captured upstream URL. Verified live (foundation
// research, ac06f4cb).
const GROK_IMAGE_URL = "https://api.x.ai/v1/images/generations";
const GROK_IMAGE_EDIT_URL = "https://api.x.ai/v1/images/edits";
const GROK_STT_URL = "https://api.x.ai/v1/stt";
const GROK_TTS_URL = "https://api.x.ai/v1/tts";
// The `model` query param is CATALOG-OWNED via the generated realtime
// artifact (`@openllmsh/protocol/realtime-generated`), so this URL cannot
// drift from the catalog row the admission schema accepts. The HOST is a
// vendor fact and stays local. Byte-identical to the previous literal.
const GROK_REALTIME_URL = `wss://api.x.ai/v1/realtime?model=${REALTIME_DEFAULT_MODEL_BY_PROVIDER.grok}`;

// Usage endpoint LEAF path — the host is derived from the captured inference
// endpoint (`resolveProviderUrl`), so a vendor host migration is auto-tracked.
// This is the CLI chat-proxy's own billing route (same host as inference), which
// the CLI's `billing.rs` reads to render "View credit usage" — verified live
// against a SuperGrok / X Premium+ session (see the header block above).
const USAGE_PATH = "/v1/billing";
const SETTINGS_PATH = "/v1/settings";

// Grok Imagine video generation uses the xAI API base, not the CLI chat proxy.
const GROK_VIDEO_BASE = "https://api.x.ai/v1";

// Trigger the CLI's OWN refresh when the access token is within this window of
// `expires_at`. Mirrors codex's leeway.
const REFRESH_LEEWAY_MS = 5 * 60_000;

const { bin, env } = cliLaunch(PROVIDER);

/**
 * Parse the browser authorize URL `grok login` prints. The user clicks an
 * `accounts.x.ai/sign-in` URL (the OIDC backend is `auth.x.ai`). Matched
 * leniently so a path tweak doesn't break it.
 */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/accounts\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/auth\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/(?:oauth\/)?authorize\S+/)?.[0] ??
    null
  );
};

/**
 * Parse the verification URL + one-time code from `grok login --device-auth`
 * stdout. ⚠️ RESEARCH-UNVERIFIED prompt shape — matched leniently (an
 * `accounts.x.ai`/`auth.x.ai` URL + a code-looking token near "code"); confirm
 * against a real device login.
 */
const parseDevicePrompt = (
  raw: string,
): { url: string; code: string } | null => {
  const clean = stripAnsi(raw);
  const url =
    clean.match(/https?:\/\/(?:accounts|auth)\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S+/)?.[0];
  const code = clean.match(/code[^\n]*?\b([A-Z0-9][A-Z0-9-]{3,})\b/i)?.[1];
  return url !== undefined && code !== undefined ? { url, code } : null;
};

// auth.json is a MAP of session entries keyed by `"<issuer>::<session-id>"`
// (verified against grok 0.2.73). The access token is the `key` field; the
// session also carries `refresh_token` + `expires_at`.
type TGrokSession = {
  /** The access token sent as `Authorization: Bearer <key>`. */
  readonly key?: string;
  readonly refresh_token?: string;
  /** ISO-8601 expiry of the access token. */
  readonly expires_at?: string;
  /** ISO-8601 session creation time — used to pick the newest session. */
  readonly create_time?: string;
  /** The xAI account uuid (= `principal_id`) — stable across sessions;
   *  feeds `account_hash`. NOT `agent_id`, which is per-device. */
  readonly user_id?: string;
};
type TGrokStore = Readonly<Record<string, TGrokSession>>;

export const resolveGrokSession = (
  prior: TGrokSession,
  refreshed: TGrokSession,
): TGrokSession => ({
  ...refreshed,
  user_id: refreshed.user_id ?? prior.user_id,
});

const authPath = (): string => join(cliConfigDir(PROVIDER), "auth.json");

const waitAuthStoreHint = (signal: AbortSignal): Promise<void> =>
  waitFileStoreHint(authPath(), signal);

const loadStore = (): Promise<TStoreRead<TGrokStore>> =>
  // Isolated HOME → <home>/.grok/auth.json (cliConfigDir).
  readJsonStore<TGrokStore>(authPath());

/** The newest session entry carrying a usable access token, or null. */
const newestSessionFromStore = (
  store: TGrokStore | null,
): TGrokSession | null => {
  if (store === null) return null;
  const sessions = Object.values(store).filter(
    (s): s is TGrokSession & { readonly key: string } =>
      typeof s?.key === "string" && s.key.length > 0,
  );
  if (sessions.length === 0) return null;
  // Newest first — ISO `create_time` sorts lexicographically.
  sessions.sort((a, b) =>
    (b.create_time ?? "").localeCompare(a.create_time ?? ""),
  );
  return sessions[0] ?? null;
};

const newestSession = async (): Promise<TGrokSession | null> =>
  newestSessionFromStore(storeReadValue(await loadStore()));

const parseExpiryMs = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

// We identify as OURSELVES, not the Grok CLI. Mirroring the OpenClaw client
// (`ref/openclaw/extensions/xai/xai-oauth.ts` — `User-Agent: openclaw/<ver>`,
// and NO `x-grok-client-*` identity headers on the proxy), we present a
// `user-agent: openllm/<ver>` and do NOT send `x-grok-client-identifier`. The
// only `x-grok-*` header retained is the version below, and solely because
// cli-chat-proxy.grok.com GATES on it: a request without `x-grok-client-version`
// (or with an old one) is rejected 426 "Your Grok CLI version (none) is
// outdated. Please update to version 0.1.202 or later". We send the INSTALLED
// binary's real version via the shared stamp-keyed `cliVersion` cache (no
// process-local forever memo — a binary replacement must be visible); fall
// back to a known-good floor if `--version` can't be read. (Full OpenClaw
// parity would drop this header too; that needs a live 426-gate test the
// audit never ran.)
const OPENLLM_USER_AGENT = `openllm/${DAEMON_VERSION}`;
const clientVersion = async (): Promise<string> => {
  const v = await cliVersion(bin(), env());
  return v?.match(/\d+\.\d+\.\d+/)?.[0] ?? "0.2.73";
};

/**
 * Trigger the grok CLI's OWN token refresh: a bounded `grok models` (a cheap
 * authenticated call). The CLI's auth manager refreshes + persists the rotated
 * token to `auth.json` when it's near expiry; the daemon never writes the store.
 */
const triggerRefresh = async (): Promise<void> => {
  await spawnRefresh([bin(), "models"], env(), {
    readStore: async () => {
      const session = newestSessionFromStore(storeReadValue(await loadStore()));
      return refreshCredentialSnapshot({
        accessToken: session?.key,
        refreshToken: session?.refresh_token,
        accountId: session?.user_id ?? null,
      });
    },
  });
};

// Within leeway → refresh in the background (token still valid, no stall);
// hard-expired → await it. Single-flight per provider.
const refresh = nativeRefresher({
  slug: PROVIDER,
  label: "Grok",
  leewayMs: REFRESH_LEEWAY_MS,
  trigger: triggerRefresh,
});

type TStoredGrokToken =
  | {
      readonly kind: "live";
      readonly accessToken: string;
      readonly session: TGrokSession;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

/** Stored access token only — never native-refreshes. Usage reads this. */
const readStoredToken = async (): Promise<TStoredGrokToken> => {
  const session = await newestSession();
  if (session?.key === undefined || session.key.length === 0) {
    return { kind: "missing" };
  }
  const expiresAtMs = parseExpiryMs(session.expires_at);
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    return { kind: "expired" };
  }
  return { kind: "live", accessToken: session.key, session };
};

/** Read the stored access token, triggering the CLI's native refresh near
 *  expiry (the CLI owns the store; we just re-read after a hard-expired await).
 *  Also returns the session the token came from, so callers (e.g. `status`'s
 *  `account_hash`) don't re-read the store. */
const readToken = async (): Promise<{
  accessToken: string;
  session: TGrokSession;
  staleRefresh?: TRefreshErrorClass;
} | null> => {
  const session = await newestSession();
  if (session?.key === undefined || session.key.length === 0) return null;
  const expiresAtMs = parseExpiryMs(session.expires_at);
  // Only trigger when the credential CAN be refreshed (a refresh token exists).
  if (!session.refresh_token) credentialUnrefreshable(PROVIDER);
  const outcome = session.refresh_token ? await refresh(expiresAtMs) : "fresh";
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
    return { accessToken: session.key, session, staleRefresh: outcome.reason };
  }
  if (outcome !== "awaited") return { accessToken: session.key, session };
  // Hard-expired path: the CLI refresh was awaited — re-read the rotated store.
  const fresh = await newestSession();
  const resolved = resolveToken({
    provider: PROVIDER,
    prior: session,
    refreshed: fresh?.key !== undefined && fresh.key.length > 0 ? fresh : null,
    hasRefreshToken: (token) => Boolean(token.refresh_token),
  });
  const resolvedSession = resolveGrokSession(session, resolved.token);
  return {
    accessToken: resolvedSession.key ?? session.key,
    session: resolvedSession,
  };
};

/**
 * The bearer + our OWN client identity (`user-agent: openllm/<ver>`, like
 * OpenClaw's `openclaw/<ver>`) + account attribution, shared by every grok
 * upstream credential path (`credentialForUpstream` / `credentialForImage`).
 * The TARGET url is layered on by each caller. `x-grok-client-version` is the
 * only vendor-CLI header kept, solely to satisfy the 426 version gate; we do
 * NOT send `x-grok-client-identifier` (we are not the Grok CLI).
 */
const grokClientCredential = async (): Promise<{
  readonly access_token: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly account_hash?: string;
  readonly stale_refresh?: TRefreshErrorClass;
}> => {
  const token = await readToken();
  if (token === null) {
    throw new Error("grok: not signed in (no stored credential)");
  }
  return {
    access_token: token.accessToken,
    headers: {
      "user-agent": OPENLLM_USER_AGENT,
      "x-grok-client-version": await clientVersion(),
    },
    // Which account this hop's cost attributes to (recorded on the row).
    ...accountHashField(PROVIDER, token.session.user_id),
    ...(token.staleRefresh !== undefined
      ? { stale_refresh: token.staleRefresh }
      : {}),
  };
};

// ─── Login wiring ────────────────────────────────────────────────────────
//
// Grok has BOTH native flows, so we wire both (mirroring codex). They share ONE
// `loginSlot` so only one `grok login` runs at a time, and `cancelConnect`
// (from the device adaptor) kills whichever is live:
//   - connect            → `grok login` (browser, this machine);
//   - connectDeviceCode  → `grok login --device-auth` (headless/remote).

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
    "Grok CLI not found — re-run the OpenLLM daemon installer to add it.",
  connectedDetail: "signed in via Grok",
  inProgressDetail:
    "Grok sign-in already in progress — finish authorizing in your browser; this updates automatically.",
  readToken,
});

// Browser flow: `grok login` prints the authorize URL to stderr; it opens its
// OWN browser, so we only surface the URL (so a remote box can click it).
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
    logInfo("grok-connect", "spawning `grok login` (browser flow)"),
  onParsed: (url) =>
    logInfo("grok-connect", "parsed authorize URL; surfacing to dashboard", {
      urlLen: url.length,
    }),
  onParseFail: (captured) =>
    logError(
      "grok-connect",
      safeDiagnosticMessage`no authorize URL parsed from grok login`,
      {
        stderrLen: captured.length,
        stderrSample: redactUrls(captured.slice(0, 400)),
      },
    ),
  pendingDetail: (url) =>
    `Authorize Grok in the browser window that opened — or open ${url}. This page updates automatically once you're done.`,
  failDetail:
    "Couldn't start Grok sign-in. Retry, or run `grok login` on the box.",
  crashDetail: (captured, exitCode) => {
    const err = redactUrls(captured.slice(0, 400)).trim();
    const code = exitCode === null ? "" : ` (exit ${exitCode})`;
    return err.length > 0
      ? `\`grok login\` exited before starting sign-in${code} — retrying won't help until it's fixed. It reported:\n${err}\nRun \`grok login\` on the box for the full output.`
      : `\`grok login\` exited without starting sign-in${code} — retrying won't help. Run \`grok login\` on the box to see why.`;
  },
});

// Device-code flow: `grok login --device-auth` prints the verification URL +
// one-time code to stderr (verified against x.ai/cli v0.2.77); we surface them
// + open the URL locally.
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
  stream: "stderr",
  parse: parseDevicePrompt,
  onConnected: refreshConfig,
  pendingDetail: (found) => pendingAuthDetail(found),
  failDetail:
    "Couldn't start Grok device sign-in. Retry, or run `grok login --device-auth` on the box.",
  crashDetail: (captured, exitCode) => {
    const err = redactUrls(captured.slice(0, 400)).trim();
    const code = exitCode === null ? "" : ` (exit ${exitCode})`;
    return err.length > 0
      ? `\`grok login --device-auth\` exited before starting sign-in${code} — retrying won't help until it's fixed. It reported:\n${err}\nRun \`grok login --device-auth\` on the box for the full output.`
      : `\`grok login --device-auth\` exited without starting sign-in${code} — retrying won't help. Run \`grok login --device-auth\` on the box to see why.`;
  },
  cancelMessages: {
    cancelled: "Grok sign-in cancelled",
    none: "no sign-in was in progress",
  },
});

// ─── /v1/billing parsing ───────────────────────────────────────────────────
//
// The CLI chat-proxy's billing route returns a `config` object whose numeric
// fields are `{ val: number }` wrappers (verified live + cross-checked against
// the CLI binary's own `billing.rs` struct):
//   { config: { monthlyLimit:{val}, used:{val}, onDemandCap:{val},
//               billingPeriodStart, billingPeriodEnd, history:[…] } }
// The plain path gives the MONTHLY included-credit window (`used` /
// `monthlyLimit`; period end = reset). `?format=credits` gives the WEEKLY Grok
// Build pool (`creditUsagePercent` / `productUsage[GrokBuild]`; `currentPeriod`)
// — the primary limit `grok /usage` + grok.com show and the one that gates
// inference. We surface BOTH (weekly first); see {@link parseGrokUsage}.

const GrokBillingVal = S.Struct({ val: S.optional(S.Finite) });
const GrokBillingConfig = S.Struct({
  monthlyLimit: S.optional(GrokBillingVal),
  used: S.optional(GrokBillingVal),
  billingPeriodEnd: S.optional(S.String),
});
const GrokBilling = S.Struct({ config: GrokBillingConfig });
const decodeGrokBilling = S.decodeUnknownOption(GrokBilling);

// The `?format=credits` view — the WEEKLY unified-billing pool the Grok CLI's
// own `/usage` and the grok.com dashboard show, and the one that actually gates
// Grok Build inference (verified live 2026-07: an account at 47% monthly can be
// 100% weekly and 402 "Grok Build usage balance exhausted"). `creditUsagePercent`
// is the overall figure; `productUsage[GrokBuild].usagePercent` is the same pool
// per-product. `currentPeriod.end` is the weekly reset.
const GrokCredits = S.Struct({
  config: S.Struct({
    ...GrokBillingConfig.fields,
    creditUsagePercent: S.optional(S.Finite),
    currentPeriod: S.optional(
      S.Struct({
        type: S.optional(S.String),
        start: S.optional(S.String),
        end: S.optional(S.String),
      }),
    ),
    productUsage: S.optional(
      S.Array(
        S.Struct({
          product: S.optional(S.String),
          usagePercent: S.optional(S.Finite),
        }),
      ),
    ),
  }),
});
const decodeGrokCredits = S.decodeUnknownOption(GrokCredits);

const GROK_NOTE = "Grok — read locally via Grok CLI";

type TGrokSettings = { readonly subscription_tier_display?: unknown };

/** Best-effort private-client tier read; quota availability never depends on it. */
const readGrokPlan = async (
  headers: Readonly<Record<string, string>>,
): Promise<string | null> => {
  try {
    const response = await fetch(
      await resolveProviderUrl(PROVIDER, SETTINGS_PATH),
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const settings = (await response.json()) as TGrokSettings;
    return typeof settings.subscription_tier_display === "string"
      ? settings.subscription_tier_display
      : null;
  } catch {
    return null;
  }
};

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n));
const parseIsoMs = (iso: string | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** The MONTHLY included-credit window from a plain `/v1/billing` body, or null
 *  when the plan reports no included-quota window (on-demand-only). */
export const parseGrokMonthlyWindow = (
  body: unknown,
): TProviderUsageWindow | null => {
  const decoded = decodeGrokBilling(body);
  if (Option.isNone(decoded)) return null;
  const { config } = decoded.value;
  const limit = config.monthlyLimit?.val ?? 0;
  if (limit <= 0) return null;
  const used = config.used?.val ?? 0;
  return {
    label: "Monthly",
    percent_used: clampPercent((used / limit) * 100),
    reset_at_ms: parseIsoMs(config.billingPeriodEnd),
  };
};

/** The WEEKLY Grok Build window from a `?format=credits` body, or null when the
 *  view lacks a weekly figure. Prefers the GrokBuild per-product percent, then
 *  the overall `creditUsagePercent`. */
export const parseGrokWeeklyWindow = (
  body: unknown,
): TProviderUsageWindow | null => {
  const decoded = decodeGrokCredits(body);
  if (Option.isNone(decoded)) return null;
  const { config } = decoded.value;
  const product = config.productUsage?.find((p) => p.product === "GrokBuild");
  let pct = product?.usagePercent ?? config.creditUsagePercent;
  const resetAt = parseIsoMs(config.currentPeriod?.end);
  if (pct === undefined) {
    const startAt = parseIsoMs(config.currentPeriod?.start);
    if (
      config.currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY" ||
      startAt === null ||
      resetAt === null ||
      resetAt <= startAt
    )
      return null;
    // Grok omits zero-valued counters after reset. Its native
    // credit_balance_from_config uses the legacy budget, else 0. Require a
    // real weekly period here so an empty/malformed response isn't a quota.
    const limit = config.monthlyLimit?.val ?? 0;
    const used = config.used?.val ?? 0;
    pct = limit > 0 ? (used / limit) * 100 : 0;
  }
  return {
    label: "Weekly",
    percent_used: clampPercent(pct),
    reset_at_ms: resetAt,
  };
};

/** Combine the weekly (`?format=credits`) + monthly (plain) views into ONE
 *  snapshot. Weekly is listed first (it's the pool that gates Grok Build
 *  inference; the CLI's `/usage` shows it). A null `creditsBody` means a
 *  successful response with no parseable weekly window, so monthly-only is
 *  valid. HTTP/network failures are handled by `grokWeeklyUsageUnavailable`
 *  before this pure parser is called. Returns `unavailable` only when NEITHER
 *  body yields a window. */
export const parseGrokUsage = (
  billingBody: unknown,
  creditsBody: unknown,
): TProviderUsageSnapshot => {
  const weekly = parseGrokWeeklyWindow(creditsBody);
  const monthly = parseGrokMonthlyWindow(billingBody);
  const windows = [weekly, monthly].filter(
    (w): w is TProviderUsageWindow => w !== null,
  );
  if (windows.length === 0) {
    return {
      kind: "unavailable",
      reason: "Grok reported no included-quota window for this plan.",
      link: "https://grok.com",
    };
  }
  return {
    kind: "quota",
    status: statusForWindows(windows),
    windows,
    note: GROK_NOTE,
  };
};

/** Back-compat monthly-only snapshot from a plain `/v1/billing` body. Retained
 *  for callers/tests that only exercise the monthly view; new code uses
 *  {@link parseGrokUsage} to include the weekly Grok Build pool. */
export const parseGrokBilling = (body: unknown): TProviderUsageSnapshot =>
  parseGrokUsage(body, null);

/** The weekly credits endpoint is the inference-gating envelope, so a failed
 * fetch cannot fall back to the secondary monthly view. Kept separate from the
 * body parser so `parseGrokUsage` stays pure. */
export const grokWeeklyUsageUnavailable = (
  status: number,
): TProviderUsageSnapshot => {
  const reason =
    status === 401
      ? "Grok authorization was rejected — re-sign in via `grok login`."
      : status === 403
        ? "No active SuperGrok / X Premium+ subscription on this account."
        : status === 0
          ? "Grok usage fetch failed."
          : `Grok couldn't report usage (HTTP ${status}).`;
  return { kind: "unavailable", reason, link: "https://grok.com" };
};

// ─── Live model rows (shared by listModels + per-hop capability reads) ─────
//
// The CLI chat proxy's own `GET /v1/models` (the call the grok CLI's model
// picker makes). Cached briefly because the walker consults per-hop model
// capabilities (`supports_reasoning_effort`) and must not pay a network
// round-trip per request. `null` on ANY failure — callers treat unknown as
// "leave the request untouched" / keep the cached catalog.

type TGrokModelRow = Readonly<Record<string, unknown>>;

const MODEL_ROWS_TTL_MS = 5 * 60_000;
let modelRowsCache: {
  at: number;
  rows: ReadonlyArray<TGrokModelRow>;
} | null = null;
// Single-flight: concurrent cold/expired callers (the walker calls
// `supportsReasoningEffort` per request) share ONE in-flight `/v1/models`
// fetch instead of each spawning their own. Cleared when it settles.
let modelRowsInflight: Promise<ReadonlyArray<TGrokModelRow> | null> | null =
  null;

const fetchModelRows =
  async (): Promise<ReadonlyArray<TGrokModelRow> | null> => {
    const token = await readToken();
    if (token === null) return null;
    try {
      // Host derived from the CAPTURED inference URL via `resolveProviderUrl`;
      // bearer + our own `openllm/<ver>` identity (+ the gate version header),
      // mirroring the usage read.
      const resp = await fetch(
        await resolveProviderUrl(PROVIDER, "/v1/models"),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            "user-agent": OPENLLM_USER_AGENT,
            "x-grok-client-version": await clientVersion(),
            accept: "application/json",
          },
          signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
        },
      );
      if (!resp.ok) return null;
      // OpenAI-wire `{ data: [...] }`; tolerate `{ models: [...] }` too.
      const b = (await resp.json()) as {
        data?: ReadonlyArray<TGrokModelRow>;
        models?: ReadonlyArray<TGrokModelRow>;
      };
      const rows = b.data ?? b.models ?? [];
      if (rows.length === 0) return null;
      modelRowsCache = { at: Date.now(), rows };
      return rows;
    } catch {
      return null;
    }
  };

const modelRows = async (): Promise<ReadonlyArray<TGrokModelRow> | null> => {
  if (
    modelRowsCache !== null &&
    Date.now() - modelRowsCache.at < MODEL_ROWS_TTL_MS
  ) {
    return modelRowsCache.rows;
  }
  if (modelRowsInflight === null) {
    modelRowsInflight = fetchModelRows().finally(() => {
      modelRowsInflight = null;
    });
  }
  return modelRowsInflight;
};

/**
 * Whether ONE model row advertises a configurable `reasoning.effort`. Only
 * current flagship Grok Build models set `supports_reasoning_effort` — the
 * partner client (openclaw) strips the reasoning params for the rest, and the
 * walker mirrors that via `TProviderDelegate.supportsReasoningEffort` (audit
 * 2026-07-14 §F2). Pure (no network) so it can be unit-tested; tolerates both
 * snake and camel casing like the partner's reader.
 *
 * A row that EXISTS but lacks the field counts as `false`, not unknown: the
 * live `/v1/models` omits false-y fields proto3-style (verified live
 * 2026-07-14 — composer's row carries no `supports_reasoning_effort`, the
 * CLI's own models_cache materializes it as `false`, and sending effort
 * anyway 400s "does not support parameter reasoningEffort"). Only a MISSING
 * row is unknown (`null` → leave the request untouched); wrongly stripping
 * degrades to default effort, wrongly sending hard-fails the request.
 */
export const reasoningEffortFromRows = (
  rows: ReadonlyArray<TGrokModelRow>,
  providerModelId: string,
): boolean | null => {
  const row = rows.find((m) => m.id === providerModelId);
  if (row === undefined) return null;
  const v = row.supports_reasoning_effort ?? row.supportsReasoningEffort;
  return v === true;
};

export const grokDelegate: TProviderDelegate = {
  slug: PROVIDER,
  statusCancellable: false,

  connect: connectDirect,
  connectDeviceCode: deviceLogin.connectDeviceCode,
  cancelConnect: deviceLogin.cancelConnect,

  // Passive observation from ONE typed `auth.json` snapshot. Do not call
  // `readToken()` here — that native-refreshes via `grok models`.
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
    const session = newestSessionFromStore(
      store?.kind === "present" ? store.value : null,
    );
    const accessToken =
      session?.key !== undefined && session.key.length > 0 ? session.key : null;
    if (accessToken !== null) clearPendingAuth(PROVIDER);
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
                  ? "grok CLI installed but not signed in"
                  : "grok CLI not installed",
          }
        : {
            last_login_at_ms: null,
            // Stable xAI account identity, hashed (`account-id.ts`) — the
            // `user_id` (= `principal_id`) of the stored session snapshot.
            ...accountHashField(PROVIDER, session?.user_id),
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
        missingReason: "not signed in to Grok",
        accountIdOf: (value) => nonEmpty(value.session.user_id),
        priorAccountIdWhenExpired: async () =>
          nonEmpty((await newestSession())?.user_id),
        readNative: async () => {
          await readToken();
          const fresh = await readStoredToken();
          return fresh.kind === "live" ? fresh : null;
        },
      });
      if (cred.kind === "unavailable") return cred;
      const { accessToken } = cred.value;
      // Same host as inference (`resolveProviderUrl` derives it from the captured
      // upstream, never spawning the CLI). The plain OAuth bearer is accepted; we
      // send our own `openllm/<ver>` identity (+ the gate version header),
      // mirroring `credentialForUpstream`.
      const headers = {
        authorization: `Bearer ${accessToken}`,
        "user-agent": OPENLLM_USER_AGENT,
        "x-grok-client-version": await clientVersion(),
        accept: "application/json",
      };
      // One authed billing GET → the parsed body, or a `{ error }` marker carrying
      // the HTTP status so the WEEKLY (primary) view can turn a hard error into an
      // `unavailable` snapshot while a MONTHLY failure just degrades gracefully.
      const getBilling = async (
        path: string,
      ): Promise<{ body: unknown } | { error: number }> => {
        try {
          const resp = await fetch(await resolveProviderUrl(PROVIDER, path), {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
          });
          if (!resp.ok) return { error: resp.status };
          return { body: await resp.json() };
        } catch {
          return { error: 0 };
        }
      };

      // The WEEKLY Grok Build pool (`?format=credits`) is the primary limit —
      // it's what `grok /usage` and grok.com show and what gates inference; the
      // MONTHLY included-credit view (plain path) is secondary. Fetch both; weekly
      // decides the error envelope, monthly is best-effort (null → weekly-only).
      const [credits, monthly] = await Promise.all([
        getBilling(`${USAGE_PATH}?format=credits`),
        getBilling(USAGE_PATH),
      ]);

      if ("error" in credits) {
        return grokWeeklyUsageUnavailable(credits.error);
      }

      const snapshot = parseGrokUsage(
        "body" in monthly ? monthly.body : null,
        "body" in credits ? credits.body : null,
      );
      if (snapshot.kind !== "quota") return snapshot;
      const plan = await readGrokPlan(headers);
      return plan === null
        ? snapshot
        : { ...snapshot, plan, plan_source: "private-client" };
    }),

  listModels: (): ReturnType<NonNullable<TProviderDelegate["listModels"]>> =>
    withRefreshCaller(
      "models",
      async (): ReturnType<NonNullable<TProviderDelegate["listModels"]>> => {
        // Live `/v1/models` rows via the shared cached fetch (both Grok Build
        // models report `api_backend` through it). Metadata only; null on any
        // failure (never an empty list).
        const rows = await modelRows();
        if (rows === null) return null;
        const entries = parseGrokModelRows(rows);
        return entries.length > 0 ? entries : null;
      },
    ),

  discoverModels: async (
    options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    const ver = cachedCliSemver(options.cliVersion);
    if (ver === null) return skippedModelDiscovery();
    const store = await loadStore();
    if (store.kind !== "present") return skippedModelDiscovery();
    const session = newestSessionFromStore(store.value);
    if (session === null) return skippedModelDiscovery();
    const accessToken = session.key;
    if (accessToken === undefined || accessToken.length === 0) {
      return skippedModelDiscovery();
    }
    if (
      !credentialHasFetchLifetime(
        parseExpiryMs(session.expires_at),
        REFRESH_LEEWAY_MS,
      )
    ) {
      return skippedModelDiscovery();
    }
    return modelDiscoveryFromList(
      await fetchModelList(
        await resolveProviderUrl(PROVIDER, "/v1/models"),
        {
          authorization: `Bearer ${accessToken}`,
          "user-agent": OPENLLM_USER_AGENT,
          "x-grok-client-version": ver,
          accept: "application/json",
        },
        parseGrokModelList,
      ),
    );
  },

  // The live row, normalized into the catalog's own caps vocabulary: a
  // model that advertises no configurable effort DENIES `reasoning`.
  // Unknown (missing row, unreachable list) stays `null` — nothing
  // observed, so the request is left untouched. Same call site, same
  // cached `/v1/models`: no extra fetch and no bootstrap lag.
  // The CLOSED set this delegate's live rows can deny, so the walker skips
  // the `/v1/models` read entirely for a body that carries none of them (a
  // cold or expired cache is a network round trip with a 10s timeout, and a
  // failed fetch is not negatively cached). `reasoningEffortFromRows` is the
  // only row fact read below, and `reasoning` is the only param it denies —
  // extend this list in the same commit that observes a second one.
  observedDeniedParamCandidates: ["reasoning"],

  getObservedModelCaps: async (providerModelId) => {
    const rows = await modelRows();
    if (rows === null) return null;
    return reasoningEffortFromRows(rows, providerModelId) === false
      ? { deniedParams: ["reasoning"] }
      : null;
  },

  // xAI rejects contains-count bounds in tool schemas (partner compat:
  // openclaw `model-compat.ts` — audit 2026-07-14 §F7); the walker strips
  // them recursively from every tool's `parameters`.
  unsupportedToolSchemaKeywords: ["minContains", "maxContains"],

  credentialForUpstream: (): ReturnType<
    TProviderDelegate["credentialForUpstream"]
  > =>
    withRefreshCaller(
      "upstream",
      async (): ReturnType<TProviderDelegate["credentialForUpstream"]> => {
        // cli-chat-proxy.grok.com's 426 gate requires `x-grok-client-version`, so
        // `grokClientCredential` supplies the installed CLI's REAL version — but we
        // identify as ourselves (`user-agent: openllm/<ver>`) and do NOT send
        // `x-grok-client-identifier`; we are not the Grok CLI. The Responses TARGET
        // URL is captured/default per-hop; the originator's other headers ride through.
        return {
          ...(await grokClientCredential()),
          url: await resolveUpstreamUrl(PROVIDER),
        };
      },
    ),

  credentialForImage: (): Promise<TImageCredential> =>
    withRefreshCaller(
      "upstream",
      async (): Promise<TImageCredential> => ({
        ...(await grokClientCredential()),
        url: GROK_IMAGE_URL,
      }),
    ),

  credentialForVideo: (): ReturnType<
    NonNullable<TProviderDelegate["credentialForVideo"]>
  > =>
    withRefreshCaller(
      "upstream",
      async (): ReturnType<
        NonNullable<TProviderDelegate["credentialForVideo"]>
      > => ({
        ...(await grokClientCredential()),
        url: GROK_VIDEO_BASE,
      }),
    ),

  // `POST /v1/images/edits` — a DISTINCT model (`grok-imagine-image-2.0`)
  // from the generation alias; never infer editing from generation.
  // Verified live (foundation research, ac06f4cb).
  credentialForImageEdit: (): Promise<TImageCredential> =>
    withRefreshCaller(
      "upstream",
      async (): Promise<TImageCredential> => ({
        ...(await grokClientCredential()),
        url: GROK_IMAGE_EDIT_URL,
      }),
    ),

  // `POST /v1/stt` — batch speech-to-text, multipart `file`+`language`
  // (+`format=true`, verified live). Mono 16-bit 16kHz WAV input.
  credentialForTranscription: (): Promise<TImageCredential> =>
    withRefreshCaller(
      "upstream",
      async (): Promise<TImageCredential> => ({
        ...(await grokClientCredential()),
        url: GROK_STT_URL,
      }),
    ),

  // `POST /v1/tts` — JSON `{text, voice_id:"eve", language}` → MP3.
  // Verified live (foundation research, ac06f4cb).
  credentialForSpeech: (): Promise<TImageCredential> =>
    withRefreshCaller(
      "upstream",
      async (): Promise<TImageCredential> => ({
        ...(await grokClientCredential()),
        url: GROK_TTS_URL,
      }),
    ),

  // `wss://api.x.ai/v1/realtime?model=grok-voice-latest` — text-to-audio
  // realtime session (verified live; microphone/barge-in unverified — see
  // `GROK_REALTIME_OPERATIONS`). Local-only credential; no walker consumes
  // this yet (out of scope for this slice — see delegation/types.ts).
  credentialForRealtime: (): Promise<TImageCredential> =>
    withRefreshCaller(
      "upstream",
      async (): Promise<TImageCredential> => ({
        ...(await grokClientCredential()),
        url: GROK_REALTIME_URL,
      }),
    ),

  logout: async () => {
    // `grok logout` clears the cached credentials; then ensure the isolated
    // auth.json is gone regardless of CLI version.
    if ((await cliInstallState(PROVIDER, { demand: true })).installed) {
      await runCapture([bin(), "logout"], env());
    }
    await rm(authPath(), { force: true }).catch(() => {});
    noteAuthStoreIdentityChange(PROVIDER);
    const cleared = (await readToken()) === null;
    return cleared
      ? { ok: true, detail: "signed out of Grok" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
