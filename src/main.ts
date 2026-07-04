#!/usr/bin/env bun

/**
 * `openllmc` — the OpenLLM CLI. One binary distributes every gateway
 * extension. Command surface (names/descriptions/verbs) is defined ONCE in
 * `commands.ts` — help + shell completion derive from it.
 *
 *   openllmc mcp [--only <group>]     the unified MCP server over stdio
 *   openllmc exec <group> <verb> […]  CLI utilities (hook verbs, scripting)
 *   openllmc api --spec               print the embedded OpenAPI spec
 *   openllmc setup                    PATH symlink + shell completion
 *   openllmc completion <shell|install>
 *   openllmc self-update              converge to the gateway's pinned release
 *   openllmc version
 *
 * `openllmc ctx …` is kept as a hidden alias of `openllmc exec ctx …` — the
 * shipped plugin hooks call it, and hook bundles + the binary rev
 * independently.
 */

import { EXEC_GROUPS, EXEC_VERBS, helpText, type TExecGroup } from "./commands";
import { runCompletionCommand } from "./completion";
import { CLI_VERSION } from "./env";
import { runClaudeContextCli } from "./mcp/claude-context";
import { MCP_GROUPS, runMcpServer, type TMcpGroup } from "./mcp/server";
import { runSelfUpdate } from "./self-update";
import { runSetup } from "./setup-cmd";

const HELP = helpText(CLI_VERSION);

const argv = process.argv.slice(2);
const cmd = argv[0];

const isGroup = (s: string): s is TMcpGroup =>
  (MCP_GROUPS as readonly string[]).includes(s);

const isExecGroup = (s: string): s is TExecGroup =>
  (EXEC_GROUPS as readonly string[]).includes(s);

/** `-h`/`--help` anywhere in a subcommand's args → print its usage, exit 0. */
const wantsHelp = (rest: readonly string[]): boolean =>
  rest.includes("-h") || rest.includes("--help");

const usage = (text: string, exit: number): never => {
  (exit === 0 ? process.stdout : process.stderr).write(text);
  return process.exit(exit);
};

const MCP_USAGE = `usage: openllmc mcp [--only <group>]

Run the unified MCP server over stdio (what mcpServers.openllm executes).
Groups: ${MCP_GROUPS.join(" | ")} (default: all; --only is for debugging).
Requires LLM_GATEWAY_API_KEY (env or the shared ~/.openllm/.env).
`;

const EXEC_USAGE = `usage: openllmc exec <group> <verb> [...]

Run a CLI utility — the one-shot path the plugin hooks + scripts use
(hooks can't speak MCP stdio; this is the same code over argv/stdout).

${EXEC_GROUPS.map((g) => `  openllmc exec ${g} <${EXEC_VERBS[g].join("|")}>`).join("\n")}

  ctx index      --path <dir> [--force]        index a repo for semantic search
  ctx search     --path <dir> --query <q> [--limit N]
  ctx status     --path <dir>                  indexing progress/state
  ctx index-docs --url <url> [--force]         index a docs site
`;

const API_USAGE = `usage: openllmc api --spec

Print the embedded OpenAPI spec (the exact document the gateway serves at
/api/swagger; also the source of the MCP native-API tools).
`;

const SETUP_USAGE = `usage: openllmc setup

Post-install setup: symlink openllmc onto your PATH (/usr/local/bin or
~/.local/bin) and install shell completion for your current shell
(bash/zsh/fish). Idempotent — safe to re-run. Needed after a dashboard
(daemon-driven) install, which runs sandboxed and can't touch PATH dirs.
`;

const SELF_UPDATE_USAGE = `usage: openllmc self-update

Converge this binary to the gateway's pinned release: fetch
/api/cli/version, download + sha256-verify the target, atomic swap.
Source builds (0.0.0-dev) never self-update.
`;

const COMPLETION_USAGE = `usage: openllmc completion <bash|zsh|fish|install>

Print a completion script for a shell, or \`install\` to wire it into your
rc (~/.zshrc, ~/.bashrc) / fish completions dir automatically.
`;

const main = async (): Promise<void> => {
  const rest = argv.slice(1);
  switch (cmd) {
    case "mcp": {
      if (wantsHelp(rest)) return usage(MCP_USAGE, 0);
      const onlyIdx = rest.indexOf("--only");
      let groups: readonly TMcpGroup[] = MCP_GROUPS;
      if (onlyIdx >= 0) {
        const g = rest[onlyIdx + 1] ?? "";
        if (!isGroup(g)) {
          process.stderr.write(
            `unknown group "${g}" — expected one of: ${MCP_GROUPS.join(", ")}\n`,
          );
          process.exit(2);
        }
        groups = [g];
      }
      await runMcpServer(groups);
      break;
    }
    // `ctx` is the legacy alias the shipped hooks call — same dispatch as
    // `exec ctx`. Hidden from help/completion; kept so hook bundles and the
    // binary can rev independently.
    case "ctx": {
      if (wantsHelp(rest)) return usage(EXEC_USAGE, 0);
      const verb = rest[0] ?? "";
      if (!(EXEC_VERBS.ctx as readonly string[]).includes(verb)) {
        return usage(EXEC_USAGE, 2);
      }
      await runClaudeContextCli(rest);
      break;
    }
    case "exec": {
      if (rest.length === 0 || wantsHelp(rest)) {
        return usage(EXEC_USAGE, rest.length === 0 ? 2 : 0);
      }
      const group = rest[0];
      if (!isExecGroup(group)) {
        process.stderr.write(
          `unknown exec group "${group}" — expected one of: ${EXEC_GROUPS.join(", ")}\n\n${EXEC_USAGE}`,
        );
        process.exit(2);
      }
      const verb = rest[1] ?? "";
      if (!(EXEC_VERBS[group] as readonly string[]).includes(verb)) {
        return usage(EXEC_USAGE, 2);
      }
      // One group today; a switch keeps the next group's dispatch obvious.
      switch (group) {
        case "ctx":
          await runClaudeContextCli(rest.slice(1));
          break;
      }
      break;
    }
    case "api": {
      if (wantsHelp(rest)) return usage(API_USAGE, 0);
      if (rest[0] === "--spec") {
        const { default: spec } = await import("./sdk/generated/openapi.json");
        process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
        process.exit(0);
      }
      return usage(API_USAGE, 2);
    }
    case "setup":
      if (wantsHelp(rest)) return usage(SETUP_USAGE, 0);
      return process.exit(runSetup());
    case "completion":
      if (wantsHelp(rest)) return usage(COMPLETION_USAGE, 0);
      return process.exit(runCompletionCommand(rest));
    case "self-update":
      if (wantsHelp(rest)) return usage(SELF_UPDATE_USAGE, 0);
      await runSelfUpdate();
      break;
    case "version":
    case "-v":
    case "--version":
      process.stdout.write(`openllmc v${CLI_VERSION}\n`);
      break;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return process.exit(cmd === undefined ? 2 : 0);
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
};

main().catch((err) => {
  process.stderr.write(
    `[openllmc] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
