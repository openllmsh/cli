/**
 * The single source of truth for the `openllmc` command surface — names,
 * descriptions, argument choices. `main.ts` (dispatch + help), every
 * subcommand's `-h`, and `completion.ts` all derive from these definitions,
 * so help text and shell completion can't drift from the actual CLI.
 * Mirrors the daemon's `commands.ts`.
 *
 * Descriptions must stay colon-free: zsh completion specs are `value:desc`.
 */

export type TCommand = {
  readonly name: string;
  readonly args?: string;
  readonly description: string;
};

/** The exec groups — every CLI utility runs through ONE path:
 *  `openllmc exec <group> <verb> […]`. */
export const EXEC_GROUPS = ["ctx"] as const;
export type TExecGroup = (typeof EXEC_GROUPS)[number];

/** Per-group verbs (drives dispatch, help, and completion). */
export const EXEC_VERBS: Record<TExecGroup, readonly string[]> = {
  ctx: ["index", "search", "status", "index-docs"],
};

export const COMMANDS: readonly TCommand[] = [
  {
    name: "mcp",
    args: "[--only <group>]",
    description: "Run the unified MCP server over stdio",
  },
  {
    name: "exec",
    args: "<group> <verb> [...]",
    description: "Run a CLI utility (hook verbs and scripting)",
  },
  {
    name: "api",
    args: "--spec",
    description: "Print the embedded OpenAPI spec",
  },
  {
    name: "setup",
    description: "Add openllmc to PATH and install shell completion",
  },
  {
    name: "completion",
    args: "<bash|zsh|fish|install>",
    description: "Print or install shell completion",
  },
  {
    name: "self-update",
    description: "Update to the gateway's pinned release",
  },
  { name: "version", description: "Print the version" },
  { name: "help", description: "Show help" },
] as const;

export type TFlag = { readonly name: string; readonly description: string };

export const FLAGS: readonly TFlag[] = [
  { name: "-h", description: "Show help" },
  { name: "--help", description: "Show help" },
  { name: "-v", description: "Print the version" },
  { name: "--version", description: "Print the version" },
] as const;

/** The MCP tool groups `mcp --only` accepts (mirrors `mcp/server.ts`). */
export const MCP_ONLY_GROUPS = [
  "openllm",
  "claude-context",
  "supermemory",
] as const;

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type TCompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Render the top-level help text from the definitions above. */
export const helpText = (version: string): string => {
  const rows = COMMANDS.map((c) => {
    const invocation = c.args === undefined ? c.name : `${c.name} ${c.args}`;
    return `  openllmc ${invocation.padEnd(30)} ${c.description}`;
  }).join("\n");
  return `openllmc v${version} — the OpenLLM CLI

Usage:
${rows}

Exec groups:
${EXEC_GROUPS.map((g) => `  openllmc exec ${g} <${EXEC_VERBS[g].join("|")}>`).join("\n")}

Config (env, or the shared ~/.openllm/.env):
  LLM_GATEWAY_URL       gateway origin (default: the baked cloud origin)
  LLM_GATEWAY_API_KEY   your sk-llm-... API key

Every command accepts -h/--help.
`;
};
