/**
 * The ONE MCP server (`openllm mcp`) — composes every tool group over a
 * single stdio transport, registered in `~/.claude.json` as the single
 * `mcpServers.openllm` entry:
 *
 *   - openllm         — the native gateway API (the MCP-exposed subset of
 *                       the generated OpenAPI spec — inference + read-only
 *                       ops; account/config writes + raw plugin mirrors are
 *                       trimmed to cut context. See `openllm/tools.ts`.)
 *   - claude-context  — semantic code + docs search (gateway dispatch)
 *   - supermemory     — persistent memory / recall (gateway dispatch)
 *
 * `--only <group>` narrows the surface for debugging; the install script
 * always registers the full server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TMcpGroup } from "../commands";
import { CLI_VERSION, requireKeyedConfig } from "../env";
import {
  claudeContextGroupToolDefs,
  handleClaudeContextGroupTool,
  isClaudeContextGroupTool,
} from "./claude-context";
import {
  handleOpenllmTool,
  isOpenllmTool,
  openllmToolDefs,
} from "./openllm/tools";
import {
  handleSupermemoryTool,
  supermemoryToolDefs,
} from "./supermemory/tools";

export type { TMcpGroup } from "../commands";
// The group list is owned by `commands.ts` (the dependency-free command
// surface) so completion can consume it without this module's SDK graph.
export { MCP_ONLY_GROUPS as MCP_GROUPS } from "../commands";

const isSupermemoryTool = (name: string): boolean =>
  supermemoryToolDefs.some((t) => t.name === name);

export const runMcpServer = async (groups: readonly TMcpGroup[]) => {
  // stdout is reserved for MCP JSON-RPC; push all logs to stderr.
  console.log = (...a: unknown[]) =>
    process.stderr.write(`[LOG] ${a.join(" ")}\n`);
  console.warn = (...a: unknown[]) =>
    process.stderr.write(`[WARN] ${a.join(" ")}\n`);
  console.error = (...a: unknown[]) =>
    process.stderr.write(`[ERR] ${a.join(" ")}\n`);

  const cfg = requireKeyedConfig();
  const gatewayConfig = { baseUrl: cfg.gatewayUrl, apiKey: cfg.apiKey };
  const supermemoryConfig = {
    name: "openllm",
    version: CLI_VERSION,
    gatewayUrl: cfg.gatewayUrl,
    gatewayApiKey: cfg.apiKey,
  };

  const tools = [
    ...(groups.includes("openllm") ? openllmToolDefs : []),
    ...(groups.includes("claude-context") ? claudeContextGroupToolDefs : []),
    ...(groups.includes("supermemory") ? supermemoryToolDefs : []),
  ];

  const server = new Server(
    { name: "openllm", version: CLI_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    if (groups.includes("claude-context") && isClaudeContextGroupTool(name)) {
      return handleClaudeContextGroupTool(name, a, gatewayConfig);
    }
    if (groups.includes("supermemory") && isSupermemoryTool(name)) {
      return handleSupermemoryTool(name, a, supermemoryConfig);
    }
    if (groups.includes("openllm") && isOpenllmTool(name)) {
      return handleOpenllmTool(name, a, gatewayConfig);
    }
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log(
    `[MCP] openllm v${CLI_VERSION} listening on stdio (groups: ${groups.join(", ")})`,
  );
};
