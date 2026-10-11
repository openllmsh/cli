/**
 * Shared `@anthropic-ai/claude-agent-sdk` `query()` option construction for
 * the two Claude tool-bearing paths (`claude-tool-session.ts`'s held-open
 * passthrough orchestrator and `claude-tool-capture.ts`'s inert-tool capture
 * builder). Only fields genuinely identical between the two live here —
 * `canUseTool`, `resume`, `systemPrompt`, `abortController`, `title` are real
 * behavioral differences and stay at each call site.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { spawnCwd } from "../delegation/util";

/** The `tool()`-built entries `createSdkMcpServer` accepts. */
type TSdkMcpTools = Parameters<typeof createSdkMcpServer>[0]["tools"];

/** In-process MCP server identity both tool-bearing paths register under. */
export const CLAUDE_TOOL_SDK_MCP_SERVER_NAME = "openllm";
export const CLAUDE_TOOL_SDK_MCP_SERVER_VERSION = "1.0.0";

export type TClaudeToolSdkOptionsBaseParams = {
  readonly bin: string;
  /** Final env for the SDK's child — already cleaned/decorated by the
   *  caller. `cwd` derives from it via `spawnCwd`, which reads only
   *  `env.HOME` (untouched by cleaning/decoration) — see
   *  `claude-native-capture-shared-spawn.test.ts` for the equivalence proof. */
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  /** In-process MCP tool definitions built by each caller's own `tool()`
   *  registration (the passthrough tools vs the inert capture tools). */
  readonly tools: TSdkMcpTools;
};

export type TClaudeToolSdkOptionsBase = {
  readonly model: string;
  readonly pathToClaudeCodeExecutable: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly settingSources: []; // `Options.settingSources` is `SettingSource[]`
  readonly tools: string[]; // built-ins stripped; `Options.tools` is `string[]`
  readonly mcpServers: {
    readonly [CLAUDE_TOOL_SDK_MCP_SERVER_NAME]: ReturnType<
      typeof createSdkMcpServer
    >;
  };
};

/**
 * Fields identical across both tool-bearing `query()` builders. Spread first,
 * then layer `canUseTool` / `resume` / `systemPrompt` / `abortController` /
 * `title` on top per call site.
 */
export const buildClaudeToolSdkOptionsBase = (
  params: TClaudeToolSdkOptionsBaseParams,
): TClaudeToolSdkOptionsBase => ({
  model: params.providerModelId,
  pathToClaudeCodeExecutable: params.bin,
  env: params.env,
  cwd: spawnCwd(params.env),
  settingSources: [],
  tools: [],
  mcpServers: {
    [CLAUDE_TOOL_SDK_MCP_SERVER_NAME]: createSdkMcpServer({
      name: CLAUDE_TOOL_SDK_MCP_SERVER_NAME,
      version: CLAUDE_TOOL_SDK_MCP_SERVER_VERSION,
      tools: params.tools,
    }),
  },
});

export type TClaudeToolResumeAndSystemPromptParams = {
  readonly systemText: string | null;
  readonly resumeSessionId: string | null;
  /** Capture never sends a system prompt while resuming (the resumed session
   *  already carries it); tool-session has no such guard because its callers
   *  already only pass `systemText` on a fresh start. Real policy difference
   *  — not unified away. Default false preserves tool-session's prior
   *  behavior exactly. */
  readonly suppressSystemPromptWhenResuming?: boolean;
};

/** Shared `resume`/`systemPrompt` conditional-emission owner — both
 *  tool-bearing `query()` builders spread this instead of hand-rolling the
 *  same two ternary spreads. */
export const claudeToolResumeAndSystemPromptOptions = (
  params: TClaudeToolResumeAndSystemPromptParams,
): { readonly resume?: string; readonly systemPrompt?: string } => {
  const suppressSystemPrompt =
    params.suppressSystemPromptWhenResuming === true &&
    params.resumeSessionId !== null;
  return {
    ...(params.resumeSessionId !== null
      ? { resume: params.resumeSessionId }
      : {}),
    ...(params.systemText !== null && !suppressSystemPrompt
      ? { systemPrompt: params.systemText }
      : {}),
  };
};
