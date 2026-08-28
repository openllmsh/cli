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

export type TFlag = { readonly name: string; readonly description: string };

export const COMMANDS = [
  {
    name: "claude",
    args: "[...args]",
    description: "Run Claude Code through OpenLLM",
  },
  {
    name: "codex",
    args: "[...args]",
    description: "Run Codex through OpenLLM",
  },
  {
    name: "grok",
    args: "[...args]",
    description: "Run Grok Build through OpenLLM",
  },
  {
    name: "hermes",
    args: "[install|uninstall|status|--no-persist] [...args]",
    description: "Run Hermes TUI through OpenLLM",
  },
  {
    name: "opencode",
    args: "[...args]",
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
    name: "start",
    description: "Start OpenLLM and guide credential setup when needed",
  },
  { name: "stop", description: "Stop OpenLLM" },
  {
    name: "restart",
    description: "Restart OpenLLM after completing credential setup",
  },
  {
    name: "auto-update",
    args: "<on|off|status>",
    description: "Read or change daemon automatic updates",
  },
  {
    name: "update",
    description: "Update the full OpenLLM product from the configured gateway",
  },
  {
    name: "self-update",
    description: "Update this CLI binary to the pinned gateway release",
  },
  {
    name: "sessions",
    args: "[list|attach|kill]",
    description: "List, attach, or kill local daemon sessions",
  },
  {
    name: "uninstall",
    args: "[--yes] [--keep-logins|--remove-logins]",
    description: "Uninstall OpenLLM (daemon + CLI) from this machine",
  },
  {
    name: "doctor",
    args: "[--fix] [--no-ai] [-c]",
    description: "Diagnose the local daemon and report leftover install state",
  },
  { name: "version", description: "Print the version" },
  { name: "help", description: "Show help" },
] as const satisfies readonly TCommand[];

export type TCommandName = (typeof COMMANDS)[number]["name"];

/**
 * openllm's own flags for a client invocation, which sit BEFORE the client name
 * (`openllm -d -r claude …`). They must not be consumed after the name: `-d`
 * and `-r` are already claude's --debug/--resume and grok's --resume, so
 * reading them there would steal a flag meant for the client.
 */
export const CLIENT_FLAGS: readonly TFlag[] = [
  { name: "-d", description: "Skip every approval prompt in the client" },
  { name: "-r", description: "Route the session via the cloud gateway" },
] as const;

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
 *
 * The group STRINGS are the openllm-branded selector vocabulary
 * (`openllm-context`, `openllm-memory`) — distinct from the internal backend
 * plugin slugs (`/api/plugins/claude-context`, `…/supermemory`), env vars, and
 * on-disk state dirs, all of which stay on their historical wire-stable names.
 */
export const MCP_ONLY_GROUPS = [
  "openllm",
  "openllm-context",
  "openllm-memory",
] as const;
export type TMcpGroup = (typeof MCP_ONLY_GROUPS)[number];

/**
 * Legacy group selectors accepted for backward compatibility. Free-tier client
 * overlays persisted `--only supermemory` (and code search `claude-context`)
 * into their configs before the rename, so `normalizeMcpGroup` maps those old
 * strings onto the current names rather than rejecting an already-installed
 * client.
 */
const MCP_GROUP_ALIASES: Readonly<Record<string, TMcpGroup>> = {
  "claude-context": "openllm-context",
  supermemory: "openllm-memory",
};

/**
 * Resolve a `--only` value to a canonical group, accepting the legacy aliases.
 * Returns `undefined` for an unknown group.
 */
export const normalizeMcpGroup = (s: string): TMcpGroup | undefined => {
  if ((MCP_ONLY_GROUPS as readonly string[]).includes(s)) return s as TMcpGroup;
  return MCP_GROUP_ALIASES[s];
};

/**
 * Groups a free-tier key is allowed to expose. Semantic code search
 * (`openllm-context`) is Pro. ONE list — overlay `mcpArgs()` and the MCP
 * server itself both read this, so a persisted client config that launches
 * `openllm mcp` with no `--only` still drops code search for free users.
 */
