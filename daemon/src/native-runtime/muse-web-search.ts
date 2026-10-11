/**
 * Muse host-native web search — narrow approval policy + wire reporting.
 *
 * Muse exposes TWO similarly-named tools:
 *   - `web_search` — provider-hosted web search (query in args)
 *   - `search`     — local filesystem search (pattern in args)
 *
 * ## Host policy contract (SDK / ACP evidence — not guessed)
 *
 * MSP `ApprovalMode` is closed select-never-create: clients cannot push an
 * allowlist rule such as "web_search only"
 * (`SessionSetApprovalModeParams`, sdk-migration.md). Official probes:
 *   - `onRequest`: known-safe tools (e.g. `pwd`) run WITHOUT `onApproval`
 *   - `denyUnmatched` (1.2.1): unmatched tools ask then deny when rejected;
 *     live OS-sandboxed probes also showed pathological delayed completion
 *     (~71s vs ~10s) while still reading synthetic HOME with zero callbacks
 *   - `--disable-write` / `--disable-shell`: spawn-time floor (not reads)
 *
 * Therefore this module's `onApproval` decision is ONLY authoritative for
 * tools the host actually prompts. It must not be described as denying
 * known-safe auto-exec. Runtime pairs `onRequest` + approve-once
 * `web_search` + auth overlay outside `workspaceRoot` + daemon sandbox.
 * Absolute-path known-safe reads of HOME remain an explicit residual under
 * BOTH modes — local test candidate only; do not invent stronger claims.
 *
 * Official `rawArgs` / toolCall `args` for `web_search` are the
 * model-authored JSON object string with a `query` string
 * (`ApprovalRequestParams.rawArgs`; ACP `web_search.query`). Missing or
 * invalid query objects never approve.
 *
 * Completed provider-executed `web_search` toolCalls are REPORTED as
 * canonical `server_search_calls`. They are NEVER re-emitted as caller
 * `tool_calls`. Citation urls accept only credential-less http(s).
 */

import type { TServerSearchCall } from "@openllmsh/protocol";
import type { TMuseToolNameMap } from "./muse-mcp-server";

/** MSP approval choice fields this policy reads. */
export type TMuseApprovalChoice = {
  readonly choiceId: string;
  readonly decision: string;
  readonly scope: string;
};

/** MSP `approval/requested` fields this policy reads. */
export type TMuseApprovalRequest = {
  readonly approvalId?: string;
  readonly toolName?: string | null;
  readonly toolCallId?: string | null;
  readonly rawArgs?: string | null;
  readonly protectedWrite?: boolean;
  readonly availableChoices: ReadonlyArray<TMuseApprovalChoice>;
  readonly subject?: {
    readonly kind?: string | null;
    readonly toolName?: string | null;
    readonly path?: string | null;
    readonly command?: string | null;
  } | null;
};

/** Folded `toolCall` fields used to build a ServerSearchCall. */
export type TMuseSearchToolCall = {
  readonly itemId: string;
  readonly callId?: string;
  readonly tool?: string;
  readonly args?: string;
  readonly status?: string;
  readonly visibleOutput?: string;
};

/** ACP search-card titles slice query text to 1024; keep the same bound. */
export const MUSE_WEB_SEARCH_QUERY_MAX_CHARS = 1024;

/** Keys that mark a non-search / protected operation payload. */
const PROTECTED_ARG_KEYS = [
  "command",
  "path",
  "file",
  "filename",
  "cwd",
  "argv",
] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const parseArgsObject = (
  raw: string | null | undefined,
): Record<string, unknown> | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
};

/**
 * Official `web_search` args: JSON object with a non-empty `query` string
 * (MSP verbatim args / ACP `web_search.query`). Rejects filesystem `pattern`,
 * protected operation keys, and oversized queries.
 */
export const webSearchQueryOf = (
  raw: string | null | undefined,
): string | null => {
  const args = parseArgsObject(raw);
  if (args === null) return null;
  const query = asString(args.query);
  if (query === null) return null;
  if (query.length > MUSE_WEB_SEARCH_QUERY_MAX_CHARS) return null;
  if (asString(args.pattern) !== null) return null;
  for (const key of PROTECTED_ARG_KEYS) {
    if (key in args) return null;
  }
  return query;
};

/**
 * Exact host-native web_search identity from the SDK-typed approval subject.
 *
 * Uses strict equality on `toolName` / `subject.toolName` / `subject.kind` —
 * never substring / regex matching (so filesystem `search`, `web_search_foo`,
 * or a caller MCP tool that merely contains "search" cannot pass).
 * Requires a valid bounded official `query` object in `rawArgs`.
 */
