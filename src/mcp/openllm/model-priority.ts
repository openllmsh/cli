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

const isSubscriptionCatalogEntry = (entry: unknown): boolean => {
  if (typeof entry !== "object" || entry === null) return false;
  const rec = entry as Record<string, unknown>;
  return (
    typeof rec.provider === "string" &&
    SUBSCRIPTION_SLUGS.has(rec.provider) &&
    typeof rec.id === "string" &&
    rec.id.startsWith(`${rec.provider}/`) &&
    rec.id.length > rec.provider.length + 1
  );
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
 * fields are preserved. Classification requires a subscription provider and
 * its namespaced catalog ID — aliases and upstream model names never match.
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
