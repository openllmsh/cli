import type { TAttemptUsage } from "@openllmsh/wire/lib/attempt-outcome";
import { createUsageObserver } from "@openllmsh/wire/lib/usage-observer";

export const anthropicAttemptUsage = (usage: unknown): TAttemptUsage | null => {
  const observer = createUsageObserver("anthropic", "json");
  observer.observe({ usage });
  return observer.usage();
};

/** Codex's `last` is per turn; `total` is cumulative and must not settle. */
export const codexAttemptUsage = (last: unknown): TAttemptUsage | null => {
  if (last === null || typeof last !== "object" || Array.isArray(last))
    return null;
  const usage = last as Record<string, unknown>;
  const observer = createUsageObserver("openai", "json");
  observer.observe({
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    },
  });
  return observer.usage();
};
