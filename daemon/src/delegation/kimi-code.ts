/**
 * Kimi Code (Moonshot) delegate.
 *
 * Native delegation: use the installed Kimi CLI's OWN token + identity.
 * Replaces the server-side synthesis in `kimi-code/common.ts`. Weakest of
 * the three — Kimi's consumer ToS has a flat no-commercial bar
 * (proposal §5); rank support/warnings accordingly.
 *
 * ISOLATED install: the daemon runs its OWN `kimi` under
 * `~/.openllm/cli/kimi_code/` with `KIMI_CODE_HOME` pointed inside it
 * (see cli-paths.ts), so it never touches the user's `~/.kimi-code`.
 * Verified against the Kimi Code CLI source (ref/kimi-code — Node/TS):
 *   - OAuth token at the region's credential slot under `<KIMI_CODE_HOME>/credentials/`, shape
 *     { access_token, refresh_token, expires_at (epoch SECONDS), … }.
 *   - Device id `<KIMI_CODE_HOME>/device_id` (uuid4) — forwarded as
 *     X-Msh-Device-Id so the identity is the real CLI's, not forged.
 *   - Login: NO `login` subcommand and NO headless flag — the CLI's
 *     sign-in is the in-TUI `/login` slash command (needs a raw-mode TTY),
 *     so the daemon can't spawn it. Instead the daemon drives Kimi's OWN
 *     device-code OAuth flow directly (the exact flow the CLI runs
 *     internally — `packages/oauth`): POST `/api/oauth/device_authorization`
 *     → open the verification URL (code pre-embedded) → poll
 *     `/api/oauth/token` (grant_type=device_code) → write the credential
 *     file the CLI would have written. Same endpoints, client id, wire
 *     shape, and `device_id` as the official CLI.
 *   - Upstream identity (packages/oauth identity.ts): User-Agent
 *     `kimi-code-cli/<ver>`, `X-Msh-Platform: kimi_code_cli`,
 *     `X-Msh-Version`, `X-Msh-Device-Name` (hostname),
 *     `X-Msh-Device-Model`, `X-Msh-Os-Version` (os.release()),
 *     `X-Msh-Device-Id`.
 *   - Usage: GET <region api origin>/coding/v1/usages (global `api.kimi.ai`
 *     by default; `kimi-region.ts`).
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { arch, hostname, release, type } from "node:os";
import { dirname, join } from "node:path";
import type { TProviderUsageSnapshot } from "@openllmsh/protocol";
import { QUOTA_REJECT_PERCENT, QUOTA_WARN_PERCENT } from "@openllmsh/protocol";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { cliInstallState } from "../cli-install";
import { cliConfigDir } from "../cli-paths";
import { logWarn, safeDiagnosticMessage } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { accountHashField, jwtClaims, nonEmpty } from "./account-id";
import { resolveProviderUrl, resolveUpstreamUrl } from "./auth-config";
import { cliLaunch, loginWiring, nativeRefresher } from "./delegate-shared";
import {
  cachedCliSemver,
  credentialHasFetchLifetime,
  fetchModelList,
  modelDiscoveryFromList,
  parseKimiModelList,
  skippedModelDiscovery,
} from "./fetch-model-list";
import { kimiEndpoints, writeKimiRegionMarker } from "./kimi-region";
import type { TDeviceAuth, TDevicePoll } from "./login-direct";
import { makeDeviceCodeConnect } from "./login-direct";
import { makeCancelConnect } from "./login-flow";
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
  TModelDiscoveryOptions,
  TModelDiscoveryResult,
  TProviderDelegate,
} from "./types";
import { resolveUsageCredential } from "./usage-credential";
import {
  cliVersion,
  connectedObservation,
  disconnectedObservation,
  readJsonStore,
  STATUS_CHECK_FAILED_DETAIL,
  storeReadValue,
  unknownObservation,
} from "./util";

const PROVIDER = "kimi_code" as const;
// Usage endpoint LEAF path — the host is derived from the captured inference
// endpoint (`resolveProviderUrl`), so a vendor host migration is auto-tracked.
const USAGE_PATH = "/coding/v1/usages";

// Device-code OAuth — verbatim from `ref/kimi-code/packages/oauth`
// (constants.ts + oauth.ts). Same host + public client id the CLI uses,
// so the daemon runs the CLI's own login, not a forged one.
// The host is REGION-dependent (`kimi-region.ts`; global/kimi.ai by default).
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// When the access token is within this window of `expires_at`, `readToken`
// TRIGGERS the kimi CLI's OWN native refresh (a minimal `kimi -p` inference — the
// CLI refreshes mid-request and persists it). No token endpoint or client id is
// used for REFRESH; the constants above belong to the device-code LOGIN flow,
// which the daemon must drive itself (kimi's only sign-in is the in-TUI /login).
// Kimi access tokens live ~15 min; 5 min matches grok/chatgpt/cursor so the
// background `kicked` window is a real share of that lifetime. Must stay
// strictly above `REFRESH_COOLDOWN_MS` (30 s).
const REFRESH_LEEWAY_MS = 5 * 60_000;

const { bin, env } = cliLaunch(PROVIDER);
const kimiHome = (): string => cliConfigDir(PROVIDER);
const credentialPath = (): string => kimiEndpoints().credentialPath;

type TKimiToken = {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_at?: number;
};

// kimi's native refresh is a `kimi -p` inference through the MANAGED (OAuth)
// provider — which the CLI's `ensureFresh` refreshes mid-request. `kimi -p` needs
// the managed model in config.toml, which kimi's interactive `/login` registers
// (via `provisionManagedKimiCodeConfig` → `GET /models`). The daemon drives
// device-code login DIRECTLY, so it never writes that config → `kimi -p` errors
// "No model configured" and the token never refreshes. We replicate ONLY the
// data-fetch: the managed model entries are pulled from the SAME `/models`
// endpoint and written verbatim (never hardcoded). These are the CLI's stable
// structural constants (ref/kimi-code `managed-kimi-code.ts`).
const MANAGED_PROVIDER = "managed:kimi-code"; // KIMI_CODE_PROVIDER_NAME
const MANAGED_ALIAS_PREFIX = "kimi-code"; // managedModelKey = `${this}/<id>`
const configTomlPath = (): string => join(kimiHome(), "config.toml");

// Provisioned once per process; single-flight; back off after a failed fetch.
let configEnsured = false;
let provisionInFlight: Promise<void> | null = null;
let provisionBackoffUntil = 0;

/**
 * Fetch the vendor's managed model list (`GET /coding/v1/models` — exactly the
 * call the CLI's `fetchManagedKimiCodeModels` makes after login) and write the
 * managed provider + those models into the isolated `config.toml`. The MODEL
 * entries (ids, context sizes) come straight from the API — nothing about them is
 * hardcoded; `base_url` is derived from the captured upstream host. Returns false
 * on any failure (non-200 / no models / parse).
 */
