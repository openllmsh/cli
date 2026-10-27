/** Pure Codex hook `-c` serializer shared by session and ChatGPT launches. */
import type { TJsonObject } from "./merge";
import { substitute, tomlLeaves } from "./merge";

/** Materialize an embedded hooks JSON document as Codex session overrides. */
export const codexHookArgs = (
  hooks: string,
  bin: string,
): readonly string[] => {
  const doc = JSON.parse(
    substitute(hooks, { OPENLLM_BIN: bin }),
  ) as TJsonObject;
  return tomlLeaves({
    features: { hooks: true },
    hooks: doc.hooks,
  }).flatMap((pair) => ["-c", pair]);
};
