/**
 * CLI MCP host glue (`openllm mcp`) — stdio transport, onboarding, gateway
 * tier lookup, local-auth tools, and ffmpeg transcription. Tool defs and
 * `createMcpServer` come from `@openllmsh/sdk/mcp`.
 */

import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type {
  TBeginMarketplaceLoadOptions,
  TMarketplaceLaunch,
  TMarketplaceLoad,
  TUpstream,
} from "@openllmsh/sdk/mcp";
import {
  attachMarketplaceUpstreams,
  beginMarketplaceLoad as beginMarketplaceLoadSdk,
  createMcpServer as createSdkMcpServer,
  LAUNCH_TIMEOUT_MS,
  OPENLLM_MEMORY_BUILTIN_ID,
} from "@openllmsh/sdk/mcp";
import type { TGateway } from "../clients/gateway";
import { fetchTier } from "../clients/gateway";
import type { TMarketplaceLaunch as TCliMarketplaceLaunch } from "../clients/marketplace";
import type { TMcpGroup } from "../commands";
import { mcpGroupsForTier } from "../commands";
import { CLI_VERSION } from "../env";
import { buildProjectRef } from "../memory-hooks/project-ref";
import { memoryProject } from "../memory-hooks/transcript";
import { requireCliApiKey } from "../onboarding";
import {
  handleLocalAuthTool,
  isLocalAuthTool,
  localAuthToolDefs,
} from "./local-auth";
import { connectUpstreams as connectUpstreamsWithStdio } from "./marketplace/upstream";
import { transcribeAudio } from "./openllm/transcribe-audio";
import type { TToolResult } from "./types";

export type { TMcpGroup } from "../commands";
export { MCP_ONLY_GROUPS as MCP_GROUPS } from "../commands";
export {
  attachMarketplaceUpstreams,
  LAUNCH_TIMEOUT_MS,
  OPENLLM_MEMORY_BUILTIN_ID,
};

/** Register CLI-only local-auth tools on a live server. */
const registerLocalAuthTools = (server: McpServer): void => {
  for (const tool of localAuthToolDefs) {
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
        if (isLocalAuthTool(name)) return handleLocalAuthTool(name, args);
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      },
    );
  }
};

/**
 * Build the MCP server for this process: SDK tools + CLI local-auth +
 * optional ffmpeg transcription. Marketplace upstreams may include stdio
 * (CLI-only) via {@link connectUpstreamsWithStdio}.
 */
export const createCliMcpServer = ({
  requested,
  tier,
  config,
  upstreams = [],
  builtins = [],
}: {
  requested: readonly TMcpGroup[];
  tier: Parameters<typeof mcpGroupsForTier>[1];
  config: { baseUrl: string; apiKey: string };
  upstreams?: readonly TUpstream[];
  builtins?: readonly string[];
}): McpServer => {
  const groups = mcpGroupsForTier(requested, tier);
  const server = createSdkMcpServer({
    version: CLI_VERSION,
    groups,
    config,
    upstreams,
    builtins,
    includeFreeTierOnlyTools: tier === "free",
    transcribe: (args, cfg) => transcribeAudio(args, cfg),
    memory: {
      resolveProject: (override) => memoryProject(process.cwd(), override),
      buildProjectRef: (slug) => buildProjectRef(process.cwd(), slug),
    },
  });
  if (groups.includes("openllm")) registerLocalAuthTools(server);
  return server;
};

/** Tests and older imports still call `createMcpServer` from this module. */
export const createMcpServer = createCliMcpServer;

type TCliBeginOptions = {
  readonly fetchLaunch?: (
    gateway: TGateway,
  ) => Promise<TCliMarketplaceLaunch | TMarketplaceLaunch>;
  readonly connect?: (
    servers: TCliMarketplaceLaunch["servers"],
  ) => Promise<readonly TUpstream[]>;
};

