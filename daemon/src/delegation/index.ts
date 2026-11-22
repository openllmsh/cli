import type { TSubscriptionProviderSlug } from "@openllmsh/sdk/protocol";
import { antigravityDelegate } from "./antigravity";
import { chatgptDelegate } from "./chatgpt";
import { claudeCodeDelegate } from "./claude-code";
import { cursorDelegate } from "./cursor";
import { grokDelegate } from "./grok";
import { kimiCodeDelegate } from "./kimi-code";
import { museDelegate } from "./muse";
import type { TProviderDelegate } from "./types";

export * from "./types";

/**
 * The OAuth provider slugs the daemon serves locally. These are
 * exactly the `authKind: "oauth"` providers the cloud refuses
 * server-side (`packages/core/providers/registry.ts`).
 */
export const DELEGATES: Readonly<Record<string, TProviderDelegate>> = {
  claude_code: claudeCodeDelegate,
  chatgpt: chatgptDelegate,
  kimi_code: kimiCodeDelegate,
  grok: grokDelegate,
  cursor: cursorDelegate,
  muse: museDelegate,
  antigravity: antigravityDelegate,
};

/**
 * Check if a provider slug is an OAuth/vendor-CLI provider served by the daemon.
 */
export const isOAuthSlug = (slug: string): slug is TSubscriptionProviderSlug =>
  Object.hasOwn(DELEGATES, slug);

/**
 * @deprecated Use isOAuthSlug instead. Kept for backward compatibility.
 */
export const isSubscriptionSlug = isOAuthSlug;

export const getDelegate = (slug: string): TProviderDelegate | null =>
  DELEGATES[slug] ?? null;
