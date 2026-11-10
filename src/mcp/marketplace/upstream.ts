/**
 * CLI marketplace upstream dialer. HTTP/SSE remotes go through
 * `@openllmsh/sdk/mcp` (`connectUpstream` / `connectUpstreams`); this module
 * only adds the Bun.spawn stdio transport the compiled CLI can spawn.
 */

import type {
  TConnectUpstreamOptions,
  TConnectUpstreamsOptions,
  TMarketplaceLaunchServer,
  TMcpChannel,
  TUpstream,
  TUpstreamTool,
} from "@openllmsh/sdk/mcp";
import {
  CALL_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  connectUpstream as connectSdkUpstream,
  connectUpstreams as connectSdkUpstreams,
  UPSTREAM_TOOL_SEPARATOR,
  upstreamToolName,
} from "@openllmsh/sdk/mcp";
import { CLI_VERSION } from "../../cli-version";

export type { TUpstream, TUpstreamTool };
export { UPSTREAM_TOOL_SEPARATOR, upstreamToolName };

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

/** Bun.spawn newline-delimited JSON-RPC channel for a stdio launch entry. */
const stdioChannel = (server: TMarketplaceLaunchServer): TMcpChannel => {
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

const channelForStdio = (
  server: TMarketplaceLaunchServer,
): TMcpChannel | undefined => {
  if (server.transport !== "stdio") return undefined;
  if (server.command === undefined) return undefined;
  return stdioChannel(server);
};

/** Dial one upstream (HTTP/SSE via SDK, stdio via Bun.spawn). */
export const connectUpstream = async (
  server: TMarketplaceLaunchServer,
  options: TConnectUpstreamOptions = {},
): Promise<TUpstream> => {
  if (server.transport === "stdio") {
    if (server.command === undefined)
      throw new Error(`${server.id}: incomplete launch entry`);
    return connectSdkUpstream(server, {
      clientVersion: CLI_VERSION,
      ...options,
      channel: options.channel ?? stdioChannel(server),
    });
  }
  return connectSdkUpstream(server, {
    clientVersion: CLI_VERSION,
    ...options,
  });
};

/** Dial every upstream in parallel; stdio entries get a Bun.spawn channel. */
export const connectUpstreams = async (
  servers: readonly TMarketplaceLaunchServer[],
  options: TConnectUpstreamsOptions = {},
): Promise<readonly TUpstream[]> =>
  connectSdkUpstreams(servers, {
    clientVersion: CLI_VERSION,
    onWarn: (message) => console.warn(message),
    ...options,
    channelFor: (server) =>
      options.channelFor?.(server) ?? channelForStdio(server),
  });
