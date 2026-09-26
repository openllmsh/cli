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

import { callOperation, localAwareFetch } from "../../sdk/client";
import {
  OPENLLM_CHAIN_HEADER,
  OPENLLM_RESOLVED_MODEL_HEADER,
} from "../../sdk/generated/inference-headers";
import generatedSpec from "../../sdk/generated/openapi.json";
import type { TApiOperation } from "../../sdk/generated/operations";
import { API_OPERATIONS } from "../../sdk/generated/operations";
import { SUBSCRIPTION_PROVIDER_SLUGS } from "../../sdk/generated/subscription-providers";
import type { TToolResult, TToolResultContent } from "../types";
import { MODELS_TOOL_NAME } from "./model-priority";

const schemaObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Resolve only local generated references; media body schemas have no recursive branches. */
const resolveGeneratedSchema = (
  value: unknown,
  seen: ReadonlySet<string> = new Set(),
): unknown => {
  if (Array.isArray(value))
    return value.map((item) => resolveGeneratedSchema(item, seen));
  const object = schemaObject(value);
  if (object === undefined) return value;
  if (
    typeof object.$ref === "string" &&
    object.$ref.startsWith("#/") &&
    !seen.has(object.$ref)
  ) {
    let target: unknown = generatedSpec;
    for (const segment of object.$ref.slice(2).split("/"))
      target =
        schemaObject(target)?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (target !== undefined)
      return resolveGeneratedSchema(target, new Set([...seen, object.$ref]));
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      resolveGeneratedSchema(child, seen),
    ]),
  );
};

const generatedBodySchema = (
  op: TApiOperation,
): Record<string, unknown> | undefined => {
  const paths = schemaObject(generatedSpec.paths);
  const operation = schemaObject(schemaObject(paths?.[op.path])?.[op.method]);
  const content = schemaObject(schemaObject(operation?.requestBody)?.content);
  const schema = schemaObject(content?.["application/json"])?.schema;
  return schemaObject(resolveGeneratedSchema(schema));
};

/** MCP tool names must match `[a-zA-Z0-9_-]+` — sanitize the operation id.
 *  Exported: the browser chat's tool bridge maps operations back to tool
 *  names with the SAME convention (no second naming scheme). */
