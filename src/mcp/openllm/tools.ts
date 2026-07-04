/**
 * openllm native-API tool group — every operation in the generated OpenAPI
 * spec becomes an MCP tool. The tool surface is DERIVED from the committed
 * SDK artifacts (`../../sdk/generated/operations.ts`), so coverage tracks
 * the spec automatically — no hand-picked subset. Mutating operations
 * (post/put/patch/delete) carry explicit consent copy in their descriptions.
 */

import { callOperation } from "../../sdk/client";
import {
  API_OPERATIONS,
  type TApiOperation,
} from "../../sdk/generated/operations";

// runtime-only: the MCP tool-result envelope.
type TToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** MCP tool names must match `[a-zA-Z0-9_-]+` — sanitize the operation id. */
const toolNameFor = (op: TApiOperation): string =>
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
        "JSON request body — see the operation's schema in the OpenAPI spec (`openllmc api --spec`).",
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

export const openllmToolDefs = API_OPERATIONS.map((op) => ({
  name: toolNameFor(op),
  description: descriptionFor(op),
  inputSchema: inputSchemaFor(op),
}));

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