/** CLI-shaped wrapper around the SDK loader (requested groups first). */
export const beginMarketplaceLoad = (
  requested: readonly TMcpGroup[],
  gateway: TGateway,
  options: TCliBeginOptions = {},
): TMarketplaceLoad => {
  const config = { baseUrl: gateway.cloudOrigin, apiKey: gateway.apiKey };
  const sdkOptions: TBeginMarketplaceLoadOptions = {
    groups: requested,
    clientVersion: CLI_VERSION,
    ...(options.fetchLaunch === undefined
      ? {}
      : {
          fetchLaunch: async () => {
            const launch = await options.fetchLaunch?.(gateway);
            return (launch ?? {
              servers: [],
              builtins: [],
            }) as TMarketplaceLaunch;
          },
        }),
    ...(options.connect === undefined
      ? {
          connect: (servers) =>
            connectUpstreamsWithStdio(
              servers.map((s) => ({
                id: s.id,
                transport: s.transport,
                url: s.url,
                headers: s.headers,
                command: s.command,
                args: s.args,
                env: s.env,
                blocked_tools: s.blocked_tools,
              })),
            ),
        }
      : {
          connect: async (servers) =>
            options.connect?.(
              servers.map((s) => ({
                id: s.id,
                transport: s.transport,
                url: s.url,
                headers: s.headers,
                command: s.command,
                args: s.args,
                env: s.env,
                blocked_tools: s.blocked_tools,
              })),
            ) ?? [],
        }),
  };
  return beginMarketplaceLoadSdk(config, sdkOptions);
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

  const credential = await requireCliApiKey("machine");
  if (!credential.ok) {
    process.stderr.write(credential.message);
    process.exitCode = 1;
    return;
  }
  const cfg = credential.config;
  const config = { baseUrl: cfg.gatewayUrl, apiKey: cfg.apiKey };
  const gateway: TGateway = {
    base: cfg.gatewayUrl,
    apiKey: cfg.apiKey,
    cloudOrigin: cfg.gatewayUrl,
    local: false,
  };
  const tierPromise = fetchTier(gateway);
  // Wrapper defaults connect to the CLI stdio+HTTP dialer.
  const { launchPromise, marketplacePromise } = beginMarketplaceLoad(
    requested,
    gateway,
  );
  let upstreams: readonly TUpstream[] = [];
  let builtins: readonly string[] = [];
  let marketplaceSettled = false;
  void launchPromise.then((launch) => {
    builtins = launch.builtins;
  });
  const marketplaceTask = marketplacePromise.then(
    (connected) => {
      upstreams = connected.upstreams;
      builtins = connected.builtins;
      marketplaceSettled = true;
      return connected;
    },
    (err: unknown) => {
      marketplaceSettled = true;
      console.warn(
        `[MCP] marketplace: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        upstreams: [] as readonly TUpstream[],
        builtins,
      };
    },
  );
  const closeUpstreams = (): void => {
    for (const upstream of upstreams) void upstream.close();
  };
  process.once("exit", closeUpstreams);
  process.stdin.once("end", closeUpstreams);

  let attachedLate = false;
  serveStdio(async () => {
    const [tier] = await Promise.all([
      tierPromise,
      Promise.race([
        launchPromise.then(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, LAUNCH_TIMEOUT_MS);
        }),
      ]),
    ]);
    const includedAtCreate = upstreams;
    const builtinsAtCreate = builtins;
    const server = createCliMcpServer({
      requested,
      tier,
      config,
      upstreams: includedAtCreate,
      builtins: builtinsAtCreate,
    });
    if (includedAtCreate.length > 0) attachedLate = true;
    if (!marketplaceSettled) {
      void marketplaceTask.then((connected) => {
        if (attachedLate || connected.upstreams.length === 0) return;
        attachedLate = true;
        if (mcpGroupsForTier(requested, tier).includes("openllm")) {
          attachMarketplaceUpstreams(server, connected.upstreams);
        }
      });
    }
    return server;
  });
  console.log(
    `[MCP] openllm v${CLI_VERSION} listening on stdio (groups: ${requested.join(", ")})`,
  );
};
