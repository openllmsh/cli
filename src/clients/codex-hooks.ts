/** Pure Codex hook `-c` serializer shared by session and ChatGPT launches. */
import type { TJsonObject } from "./merge";
import { substitute, tomlLeaves } from "./merge";

const AD_HOOK_COMMAND = "exec ad";

type TCodexHook = { readonly command?: unknown };
type TCodexHookGroup = { readonly hooks?: readonly TCodexHook[] };
type TCodexHooks = { readonly Stop?: readonly TCodexHookGroup[] };

/** Drops the contextual-ad Stop hook without disturbing other Codex hooks. */
const hooksForTier = (
  hooks: TCodexHooks,
  tier: "free" | "trial" | "pro" | undefined,
): TCodexHooks => {
  if (tier === "free") return hooks;
  const stop = hooks.Stop?.map((group) => ({
    ...group,
    hooks: group.hooks?.filter(
      (hook) =>
        typeof hook.command !== "string" ||
        !hook.command.includes(AD_HOOK_COMMAND),
    ),
  })).filter((group) => (group.hooks?.length ?? 0) > 0);
  return stop === undefined || stop.length === 0 ? {} : { Stop: stop };
};

/** Materialize embedded hooks as Codex session overrides for a launch tier. */
export const codexHookArgs = (
  hooks: string,
  bin: string,
  tier: "free" | "trial" | "pro" | undefined,
): readonly string[] => {
  const doc = JSON.parse(
    substitute(hooks, { OPENLLM_BIN: bin }),
  ) as TJsonObject;
  return tomlLeaves({
    features: { hooks: true },
    hooks: hooksForTier(doc.hooks as TCodexHooks, tier),
  }).flatMap((pair) => ["-c", pair]);
};
