/**
 * The ONE MCP server (`openllm mcp`) — composes native API, context, and
 * memory tools over stdio. `--only <group>` narrows the surface for debugging;
 * the free-tier gate applies before registration, not just to tools/list.
 */

import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { fetchTier } from "../clients/gateway";
import type { TMcpGroup } from "../commands";
import { mcpGroupsForTier } from "../commands";
import { CLI_VERSION } from "../env";
import { requireCliApiKey } from "../onboarding";
import {
  claudeContextGroupToolDefs,
  handleClaudeContextGroupTool,
  isClaudeContextGroupTool,
} from "./claude-context";
import {
  MODELS_TOOL_NAME,
  prioritizeSubscriptionModels,
} from "./openllm/model-priority";
import {
  handleOpenllmTool,
  isMcpListedTool,
  openllmToolDefs,
  TRANSCRIPTION_TOOL_NAME,
} from "./openllm/tools";
import { transcribeAudio } from "./openllm/transcribe-audio";
import {
  handleSupermemoryTool,
  supermemoryToolDefs,
} from "./supermemory/tools";
import type { TToolResult } from "./types";

export type { TMcpGroup } from "../commands";
export { MCP_ONLY_GROUPS as MCP_GROUPS } from "../commands";

const isSupermemoryTool = (name: string): boolean =>
  supermemoryToolDefs.some((tool) => tool.name === name);

/** One registration path for both negotiated stdio eras and local tests. */
export const createMcpServer = ({
  requested,
  tier,
  config,
}: {
  requested: readonly TMcpGroup[];
  tier: Parameters<typeof mcpGroupsForTier>[1];
  config: { baseUrl: string; apiKey: string };
}): McpServer => {
  const groups = mcpGroupsForTier(requested, tier);
  const supermemoryConfig = {
    name: "openllm",
    version: CLI_VERSION,
    gatewayUrl: config.baseUrl,
    gatewayApiKey: config.apiKey,
  };
  const tools = [
    ...(groups.includes("openllm") ? openllmToolDefs : []),
    ...(groups.includes("openllm-context") ? claudeContextGroupToolDefs : []),
    ...(groups.includes("openllm-memory") ? supermemoryToolDefs : []),
  ];
  const server = new McpServer(
    { name: "openllm", version: CLI_VERSION },
    { capabilities: { tools: {} } },
  );
  for (const tool of tools) {
    const name = tool.name;
    const inputSchema: Record<string, unknown> = tool.inputSchema;
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(inputSchema),
      },
      async (args): Promise<TToolResult> => {
        if (
          groups.includes("openllm-context") &&
          isClaudeContextGroupTool(name)
        ) {
          return handleClaudeContextGroupTool(name, args, config);
        }
        if (groups.includes("openllm-memory") && isSupermemoryTool(name)) {
          return handleSupermemoryTool(name, args, supermemoryConfig);
        }
        if (groups.includes("openllm") && isMcpListedTool(name)) {
          if (name === TRANSCRIPTION_TOOL_NAME)
            return transcribeAudio(args, config);
          const result = await handleOpenllmTool(name, args, config);
          return name === MODELS_TOOL_NAME
            ? prioritizeSubscriptionModels(result)
            : result;
        }
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      },
    );
  }
  return server;
};

export const runMcpServer = async (
  requested: readonly TMcpGroup[],
): Promise<void> => {
  // stdout is reserved for MCP JSON-RPC; push all logs to stderr.
  console.log = (...args: unknown[]) =>
    process.stderr.write(`[LOG] ${args.join(" ")}\n`);
  console.warn = (...args: unknown[]) =>
    process.stderr.write(`[WARN] ${args.join(" ")}\n`);
  console.error = (...args: unknown[]) =>
    process.stderr.write(`[ERR] ${args.join(" ")}\n`);

  const credential = requireCliApiKey("machine");
  if (!credential.ok) {
    process.stderr.write(credential.message);
    process.exitCode = 1;
    return;
  }
  const cfg = credential.config;
  const config = { baseUrl: cfg.gatewayUrl, apiKey: cfg.apiKey };
  const tier = await fetchTier({
    base: cfg.gatewayUrl,
    apiKey: cfg.apiKey,
    cloudOrigin: cfg.gatewayUrl,
    local: false,
    localToken: null,
  });
  serveStdio(() => createMcpServer({ requested, tier, config }));
  console.log(
    `[MCP] openllm v${CLI_VERSION} listening on stdio (groups: ${mcpGroupsForTier(requested, tier).join(", ")})`,
  );
};
