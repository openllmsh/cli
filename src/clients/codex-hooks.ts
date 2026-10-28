/** Pure Codex hook `-c` serializer shared by session and ChatGPT launches. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../env";
import type { TJsonObject } from "./merge";
import { substitute, tomlLeaves, tomlValue } from "./merge";

const AD_HOOK_COMMAND = "exec ad";

/** Codex keys hooks passed as `-c` flags under this synthetic source path. */
const SESSION_FLAGS_SOURCE = "/<session-flags>/config.toml";

type TCodexHook = {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly timeout?: unknown;
  readonly async?: unknown;
  readonly statusMessage?: unknown;
};
type TCodexHookGroup = {
  readonly matcher?: unknown;
  readonly hooks?: readonly TCodexHook[];
};
type TCodexHooks = TJsonObject & {
  readonly Stop?: readonly TCodexHookGroup[];
};

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
  if (stop === undefined) return hooks;
  const { Stop: _stop, ...otherHooks } = hooks;
  return stop.length === 0 ? otherHooks : { ...otherHooks, Stop: stop };
};

/** `PreToolUse` → `pre_tool_use`, Codex's `hook_event_key_label`. */
const eventKeyLabel = (event: string): string =>
  event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

/** Codex 0.159's default command-hook timeout (seconds). */
const DEFAULT_HOOK_TIMEOUT_SEC = 600;

/** JSON with keys sorted at every level — Codex's `canonical_json`. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * Codex's trust hash for one command hook (`hook_hash` in codex-rs
 * hooks/src/engine/discovery.rs): sha256 of the canonical JSON of the
 * normalized `{event_name, matcher, hooks: [handler]}` identity, with `None`
 * fields dropped as TOML serialization drops them.
 */
const commandHookHash = (
  event: string,
  matcher: string | undefined,
  hook: TCodexHook,
): string => {
  const timeout =
    typeof hook.timeout === "number" ? Math.max(1, hook.timeout) : undefined;
  const identity = {
    event_name: eventKeyLabel(event),
    matcher,
    hooks: [
      {
        type: "command",
        command: hook.command,
        timeout: timeout ?? DEFAULT_HOOK_TIMEOUT_SEC,
        async: hook.async === true,
        statusMessage:
          typeof hook.statusMessage === "string"
            ? hook.statusMessage
            : undefined,
      },
    ],
  };
  const digest = createHash("sha256")
    .update(canonicalJson(identity))
    .digest("hex");
  return `sha256:${digest}`;
};

/** The user's own hook approvals, read-only, so our `hooks.state` override
 *  (a whole-table replace) never revokes them. */
export const userCodexHookState = (): TJsonObject => {
  try {
    const doc = Bun.TOML.parse(
      readFileSync(join(userHome(), ".codex", "config.toml"), "utf-8"),
    ) as TJsonObject;
    const hooks = doc.hooks as TJsonObject | undefined;
    const state = hooks?.state;
    return typeof state === "object" && state !== null && !Array.isArray(state)
      ? (state as TJsonObject)
      : {};
  } catch {
    return {};
  }
};

/**
 * Pre-approve the hooks we pass as session flags, so Codex never stops a
 * launch on "Hooks need review" — a free user's ad hook must run. Codex runs a
 * hook only when `hooks.state.<key>.trusted_hash` matches its hash, and takes
 * that table as ONE inline `-c` value (the key contains dots).
 */
const trustState = (hooks: TCodexHooks): TJsonObject => {
  const state: TJsonObject = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    (groups as TCodexHookGroup[]).forEach((group, groupIndex) => {
      const matcher =
        typeof group.matcher === "string" ? group.matcher : undefined;
      group.hooks?.forEach((hook, handlerIndex) => {
        if (hook.type !== "command" || typeof hook.command !== "string") return;
        const key = `${SESSION_FLAGS_SOURCE}:${eventKeyLabel(event)}:${groupIndex}:${handlerIndex}`;
        state[key] = {
          trusted_hash: commandHookHash(event, matcher, hook),
        };
      });
    });
  }
  return state;
};

/** Materialize embedded hooks as Codex session overrides for a launch tier,
 *  pre-trusted so they run without a review prompt. */
export const codexHookArgs = (
  hooks: string,
  bin: string,
  tier: "free" | "trial" | "pro" | undefined,
): readonly string[] => {
  const doc = JSON.parse(
    substitute(hooks, { OPENLLM_BIN: bin }),
  ) as TJsonObject;
  const tierHooks = hooksForTier(doc.hooks as TCodexHooks, tier);
  const state = { ...userCodexHookState(), ...trustState(tierHooks) };
  return [
    ...tomlLeaves({ features: { hooks: true }, hooks: tierHooks }),
    ...(Object.keys(state).length === 0
      ? []
      : [`hooks.state=${tomlValue(state)}`]),
  ].flatMap((pair) => ["-c", pair]);
};
