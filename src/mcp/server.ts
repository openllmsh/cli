/**
 * The ONE MCP server (`openllm mcp`) — composes native API and memory
 * tools over stdio, plus the user's enabled marketplace integrations, whose
 * tools are proxied in as `<id>__<tool>` so clients carry ONE MCP entry. `--only <group>` narrows the surface for debugging;
 * the free-tier gate applies before registration, not just to tools/list.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { fetchTier } from "../clients/gateway";
import { fetchMarketplaceServers } from "../clients/marketplace";
import type { TMcpGroup } from "../commands";
import { mcpGroupsForTier } from "../commands";
import { CLI_VERSION } from "../env";
import { requireCliApiKey } from "../onboarding";
import {
  handleLocalAuthTool,
  isLocalAuthTool,
  localAuthToolDefs,
} from "./local-auth";
import type { TUpstream } from "./marketplace/upstream";
import { connectUpstreams, upstreamToolName } from "./marketplace/upstream";
import { handleMemoryTool, memoryToolDefs } from "./memory/tools";
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
import type { TToolResult } from "./types";

export type { TMcpGroup } from "../commands";
export { MCP_ONLY_GROUPS as MCP_GROUPS } from "../commands";

const isMemoryTool = (name: string): boolean =>
  memoryToolDefs.some((tool) => tool.name === name);

/** One registration path for both negotiated stdio eras and local tests. */
export const createMcpServer = ({
  requested,
  tier,
  config,
  upstreams = [],
}: {
  requested: readonly TMcpGroup[];
  tier: Parameters<typeof mcpGroupsForTier>[1];
  config: { baseUrl: string; apiKey: string };
  upstreams?: readonly TUpstream[];
}): McpServer => {
  const groups = mcpGroupsForTier(requested, tier);
  const memoryConfig = {
    name: "openllm",
    version: CLI_VERSION,
    gatewayUrl: config.baseUrl,
    gatewayApiKey: config.apiKey,
  };
  const tools = [
    ...(groups.includes("openllm")
      ? [...openllmToolDefs, ...localAuthToolDefs]
      : []),
    ...(groups.includes("openllm-memory") ? memoryToolDefs : []),
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
        ...("annotations" in tool ? { annotations: tool.annotations } : {}),
        inputSchema: fromJsonSchema<Record<string, unknown>>(inputSchema),
      },
      async (args): Promise<TToolResult> => {
        if (groups.includes("openllm-memory") && isMemoryTool(name)) {
          return handleMemoryTool(name, args, memoryConfig);
        }
        if (groups.includes("openllm") && isLocalAuthTool(name))
          return handleLocalAuthTool(name, args);
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
  if (groups.includes("openllm")) {
    // A duplicate name or an unconvertible schema skips that one tool only —
    // a bad vendor manifest must never take the built-in tools down with it.
    const registered = new Set(tools.map((tool) => tool.name));
    for (const upstream of upstreams) {
      for (const tool of upstream.tools) {
        const name = upstreamToolName(upstream.id, tool.name);
        if (registered.has(name)) {
          console.warn(`[MCP] marketplace: skipping duplicate tool ${name}`);
          continue;
        }
        try {
          server.registerTool(
            name,
            {
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
              ...(tool.annotations === undefined
                ? {}
                : { annotations: tool.annotations }),
              inputSchema: fromJsonSchema<Record<string, unknown>>(
                tool.inputSchema,
              ),
            },
            (args): Promise<CallToolResult> => upstream.call(tool.name, args),
          );
          registered.add(name);
        } catch (err) {
          console.warn(
            `[MCP] marketplace: skipping ${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
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
  const gateway = {
    base: cfg.gatewayUrl,
    apiKey: cfg.apiKey,
    cloudOrigin: cfg.gatewayUrl,
    local: false,
  };
  // Tier and marketplace integrations are independent reads; both fail open.
  const [tier, servers] = await Promise.all([
    fetchTier(gateway),
    requested.includes("openllm") ? fetchMarketplaceServers(gateway) : [],
  ]);
  const upstreams = await connectUpstreams(servers);
  const closeUpstreams = (): void => {
    for (const upstream of upstreams) void upstream.close();
  };
  process.once("exit", closeUpstreams);
  process.stdin.once("end", closeUpstreams);
  serveStdio(() => createMcpServer({ requested, tier, config, upstreams }));
  console.log(
    `[MCP] openllm v${CLI_VERSION} listening on stdio (groups: ${mcpGroupsForTier(requested, tier).join(", ")})`,
  );
};