export const isHostNativeWebSearchApproval = (
  request: TMuseApprovalRequest,
): boolean => {
  if (request.protectedWrite === true) return false;

  // Prefer the request-level toolName (ApprovalRequestParams.toolName); fall
  // back to the typed subject.toolName. Both must be exact when both exist.
  const requestTool = asString(request.toolName);
  const subjectTool = asString(request.subject?.toolName);
  if (
    requestTool !== null &&
    subjectTool !== null &&
    requestTool !== subjectTool
  ) {
    return false;
  }
  const toolName = requestTool ?? subjectTool;
  if (toolName !== "web_search") return false;

  // SDK ApprovalSubject.kind is required on the wire. When present it must be
  // the tool/network subject — never shell / fileAccess / process.
  const subjectKind = asString(request.subject?.kind);
  if (subjectKind === null) return false;
  if (subjectKind !== "tool" && subjectKind !== "network") return false;
  if (asString(request.subject?.path) !== null) return false;
  if (asString(request.subject?.command) !== null) return false;

  // Missing / invalid / pattern-shaped / protected rawArgs never approve.
  return webSearchQueryOf(request.rawArgs) !== null;
};

/**
 * Drop a caller function tool literally named `web_search` so the Muse
 * host-native search owns the turn (Codex `suppressHostedSearchClientTool`
 * parity). Other caller tools — including ones whose names merely contain
 * "search" — stay registered for MCP handoff.
 */
export const suppressMuseHostedSearchClientTool = <
  T extends { readonly name: string },
>(
  tools: ReadonlyArray<T>,
): ReadonlyArray<T> => tools.filter((tool) => tool.name !== "web_search");

const pickChoice = (
  choices: ReadonlyArray<TMuseApprovalChoice>,
  decisions: ReadonlyArray<string>,
  scope?: string,
): TMuseApprovalChoice | undefined =>
  choices.find(
    (choice) =>
      decisions.includes(choice.decision) &&
      (scope === undefined || choice.scope === scope),
  );

/**
 * True iff `request` is asking approval for a tool call whose name is one of
 * OUR OWN registered caller/MCP function tools (`params.tools` on
 * `runMuseNative`, served by the per-turn loopback `startMuseMcpServer`).
 * Approving this does NOT execute anything native: it only lets MSP proceed
 * to call our own loopback MCP server, whose handler immediately fires
 * `onToolCall` and ends the turn as an OpenAI `tool_calls` intent for the
 * caller to run themselves — the same "returned unexecuted" contract already
 * used for Claude/Codex/Cursor caller tools.
 *
 * `nameMap` MUST be built by the shared {@link buildMuseToolNameMap} (from
 * `muse-mcp-server.ts`) over the SAME `params.tools` this turn actually
 * registered. Require Meta's observed namespaced MCP wire form
 * (`mcp__openllm_muse_client_tools.<leaf>` — {@link MUSE_MCP_WIRE_PREFIX} /
 * `museMcpWireToolName`) via exact `wireToCaller` membership. A bare name
 * proves registration, not provenance: it could also name a Muse built-in.
 * Never use prefix/substring matching or accept a missing subject kind (the
 * SDK requires it). Defense in depth mirrors
 * {@link isHostNativeWebSearchApproval}: a `protectedWrite` flag, or a
 * `subject.kind`/`path`/`command` naming a real execution surface (shell,
 * fileAccess, process), never approves even given a name match.
 */
export const isRegisteredCallerToolApproval = (
  request: TMuseApprovalRequest,
  nameMap: TMuseToolNameMap,
): boolean => {
  if (request.protectedWrite === true) return false;
  const requestTool = asString(request.toolName);
  const subjectTool = asString(request.subject?.toolName);
  if (
    requestTool !== null &&
    subjectTool !== null &&
    requestTool !== subjectTool
  ) {
    return false;
  }
  const toolName = requestTool ?? subjectTool;
  if (toolName === null) return false;
  if (!nameMap.wireToCaller.has(toolName)) return false;

  const subjectKind = asString(request.subject?.kind);
  if (subjectKind !== "tool" && subjectKind !== "network") {
    return false;
  }
  if (asString(request.subject?.path) !== null) return false;
  if (asString(request.subject?.command) !== null) return false;
  return true;
};

/**
 * Narrow host-native approval decision.
 * - `web_search` → approve once only (`decision=approved`, `scope=once`)
 * - a registered caller/MCP tool (when `nameMap` is given) → approve once
 *   only — see {@link isRegisteredCallerToolApproval}; never native
 *   execution, only a handoff to our own loopback MCP server
 * - everything else → deny/abort once
 * No `approvedForSession` / persistent allow fallback for EITHER approve
 * branch — an approval choice that isn't explicitly `scope: "once"` is
 * never accepted, matching the same strict rule `web_search` already used;
 * a broader/session/persistent grant is refused with a thrown error rather
 * than silently taken.
 */
