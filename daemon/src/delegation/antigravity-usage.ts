/**
 * Google Antigravity quota windows — the same read t3code ships
 * (pingdotgg/t3code `apps/server/src/provider/antigravityUsageLimits.ts`).
 *
 * The ACP agent exposes no quota method, so this reads the agent's own token
 * file (`<GEMINI_HOME>/antigravity-acp/acp_token.json`), mints a short-lived
 * access token from its refresh token, and POSTs Google's Code Assist
 * `v1internal:retrieveUserQuotaSummary` (falling back to
 * `v1internal:fetchAvailableModels` for older accounts) — the calls the agent
 * itself makes, under the agent's User-Agent.
 *
 * Bounds (deliberately accepted risk, see the delegate's `usage()`):
 *   - read-only: the token file is never written; the access token lives in
 *     memory only and goes nowhere but Google's OAuth + Code Assist hosts;
 *   - demand-driven: runs only when `usage()` is asked (no background poll);
 *   - every failure maps to `unavailable` / a classified refresh failure.
 */
import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import type {
  TProviderUsageSnapshot,
  TProviderUsageWindow,
} from "@openllmsh/protocol";
import { QUOTA_REJECT_PERCENT, QUOTA_WARN_PERCENT } from "@openllmsh/protocol";
import { antigravityTokenPath } from "../native-runtime/antigravity-acp";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh the cached access token this long before Google's expiry. */
const EXPIRY_SKEW_MS = 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const ANTIGRAVITY_PLANS_URL = "https://antigravity.google/docs/plans";

type TTokenFile = {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  readonly project_id?: string;
};

type TQuota = {
  readonly remainingFraction?: unknown;
  readonly resetTime?: unknown;
};