export const FREE_TIER_MCP_GROUPS = ["openllm", "openllm-memory"] as const;

export const mcpGroupsForTier = (
  groups: readonly TMcpGroup[],
  tier: "free" | "trial" | "pro" | undefined,
): TMcpGroup[] => {
  if (tier !== "free") return [...groups];
  const allowed: ReadonlySet<string> = new Set(FREE_TIER_MCP_GROUPS);
  return groups.filter((g) => allowed.has(g));
};

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type TCompletionShell = (typeof COMPLETION_SHELLS)[number];

export const AUTO_UPDATE_ACTIONS = ["on", "off", "status"] as const;
export type TAutoUpdateAction = (typeof AUTO_UPDATE_ACTIONS)[number];

/**
 * Per-command second-level completion tokens. Keys are canonical subcommand
 * names. Completion generators append `-h/--help` to every command.
 */
export const COMMAND_ARGS: Readonly<
  Partial<Record<TCommandName, readonly string[]>>
> = {
  completion: [...COMPLETION_SHELLS, "install"],
  "auto-update": [...AUTO_UPDATE_ACTIONS],
  mcp: ["--only", ...MCP_ONLY_GROUPS],
  api: ["--spec"],
  raycast: ["uninstall", "status"],
  hermes: ["install", "uninstall", "status", "--no-persist"],
  sessions: ["list", "attach", "kill"],
  doctor: ["--fix", "--no-ai", "-c", "--copy"],
  uninstall: ["--yes", "-y", "--keep-logins", "--remove-logins"],
};

export const padRight = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;

const helpRows = (
  rows: ReadonlyArray<{ readonly left: string; readonly right: string }>,
): string => {
  const width = Math.max(1, ...rows.map((row) => row.left.length));
  return rows
    .map((row) => `  ${padRight(row.left, width)}  ${row.right}`)
    .join("\n");
};

/** Render the top-level help text from the definitions above. */
export const helpText = (version: string): string => {
  const commandRows = helpRows(
    COMMANDS.map((c: TCommand) => ({
      left: c.args === undefined ? c.name : `${c.name} ${c.args}`,
      right: c.description,
    })),
  );
  const clientFlagRows = helpRows(
    CLIENT_FLAGS.map((f) => ({ left: f.name, right: f.description })),
  );
  const flagRows = helpRows(
    FLAGS.map((f) => ({ left: f.name, right: f.description })),
  );
  const envRows = helpRows([
    {
      left: "OPENLLM_CLOUD_ORIGIN",
      right: "gateway origin (default: the baked cloud origin)",
    },
    { left: "OPENLLM_API_KEY", right: "your sk-llm-... API key" },
    {
      left: "OPENLLM_GATEWAY",
      right: "force local or cloud (default: local when the daemon is up)",
    },
  ]);
  return `openllm v${version}  —  the OpenLLM CLI (also ollm)

Usage
  openllm [-d] [-r] <command> [...]

Commands
${commandRows}

Client flags  (before the client name — everything after it is the client's)
${clientFlagRows}

  Examples:  openllm -d claude    openllm -r codex    openllm -dr grok
  They sit before the name on purpose: -d/-r are also claude --debug/--resume,
  so \`openllm claude -r\` passes -r straight through to claude.

Running a client
  Every argument after the client name is forwarded verbatim, so
  \`openllm claude --resume\` behaves exactly like \`claude --resume\`.
  Your client's own config is never modified. Raycast is the exception: it
  runs continuously, so \`openllm raycast\` applies to its config and
  \`openllm raycast uninstall\` removes it again.

Exec groups
${EXEC_GROUPS.map((g) => `  openllm exec ${g} <${EXEC_VERBS[g].join("|")}>`).join("\n")}

Flags
${flagRows}

Config  (env, or the shared ~/.openllm/.env)
${envRows}

Every command accepts -h/--help.
`;
};