export const toolNameFor = (op: TApiOperation): string =>
  `api_${op.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;

const MUTATING = new Set(["post", "put", "patch", "delete"]);
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

/** The media tools whose `model` is OPTIONAL — the one table. Consumers ask
 *  through {@link isMediaOptionalModelTool} rather than re-listing it. */
const MEDIA_OPTIONAL_MODEL_TOOLS: ReadonlySet<string> = new Set([
  "api_v1Images_imagesGenerations",
  "api_v1Images_imagesEdits",
  "api_v1Audio_transcriptions",
  "api_v1Audio_speech",
  "api_v1Videos_videosCreate",
]);

/** Also read by the browser chat, which marks exactly these `strict: false` —
 *  Responses normalizes an omitted `strict` toward strict, which would promote
 *  their optional fields to required. */
export const isMediaOptionalModelTool = (name: string): boolean =>
  MEDIA_OPTIONAL_MODEL_TOOLS.has(name);

/** Answers the loop this fixes: an agent filled every optional field, then on
 *  a rejection kept the body and swapped the model. So — smallest request,
 *  omit `model` rather than invent one (`"auto"` is named because agents reach
 *  for it, and it resolves as a literal id), and on a rejection change the FIELD
 *  (only what the agent added; a user's own constraint is reported, not
 *  silently overridden). */
const MEDIA_OPTIONAL_MODEL_GUIDANCE =
  ' Send the smallest request that expresses the user\'s intent — the optional fields are not a checklist, so send an optional key only when the user asked for that specific thing. Model is optional. Omit model entirely for automatic selection: omitting it is the default-selection mechanism (it uses the catalog-ranked media default chain — subscription candidates first, then a compatible API-key tail — and may fall through at runtime after a failed, unaccepted attempt), so never send a placeholder in its place — `model: "auto"` and `model: ""` are both invalid ways to request automatic selection, and `"auto"` in particular is taken as a literal model id. An explicit model is used as requested. If a field is rejected, fix that field and do not retry the same rejected fields under a different model: drop the unsupported options you added on your own, keep every constraint the user gave (voice, format, size, quality and the like), and if one of THOSE is what the provider refuses, report the conflict and the supported alternatives instead of silently changing or dropping it.';

const descriptionFor = (op: TApiOperation): string => {
  const base =
    op.summary.length > 0
      ? op.summary
      : `${op.method.toUpperCase()} ${op.path}`;
  const wire = ` [${op.method.toUpperCase()} ${op.path}]`;
  const consent = MUTATING.has(op.method)
    ? " MUTATING operation — call only when the user explicitly asked for this change; confirm first when destructive."
    : "";
  const name = toolNameFor(op);
  const media = MEDIA_OPTIONAL_MODEL_TOOLS.has(name)
    ? MEDIA_OPTIONAL_MODEL_GUIDANCE
    : "";
  return `${base}${wire}${consent}${media}`;
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
    properties.body = (MEDIA_OPTIONAL_MODEL_TOOLS.has(toolNameFor(op))
      ? generatedBodySchema(op)
      : undefined) ?? {
      type: "object",
      description:
        "JSON request body — see the operation's schema in the OpenAPI spec (`openllm api --spec`).",
    };
  }
  return {
    type: "object",
    properties,
    ...(MEDIA_OPTIONAL_MODEL_TOOLS.has(toolNameFor(op))
      ? { additionalProperties: false }
      : {}),
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

/** Browser-safe identification/limit shared with the CLI-only local adapter. */
export const TRANSCRIPTION_TOOL_NAME = "api_v1Audio_transcriptions";
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/** MCP-listed subset, with local input contracts where the CLI owns the IO. */
export const openllmToolDefs = API_OPERATIONS.filter(isMcpExposed).map(
  (op): TToolDef => {
    const def = toolDef(op);
    if (def.name === MODELS_TOOL_NAME) {
      return {
        ...def,
        description: `${def.description} Subscription providers: ${SUBSCRIPTION_PROVIDER_SLUGS.join(", ")}. Direct subscription provider/model IDs are listed first. Use exact returned IDs and check capabilities, audio formats, limits, and provider_type. Media inference may omit model (catalog-ranked chain; runtime fallback after a failed unaccepted attempt). Aliases are configurable fallback chains and may invoke API-key providers; they are not subscription guarantees. This is configured availability, not live readiness or remaining quota.`,
      };
    }
    if (def.name !== TRANSCRIPTION_TOOL_NAME) return def;
    return {
      ...def,
      description: `${def.description} Transcribe a local audio file by path; never send audio bytes or base64. Relative paths resolve from the MCP server working directory. Input and converted audio are limited to 25 MiB. WAV, MP3 and WebM pass through (provider codec restrictions still apply); Ogg (including Opus voice notes) and FLAC require system ffmpeg on PATH and are converted to mono 16 kHz PCM WAV.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description:
              "Local audio file path (absolute or relative to the MCP server working directory).",
          },
          model: {
            type: "string",
            minLength: 1,
            description:
              "Optional model; omit to use the catalog-ranked media default chain (subscription first, then a compatible API-key tail).",
          },
          language: {
            type: "string",
            minLength: 1,
            description: "Optional language code, for example en.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    };
  },
);

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

/** Which model served — or refused — this request, from the headers the
 *  gateway attaches on BOTH outcomes. Empty when nothing was resolved. */