export const decideMuseNativeApproval = (
  request: TMuseApprovalRequest,
  nameMap?: TMuseToolNameMap,
): { readonly choiceId: string } => {
  if (isHostNativeWebSearchApproval(request)) {
    const allow = pickChoice(request.availableChoices, ["approved"], "once");
    if (allow !== undefined) return { choiceId: allow.choiceId };
    throw new Error(
      "Muse offered no approve-once choice for host-native web_search",
    );
  }
  if (
    nameMap !== undefined &&
    isRegisteredCallerToolApproval(request, nameMap)
  ) {
    const allow = pickChoice(request.availableChoices, ["approved"], "once");
    if (allow !== undefined) return { choiceId: allow.choiceId };
    throw new Error(
      "Muse offered no approve-once choice for a registered caller tool",
    );
  }
  const deny =
    pickChoice(request.availableChoices, ["denied", "abort"], "once") ??
    pickChoice(request.availableChoices, ["denied", "abort"]);
  if (deny === undefined) {
    throw new Error(
      "Muse offered no deny/abort choice; native tool was not approved",
    );
  }
  return { choiceId: deny.choiceId };
};

/** Public citation/result urls: http(s) only, no credentials, no opaque schemes. */
export const isSafeHttpUrl = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (parsed.hostname.length === 0) return false;
  return true;
};

const resultEntryOf = (
  value: unknown,
): { readonly url: string; readonly title?: string } | null => {
  const rec = asRecord(value);
  if (rec === null) return null;
  const url =
    asString(rec.url) ?? asString(rec.link) ?? asString(rec.href) ?? null;
  if (url === null || !isSafeHttpUrl(url)) return null;
  const title = asString(rec.title) ?? asString(rec.name) ?? undefined;
  return title !== undefined ? { url, title } : { url };
};

/** Collect public url/title pairs from a structured search payload. */
export const searchResultsFromVisibleOutput = (
  visibleOutput: string | undefined,
): ReadonlyArray<{ readonly url: string; readonly title?: string }> => {
  if (typeof visibleOutput !== "string" || visibleOutput.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(visibleOutput);
  } catch {
    return [];
  }
  const rec = asRecord(parsed);
  const buckets: unknown[] = [];
  if (rec !== null) {
    for (const key of ["results", "citations", "sources", "links"] as const) {
      const value = rec[key];
      if (Array.isArray(value)) buckets.push(...value);
    }
  } else if (Array.isArray(parsed)) {
    buckets.push(...parsed);
  }
  const out: Array<{ readonly url: string; readonly title?: string }> = [];
  const seen = new Set<string>();
  for (const entry of buckets) {
    const mapped = resultEntryOf(entry);
    if (mapped === null || seen.has(mapped.url)) continue;
    seen.add(mapped.url);
    out.push(mapped);
    if (out.length >= 32) break;
  }
  return out;
};

/**
 * Map a completed Muse `web_search` toolCall onto a canonical ServerSearchCall.
 * Returns null for non-search tools, incomplete items, or query-less payloads.
 */
export const serverSearchCallFromMuseToolCall = (
  item: TMuseSearchToolCall,
): TServerSearchCall | null => {
  if (item.tool !== "web_search") return null;
  if (item.status !== undefined && item.status !== "completed") return null;
  const query = webSearchQueryOf(item.args);
  if (query === null) return null;
  const results = searchResultsFromVisibleOutput(item.visibleOutput);
  return {
    id: asString(item.callId) ?? item.itemId,
    query,
    ...(results.length > 0 ? { results: [...results] } : {}),
  };
};

/** Filesystem preconditions for opt-in live Muse hosted-search acceptance. */
export type TMuseLiveSearchPreconditions = {
  readonly binaryPresent: boolean;
  readonly authPresent: boolean;
};

/**
 * Gate live Muse search BEFORE any HTTP request. Only missing binary / auth
 * file skip the run — never response-body heuristics.
 */
export const museLiveSearchUnavailableReason = (
  preconditions: TMuseLiveSearchPreconditions,
): string | null => {
  if (!preconditions.binaryPresent) return "muse binary not found";
  if (!preconditions.authPresent) return "muse auth.json not found";
  return null;
};

export type TMuseHostedSearchCompletionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Static acceptance shape for a Muse-hop chat.completion that ran hosted
 * web_search: HTTP 200 body with `server_search_calls`, no caller
 * `tool_calls`, and non-empty assistant content.
 */
export const museHostedSearchCompletionOf = (
  status: number,
  body: unknown,
): TMuseHostedSearchCompletionCheck => {
  if (status !== 200) {
    return { ok: false, reason: `expected HTTP 200, got ${status}` };
  }
  const root = asRecord(body);
  if (root === null) return { ok: false, reason: "response is not an object" };
  const choices = Array.isArray(root.choices) ? root.choices : null;
  if (choices === null || choices.length === 0) {
    return { ok: false, reason: "missing choices" };
  }
  const message = asRecord(asRecord(choices[0])?.message);
  if (message === null) return { ok: false, reason: "missing message" };
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return {
      ok: false,
      reason: "caller tool_calls present; native search must not hand off",
    };
  }
  const searches = message.server_search_calls;
  if (!Array.isArray(searches) || searches.length === 0) {
    return { ok: false, reason: "missing server_search_calls" };
  }
  const hasQuery = searches.some(
    (row) => asString(asRecord(row)?.query) !== null,
  );
  if (!hasQuery) {
    return { ok: false, reason: "server_search_calls lack query" };
  }
  const content = message.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, reason: "empty assistant content" };
  }
  return { ok: true };
};
