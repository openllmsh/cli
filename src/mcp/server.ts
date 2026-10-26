/**
 * The ONE MCP server (`openllm mcp`) — composes native API and memory
 * tools over stdio, plus the user's enabled marketplace integrations, whose
 * tools are proxied in as `<id>__<tool>` so clients carry ONE MCP entry. `--only <group>` narrows the surface for debugging;
 * the free-tier gate applies before registration, not just to tools/list.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { TGateway } from "../clients/gateway";
import { fetchTier } from "../clients/gateway";
import type { TMarketplaceLaunch } from "../clients/marketplace";
import {
  fetchMarketplaceLaunch,
  LAUNCH_TIMEOUT_MS,
} from "../clients/marketplace";
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
  isFreeTierOnlyTool,
  isMcpListedTool,
  openllmToolDefs,
  TRANSCRIPTION_TOOL_NAME,
} from "./openllm/tools";
import { transcribeAudio } from "./openllm/transcribe-audio";
import type { TToolResult } from "./types";

export type { TMcpGroup } from "../commands";
export { MCP_ONLY_GROUPS as MCP_GROUPS } from "../commands";

/** Catalog id for the first-party memory builtin. */
export const OPENLLM_MEMORY_BUILTIN_ID = "openllm-memory";

const isMemoryTool = (name: string): boolean =>
  memoryToolDefs.some((tool) => tool.name === name);

/** One registration path for both negotiated stdio eras and local tests. */
export const createMcpServer = ({
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
  /** Enabled first-party builtins from `/api/marketplace/launch`. */
  builtins?: readonly string[];
}): McpServer => {
  const groups = mcpGroupsForTier(requested, tier);
  const memoryEnabled =
    groups.includes("openllm-memory") &&
    builtins.includes(OPENLLM_MEMORY_BUILTIN_ID);
  const memoryConfig = {
    name: "openllm",
    version: CLI_VERSION,
    gatewayUrl: config.baseUrl,
    gatewayApiKey: config.apiKey,
  };
  // Free-tier-only tools need a CONFIRMED free tier: unknown (offline,
  // billing unavailable) hides them, unlike the group gate's fail-open.
  const openllmTools = openllmToolDefs.filter(
    (tool) => tier === "free" || !isFreeTierOnlyTool(tool.name),
  );
  const tools = [
    ...(groups.includes("openllm")
      ? [...openllmTools, ...localAuthToolDefs]
      : []),
    ...(memoryEnabled ? memoryToolDefs : []),
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
        if (memoryEnabled && isMemoryTool(name)) {
          return handleMemoryTool(name, args, memoryConfig);
        }
        if (groups.includes("openllm") && isLocalAuthTool(name))
          return handleLocalAuthTool(name, args);
        if (
          groups.includes("openllm") &&
          isMcpListedTool(name) &&
          (tier === "free" || !isFreeTierOnlyTool(name))
        ) {
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
    attachMarketplaceUpstreams(
      server,
      upstreams,
      new Set(tools.map((tool) => tool.name)),
    );
  }
  return server;
};

/** Register marketplace proxy tools on a live server. Safe to call after
 *  `serveStdio` — each `registerTool` notifies `tools/list_changed`. */
export const attachMarketplaceUpstreams = (
  server: McpServer,
  upstreams: readonly TUpstream[],
  alreadyRegistered: ReadonlySet<string> = new Set(),
): void => {
  // A duplicate name or an unconvertible schema skips that one tool only —
  // a bad vendor manifest must never take the built-in tools down with it.
  const registered = new Set(alreadyRegistered);
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
};

export type TLaunchConnected = {
  readonly upstreams: readonly TUpstream[];
  readonly builtins: readonly string[];
};

export type TMarketplaceLoad = {
  readonly launchPromise: Promise<TMarketplaceLaunch>;
  readonly marketplacePromise: Promise<TLaunchConnected>;
};

export type TBeginMarketplaceLoadOptions = {
  readonly fetchLaunch?: (gateway: TGateway) => Promise<TMarketplaceLaunch>;
  readonly connect?: (
    servers: TMarketplaceLaunch["servers"],
  ) => Promise<readonly TUpstream[]>;
};

/**
 * Kick off `/api/marketplace/launch` whenever the `openllm` OR
 * `openllm-memory` group is requested. Builtins settle with the launch
 * response; upstream dials (only for `openllm`) may lag behind.
 */
export const beginMarketplaceLoad = (
  requested: readonly TMcpGroup[],
  gateway: TGateway,
  options: TBeginMarketplaceLoadOptions = {},
): TMarketplaceLoad => {
  const fetchLaunch = options.fetchLaunch ?? fetchMarketplaceLaunch;
  const connect = options.connect ?? connectUpstreams;
  const wantsLaunch =
    requested.includes("openllm") || requested.includes("openllm-memory");
  const emptyLaunch: TMarketplaceLaunch = { servers: [], builtins: [] };
  const launchPromise = wantsLaunch
    ? fetchLaunch(gateway)
    : Promise.resolve(emptyLaunch);
  const marketplacePromise: Promise<TLaunchConnected> = requested.includes(
    "openllm",
  )
    ? launchPromise.then(async (launch) => ({
        upstreams: await connect(launch.servers),
        builtins: launch.builtins,
      }))
    : launchPromise.then((launch) => ({
        upstreams: [] as readonly TUpstream[],
        builtins: launch.builtins,
      }));
  return { launchPromise, marketplacePromise };
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
  // Kick off gateway reads before we listen — but do NOT await marketplace
  // upstream handshakes on the critical path. `serveStdio` starts reading
  // stdin immediately; the factory waits for the launch response (builtins)
  // bounded by the launch timeout. Slower upstream dials land via
  // `tools/list_changed` after listen.
  const tierPromise = fetchTier(gateway);
  const { launchPromise, marketplacePromise } = beginMarketplaceLoad(
    requested,
    gateway,
  );
  let upstreams: readonly TUpstream[] = [];
  let builtins: readonly string[] = [];
  let marketplaceSettled = false;
  // Builtins are available as soon as launch returns — do not wait on
  // upstream handshakes to enable memory tools.
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
        // Preserve builtins already set from a successful launch.
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
    // Snapshot which upstreams the constructor already registered so a late
    // attach does not double-register when they finished during the wait.
    const includedAtCreate = upstreams;
    const builtinsAtCreate = builtins;
    const server = createMcpServer({
      requested,
      tier,
      config,
      upstreams: includedAtCreate,
      builtins: builtinsAtCreate,
    });
    if (includedAtCreate.length > 0) attachedLate = true;
    // Upstream dials finished after create: attach remotes and notify
    // tools/list_changed. Builtin memory tools are fixed at create time from
    // the launch snapshot (next MCP start picks up a toggle that landed late).
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
  // Announce immediately — hosts key off this line. Tier only shapes the
  // group list in the message; requested groups are a safe provisional.
  console.log(
    `[MCP] openllm v${CLI_VERSION} listening on stdio (groups: ${requested.join(", ")})`,
  );
};