const attributionFromHeaders = (headers: Headers): string => {
  const resolved = headers.get(OPENLLM_RESOLVED_MODEL_HEADER)?.trim() ?? "";
  if (resolved === "") return "";
  const chain = (headers.get(OPENLLM_CHAIN_HEADER) ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  return chain.length > 1
    ? `Served by ${resolved} (chain: ${chain.join(" → ")}).`
    : `Served by ${resolved}.`;
};

const withAttribution = (text: string, headers: Headers): string => {
  const attribution = attributionFromHeaders(headers);
  return attribution === "" ? text : `${text} ${attribution}`;
};

/** Status line and provider body (message, `param`, `code`) verbatim;
 *  attribution is APPENDED, and absent when no model was ever selected. */
const responseErrorResult = async (res: Response): Promise<TToolResult> => {
  const text = await res.text().catch(() => "");
  return textResult(
    withAttribution(`HTTP ${res.status}: ${text}`, res.headers),
    true,
  );
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
    // localAwareFetch: a daemon-hosted media URL is loopback and needs the
    // local caller token; a cloud/CDN URL passes through untouched.
    response = await localAwareFetch(durableUrl, {
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

/**
 * Aggregation of a canonical `/v1/images/generations` SSE body.
 *
 * A caller asking to stream is HONOURED end to end: the request is forwarded
 * unchanged and the HTTP surface really streams. This tool has no SSE reader,
 * so it collapses the event stream into the final result rather than
 * rewriting the caller's request to `stream: false` — which silently handed
 * an agent something other than what it asked for.
 *
 * Mirrors `packages/wire/lib/canonical/image-sse.ts` in behaviour, but is
 * reimplemented here because the CLI ships as a self-contained binary with no
 * workspace dependencies. Two deliberate differences from
 * `aggregateImageSse`: EVERY completion is kept (`n > 1` yields one completed
 * event per image, and dropping all but the last would lose images the user
 * paid for), and a terminal `error` frame is surfaced rather than swallowed.
 */
type TImageSseAggregate =
  | {
      readonly kind: "body";
      readonly body: {
        readonly created: number;
        readonly data: ReadonlyArray<TImageGenerationItem>;
      };
    }
  | { readonly kind: "error"; readonly message: string };

type TSseFrame = {
  readonly event: string | null;
  readonly data: string;
};

/**
 * Split an SSE body into frames.
 *
 * Follows the event-stream framing rules the gateway emits against: lines end
 * with LF, CRLF or CR; a blank line dispatches the frame; a line starting
 * with `:` is a COMMENT and carries no data (the gateway uses comments for
 * keepalives and for the "partials unavailable" note, precisely so no client
 * can mistake them for progress); repeated `data:` lines within one frame are
 * joined with a newline.
 */
const parseSseFrames = (raw: string): ReadonlyArray<TSseFrame> => {
  const frames: TSseFrame[] = [];
  let event: string | null = null;
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
    event = null;
    data = [];
  };
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  // A stream cut off mid-frame never dispatched its last frame; the spec
  // discards it, and so do we — a truncated frame is not a result.
  return frames;
};

const sseFrameError = (
  event: string | null,
  parsed: unknown,
): string | null => {
  const error =
    typeof parsed === "object" && parsed !== null && "error" in parsed
      ? (parsed as { readonly error: unknown }).error
      : null;
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { readonly message: unknown }).message === "string"
      ? (error as { readonly message: string }).message
      : null;
  if (message !== null) return message;
  return event === "error" ? "The image stream reported an error." : null;
};

const aggregateImageSseText = (raw: string): TImageSseAggregate => {
  const data: TImageGenerationItem[] = [];
  let created: number | null = null;
  let errorMessage: string | null = null;

  for (const frame of parseSseFrames(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      // An unparseable frame is not a result. Skipping it keeps a provider's
      // unknown extension from failing a generation that otherwise succeeded.
      continue;
    }
    const failure = sseFrameError(frame.event, parsed);
    if (failure !== null) {
      errorMessage = failure;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as {
      readonly type?: unknown;
      readonly b64_json?: unknown;
      readonly url?: unknown;
      readonly created_at?: unknown;
    };
    // Partials are successive PREVIEWS of one image, not fragments of it, so
    // they are discarded rather than concatenated.
    if (event.type !== "image_generation.completed") continue;
    if (created === null && typeof event.created_at === "number")
      created = event.created_at;
    data.push({
      ...(typeof event.b64_json === "string"
        ? { b64_json: event.b64_json }
        : {}),
      ...(typeof event.url === "string" ? { url: event.url } : {}),
    });
  }

  if (errorMessage !== null) {
    // Terminal, but never silent about what DID land: a per-image persistence
    // failure can follow completions, and those urls stay useful.
    const urls = data
      .map((item) => (typeof item.url === "string" ? item.url : null))
      .filter((url): url is string => url !== null);
    return {
      kind: "error",
      message:
        urls.length === 0
          ? errorMessage
          : `${errorMessage} Images that were saved: ${urls.join(" ")}`,
    };
  }
  if (data.length === 0) {
    return {
      kind: "error",
      message:
        "The image stream ended without a completed image. Nothing was generated.",
    };
  }
  return { kind: "body", body: { created: created ?? 0, data } };
};

const isEventStream = (headers: Headers): boolean =>
  (headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");

const imageResult = async (
  body: unknown,
  config: { readonly baseUrl: string },
  label: string,
  headers: Headers,
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
    withAttribution(label, headers),
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
  const res = await localAwareFetch(url, {
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
    return textResult(
      withAttribution(
        `HTTP ${res.status}: missing media url header`,
        res.headers,
      ),
      true,
    );
  }
  const durableUrl = new URL(mediaUrl, config.baseUrl).toString();
  if (kind === "video") {
    return textResult(
      withAttribution(`Video generated — ${durableUrl}`, res.headers),
    );
  }

  const media = await fetchDurableMedia(durableUrl, config.baseUrl, true);
  if (!media.ok) {
    await media.body?.cancel().catch(() => {});
    return textResult(
      withAttribution(
        `Audio generated — ${durableUrl} (still finalizing; open the url shortly)`,
        res.headers,
      ),
    );
  }
  return {
    content: [
      {
        type: "text",
        text: withAttribution(`Audio generated — ${durableUrl}`, res.headers),
      },
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
  if (op.path === "/v1/videos" && op.method === "post") {
    const properties = schemaObject(inputSchemaFor(op).properties) ?? {};
    if (Object.keys(args).some((key) => !Object.hasOwn(properties, key)))
      return textResult(
        "Invalid video tool envelope. Put canonical fields inside body; use input_image for a starting frame or reference_images for subject guidance, not input_reference.",
        true,
      );
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
    // Name the model that refused, so a retry fixes the FIELD, not the model.
    if (!res.ok)
      return textResult(
        withAttribution(`HTTP ${res.status}: ${text}`, res.headers),
        true,
      );
    if (
      op.path === "/v1/images/generations" ||
      op.path === "/v1/images/edits"
    ) {
      const label =
        op.path === "/v1/images/edits" ? "Image edited." : "Image generated.";
      // The RESPONSE decides how it is read — the declared content type, not
      // a guess at the body's shape. An ordinary JSON answer takes the
      // unchanged path below; only a real event stream is aggregated.
      if (!isEventStream(res.headers)) {
        return imageResult(res.body, config, label, res.headers);
      }
      const aggregated = aggregateImageSseText(text);
      if (aggregated.kind === "error") {
        // An HTTP 200 carrying a terminal `error` frame was still served by
        // some model; don't let it be the one failure shape that hides it.
        return textResult(
          withAttribution(aggregated.message, res.headers),
          true,
        );
      }
      return imageResult(aggregated.body, config, label, res.headers);
    }
    if (op.path === "/v1/audio/transcriptions" || op.path === "/v1/videos") {
      return textResult(withAttribution(text, res.headers));
    }
    return textResult(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
  }
};
