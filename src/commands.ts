/**
 * The single source of truth for the `openllm` command surface — names,
 * descriptions, argument choices. `main.ts` (dispatch + help), every
 * subcommand's `-h`, and `completion.ts` all derive from these definitions,
 * so help text and shell completion can't drift from the actual CLI.
 * Mirrors the daemon's `commands.ts`.
 *
 * Descriptions must stay colon-free AND apostrophe-free: zsh completion
 * specs are single-quoted `value:desc` strings (an apostrophe terminates
 * the quote → parse error on source), and fish -d args are single-quoted
 * too. The generators also escape defensively, but keep the source clean.
 */

export type TCommand = {
  readonly name: string;
  readonly args?: string;
  readonly description: string;
};

/** The exec groups — every CLI utility runs through ONE path:
 *  `openllm exec <group> <verb> […]`. */
export const EXEC_GROUPS = ["ctx"] as const;
export type TExecGroup = (typeof EXEC_GROUPS)[number];

/** Per-group verbs (drives dispatch, help, and completion). */
export const EXEC_VERBS: Record<TExecGroup, readonly string[]> = {
  ctx: ["index", "search", "status", "index-docs"],
};

export const COMMANDS: readonly TCommand[] = [
  {
    name: "claude",
    args: "[-d] [-r] [...args]",
    description: "Run Claude Code through OpenLLM",
  },
  {
    name: "codex",
    args: "[-d] [-r] [...args]",
    description: "Run Codex through OpenLLM",
  },
  {
    name: "grok",
    args: "[-d] [-r] [...args]",
    description: "Run Grok Build through OpenLLM",
  },
  {
    name: "opencode",
    args: "[-r] [...args]",
    description: "Run OpenCode through OpenLLM",
  },
  {
    name: "raycast",
    args: "[uninstall|status]",
    description: "Apply OpenLLM to Raycast, or remove it",
  },
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
    description: "Add openllm to PATH and install shell completion",
  },
  {
    name: "completion",
    args: "<bash|zsh|fish|install>",
    description: "Print or install shell completion",
  },
  {
    name: "self-update",
    description: "Update to the pinned gateway release",
  },
  {
    name: "uninstall",
    args: "[--yes]",
    description: "Remove the openllm CLI from this machine",
  },
  {
    name: "doctor",
    args: "[--scrub-legacy]",
    description: "Report or clean up leftovers from the old install model",
  },
  { name: "version", description: "Print the version" },
  { name: "help", description: "Show help" },
] as const;

/** The flags a CLIENT invocation accepts (see `parseClientFlags`). Completion
 *  offers these after a client name; `-d` only applies to clients that have an
 *  equivalent, which the runtime enforces. */
export const CLIENT_FLAGS = ["-d", "-r"] as const;

export type TFlag = { readonly name: string; readonly description: string };

export const FLAGS: readonly TFlag[] = [
  { name: "-h", description: "Show help" },
  { name: "--help", description: "Show help" },
  { name: "-v", description: "Print the version" },
  { name: "--version", description: "Print the version" },
] as const;

/**
 * The MCP tool groups `mcp --only` accepts. Owned HERE (the command-surface
 * source of truth, dependency-free) so `completion.ts` doesn't pull the MCP
 * SDK graph; `mcp/server.ts` re-exports it as `MCP_GROUPS` for dispatch.
 */
export const MCP_ONLY_GROUPS = [
  "openllm",
  "claude-context",
  "supermemory",
] as const;
export type TMcpGroup = (typeof MCP_ONLY_GROUPS)[number];

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type TCompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Render the top-level help text from the definitions above. */
export const helpText = (version: string): string => {
  const rows = COMMANDS.map((c) => {
    const invocation = c.args === undefined ? c.name : `${c.name} ${c.args}`;
    return `  openllm ${invocation.padEnd(30)} ${c.description}`;
  }).join("\n");
  return `openllm v${version} — the OpenLLM CLI (also available as \`ollm\`)

Usage:
${rows}

Running a client:
  Arguments are forwarded to the client verbatim, so \`openllm claude --resume\`
  behaves exactly like \`claude --resume\`. Use \`--\` when an argument would
  otherwise be read by openllm itself (e.g. \`openllm grok -- --help\`).
  Your client's own config is never modified — the OpenLLM settings are
  applied for the lifetime of that one launch. Raycast is the exception: it
  runs continuously, so \`openllm raycast\` applies to its config and
  \`openllm raycast uninstall\` removes it again.

Exec groups:
${EXEC_GROUPS.map((g) => `  openllm exec ${g} <${EXEC_VERBS[g].join("|")}>`).join("\n")}

Config (env, or the shared ~/.openllm/.env):
  OPENLLM_CLOUD_ORIGIN  gateway origin (default: the baked cloud origin)
  OPENLLM_API_KEY       your sk-llm-... API key
  OPENLLM_GATEWAY       force \`local\` or \`cloud\` (default: local when the
                        daemon is reachable, else cloud)

Every command accepts -h/--help.
`;
};