const provisionModelConfig = async (
  accessToken: string,
  base: string,
): Promise<boolean> => {
  try {
    const resp = await fetch(`${base}/models`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(await identityHeaders()),
        accept: "application/json",
      },
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as {
      data?: ReadonlyArray<Record<string, unknown>>;
    };
    const models = (body.data ?? [])
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        ctx: Number(m.context_length),
      }))
      .filter((m) => m.id.length > 0 && Number.isInteger(m.ctx) && m.ctx > 0);
    if (models.length === 0) return false;
    const { oauthKey, oauthHost } = kimiEndpoints();
    const lines: string[] = [
      `default_model = "${MANAGED_ALIAS_PREFIX}/${models[0].id}"`,
      "",
      `[providers."${MANAGED_PROVIDER}"]`,
      'type = "kimi"',
      `base_url = "${base}"`,
      'api_key = ""',
      "",
      `[providers."${MANAGED_PROVIDER}".oauth]`,
      'storage = "file"',
      `key = "${oauthKey}"`,
      // The CLI omits `oauth_host` only for the legacy mainland slot.
      ...(oauthKey === "oauth/kimi-code"
        ? []
        : [`oauth_host = "${oauthHost}"`]),
    ];
    for (const m of models) {
      lines.push(
        "",
        `[models."${MANAGED_ALIAS_PREFIX}/${m.id}"]`,
        `provider = "${MANAGED_PROVIDER}"`,
        `model = "${m.id}"`,
        `max_context_size = ${m.ctx}`,
      );
    }
    await Bun.write(configTomlPath(), `${lines.join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Ensure the isolated `config.toml` carries the managed model so `kimi -p` (the
 * native refresh path) can run. Idempotent + single-flight + backs off after a
 * failure. Called from `readToken` WHILE THE TOKEN IS VALID (the `/models` fetch
 * needs a live token), so the config is ready before the near-expiry refresh.
 */
const ensureModelConfig = async (accessToken: string): Promise<void> => {
  if (configEnsured) return;
  if (provisionInFlight !== null) return provisionInFlight;
  const base = await resolveProviderUrl(PROVIDER, "/coding/v1");
  const existing = await Bun.file(configTomlPath())
    .text()
    .catch(() => "");
  // Configured AND on the CURRENT host. If the captured upstream host migrated,
  // the stored `base_url` is stale — re-provision instead of returning early, or
  // `kimi -p` would refresh against the wrong host.
  if (
    existing.includes(MANAGED_PROVIDER) &&
    existing.includes(`base_url = "${base}"`) &&
    existing.includes(`key = "${kimiEndpoints().oauthKey}"`)
  ) {
    configEnsured = true;
    return;
  }
  if (Date.now() < provisionBackoffUntil) return;
  provisionInFlight = provisionModelConfig(accessToken, base)
    .then((ok) => {
      if (ok) configEnsured = true;
      else provisionBackoffUntil = Date.now() + 60_000;
    })
    .finally(() => {
      provisionInFlight = null;
    });
  return provisionInFlight;
};

/**
 * Trigger the kimi CLI's OWN native token refresh: a minimal `kimi -p` inference
 * through the managed (OAuth) provider. The CLI refreshes its token mid-request
 * (`ensureFresh`) and persists it; the daemon never touches the token. `kimi -p`
 * is TTY-gated (so under a PTY); the managed model it runs is provisioned by
 * `readToken` from the native `/models` list. Output ignored; bounded.
 */
const triggerRefresh = async (): Promise<void> => {
  await spawnRefresh([bin(), "-p", "ping"], env(), {
    pty: true,
    readStore: async () => {
      const tok = storeReadValue(
        await readJsonStore<TKimiToken>(credentialPath()),
      );
      return refreshCredentialSnapshot({
        accessToken: tok?.access_token,
        refreshToken: tok?.refresh_token,
      });
    },
  });
};

// Within the leeway window → fire the CLI refresh in the background (still
// valid, no stall); hard-expired → await it. Single-flight per provider.
const refresh = nativeRefresher({
  slug: PROVIDER,
  label: "Kimi Code",
  leewayMs: REFRESH_LEEWAY_MS,
  trigger: triggerRefresh,
});

const storedAccessToken = (tok: TKimiToken | null): string | null =>
  tok?.access_token !== undefined && tok.access_token.length > 0
    ? tok.access_token
    : null;

type TStoredKimiToken =
  | {
      readonly kind: "live";
      readonly tok: TKimiToken;
      readonly accessToken: string;
      readonly expiresAtMs: number | null;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

/** Stored access token only — never native-refreshes. Usage reads this. */
const readStoredToken = async (): Promise<TStoredKimiToken> => {
  const tok = storeReadValue(await readJsonStore<TKimiToken>(credentialPath()));
  if (tok?.access_token === undefined || tok.access_token.length === 0) {
    return { kind: "missing" };
  }
  const expiresAtMs =
    typeof tok.expires_at === "number" && tok.expires_at > 0
      ? tok.expires_at * 1000
      : null;
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    return { kind: "expired" };
  }
  return { kind: "live", tok, accessToken: tok.access_token, expiresAtMs };
};

/**
 * The current access token from
 * the region's credential slot under `<KIMI_CODE_HOME>/credentials/`, triggering the CLI's native
 * refresh when it's within the leeway of `expires_at`. Used by
 * `credentialForUpstream` so inference carries a live token. Passive `status()`
 * and default `usage()` must not call this — they would refresh and provision
 * model config. Manual Refresh-usage may call it under `usageNativeRefreshAllowed`.
 */
const readToken = async (): Promise<{
  accessToken: string;
  staleRefresh?: TRefreshErrorClass;
} | null> => {
  const stored = await readStoredToken();
  if (stored.kind === "missing") return null;
  const tok =
    stored.kind === "live"
      ? stored.tok
      : storeReadValue(await readJsonStore<TKimiToken>(credentialPath()));
  if (tok?.access_token === undefined || tok.access_token.length === 0) {
    return null;
  }
  const expiresAtMs =
    stored.kind === "live"
      ? stored.expiresAtMs
      : typeof tok.expires_at === "number" && tok.expires_at > 0
        ? tok.expires_at * 1000
        : null;
  // Provision the managed model config from the native `/models` list WHILE the
  // token is still valid (the fetch needs a live token), so the near-expiry
  // `kimi -p` refresh has a model to run. Idempotent — a no-op once configured.
  if (expiresAtMs === null || expiresAtMs > Date.now()) {
    await ensureModelConfig(tok.access_token);
  }
  // Only trigger when the credential CAN be refreshed — an empty/missing refresh
  // token can't (and the CLI can't either), so don't waste a spawn.
  const refreshable =
    tok.refresh_token !== undefined && tok.refresh_token.length > 0;
  if (!refreshable) credentialUnrefreshable(PROVIDER);
  const outcome = refreshable ? await refresh(expiresAtMs) : "fresh";
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
    return { accessToken: tok.access_token, staleRefresh: outcome.reason };
  }
  if (outcome !== "awaited") {
    return { accessToken: tok.access_token };
  }
  // Hard-expired path: the CLI refresh was awaited — re-read the (now-rotated)
  // credential; fall back to the stale token if it failed (the upstream then
  // 401s and the UI says re-login).
  const fresh = storeReadValue(
    await readJsonStore<TKimiToken>(credentialPath()),
  );
  const resolved = resolveToken({
    provider: PROVIDER,
    prior: tok,
    refreshed:
      fresh?.access_token !== undefined && fresh.access_token.length > 0
        ? fresh
        : null,
    hasRefreshToken: (token) =>
      token.refresh_token !== undefined && token.refresh_token.length > 0,
  });
  return { accessToken: resolved.token.access_token ?? tok.access_token };
};

// Read the persisted device id, or mint + persist one (uuid4, mode 0600)
// at `<KIMI_CODE_HOME>/device_id` — exactly `createKimiDeviceId` in
// packages/oauth identity.ts. The SAME id is used for the login device
// flow and every subsequent upstream call, so the identity is stable.
const existingDeviceId = async (): Promise<string | null> => {
  const path = join(kimiHome(), "device_id");
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const id = (await file.text()).trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
};

const ensureDeviceId = async (): Promise<string> => {
  const existing = await existingDeviceId();
  if (existing !== null) return existing;
  const path = join(kimiHome(), "device_id");
  const id = crypto.randomUUID();
  mkdirSync(kimiHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, id, { encoding: "utf-8", mode: 0o600 });
  return id;
};

const kimiVersion = async (): Promise<string> => {
  const v = await cliVersion(bin(), env());
  return v?.match(/\d+\.\d+\.\d+/)?.[0] ?? "1.0.0";
};

// Mirrors packages/oauth identity.ts deviceModel().
const deviceModel = (): string => {
  const os = type();
  const ver = release();
  const a = arch();
  if (os === "Darwin") return `macOS ${ver} ${a}`;
  if (os === "Windows_NT") return `Windows ${ver} ${a}`;
  return `${os} ${ver} ${a}`.trim();
};

const headersFor = (
  version: string,
  deviceId: string,
): Record<string, string> => ({
  "user-agent": `kimi-code-cli/${version}`,
  "x-msh-platform": "kimi_code_cli",
  "x-msh-version": version,
  "x-msh-device-name": hostname(),
  "x-msh-device-model": deviceModel(),
  "x-msh-os-version": release(),
  "x-msh-device-id": deviceId,
});

const identityHeaders = async (): Promise<Record<string, string>> =>
  headersFor(await kimiVersion(), await ensureDeviceId());

// ─── Device-code login flow ──────────────────────────────────────────────
//
// kimi DRIVES the device-code flow; the direct-login adaptor ORCHESTRATES it
// (surface URL+code → background poll). The request (`TDeviceAuth`) + poll
// (`TDevicePoll`) shapes are the adaptor's generic contract, imported above.

const postForm = async (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> => {
  const resp = await fetch(`${kimiEndpoints().oauthHost}${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  let data: Record<string, unknown> = {};
  try {
    const parsed = (await resp.json()) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // non-JSON — caller interprets by status
  }
  return { status: resp.status, data };
};

const requestDeviceCode = async (
  headers: Record<string, string>,
): Promise<TDeviceAuth | null> => {
  try {
    const { status, data } = await postForm(
      "/api/oauth/device_authorization",
      { client_id: OAUTH_CLIENT_ID },
      headers,
    );
    const deviceCode = data.device_code;
    const userCode = data.user_code;
    const uriComplete = data.verification_uri_complete;
    if (
      status !== 200 ||
      typeof deviceCode !== "string" ||
      typeof userCode !== "string" ||
      typeof uriComplete !== "string"
    ) {
      return null;
    }
    const interval = Number(data.interval ?? 5);
    const expiresIn = Number(data.expires_in ?? 900);
    return {
      userCode,
      deviceCode,
      verificationUriComplete: uriComplete,
      intervalMs:
        (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
      expiresInMs:
        (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    };
  } catch {
    return null;
  }
};

const pollDeviceToken = async (
  deviceCode: string,
  headers: Record<string, string>,
): Promise<TDevicePoll> => {
  const { status, data } = await postForm(
    "/api/oauth/token",
    {
      client_id: OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
    },
    headers,
  );
  if (status === 200 && typeof data.access_token === "string") {
    return { kind: "success", wire: data };
  }
  const code = typeof data.error === "string" ? data.error : "";
  if (code === "authorization_pending")
    return { kind: "pending", slowDown: false };
  if (code === "slow_down") return { kind: "pending", slowDown: true };
  return { kind: "stop" }; // expired_token / access_denied / anything else
};

// Persist the token in the EXACT wire shape the CLI's FileTokenStorage
// writes (`tokenToWire`): snake_case, `expires_at` epoch SECONDS. mode
// 0600 file under a 0700 credentials dir, matching packages/oauth.
const writeCredential = (wire: Record<string, unknown>): void => {
  const expiresIn = Number(wire.expires_in ?? 0);
  const blob = {
    access_token: String(wire.access_token ?? ""),
    refresh_token: String(wire.refresh_token ?? ""),
    expires_at:
      Math.floor(Date.now() / 1000) +
      (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0),
    scope: typeof wire.scope === "string" ? wire.scope : "",
    token_type:
      typeof wire.token_type === "string" ? wire.token_type : "Bearer",
    expires_in: Number.isFinite(expiresIn) ? expiresIn : 0,
  };
  const { credentialPath: path, region } = kimiEndpoints();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.kimi-code-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, JSON.stringify(blob), { encoding: "utf-8", mode: 0o600 });
  // Same-directory rename is atomic: readers see either the old complete
  // credential or the new complete credential, never a truncated JSON write.
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Cleanup cannot replace the original write failure.
    }
    throw error;
  }
  writeKimiRegionMarker(region);
};

