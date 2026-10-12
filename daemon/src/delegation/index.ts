import type { TSubscriptionProviderSlug } from "@openllmsh/protocol";
import { antigravityEnabled } from "../antigravity-feature";
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
 * The subscription provider slugs the daemon serves locally. These are
 * exactly the `authKind: "oauth"` providers the cloud refuses
 * server-side (`packages/core/providers/registry.ts`). Antigravity is
 * registered only when its kill switch is on (`antigravity-feature.ts`).
 */
export const DELEGATES: Readonly<Record<string, TProviderDelegate>> = {
  claude_code: claudeCodeDelegate,
  chatgpt: chatgptDelegate,
  kimi_code: kimiCodeDelegate,
  grok: grokDelegate,
  cursor: cursorDelegate,
  muse: museDelegate,
  ...(antigravityEnabled() ? { antigravity: antigravityDelegate } : {}),
};

export const isSubscriptionSlug = (
  slug: string,
): slug is TSubscriptionProviderSlug => Object.hasOwn(DELEGATES, slug);

export const getDelegate = (slug: string): TProviderDelegate | null =>
  DELEGATES[slug] ?? null;
