/**
 * CLI marketplace upstream dialer. HTTP/SSE remotes go through
 * `@openllmsh/sdk/mcp` (`connectUpstream` / `connectUpstreams`); this module
 * only adds the stdio transport the compiled CLI can spawn, and fans both
 * kinds into one `<id>__<tool>` surface.
 *
 * A minimal JSON-RPC client: initialize → tools/list → tools/call. Every
 * upstream fails open on its own — a dead vendor drops only its tools.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
  TMarketplaceLaunchServer,
  TUpstream,
  TUpstreamTool,
} from "@openllmsh/sdk/mcp";
import {
  CALL_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  connectUpstream as connectHttpUpstream,
  connectUpstreams as connectHttpUpstreams,
  UPSTREAM_TOOL_SEPARATOR,
  upstreamToolName,
} from "@openllmsh/sdk/mcp";
import { CLI_VERSION } from "../../cli-version";

export type { TUpstream, TUpstreamTool };
export { UPSTREAM_TOOL_SEPARATOR, upstreamToolName };

type TRpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
type TNotify = (method: string) => Promise<void>;
type TChannel = {
  readonly rpc: TRpc;
  readonly notify: TNotify;
  readonly close: () => Promise<void>;
};

const PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_PAGES = 10;

type TRpcMessage = {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

const unwrap = (msg: TRpcMessage): unknown => {
  if (msg.error !== undefined)
    throw new Error(msg.error.message ?? "upstream error");
  return msg.result;
};

const stdioChannel = (server: TMarketplaceLaunchServer): TChannel => {
  const child = Bun.spawn([server.command ?? "", ...(server.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...server.env },
  });
  const pending = new Map<number, (msg: TRpcMessage) => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of child.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (line.length === 0) continue;
          try {
            const msg = JSON.parse(line) as TRpcMessage;
            if (typeof msg.id === "number") {
              pending.get(msg.id)?.(msg);
              pending.delete(msg.id);
            }
          } catch {
            // Non-JSON output — ignore.
          }
        }
      }
    } finally {
      // The child is gone: fail every in-flight call now, not at its timeout.
      for (const settle of pending.values())
        settle({ error: { message: "upstream exited" } });
      pending.clear();
    }
  })();
  const write = (body: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
    child.stdin.flush();
  };
  let nextId = 0;
  return {
    rpc: (method, params = {}) => {
      const id = ++nextId;
      const timeout =
        method === "tools/call" ? CALL_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`upstream timed out on ${method}`));
        }, timeout);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          try {
            resolve(unwrap(msg));
          } catch (err) {
            reject(err);
          }
        });
        write({ id, method, params });
      });
    },
    notify: async (method) => write({ method }),
    close: async () => {
      child.kill();
    },
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const toTool = (v: unknown): TUpstreamTool | undefined => {
  if (!isRecord(v) || typeof v.name !== "string") return undefined;
  return {
    name: v.name,
    ...(typeof v.description === "string"
      ? { description: v.description }
      : {}),
    inputSchema: isRecord(v.inputSchema)
      ? v.inputSchema
      : { type: "object", properties: {} },
    ...(isRecord(v.annotations) ? { annotations: v.annotations } : {}),
  };
};

const listTools = async (rpc: TRpc): Promise<TUpstreamTool[]> => {
  const tools: TUpstreamTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await rpc(
      "tools/list",
      cursor === undefined ? {} : { cursor },
    );
    if (!isRecord(result) || !Array.isArray(result.tools)) break;
    for (const raw of result.tools) {
      const tool = toTool(raw);
      if (tool !== undefined) tools.push(tool);
    }
    if (typeof result.nextCursor !== "string") break;
    cursor = result.nextCursor;
  }
  return tools;
};

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Dial one stdio upstream; rejects on any handshake failure. */
const connectStdioUpstream = async (
  server: TMarketplaceLaunchServer,
): Promise<TUpstream> => {
  if (server.command === undefined)
    throw new Error(`${server.id}: incomplete launch entry`);
  const channel = stdioChannel(server);
  try {
    await channel.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "openllm", version: CLI_VERSION },
    });
    await channel.notify("notifications/initialized");
    const blocked = new Set(server.blocked_tools ?? []);
    const tools = (await listTools(channel.rpc)).filter(
      (tool) => !blocked.has(tool.name),
    );
    return {
      id: server.id,
      tools,
      call: async (name, args) => {
        if (blocked.has(name))
          return errorResult(`${server.id}: ${name} is not available`);
        try {
          const result = await channel.rpc("tools/call", {
            name,
            arguments: args,
          });
          return isRecord(result) && Array.isArray(result.content)
            ? (result as CallToolResult)
            : errorResult(`${server.id}: malformed tool result`);
        } catch (err) {
          return errorResult(
            `${server.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      close: channel.close,
    };
  } catch (err) {
    await channel.close();
    throw err;
  }
};

/** Dial one upstream (HTTP/SSE via SDK, stdio here); rejects on handshake failure. */
export const connectUpstream = async (
  server: TMarketplaceLaunchServer,
): Promise<TUpstream> => {
  if (server.transport === "stdio") return connectStdioUpstream(server);
  return connectHttpUpstream(server, { clientVersion: CLI_VERSION });
};

/** Dial every upstream in parallel; failures are logged and dropped. */
export const connectUpstreams = async (
  servers: readonly TMarketplaceLaunchServer[],
): Promise<readonly TUpstream[]> => {
  const remote = servers.filter((server) => server.transport !== "stdio");
  const local = servers.filter((server) => server.transport === "stdio");
  const [httpUpstreams, stdioSettled] = await Promise.all([
    connectHttpUpstreams(remote, {
      clientVersion: CLI_VERSION,
      onWarn: (message) => console.warn(message),
    }),
    Promise.allSettled(local.map(connectStdioUpstream)),
  ]);
  const stdioUpstreams = stdioSettled.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    console.warn(
      `[MCP] marketplace ${local[i]?.id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    );
    return [];
  });
  // Preserve launch order: walk the original list and pick from each pool.
  const byId = new Map(
    [...httpUpstreams, ...stdioUpstreams].map((u) => [u.id, u]),
  );
  return servers.flatMap((server) => {
    const upstream = byId.get(server.id);
    return upstream === undefined ? [] : [upstream];
  });
};