// ─── /usages parsing ─────────────────────────────────────────────────────
//
// Port of `parseManagedUsagePayload` (ref/kimi-code packages/oauth
// managed-usage.ts). The payload is:
//   { usage: { name, used, limit, resetAt },
//     limits: [ { detail: {used,limit,name}, window: {duration,timeUnit} } ] }
// Field spelling/casing drifts across versions, so the parse is loose:
// `used` or `limit - remaining`; name from name/title/scope or a duration
// label; reset from any of reset_at/resetAt/reset_time/resetTime.

type TUsageRow = {
  readonly label: string;
  readonly percentUsed: number;
  readonly resetAtMs: number | null;
};

const toInt = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || v.trim() === "")) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

const resetAtMsOf = (raw: Record<string, unknown>): number | null => {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
};

const toUsageRow = (raw: unknown, fallbackLabel: string): TUsageRow | null => {
  if (!isRec(raw)) return null;
  const limit = toInt(raw.limit);
  let used = toInt(raw.used);
  if (used === null) {
    const remaining = toInt(raw.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (limit === null || limit <= 0 || used === null) return null;
  const label =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.title === "string"
        ? raw.title
        : fallbackLabel;
  return {
    label,
    percentUsed: Math.max(0, Math.min(100, (used / limit) * 100)),
    resetAtMs: resetAtMsOf(raw),
  };
};

// Derive a friendly window label (mirrors `limitLabel` in managed-usage.ts):
// an explicit name/title/scope, else from the window's duration + timeUnit
// (e.g. 300 TIME_UNIT_MINUTE → "5h limit"), else a positional fallback.
const limitLabel = (
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  idx: number,
): string => {
  for (const key of ["name", "title", "scope"]) {
    const v = item[key] ?? detail[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const duration = toInt(window.duration ?? item.duration ?? detail.duration);
  const rawUnit = window.timeUnit ?? item.timeUnit ?? detail.timeUnit;
  const unit = typeof rawUnit === "string" ? rawUnit : "";
  if (duration !== null) {
    if (unit.includes("MINUTE")) {
      return duration >= 60 && duration % 60 === 0
        ? `${duration / 60}h limit`
        : `${duration}m limit`;
    }
    if (unit.includes("HOUR")) return `${duration}h limit`;
    if (unit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
};

const parseUsageWindows = (payload: unknown): ReadonlyArray<TUsageRow> => {
  if (!isRec(payload)) return [];
  const rows: TUsageRow[] = [];
  const summary = toUsageRow(payload.usage, "Weekly limit");
  if (summary !== null) rows.push(summary);
  const rawLimits = payload.limits;
  if (Array.isArray(rawLimits)) {
    rawLimits.forEach((item, idx) => {
      if (!isRec(item)) return;
      const detail = isRec(item.detail) ? item.detail : item;
      const window = isRec(item.window) ? item.window : {};
      const row = toUsageRow(detail, limitLabel(item, detail, window, idx));
      if (row !== null) rows.push(row);
    });
  }
  return rows;
};

/** Parse a Kimi `/usages` response without fabricating a zero-percent window
 * from missing quota fields. */
export const parseKimiUsage = (payload: unknown): TProviderUsageSnapshot => {
  const rows = parseUsageWindows(payload);
  if (rows.length === 0) {
    return {
      kind: "unavailable",
      reason: "/usages had no parseable window",
    };
  }
  const windows = rows.map((row) => ({
    label: row.label,
    percent_used: row.percentUsed,
    reset_at_ms: row.resetAtMs,
  }));
  const maxPct = windows.reduce(
    (max, window) => Math.max(max, window.percent_used),
    0,
  );
  return {
    kind: "quota",
    status:
      maxPct >= QUOTA_REJECT_PERCENT
        ? "rejected"
        : maxPct >= QUOTA_WARN_PERCENT
          ? "allowed_warning"
          : "allowed",
    windows,
    note: "Kimi Code — read locally via Kimi CLI",
  };
};

// ─── Login wiring ────────────────────────────────────────────────────────
//
// kimi's only sign-in is the device-code flow, driven via the direct-login
// adaptor; `cancelConnect` aborts the background poll through the shared slot.

const {
  installHint,
  connectedDetail,
  inProgressDetail,
  isInstalled,
  isConnected,
  refreshConfig,
  slot,
} = loginWiring({
  provider: PROVIDER,
  installHint:
    "Kimi CLI not found — re-run the OpenLLM daemon installer to add it.",
  connectedDetail: "signed in via Kimi Code",
  inProgressDetail:
    "Kimi sign-in already in progress — finish authorizing in your browser; this updates automatically.",
  readToken,
});
// Identity headers (UA + device id) computed ONCE per login (single-flight
// guarantees no overlap) and reused by the device-code request + every poll,
// matching the pre-refactor flow which captured `headers` once in `connect`.
let loginHeaders: Record<string, string> = {};

const connectDevice = makeDeviceCodeConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint,
  connected: isConnected,
  connectedDetail,
  inProgressDetail,
  requestDeviceAuth: async () => {
    loginHeaders = await identityHeaders();
    return requestDeviceCode(loginHeaders);
  },
  pollToken: (deviceCode) => pollDeviceToken(deviceCode, loginHeaders),
  onCredential: (wire) => writeCredential(wire),
  // Refresh the auth config (upstream URL) now the identity is established.
  onConnected: refreshConfig,
  pendingDetail: (auth) =>
    `Authorize Kimi in the browser window that just opened (code ${auth.userCode}). This page updates automatically when you're done — or open ${auth.verificationUriComplete}`,
  startFailDetail:
    "Couldn't start Kimi sign-in (device authorization failed). Check your connection and retry.",
});

const cancelConnect = makeCancelConnect(PROVIDER, slot, {
  cancelled: "Kimi sign-in cancelled",
  none: "no sign-in was in progress",
});

export const kimiCodeDelegate: TProviderDelegate = {
  slug: PROVIDER,
  primaryLoginMethod: "device",
  statusCancellable: false,

  // Moonshot's endpoint rejects tool-schema `$ref`s not based at `#/$defs/`
  // ("not a valid moonshot flavored json schema … references must start with
  // #/$defs/"); the walker normalizes them before the upstream call. See
  // docs/proposals/kimi-tool-schema-ref-normalization.md.
  normalizesToolSchemaRefs: true,

  connect: connectDevice,
  cancelConnect,

  // Passive observation from ONE typed credential snapshot. Do not call
  // `readToken()` here — that refreshes via `kimi -p` and may provision config.
  status: async () => {
    const { installed, version } = await cliInstallState(PROVIDER);
    const store = installed
      ? await readJsonStore<TKimiToken>(credentialPath())
      : null;
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
    const accessToken = storedAccessToken(
      store?.kind === "present" ? store.value : null,
    );
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
                  ? "kimi CLI installed but not signed in"
                  : "kimi CLI not installed",
          }
        : {
            last_login_at_ms: null,
            // Stable Kimi account identity, hashed (`account-id.ts`) — the
            // `user_id` (= `sub`) claim of the stored access-token JWT. NOT
            // `device_id` (per-device) or `token_id`/`jti` (per-token).
            ...accountHashField(PROVIDER, jwtClaims(accessToken)?.user_id),
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
        missingReason: "not signed in to Kimi CLI",
        accountIdOf: (value) => nonEmpty(jwtClaims(value.accessToken)?.user_id),
        priorAccountIdWhenExpired: async () =>
          nonEmpty(
            jwtClaims(
              storeReadValue(await readJsonStore<TKimiToken>(credentialPath()))
                ?.access_token ?? "",
            )?.user_id,
          ),
        readNative: async () => {
          await readToken();
          // Native inference readers may return a stale fallback on failure.
          // Usage must verify the persisted token is now live before fetching.
          const fresh = await readStoredToken();
          return fresh.kind === "live" ? fresh : null;
        },
      });
      if (cred.kind === "unavailable") return cred;
      const { accessToken, tok } = cred.value;
      try {
        const resp = await fetch(
          await resolveProviderUrl(PROVIDER, USAGE_PATH),
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${accessToken}`,
              ...(await identityHeaders()),
              accept: "application/json",
            },
          },
        );
        if (!resp.ok) {
          // Phrase like the Kimi CLI itself (packages/oauth managed-usage):
          // 401 = the token was rejected — your Kimi Code subscription has
          // likely run out / is inactive, or the session needs a re-login.
          // 403 = the coding feature isn't available to this account.
          // 404 = the usage endpoint isn't enabled for this plan.
          const hasRefreshToken =
            tok.refresh_token !== undefined && tok.refresh_token.length > 0;
          const reason =
            resp.status === 401
              ? hasRefreshToken
                ? "Kimi Code authorization was rejected — this machine could not refresh the sign-in. Try again."
                : "Kimi Code authorization was rejected — your subscription may be inactive or expired. Re-sign in via the Kimi CLI (/login)."
              : resp.status === 403
                ? "No active Kimi Code subscription — your coding plan has run out or isn't enabled for this account."
                : resp.status === 404
                  ? "Kimi Code usage isn't available on this plan."
                  : `Kimi Code couldn't report usage (HTTP ${resp.status}).`;
          return { kind: "unavailable", reason };
        }
        // Parse the `{ usage, limits[] }` payload into one window per limit
        // (+ the rolled-up summary), skipping incomplete quota rows. NO tier is
        // attached: Kimi Code exposes no subscription tier through any surface
        // reachable here — the `/usages` payload is limits + a credit balance,
        // the access-token JWT carries only identity claims (client_id, device_id,
        // sub, user_id, scope, region, … — no level/plan/membership), and the
        // vendor reference has no userinfo/account endpoint. So kimi rows simply
        // omit the tier rather than fabricate one. See ref/kimi-code.
        return parseKimiUsage(await resp.json());
      } catch (err) {
        return {
          kind: "unavailable",
          reason: err instanceof Error ? err.message : "usage fetch failed",
        };
      }
    }),

  listModels: () =>
    withRefreshCaller("models", async () => {
      // Same `GET /coding/v1/models` call `provisionModelConfig` makes —
      // the vendor's per-subscription list (ids + `context_length`),
      // reported to the cloud's model cache so `/v1/models` reflects what
      // THIS subscription actually serves. Metadata only; bounded + null
      // on any failure via `fetchModelList`.
      const token = await readToken();
      if (token === null) return null;
      const base = await resolveProviderUrl(PROVIDER, "/coding/v1");
      return fetchModelList(
        `${base}/models`,
        {
          authorization: `Bearer ${token.accessToken}`,
          ...(await identityHeaders()),
          accept: "application/json",
        },
        parseKimiModelList,
      );
    }),

  discoverModels: async (
    options: TModelDiscoveryOptions,
  ): Promise<TModelDiscoveryResult> => {
    const ver = cachedCliSemver(options.cliVersion);
    const deviceId = await existingDeviceId();
    if (ver === null || deviceId === null) return skippedModelDiscovery();
    const store = await readJsonStore<TKimiToken>(credentialPath());
    if (store.kind !== "present") return skippedModelDiscovery();
    const accessToken = storedAccessToken(store.value);
    if (accessToken === null) return skippedModelDiscovery();
    const expiresAtMs =
      typeof store.value.expires_at === "number" && store.value.expires_at > 0
        ? store.value.expires_at * 1000
        : null;
    if (!credentialHasFetchLifetime(expiresAtMs, REFRESH_LEEWAY_MS)) {
      return skippedModelDiscovery();
    }
    const base = await resolveProviderUrl(PROVIDER, "/coding/v1");
    return modelDiscoveryFromList(
      await fetchModelList(
        `${base}/models`,
        {
          authorization: `Bearer ${accessToken}`,
          ...headersFor(ver, deviceId),
          accept: "application/json",
        },
        parseKimiModelList,
      ),
    );
  },

  credentialForUpstream: () =>
    withRefreshCaller("upstream", async () => {
      const token = await readToken();
      if (token === null) {
        throw new Error("kimi_code: not signed in (no stored credential)");
      }
      // Resolve the request TARGET URL — the genuine OpenAI-wire
      // `/coding/v1/chat/completions` endpoint, captured from `kimi -p ping` (or
      // the default) — and inject kimi's CREDENTIAL-BINDING identity. Kimi's
      // managed endpoint binds the token to its kimi-code client identity and
      // VALIDATES the full `x-msh-*` set + UA on every request (it 403s on any
      // subset — confirmed live with just device-id/platform/version). The daemon
      // legitimately holds a kimi-code credential (it ran kimi's OWN device-code
      // OAuth, registering `x-msh-device-id`), so presenting that identity is
      // credential-intrinsic, not a forged CLI identity — unlike claude/codex,
      // kimi's token is unusable without it. These are spread OVER the
      // originator's headers in the walker, so the kimi-code UA/device identity
      // wins for this hop. `identityHeaders()` is the same set used for the
      // device-login + /usages calls.
      const url = await resolveUpstreamUrl(PROVIDER);
      return {
        access_token: token.accessToken,
        headers: await identityHeaders(),
        url,
        // Which account this hop's cost attributes to (recorded on the row).
        ...accountHashField(PROVIDER, jwtClaims(token.accessToken)?.user_id),
        ...(token.staleRefresh !== undefined
          ? { stale_refresh: token.staleRefresh }
          : {}),
      };
    }),

  logout: async () => {
    // Kimi's CLI has no spawnable logout (device-code only) — clear the
    // isolated credential file. The device_id is kept (stable per box).
    await rm(credentialPath(), { force: true }).catch(() => {});
    // Drop the region pin too, so the next login lands on the default
    // (global) region unless the user re-pins it.
    await rm(join(kimiHome(), "region"), { force: true }).catch(() => {});
    noteAuthStoreIdentityChange(PROVIDER);
    const cleared = (await readToken()) === null;
    return cleared
      ? { ok: true, detail: "removed Kimi Code credential" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
