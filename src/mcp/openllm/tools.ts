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
import type { TToolResult, TToolResultContent } from "../types";

/** MCP tool names must match `[a-zA-Z0-9_-]+` — sanitize the operation id.
 *  Exported: the browser chat's tool bridge maps operations back to tool
 *  names with the SAME convention (no second naming scheme). */
export const toolNameFor = (op: TApiOperation): string =>
  `api_${op.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;

const MUTATING = new Set(["post", "put", "patch", "delete"]);
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

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

/** Endpoints that require a browser SESSION, not an `sk-llm-…` key, and so
 *  always 401 from the CLI. `/user/auth-methods` reads the auth service's
 *  `list-accounts` with the caller's cookies (see `authMethodsHandler`) and
 *  refuses the key path outright. Execution stays possible via `byToolName`;
 *  this only keeps them out of ListTools. */
const SESSION_ONLY_PATHS: ReadonlySet<string> = new Set(["/user/auth-methods"]);

/** Which operations surface as MCP tools an agent SEES (ListTools). This
 *  trims context bloat; it does NOT gate execution — `byToolName` above
 *  keeps every operation callable, and the browser chat imports the full
 *  `openllmToolDefsAll` below. Denylist:
 *   1. `/plugins/*` — the curated `claude-context` + `supermemory` MCP
 *      groups already expose these better; the raw HTTP mirrors are dupes.
 *   2. Non-`/v1/*` mutations (post/put/patch/delete) — account/config/
 *      vault/keys/sessions/credentials writes an agent shouldn't drive
 *      through MCP. Inference (`/v1/*`) and all read-only GETs stay.
 *   3. {@link SESSION_ONLY_PATHS} — read-only GETs the gateway serves ONLY to
 *      a browser session. The CLI authenticates with an API key and has no
 *      session cookie, so listing them spends an agent's context on a call
 *      that can only ever come back 401. */
const isMcpExposed = (op: TApiOperation): boolean => {
  if (op.path.startsWith("/plugins/")) return false;
  if (MUTATING.has(op.method) && !op.path.startsWith("/v1/")) return false;
  if (SESSION_ONLY_PATHS.has(op.path)) return false;
  return true;
};

type TToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const toolDef = (op: TApiOperation): TToolDef => ({
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

/** Names in the MCP-exposed subset. The `openllm mcp` server gates CallTool
 *  on THIS — not `isOpenllmTool` — so a client cannot invoke a hidden
 *  (generated-but-untrimmed) operation it was never offered. */
const mcpListedNames = new Set(openllmToolDefs.map((t) => t.name));

/** True when `name` is a native-API tool the CLI can EXECUTE. The full set
 *  (every generated operation) — used by the browser chat bridge, which
 *  exposes the whole surface. NOT an authorization gate for the MCP server;
 *  that uses `isMcpListedTool`. */
export const isOpenllmTool = (name: string): boolean => byToolName.has(name);

/** True when `name` is in the MCP-LISTED subset (`openllmToolDefs`). The
 *  `openllm mcp` CallTool handler uses this to reject tools it never
 *  advertised, so trimming ListTools also trims what can be invoked. */
export const isMcpListedTool = (name: string): boolean =>
  mcpListedNames.has(name);

const textResult = (text: string, isError = false): TToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const base64FromBytes = (bytes: ArrayBuffer): string => {
  const byteString = Array.from(new Uint8Array(bytes), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return btoa(byteString);
};

const resolveRawOperationUrl = (
  config: { readonly baseUrl: string },
  op: TApiOperation,
  args: Record<string, unknown>,
): string => {
  let path = op.path;
  for (const param of op.pathParams) {
    const value = args[param];
    if (value === undefined || value === null || String(value).length === 0) {
      throw new Error(`missing required path parameter "${param}"`);
    }
    path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(
    path.startsWith("/v1/") ? path : `/api${path}`,
    config.baseUrl,
  );
  for (const query of op.queryParams) {
    const value = args[query.name];
    if (value === undefined || value === null) {
      if (query.required) {
        throw new Error(`missing required query parameter "${query.name}"`);
      }
      continue;
    }
    url.searchParams.set(query.name, String(value));
  }
  return url.toString();
};

const responseErrorResult = async (res: Response): Promise<TToolResult> => {
  const text = await res.text().catch(() => "");
  return textResult(`HTTP ${res.status}: ${text}`, true);
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isApiMediaUrl = (url: string, baseUrl: string): boolean => {
  try {
    return new URL(url, baseUrl).pathname.startsWith("/api/media/");
  } catch {
    return false;
  }
};

const fetchDurableMedia = async (
  url: string,
  baseUrl: string,
  retry: boolean,
): Promise<Response> => {
  const durableUrl = new URL(url, baseUrl);

  let response: Response | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await fetch(durableUrl, {
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });

    if (response.ok || retry === false || attempt === 4) {
      return response;
    }

    await response.body?.cancel().catch(() => {});
    await sleep(attempt % 2 === 0 ? 250 : 500);
  }

  return response ?? new Response(null, { status: 500 });
};

const imageContentFromUrl = async (
  url: string,
  baseUrl: string,
): Promise<Extract<TToolResultContent, { type: "image" }>> => {
  const res = await fetchDurableMedia(
    url,
    baseUrl,
    isApiMediaUrl(url, baseUrl),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return {
    type: "image",
    data: base64FromBytes(await res.arrayBuffer()),
    mimeType: res.headers.get("content-type") ?? "image/png",
  };
};

type TImageGenerationItem = {
  readonly url?: unknown;
  readonly b64_json?: unknown;
  readonly revised_prompt?: unknown;
};

const isImageGenerationBody = (
  body: unknown,
): body is { readonly data: ReadonlyArray<TImageGenerationItem> } =>
  typeof body === "object" &&
  body !== null &&
  "data" in body &&
  Array.isArray(body.data);

const imageResult = async (
  body: unknown,
  config: { readonly baseUrl: string },
): Promise<TToolResult> => {
  if (!isImageGenerationBody(body)) {
    return textResult(JSON.stringify(body, null, 2));
  }

  const urls: string[] = [];
  const revisedPrompts: string[] = [];
  const content: TToolResultContent[] = [];
  for (const item of body.data) {
    const url = typeof item.url === "string" ? item.url : null;
    if (url !== null) urls.push(url);
    if (typeof item.revised_prompt === "string") {
      revisedPrompts.push(item.revised_prompt);
    }

    if (typeof item.b64_json === "string") {
      content.push({
        type: "image",
        data: item.b64_json,
        mimeType: "image/png",
      });
      continue;
    }
    if (url === null) continue;

    try {
      content.push(await imageContentFromUrl(url, config.baseUrl));
    } catch {
      // The durable URL remains useful even if a transient fetch failure means
      // it cannot be embedded in this response.
    }
  }

  const notes = [
    "Image generated.",
    ...urls,
    ...revisedPrompts.map((prompt) => `Revised prompt: ${prompt}`),
  ];
  return { content: [{ type: "text", text: notes.join(" ") }, ...content] };
};

type TMediaRedirectKind = "audio" | "video";

const mediaRedirectKindFor = (op: TApiOperation): TMediaRedirectKind | null => {
  if (op.path === "/v1/audio/speech") return "audio";
  if (op.path === "/v1/videos/{video_id}/content") return "video";
  return null;
};

const mediaRedirectResult = async (
  config: { readonly baseUrl: string; readonly apiKey: string },
  op: TApiOperation,
  args: Record<string, unknown>,
  kind: TMediaRedirectKind,
): Promise<TToolResult> => {
  const url = resolveRawOperationUrl(config, op, args);
  const body =
    op.hasBody && args.body !== undefined
      ? JSON.stringify(args.body)
      : undefined;
  const res = await fetch(url, {
    method: op.method.toUpperCase(),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return responseErrorResult(res);

  await res.body?.cancel();
  const mediaUrl = res.headers.get("x-openllm-media-url");
  if (mediaUrl === null || mediaUrl.length === 0) {
    return textResult(`HTTP ${res.status}: missing media url header`, true);
  }
  const durableUrl = new URL(mediaUrl, config.baseUrl).toString();
  if (kind === "video") return textResult(`Video generated — ${durableUrl}`);

  const media = await fetchDurableMedia(durableUrl, config.baseUrl, true);
  if (!media.ok) {
    await media.body?.cancel().catch(() => {});
    return textResult(
      `Audio generated — ${durableUrl} (still finalizing; open the url shortly)`,
    );
  }
  return {
    content: [
      { type: "text", text: `Audio generated — ${durableUrl}` },
      {
        type: "audio",
        data: base64FromBytes(await media.arrayBuffer()),
        mimeType: media.headers.get("content-type") ?? "audio/mpeg",
      },
    ],
  };
};

export const handleOpenllmTool = async (
  name: string,
  args: Record<string, unknown>,
  config: { baseUrl: string; apiKey: string },
): Promise<TToolResult> => {
  const op = byToolName.get(name);
  if (op === undefined) {
    return textResult(`Unknown tool: ${name}`, true);
  }
  try {
    const mediaRedirectKind = mediaRedirectKindFor(op);
    if (mediaRedirectKind !== null) {
      return await mediaRedirectResult(config, op, args, mediaRedirectKind);
    }

    const res = await callOperation(config, op, args);
    const text =
      typeof res.body === "string"
        ? res.body
        : JSON.stringify(res.body, null, 2);
    if (!res.ok) return textResult(`HTTP ${res.status}: ${text}`, true);
    if (op.path === "/v1/images/generations")
      return imageResult(res.body, config);
    return textResult(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
  }
};
