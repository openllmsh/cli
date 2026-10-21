import type { TProviderModelEntry } from "@openllmsh/protocol";
import { MODEL_LIST_FETCH_TIMEOUT_MS } from "@openllmsh/protocol";
import type {
  TFetchModelListDetailed,
  TListModelsNullReason,
  TListModelsOptions,
  TModelDiscoveryResult,
} from "./types";

export type { TFetchModelListDetailed, TListModelsNullReason };

/**
 * Coerce a provider-reported value into a positive integer, or
 * `undefined` — the shared shape check for `context_window` /
 * `context_length` fields across the delegate parsers.
 */
export const positiveInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

const asRecords = (v: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
};

/** Anthropic-shaped `{ data: [{ id, display_name, created_at }] }`. */
export const parseClaudeModelList = (
  body: unknown,
): ReadonlyArray<TProviderModelEntry> => {
  const data = asRecords(
    body !== null && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined,
  );
  return data.flatMap((m) => {
    if (typeof m.id !== "string" || m.id.length === 0) return [];
    const createdMs =
      typeof m.created_at === "string" ? Date.parse(m.created_at) : Number.NaN;
    return [
      {
        provider_model_id: m.id,
        ...(typeof m.display_name === "string"
          ? { display_name: m.display_name }
          : {}),
        ...(Number.isFinite(createdMs)
          ? { created: Math.floor(createdMs / 1000) }
          : {}),
      },
    ];
  });
};

/** Codex `{ models: [{ slug, display_name, visibility, context_window }] }`. */
export const parseChatgptModelList = (
  body: unknown,
): ReadonlyArray<TProviderModelEntry> => {
  const models = asRecords(
    body !== null && typeof body === "object"
      ? (body as { models?: unknown }).models
      : undefined,
  );
  return models.flatMap((m) => {
    if (typeof m.slug !== "string" || m.slug.length === 0) return [];
    if (m.visibility !== "list") return [];
    const ctx = positiveInt(m.context_window);
    return [
      {
        provider_model_id: m.slug,
        ...(typeof m.display_name === "string"
          ? { display_name: m.display_name }
          : {}),
        ...(ctx !== undefined ? { context_window: ctx } : {}),
      },
    ];
  });
};

/** Kimi `{ data: [{ id, context_length }] }`. */
export const parseKimiModelList = (
  body: unknown,
): ReadonlyArray<TProviderModelEntry> => {
  const data = asRecords(
    body !== null && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined,
  );
  return data.flatMap((m) => {
    if (typeof m.id !== "string" || m.id.length === 0) return [];
    const ctx = positiveInt(m.context_length);
    return [
      {
        provider_model_id: m.id,
        ...(ctx !== undefined ? { context_window: ctx } : {}),
      },
    ];
  });
};

/** Grok OpenAI-wire rows `{ id, display_name, context_window|context_length }`. */
export const parseGrokModelRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<TProviderModelEntry> =>
  rows.flatMap((m) => {
    if (typeof m.id !== "string" || m.id.length === 0) return [];
    const ctx = positiveInt(m.context_window ?? m.context_length);
    return [
      {
        provider_model_id: m.id,
        ...(typeof m.display_name === "string"
          ? { display_name: m.display_name }
          : {}),
        ...(ctx !== undefined ? { context_window: ctx } : {}),
      },
    ];
  });

export const parseGrokModelList = (
  body: unknown,
): ReadonlyArray<TProviderModelEntry> => {
  if (body === null || typeof body !== "object") return [];
  const rec = body as { data?: unknown; models?: unknown };
  return parseGrokModelRows(asRecords(rec.data ?? rec.models));
};

/** Map an HTTP status onto the closed listModels null reason. */
export const httpNullReason = (status: number): TListModelsNullReason =>
  Number.isInteger(status) && status >= 100 && status <= 599
    ? (`http_${status}` as const)
    : "error";

/**
 * Shared fetch for delegate `listModels()` implementations: bounded
 * timeout, JSON body handed to the caller's provider-specific `parse`,
 * and `null` on ANY failure (non-2xx / timeout / parse / empty) —
 * never an empty list, so a vendor hiccup can't wipe a user's cached
 * entries. Common behavior (like this timeout) lives here once instead
 * of per delegate. Prefer {@link fetchModelListDetailed} when the caller
 * needs a closed null-reason for doctor telemetry.
 */
export const fetchModelListDetailed = async (
  url: string,
  headers: Readonly<Record<string, string>>,
  parse: (body: unknown) => ReadonlyArray<TProviderModelEntry>,
): Promise<TFetchModelListDetailed> => {
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { kind: "null", reason: httpNullReason(resp.status) };
    }
    const entries = parse(await resp.json());
    if (entries.length === 0) {
      return { kind: "null", reason: "empty_after_filter" };
    }
    return { kind: "ok", models: entries };
  } catch {
    return { kind: "null", reason: "error" };
  }
};

export const fetchModelList = async (
  url: string,
  headers: Readonly<Record<string, string>>,
  parse: (body: unknown) => ReadonlyArray<TProviderModelEntry>,
): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
  const detailed = await fetchModelListDetailed(url, headers, parse);
  return detailed.kind === "ok" ? detailed.models : null;
};

/**
 * Run a detailed listModels attempt, forward a closed null reason through
 * `opts.onNullReason`, and keep the null-never-empty contract.
 */
export const listWithReason = async (
  opts: TListModelsOptions | undefined,
  run: () => Promise<TFetchModelListDetailed>,
): Promise<ReadonlyArray<TProviderModelEntry> | null> => {
  const detailed = await run();
  if (detailed.kind === "null") {
    opts?.onNullReason?.(detailed.reason);
    return null;
  }
  return detailed.models;
};

/**
 * Map a CLI/subprocess listing (null = exec failure, [] = empty) onto the
 * shared detailed shape used by {@link listWithReason}.
 */
export const detailedFromCliList = (
  listed: ReadonlyArray<TProviderModelEntry> | null,
): TFetchModelListDetailed => {
  if (listed === null) return { kind: "null", reason: "error" };
  if (listed.length === 0) {
    return { kind: "null", reason: "empty_after_filter" };
  }
  return { kind: "ok", models: listed };
};

/**
 * Auto-discovery must not start a fetch that would race expiry or trip
 * the native refresher. Unknown expiry is not proof of lifetime.
 */
export const credentialHasFetchLifetime = (
  expiresAtMs: number | null,
  leewayMs: number,
  now: number = Date.now(),
): boolean => {
  if (expiresAtMs === null) return false;
  return expiresAtMs - now > Math.max(leewayMs, MODEL_LIST_FETCH_TIMEOUT_MS);
};

export const cachedCliSemver = (
  cliVersion: string | undefined,
): string | null => {
  if (cliVersion === undefined || cliVersion.length === 0) return null;
  return cliVersion.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
};

export const modelDiscoveryFromList = (
  entries: ReadonlyArray<TProviderModelEntry> | null,
): TModelDiscoveryResult =>
  entries === null || entries.length === 0
    ? { kind: "failed" }
    : { kind: "success", models: entries };

export const skippedModelDiscovery = (): TModelDiscoveryResult => ({
  kind: "skipped",
});
