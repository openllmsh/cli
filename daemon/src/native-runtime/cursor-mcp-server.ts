/**
 * Ephemeral loopback MCP server — the vehicle that exposes an inbound
 * request's CLIENT function tools to the Cursor agent. `session/new` accepts
 * `mcpServers: [{ type: "http", name, url, headers }]` (VERIFIED via
 * t3code's working integration + the agent's advertised `mcpCapabilities:
 * { http: true }`), so per request we bind a Bun.serve on 127.0.0.1:0 with a
 * random bearer token and implement the minimal streamable-HTTP MCP subset
 * by hand (POST JSON-RPC: initialize / notifications/initialized /
 * tools/list / tools/call) — no SDK dependency.
 *
 * Tool-call semantics (v1, stateless-gateway): the FIRST `tools/call` the
 * agent makes is relayed to `onToolCall` — the serve path then emits an
 * OpenAI `tool_calls` delta + `finish_reason: "tool_calls"` to the client,
 * cancels the ACP session, and this server answers the MCP call with an
 * error result so the (already-cancelled) agent loop never hangs. The client
 * executes the tool and resends the conversation with `tool`-role results,
 * which `cursorRequestOf` folds back into the next cold session's prompt.
 * Correct OpenAI semantics at the cost of a cold session per tool round —
 * documented tradeoff, matches the bridge's no-resume v1 scoping.
 */

import { randomUUID } from "node:crypto";
import type { TCursorTool } from "./cursor-request";

export type TCursorMcpServer = {
  readonly url: string;
  readonly headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly stop: () => void;
  /** End every held `tools/call` now (as a cancelled error) without
   *  stopping the server — the persistent session stays reachable. */
  readonly releaseHeld: () => void;
};

type TRpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: number | string | null;
  readonly method?: unknown;
  readonly params?: unknown;
};

const rpcResult = (id: number | string | null, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });

const rpcError = (
  id: number | string | null,
  code: number,
  message: string,
): Response => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Start the per-request loopback MCP server. `onToolCall` fires on every
 * `tools/call` (name + parsed arguments); its RESPONSE to the agent is a
 * fixed "executed by the gateway client" text (the turn is being cut over to
 * OpenAI tool_calls semantics — see module header).
 */
export const startCursorMcpServer = (params: {
  readonly tools: ReadonlyArray<TCursorTool>;
  readonly onToolCall: (name: string, args: unknown) => void;
  /** Closed method vocabulary only — never arguments or bearer metadata. */
  readonly onRequest?: (
    method: "initialize" | "tools/list" | "tools/call",
  ) => void;
  /**
   * Persistent-session mode: a `tools/call` is NEVER answered with a fake
   * success (the agent would record it, and the client's real tool result
   * would then be a second result for one call). The response is held until
   * the agent drops the request (its prompt was cancelled) or the server
   * stops, then answered as a cancelled error. Every call is held, not only
   * the first.
   */
  readonly holdToolCalls?: boolean;
}): TCursorMcpServer => {
  const token = randomUUID();
  const held = new Set<() => void>();
  const releaseHeld = (): void => {
    for (const release of held) release();
    held.clear();
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (req: Request): Promise<Response> => {
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (req.method !== "POST") {
        // Streamable-HTTP GET opens an SSE stream for server-initiated
        // messages — we have none; 405 tells the client to skip it.
        return new Response(null, { status: 405 });
      }
      let body: TRpcRequest;
      try {
        body = (await req.json()) as TRpcRequest;
      } catch {
        return rpcError(null, -32700, "parse error");
      }
      const id =
        typeof body.id === "number" || typeof body.id === "string"
          ? body.id
          : null;
      if (
        body.method === "initialize" ||
        body.method === "tools/list" ||
        body.method === "tools/call"
      ) {
        params.onRequest?.(body.method);
      }
      switch (body.method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "openllm-client-tools", version: "1" },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return rpcResult(id, {
            tools: params.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description !== null
                ? { description: tool.description }
                : {}),
              inputSchema: tool.parameters,
            })),
          });
        case "tools/call": {
          const p = body.params as
            | { readonly name?: unknown; readonly arguments?: unknown }
            | undefined;
          if (typeof p?.name !== "string") {
            return rpcError(id, -32602, "tools/call requires a name");
          }
          if (params.holdToolCalls === true) {
            // Registered BEFORE the callback: it may end the turn (and
            // release every held call) synchronously.
            const hold = new Promise<void>((resolve) => {
              held.add(resolve);
              req.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            params.onToolCall(p.name, p.arguments ?? {});
            await hold;
            return rpcResult(id, {
              content: [{ type: "text", text: "Cancelled." }],
              isError: true,
            });
          }
          params.onToolCall(p.name, p.arguments ?? {});
          // The turn is being finished with OpenAI tool_calls semantics; the
          // agent session is cancelled by the caller. Answer anyway so a
          // still-draining agent never hangs on this HTTP call.
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: "Tool execution is delegated to the API client; this turn ends here.",
              },
            ],
            isError: false,
          });
        }
        default:
          return typeof body.method === "string" && id === null
            ? new Response(null, { status: 202 }) // unknown notification
            : rpcError(id, -32601, "method not found");
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    releaseHeld,
    stop: () => {
      releaseHeld();
      server.stop(true);
    },
  };
};
