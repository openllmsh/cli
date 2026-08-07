/**
 * openllm native-API tool group — derived from the committed SDK artifacts
 * (`../../sdk/generated/operations.ts`), so it tracks the spec automatically.
 * Two surfaces are exported:
 *   - `openllmToolDefsAll` — every operation (browser chat + execution).
 *   - `openllmToolDefs`    — the MCP-listed subset (`isMcpExposed`), trimmed
 *                            to cut agent context bloat.
 * Execution (`byToolName` / `handleOpenllmTool`) always covers the FULL set,
 * so trimming ListTools never makes an operation uncallable. Mutating
 * operations (post/put/patch/delete) carry explicit consent copy in their
 * descriptions.
 */

import { callOperation } from "../../sdk/client";
import type { TApiOperation } from "../../sdk/generated/operations";
import { API_OPERATIONS } from "../../sdk/generated/operations";
import type { TToolResult } from "../types";

/** MCP tool names must match `[a-zA-Z0-9_-]+` — sanitize the operation id.
 *  Exported: the browser chat's tool bridge maps operations back to tool
 *  names with the SAME convention (no second naming scheme). */
export const toolNameFor = (op: TApiOperation): string =>
  `api_${op.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;

const MUTATING = new Set(["post", "put", "patch", "delete"]);

const descriptionFor = (op: TApiOperation): string => {
  const base =
    op.summary.length > 0
      ? op.summary
      : `${op.method.toUpperCase()} ${op.path}`;
  const wire = ` [${op.method.toUpperCase()} ${op.path}]`;
  const consent = MUTATING.has(op.method)
    ? " MUTATING operation — call only when the user explicitly asked for this change; confirm first when destructive."
    : "";
  return `${base}${wire}${consent}`;
};

const inputSchemaFor = (op: TApiOperation): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.pathParams) {
    properties[p] = { type: "string", description: `Path parameter \`${p}\`` };
    required.push(p);
  }
  for (const q of op.queryParams) {
    properties[q.name] = {
      type: "string",
      description: `Query parameter \`${q.name}\``,
    };
    if (q.required) required.push(q.name);
  }
  if (op.hasBody) {
    properties.body = {
      type: "object",
      description:
        "JSON request body — see the operation's schema in the OpenAPI spec (`openllm api --spec`).",
    };
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
};

const byToolName = new Map<string, TApiOperation>(
  API_OPERATIONS.map((op) => [toolNameFor(op), op]),
);

/** Which operations surface as MCP tools an agent SEES (ListTools). This
 *  trims context bloat; it does NOT gate execution — `byToolName` above
 *  keeps every operation callable, and the browser chat imports the full
 *  `openllmToolDefsAll` below. Denylist:
 *   1. `/plugins/*` — the curated `claude-context` + `supermemory` MCP
 *      groups already expose these better; the raw HTTP mirrors are dupes.
 *   2. Non-`/v1/*` mutations (post/put/patch/delete) — account/config/
 *      vault/keys/sessions/credentials writes an agent shouldn't drive
 *      through MCP. Inference (`/v1/*`) and all read-only GETs stay. */
const isMcpExposed = (op: TApiOperation): boolean => {
  if (op.path.startsWith("/plugins/")) return false;
  if (MUTATING.has(op.method) && !op.path.startsWith("/v1/")) return false;
  return true;
};

const toolDef = (op: TApiOperation) => ({
  name: toolNameFor(op),
  description: descriptionFor(op),
  inputSchema: inputSchemaFor(op),
});

/** The FULL native-API tool surface — every operation. Consumed by the
 *  browser chat tool bridge (`lib/chat/tools.ts`), which intentionally
 *  exposes inference + account ops for in-chat delegation. */
export const openllmToolDefsAll = API_OPERATIONS.map(toolDef);

/** The MCP-exposed surface — trimmed to reduce agent context. The
 *  `openllm mcp` server lists THIS. */
export const openllmToolDefs = API_OPERATIONS.filter(isMcpExposed).map(toolDef);

export const isOpenllmTool = (name: string): boolean => byToolName.has(name);

export const handleOpenllmTool = async (
  name: string,
  args: Record<string, unknown>,
  config: { baseUrl: string; apiKey: string },
): Promise<TToolResult> => {
  const op = byToolName.get(name);
  if (op === undefined) {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const res = await callOperation(config, op, args);
    const text =
      typeof res.body === "string"
        ? res.body
        : JSON.stringify(res.body, null, 2);
    if (!res.ok) {
      return {
        content: [
          { type: "text" as const, text: `HTTP ${res.status}: ${text}` },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
};