type TBucket = TQuota & {
  readonly bucketId?: unknown;
  readonly window?: unknown;
  readonly displayName?: unknown;
  readonly disabled?: unknown;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The agent's token file, or null when absent/unparseable. Never logged. */
const readTokenFile = async (
  geminiHome: string,
): Promise<TTokenFile | null> => {
  let raw: string;
  try {
    raw = await readFile(antigravityTokenPath(geminiHome), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !nonEmpty(parsed.client_id) ||
      !nonEmpty(parsed.client_secret) ||
      !nonEmpty(parsed.refresh_token)
    ) {
      return null;
    }
    return {
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
      refresh_token: parsed.refresh_token,
      ...(nonEmpty(parsed.project_id) ? { project_id: parsed.project_id } : {}),
    };
  } catch {
    return null;
  }
};

class UsageHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const postJson = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> => {
  const res = await fetchImpl(url, {
    ...init,
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new UsageHttpError(res.status);
  return res.json();
};

const agentUserAgent = (): string =>
  `antigravity/hub/1.0.0 (aidev_client; os_type=${platform()}; arch=${arch()}; cl=963137146)`;

const resetMs = (value: unknown): number | null => {
  if (!nonEmpty(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const toWindow = (
  label: string,
  meterId: string,
  quota: TQuota,
  windowMs: number | undefined,
): TProviderUsageWindow | null => {
  const remaining = quota.remainingFraction;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  return {
    label,
    meter_id: meterId,
    percent_used: (1 - Math.max(0, Math.min(1, remaining))) * 100,
    reset_at_ms: resetMs(quota.resetTime),
    ...(windowMs !== undefined ? { window_ms: windowMs } : {}),
  };
};

/** `retrieveUserQuotaSummary` → windows (Claude + GPT share one allowance). */
export const summaryWindows = (summary: unknown): TProviderUsageWindow[] => {
  const s = summary as {
    readonly groups?: ReadonlyArray<{
      readonly displayName?: unknown;
      readonly buckets?: ReadonlyArray<TBucket>;
    }>;
    readonly buckets?: ReadonlyArray<TBucket>;
  } | null;
  const groups = s?.groups?.some((g) => (g.buckets?.length ?? 0) > 0)
    ? s.groups
    : [{ displayName: undefined, buckets: s?.buckets }];
  const out = new Map<string, TProviderUsageWindow>();
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled === true || !nonEmpty(bucket.bucketId)) continue;
      const family = bucket.bucketId.startsWith("gemini-")
        ? "Gemini"
        : bucket.bucketId.startsWith("3p-")
          ? "Claude & GPT"
          : nonEmpty(group.displayName)
            ? group.displayName.trim()
            : bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const window = toWindow(
        `${family} ${weekly ? "7-day" : session ? "5-hour" : nonEmpty(bucket.displayName) ? bucket.displayName.trim() : "quota"}`,
        bucket.bucketId,
        bucket,
        weekly ? WEEK_MS : session ? FIVE_HOURS_MS : undefined,
      );
      if (window !== null) out.set(bucket.bucketId, window);
    }
  }
  return [...out.values()];
};

/** `fetchAvailableModels` fallback (older accounts; no window length stated
 *  for the non-weekly quota — never invent a cadence). */
export const modelWindows = (body: unknown): TProviderUsageWindow[] => {
  const models =
    (body as { readonly models?: Record<string, unknown> } | null)?.models ??
    {};
  const out = new Map<string, TProviderUsageWindow>();
  for (const [modelId, raw] of Object.entries(models)) {
    const model = raw as {
      readonly modelProvider?: unknown;
      readonly quotaInfo?: TQuota;
      readonly weeklyQuotaInfo?: TQuota;
    };
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" ||
      modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" ||
            modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" ||
              modelId.startsWith("gpt-")
            ? "GPT"
            : null;
    if (family === null) continue;
    for (const [suffix, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (quota === undefined) continue;
      const id = `${family.toLowerCase()}-${suffix}`;
      const window = toWindow(
        `${family} ${suffix === "weekly" ? "7-day" : "quota"}`,
        id,
        quota,
        suffix === "weekly" ? WEEK_MS : undefined,
      );
      if (window === null) continue;
      const previous = out.get(id);
      if (
        previous === undefined ||
        window.percent_used > previous.percent_used
      ) {
        out.set(id, window);
      }
    }
  }
  return [...out.values()];
};

const fetchWindows = async (
  fetchImpl: typeof fetch,
  accessToken: string,
  projectId: string | undefined,
  operation: "retrieveUserQuotaSummary" | "fetchAvailableModels",
  parse: (body: unknown) => TProviderUsageWindow[],
): Promise<TProviderUsageWindow[]> => {
  for (const endpoint of ENDPOINTS) {
    try {
      const windows = parse(
        await postJson(fetchImpl, `${endpoint}/v1internal:${operation}`, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "user-agent": agentUserAgent(),
          },
          body: JSON.stringify(
            projectId !== undefined ? { project: projectId } : {},
          ),
        }),
      );
      if (windows.length > 0) return windows;
    } catch (error) {
      // Auth rejection is terminal for this read; anything else tries the
      // next endpoint (matches t3code's per-endpoint fallback).
      if (error instanceof UsageHttpError && error.status === 401) throw error;
    }
  }
  return [];
};

export type TAntigravityUsageReader = {
  readonly readAntigravityUsage: (params: {
    readonly geminiHome: string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: number;
  }) => Promise<TProviderUsageSnapshot>;
};

export const createAntigravityUsageReader = (): TAntigravityUsageReader => {
  /** Memory-only access-token cache, keyed by the refresh token it came from. */
  let cached: {
    readonly refreshToken: string;
    readonly accessToken: string;
    readonly expiresAt: number;
  } | null = null;

  const accessTokenFor = async (
    fetchImpl: typeof fetch,
    token: TTokenFile,
    now: number,
  ): Promise<string> => {
    if (
      cached !== null &&
      cached.refreshToken === token.refresh_token &&
      cached.expiresAt > now + EXPIRY_SKEW_MS
    ) {
      return cached.accessToken;
    }
    cached = null;
    const body = (await postJson(fetchImpl, OAUTH_TOKEN_URL, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: token.client_id,
        client_secret: token.client_secret,
        refresh_token: token.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    })) as { readonly access_token?: unknown; readonly expires_in?: unknown };
    if (
      !nonEmpty(body.access_token) ||
      typeof body.expires_in !== "number" ||
      body.expires_in <= 0
    ) {
      throw new Error("token refresh returned no access token");
    }
    cached = {
      refreshToken: token.refresh_token,
      accessToken: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
    return body.access_token;
  };

  const readAntigravityUsage = async (params: {
    readonly geminiHome: string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: number;
  }): Promise<TProviderUsageSnapshot> => {
    const fetchImpl = params.fetchImpl ?? fetch;
    const token = await readTokenFile(params.geminiHome);
    if (token === null) {
      return {
        kind: "unavailable",
        reason: "Sign in with Google to see Antigravity limits.",
        link: ANTIGRAVITY_PLANS_URL,
      };
    }
    let windows: TProviderUsageWindow[];
    try {
      const accessToken = await accessTokenFor(
        fetchImpl,
        token,
        params.now ?? Date.now(),
      );
      windows = await fetchWindows(
        fetchImpl,
        accessToken,
        token.project_id,
        "retrieveUserQuotaSummary",
        summaryWindows,
      );
      if (windows.length === 0) {
        windows = await fetchWindows(
          fetchImpl,
          accessToken,
          token.project_id,
          "fetchAvailableModels",
          modelWindows,
        );
      }
    } catch (error) {
      if (error instanceof UsageHttpError && error.status === 401)
        cached = null;
      return {
        kind: "unavailable",
        reason:
          error instanceof UsageHttpError
            ? `Antigravity limits unavailable (HTTP ${error.status}).`
            : "Antigravity limits unavailable.",
        link: ANTIGRAVITY_PLANS_URL,
      };
    }
    if (windows.length === 0) {
      return {
        kind: "unavailable",
        reason: "Antigravity did not return usable quota information.",
        link: ANTIGRAVITY_PLANS_URL,
      };
    }
    // Gemini and Claude/GPT are SEPARATE allowances: one exhausted family must
    // not mark the whole provider rejected (the quota gate would then skip
    // Gemini hops that still have room). Reject only when every window is out.
    const percents = windows.map((w) => w.percent_used);
    return {
      kind: "quota",
      status: percents.every((p) => p >= QUOTA_REJECT_PERCENT)
        ? "rejected"
        : percents.some((p) => p >= QUOTA_WARN_PERCENT)
          ? "allowed_warning"
          : "allowed",
      windows,
      note: "Google Antigravity — includes usage outside OpenLLM",
    };
  };

  return { readAntigravityUsage };
};

const defaultReader = createAntigravityUsageReader();

export const readAntigravityUsage = (
  params: Parameters<TAntigravityUsageReader["readAntigravityUsage"]>[0],
): Promise<TProviderUsageSnapshot> =>
  defaultReader.readAntigravityUsage(params);

/**
 * Stable raw account id for `account_hash`, read from the agent's token file
 * (local read, no spawn, no network). Prefers the Code Assist `project_id`,
 * which Google provisions per user and keeps across re-logins; falls back to
 * the refresh token, which identifies the account but rotates on re-login
 * (a weaker key: a re-login may read as a new account until the project id
 * is present). Never logged; only its hash leaves this module.
 */
export const readAntigravityAccountId = async (
  geminiHome: string,
): Promise<string | null> => {
  const token = await readTokenFile(geminiHome);
  if (token === null) return null;
  return token.project_id !== undefined
    ? `project:${token.project_id}`
    : `refresh:${token.refresh_token}`;
};
