/**
 * Codex hosted web search — the provider-native search owner for `chatgpt`
 * native-runtime hops.
 *
 * The Codex app-server enables OpenAI's hosted `web_search` through
 * `thread/start.config`, not through `dynamicTools`. OpenLLM enables it
 * ALWAYS-ON for Codex native hops: the provider owns search execution and
 * continuation, and the daemon never runs a managed search loop (see
 * `docs/refactor/2026-07-15-web-search-agent-boundary.md`).
 *
 * The model searches server-side and the grounded answer streams normally.
 * Completed hosted `webSearch` lifecycle items are RE-EMITTED through the
 * canonical chunk stream (`server_search_calls`) and re-encoded on client
 * wires (Anthropic: `server_tool_use` + `web_search_tool_result` blocks +
 * `usage.server_tool_use.web_search_requests`) — see the sinks in
 * `codex-app-server.ts` / `codex-tool-session.ts` and the messages encoders.
 *
 * Because this config is a compile-time constant, one conversation can never
 * flip between hosted-search-on and hosted-search-off across requests — so
 * the session store needs no config fingerprint/rotation for it.
 */

import type { TClientTool } from "./claude-tool-session";

/**
 * `thread/start.config` payload enabling hosted search.
 *
 * `features.standalone_web_search: false` keeps the request on the hosted
 * `web_search` tool (production app-server traffic rejects the standalone
 * `web.run` namespace). `web_search: "live"` requests live access; Codex
 * resolves the effective mode against its own permission profile.
 */
export const CODEX_HOSTED_WEB_SEARCH_CONFIG: Readonly<Record<string, unknown>> =
  {
    "features.standalone_web_search": false,
    web_search: "live",
  };

/**
 * Hosted search and a client-executed `web_search` function must stay
 * mutually exclusive on one turn — exactly one search owner (the reference
 * OpenClaw rule). With hosted search always on, a client function tool named
 * `web_search` is dropped from `dynamicTools` registration; every other
 * client tool passes through unchanged.
 */
export const suppressHostedSearchClientTool = (
  tools: ReadonlyArray<TClientTool>,
): ReadonlyArray<TClientTool> =>
  tools.filter((tool) => tool.name !== "web_search");
