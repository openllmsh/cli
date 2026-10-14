/**
 * Marketplace integrations served THROUGH the one `openllm` MCP server.
 * Each enabled integration (`/api/marketplace/launch`) is dialled as an
 * upstream MCP server — Streamable HTTP for remote entries (BYOK vendor URL
 * or the gateway's metered `/api/marketplace/mcp/<id>` proxy), stdio for
 * package entries — and its tools are re-exported as `<id>__<tool>`. Clients
 * therefore carry a single `openllm` entry; secrets stay in this process.
 *
 * A minimal JSON-RPC client: initialize → tools/list → tools/call. Every
 * upstream fails open on its own — a dead vendor drops only its tools.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { TMarketplaceLaunchServer } from "../../clients/marketplace";
import { CLI_VERSION } from "../../env";

export type TUpstreamTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
};

export type TUpstream = {
  readonly id: string;
  readonly tools: readonly TUpstreamTool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
};

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
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_PAGES = 10;

/** Separator between integration id and its tool name. */
export const UPSTREAM_TOOL_SEPARATOR = "__";

export const upstreamToolName = (id: string, tool: string): string =>
  `${id}${UPSTREAM_TOOL_SEPARATOR}${tool}`;

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

/** Pick the response for `id` out of an SSE body. */
const fromSse = (text: string, id: number): TRpcMessage | undefined => {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) continue;
    try {
      const msg = JSON.parse(data) as TRpcMessage;
      if (msg.id === id) return msg;
    } catch {
      // Not JSON — skip the event.
    }
  }
  return undefined;
};

const httpChannel = (server: TMarketplaceLaunchServer): TChannel => {
  const url = server.url ?? "";
  let sessionId: string | undefined;
  let nextId = 0;
  const post = async (
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Response> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    return res;
  };
  const rpc: TRpc = async (method, params = {}) => {
    const id = ++nextId;
    const timeout =
      method === "tools/call" ? CALL_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
    const res = await post({ id, method, params }, timeout);
    const text = await res.text();
    let msg: TRpcMessage | undefined;
    try {
      msg = (res.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      )
        ? fromSse(text, id)
        : (JSON.parse(text) as TRpcMessage);
    } catch {
      msg = undefined;
    }
    // A non-2xx without a JSON-RPC body reports the status, not a parse error.
    if (msg === undefined)
      throw new Error(
        res.ok ? "upstream sent no response" : `upstream HTTP ${res.status}`,
      );
    return unwrap(msg);
  };
  return {
    rpc,
    notify: async (method) => {
      await post({ method }, CONNECT_TIMEOUT_MS).then((r) => r.body?.cancel());
    },
    close: async () => {
      if (sessionId === undefined) return;
      await fetch(url, {
        method: "DELETE",
        headers: { ...server.headers, "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      }).catch(() => undefined);
    },
  };
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

/** Dial one upstream; rejects on any handshake failure. */
export const connectUpstream = async (
  server: TMarketplaceLaunchServer,
): Promise<TUpstream> => {
  const remote = server.transport !== "stdio";
  if (remote ? server.url === undefined : server.command === undefined)
    throw new Error(`${server.id}: incomplete launch entry`);
  const channel = remote ? httpChannel(server) : stdioChannel(server);
  try {
    await channel.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "openllm", version: CLI_VERSION },
    });
    await channel.notify("notifications/initialized");
    const tools = await listTools(channel.rpc);
    return {
      id: server.id,
      tools,
      call: async (name, args) => {
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

/** Dial every upstream in parallel; failures are logged and dropped. */
export const connectUpstreams = async (
  servers: readonly TMarketplaceLaunchServer[],
): Promise<readonly TUpstream[]> => {
  const settled = await Promise.allSettled(servers.map(connectUpstream));
  return settled.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    console.warn(
      `[MCP] marketplace ${servers[i]?.id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    );
    return [];
  });
};
