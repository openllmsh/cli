/**
 * Ephemeral loopback MCP server — declares the `sdk-facade` turn's caller
 * tools to the `claude` child over the streamable-HTTP MCP transport
 * (`claude mcp add --transport http` on the installed CLI; the SDK's
 * `McpHttpServerConfig` shape — `{type:"http", url, headers}` — is the SAME
 * wire shape the raw CLI's `--mcp-config` JSON accepts, verified against
 * `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`). `--max-turns 1` (always
 * passed by `claude-spawn.ts#buildClaudeFacadeArgv`) means the model's
 * `tool_use` ends the turn before the CLI would ever actually invoke this
 * server — `tools/call` is a defense-in-depth path, not the normal one.
 *
 * Every handler is INERT, mirroring Hermes's own `inert_mcp.py` (see
 * `12-hermes-adoption-plan.md` §3.D): `tools/list` advertises the caller's
 * exact schemas UNDER THEIR SANITIZED LEAF NAME ONLY — never prefixed. This
 * server is registered in the CLI's `--mcp-config` under the key `openllm`
 * (`claude-spawn.ts#facadeMcpConfigJson`'s `mcpServers.openllm`), and the
 * installed CLI itself prepends `mcp__<server-key>__` when it presents a
 * configured MCP server's tools to the model — the SAME two-layer split the
 * Agent SDK's own `createSdkMcpServer`/`tool()` uses for the in-process
 * passthrough path (`claude-tool-session.ts`/`claude-tool-capture.ts`
 * register bare `sanitizeClaudeMcpToolName(name)` leaves via `tool()`; the
 * SDK/CLI runtime does the `mcp__openllm__` prefixing, never the
 * registration call). Verified locally against the installed
 * `@anthropic-ai/claude-agent-sdk` bundle and the compiled `claude` CLI
 * binary's embedded `^mcp__(.+?)__` server-name-extraction regex (used to
 * look up a server by the CONFIG KEY captured between the first `mcp__` and
 * the next `__`) — there is no code path where an external `--mcp-config`
 * server is expected to self-advertise the `mcp__<server>__` prefix in its
 * own `tools/list` response; doing so here would DOUBLE-prefix the name the
 * model sees (`mcp__openllm__mcp__openllm__<leaf>`), which would never match
 * `claude-tool-capture.ts#buildClaudeToolNameMap`'s single-prefixed
 * `mcpToCaller` keys that `claude-sdk-facade.ts` decodes `tool_use` blocks
 * against — this module only sanitizes the leaf (`sanitizeClaudeMcpToolName`)
 * and never emits `CLAUDE_MCP_TOOL_PREFIX` itself. `tools/call` NEVER
 * executes — it answers an explicit MCP tool error and reports the attempt,
 * so a caller can treat it as "capture boundary breached" rather than
 * silently returning a fabricated success (00-requirements.md req. 2/6:
 * caller tools stay caller-owned; a requested function call is never a
 * completed one).
 *
 * A separate implementation from `cursor-mcp-server.ts` on purpose — that
 * server's `tools/call` cuts the ACP session over to OpenAI tool_calls
 * semantics (Cursor's only tool boundary); this one must never look
 * "successful" to the CLI, since the facade's tool boundary is the
 * `content_block_start`/`stop` `tool_use` blocks in the model's OWN message,
 * decoded by `claude-sdk-facade.ts`, never an MCP round-trip.
 */

import { randomUUID } from "node:crypto";
import { sanitizeClaudeMcpToolName } from "./claude-tool-capture";
import type { TClientTool } from "./claude-tool-session";

export type TClaudeFacadeMcpServer = {
  readonly url: string;
  readonly headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly stop: () => void;
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
 * Start the per-turn loopback MCP server. `onForbiddenCall` fires if the CLI
 * ever actually invokes a tool (should not happen under `--max-turns 1`; see
 * module doc) — callers treat this as a capture-boundary alarm, not a normal
 * event.
 */
export const startClaudeFacadeMcpServer = (params: {
  readonly tools: ReadonlyArray<TClientTool>;
  readonly onForbiddenCall: (name: string) => void;
}): TClaudeFacadeMcpServer => {
  const token = randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (req.method !== "POST") {
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
      switch (body.method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "openllm-facade-tools", version: "1" },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return rpcResult(id, {
            tools: params.tools.map((tool) => ({
              // SANITIZED LEAF ONLY — same as `claude-tool-session.ts`'s
              // `tool(sanitize(t.name), ...)` in-process registration. The
              // installed CLI (registered here under the `openllm` key —
              // `claude-spawn.ts#facadeMcpConfigJson`) is the one that
              // prepends `mcp__openllm__` before presenting this to the
              // model — never this server. Advertising the already-prefixed
              // name here would make the CLI double-prefix it
              // (`mcp__openllm__mcp__openllm__<leaf>`), which would never
              // match `buildClaudeToolNameMap`'s single-prefixed
              // `mcpToCaller` keys that `claude-sdk-facade.ts` decodes
              // `tool_use` blocks against.
              name: sanitizeClaudeMcpToolName(tool.name),
              ...(tool.description !== undefined
                ? { description: tool.description }
                : {}),
              inputSchema: { ...tool.parameters, type: "object" },
            })),
          });
        case "tools/call": {
          const p = body.params as { readonly name?: unknown } | undefined;
          const name = typeof p?.name === "string" ? p.name : "<unknown>";
          params.onForbiddenCall(name);
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: "sdk-facade: tool execution is caller-owned; this server never executes a tool",
              },
            ],
            isError: true,
          });
        }
        default:
          return typeof body.method === "string" && id === null
            ? new Response(null, { status: 202 })
            : rpcError(id, -32601, "method not found");
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    stop: (): void => {
      server.stop(true);
    },
  };
};
