#!/usr/bin/env bun

/**
 * `openllmc` — the OpenLLM CLI. One binary distributes every gateway
 * extension:
 *
 *   openllmc mcp [--only <group>]   the unified MCP server over stdio
 *                                   (groups: openllm, claude-context,
 *                                   supermemory; default all)
 *   openllmc ctx <sub> …            claude-context hook verbs
 *                                   (index | search | status | index-docs)
 *   openllmc api --spec             print the embedded OpenAPI spec
 *   openllmc self-update            converge to the gateway's pinned release
 *   openllmc version                print the version
 */

import { CLI_VERSION } from "./env";
import {
  CLAUDE_CONTEXT_CLI_SUBCOMMANDS,
  runClaudeContextCli,
} from "./mcp/claude-context";
import { MCP_GROUPS, runMcpServer, type TMcpGroup } from "./mcp/server";
import { runSelfUpdate } from "./self-update";

const HELP = `openllmc v${CLI_VERSION} — the OpenLLM CLI

Usage:
  openllmc mcp [--only <group>]   run the unified MCP server (stdio)
                                  groups: ${MCP_GROUPS.join(" | ")} (default: all)
  openllmc ctx <sub> [...]        claude-context hook verbs:
                                  ${CLAUDE_CONTEXT_CLI_SUBCOMMANDS.join(" | ")}
  openllmc api --spec             print the embedded OpenAPI spec (JSON)
  openllmc self-update            update to the gateway's pinned release
  openllmc version                print the version

Config (env, or the shared ~/.openllm/.env):
  LLM_GATEWAY_URL       gateway origin (default: the baked cloud origin)
  LLM_GATEWAY_API_KEY   your sk-llm-... API key
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

const isGroup = (s: string): s is TMcpGroup =>
  (MCP_GROUPS as readonly string[]).includes(s);

// `--bytecode` compiles CommonJS-style — no top-level await — so the
// dispatch lives in an async main() invoked at the bottom.
const main = async (): Promise<void> => {
  switch (cmd) {
    case "mcp": {
      const onlyIdx = argv.indexOf("--only");
      let groups: readonly TMcpGroup[] = MCP_GROUPS;
      if (onlyIdx >= 0) {
        const g = argv[onlyIdx + 1] ?? "";
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
    case "ctx": {
      const sub = argv[1] ?? "";
      if (
        !(CLAUDE_CONTEXT_CLI_SUBCOMMANDS as readonly string[]).includes(sub)
      ) {
        process.stderr.write(
          `usage: openllmc ctx <${CLAUDE_CONTEXT_CLI_SUBCOMMANDS.join("|")}> [...]\n`,
        );
        process.exit(2);
      }
      await runClaudeContextCli(argv.slice(1));
      break;
    }
    case "api": {
      if (argv[1] === "--spec") {
        const { default: spec } = await import("./sdk/generated/openapi.json");
        process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
        process.exit(0);
      }
      process.stderr.write("usage: openllmc api --spec\n");
      return process.exit(2);
    }
    case "self-update":
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
