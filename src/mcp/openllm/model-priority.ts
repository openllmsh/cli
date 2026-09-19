/**
 * Subscription-first presentation of `/v1/models` MCP results.
 * Reorder is MCP-side only — the HTTP catalog is unchanged.
 */

import { SUBSCRIPTION_PROVIDER_SLUGS } from "../../sdk/generated/subscription-providers";
import type { TToolResult, TToolResultContent } from "../types";

/** MCP tool name for GET /v1/models (`v1Models.list`). */
export const MODELS_TOOL_NAME = "api_v1Models_list";

const SUBSCRIPTION_SLUGS: ReadonlySet<string> = new Set(
  SUBSCRIPTION_PROVIDER_SLUGS,
);

const compactSubscriptionId = (id: string): boolean => {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return false;
  return SUBSCRIPTION_SLUGS.has(id.slice(0, slash));
};

const isDirectSubscriptionId = (rec: Record<string, unknown>): boolean =>
  typeof rec.provider === "string" &&
  rec.provider !== "fallback-chain" &&
  SUBSCRIPTION_SLUGS.has(rec.provider) &&
  typeof rec.id === "string" &&
  rec.id.startsWith(`${rec.provider}/`) &&
  rec.id.length > rec.provider.length + 1;

const isSubscriptionCatalogEntry = (entry: unknown): boolean => {
  if (typeof entry !== "object" || entry === null) return false;
  const rec = entry as Record<string, unknown>;
  if (rec.provider_type === "api_key") return false;
  if (rec.provider === "fallback-chain") return false;
  if (rec.provider_type === "subscription") {
    return isDirectSubscriptionId(rec);
  }
  if (Object.hasOwn(rec, "provider")) {
    return isDirectSubscriptionId(rec);
  }
  return typeof rec.id === "string" && compactSubscriptionId(rec.id);
};

const reorderModelsListText = (text: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.object !== "list" || !Array.isArray(rec.data)) return null;
  const originalData: unknown[] = rec.data;

  const subscription: unknown[] = [];
  const rest: unknown[] = [];
  for (const item of originalData) {
    if (isSubscriptionCatalogEntry(item)) subscription.push(item);
    else rest.push(item);
  }
  const data = [...subscription, ...rest];
  if (data.every((entry, index) => entry === originalData[index])) return null;
  return JSON.stringify({ ...rec, data }, null, 2);
};

/**
 * Stable-partition success `/v1/models` JSON text blocks so subscription
 * catalog entries come first. Malformed JSON, non-list envelopes, error
 * results, and non-text blocks are returned unchanged. Extra envelope
 * fields are preserved. Classification uses provider_type when present, else
 * provider + namespaced ID, else a compact provider/model ID only when
 * provider is absent. Aliases and conflicting metadata never match.
 */
export const prioritizeSubscriptionModels = (
  result: TToolResult,
): TToolResult => {
  if (result.isError === true) return result;
  return {
    ...result,
    content: result.content.map((block): TToolResultContent => {
      if (block.type !== "text") return block;
      const next = reorderModelsListText(block.text);
      if (next === null) return block;
      return { type: "text", text: next };
    }),
  };
};
