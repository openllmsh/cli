#!/usr/bin/env bun

/**
 * `openllm` — the OpenLLM CLI. One binary distributes every gateway
 * extension. Command surface (names/descriptions/verbs) is defined ONCE in
 * `commands.ts` — help + shell completion derive from it.
 *
 *   openllm mcp [--only <group>]     the unified MCP server over stdio
 *   openllm exec <group> <verb> […]  CLI utilities (hook verbs, scripting)
 *   openllm api --spec               print the embedded OpenAPI spec
 *   openllm setup                    PATH symlink + shell completion
 *   openllm completion <shell|install>
 *   openllm start|stop|restart       delegate daemon lifecycle management
 *   openllm auto-update <on|off|status>
 *   openllm self-update              converge this CLI to the pinned release
 *   openllm version
 *
 * `openllm ctx …` is kept as a hidden alias of `openllm exec ctx …` — the
 * shipped plugin hooks call it, and hook bundles + the binary rev
 * independently.
 */

import { runHermesCommand } from "./clients/hermes";
import { runRaycastCommand } from "./clients/raycast";
import { CLIENTS, isClientId, parseClientFlags } from "./clients/registry";
import { runSessionClient } from "./clients/session";
import type { TExecGroup } from "./commands";
import {
  AUTO_UPDATE_ACTIONS,
  EXEC_GROUPS,
  EXEC_VERBS,
  helpText,
} from "./commands";
import { runCompletionCommand } from "./completion";
import type { TDaemonLifecycleCommand } from "./daemon-delegation";
import { runManagedDaemonCommand } from "./daemon-delegation";
import { runDoctor } from "./doctor-cmd";
import { CLI_VERSION } from "./env";
import { runClaudeContextCli } from "./mcp/claude-context";
import type { TMcpGroup } from "./mcp/server";
import { MCP_GROUPS, runMcpServer } from "./mcp/server";
import { runSelfUpdate } from "./self-update";
import { runSessionsCommand } from "./sessions-cmd";
import { runSetup } from "./setup-cmd";
import { runUninstall } from "./uninstall-cmd";
import { runUpdate } from "./update-cmd";

const HELP = helpText(CLI_VERSION);

const argv = process.argv.slice(2);
// OUR client flags sit BEFORE the subcommand (`openllm -d -r claude …`), so
// they're stripped here — everything after the client name belongs to the
// client. See `parseClientFlags` for why position matters (`-d`/`-r` collide
// with claude's --debug/--resume and grok's --resume).
const clientFlags = parseClientFlags(argv);
const cmd = clientFlags.rest[0];

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

const MCP_USAGE = `usage: openllm mcp [--only <group>]

Run the unified MCP server over stdio (what mcpServers.openllm executes).
Groups: ${MCP_GROUPS.join(" | ")} (default: all; --only is for debugging).
Requires a configured API key. Run \`openllm start\` interactively to sign in and paste one when prompted.
`;

const EXEC_USAGE = `usage: openllm exec <group> <verb> [...]

Run a CLI utility — the one-shot path the plugin hooks + scripts use
(hooks can't speak MCP stdio; this is the same code over argv/stdout).

${EXEC_GROUPS.map((g) => `  openllm exec ${g} <${EXEC_VERBS[g].join("|")}>`).join("\n")}

  ctx index      --path <dir> [--force]        index a repo for semantic search
  ctx search     --path <dir> --query <q> [--limit N]
  ctx status     --path <dir>                  indexing progress/state
  ctx index-docs --url <url> [--force]         index a docs site
`;

const API_USAGE = `usage: openllm api --spec

Print the embedded OpenAPI spec (the exact document the gateway serves at
/api/swagger; also the source of the MCP native-API tools).
`;

const SETUP_USAGE = `usage: openllm setup

Post-install setup: symlink openllm onto your PATH (/usr/local/bin or
~/.local/bin) and install shell completion for your current shell
(bash/zsh/fish). Idempotent — safe to re-run. Needed after a dashboard
(daemon-driven) install, which runs sandboxed and can't touch PATH dirs.
`;

const SELF_UPDATE_USAGE = `usage: openllm self-update

Converge this binary to the gateway's pinned release: fetch
/api/cli/version, download + sha256-verify the target, atomic swap.
Source builds (0.0.0-dev) never self-update.
`;

const UPDATE_USAGE = `usage: openllm update

Update the FULL product: rerun the trusted installer from your configured
gateway origin so the daemon AND CLI binaries converge and install invariants
are re-enforced. Distinct from \`self-update\` (CLI binary only) and from the
daemon's background \`auto-update\` preference. Preserves your env file and
never installs vendor CLIs or edits your shell.
`;

const DAEMON_LIFECYCLE_USAGE = (
  command: string,
): string => `usage: openllm ${command}

Delegate ${command} to the managed openllmd daemon.
`;

const AUTO_UPDATE_USAGE = `usage: openllm auto-update <on|off|status>

Read or change the managed daemon automatic-update preference.
`;

const COMPLETION_USAGE = `usage: openllm completion <bash|zsh|fish|install>

Print a completion script for a shell, or \`install\` to wire it into your
rc (~/.zshrc, ~/.bashrc) / fish completions dir automatically.
`;

/** Per-client usage — shown for `openllm <client> -h`. */
const clientUsage = (id: string): string => {
  const client = CLIENTS[id as keyof typeof CLIENTS];
  if (client.mode === "always-on") {
    return `usage: openllm ${id} [uninstall|status]\n\n${client.note}\n`;
  }
  const dangerous =
    client.dangerousFlag !== undefined
      ? `  openllm -d ${id}    skip every approval prompt (${client.dangerousFlag})\n`
      : "";
  const sessionFlags =
    client.daemonCli === undefined ? "" : "[--new|--attach [id]] ";
  const sessionSelection =
    client.daemonCli === undefined
      ? ""
      : `  openllm --new ${id}          always start a fresh session
  openllm --attach ${id}       attach to the best match without being asked
  openllm --attach <id> ${id}  attach to a specific session (id or prefix)

When ${client.name} sessions are already running on this machine — started here
OR from the browser — they are offered before a new one starts. Attaching joins
the LIVE session alongside any other viewer; it is not a vendor \`--resume\`.
List them any time with \`openllm sessions list\`.
`;
  return `usage: openllm [-d] [-r] ${sessionFlags}${id} [...args]

Runs ${client.name} through OpenLLM. EVERY argument after \`${id}\` is forwarded
to ${client.bin} verbatim, so \`openllm ${id} <args>\` behaves exactly like
\`${client.bin} <args>\` — including \`-d\`/\`-r\` if ${client.bin} defines them.

${client.note}

openllm's own flags go BEFORE the client name:
${dangerous}  openllm -r ${id}    route the session via the cloud gateway

${sessionSelection}

The session points at your local daemon by default, so subscription models
serve locally with no cloud round trip. \`-r\` points it at the cloud origin,
which 307-redirects subscription hops back to a live daemon.

  openllm ${id} -- --help   # \`--\` also works, though nothing after the
                          # client name is ever read by openllm
`;
};

const main = async (): Promise<void> => {
  if (clientFlags.sessionSelectionError !== undefined) {
    process.stderr.write(`[openllm] ${clientFlags.sessionSelectionError}\n`);
    process.exit(2);
  }
  const rest = clientFlags.rest.slice(1);

  // Client subcommands are dispatched from the registry (the SSOT) rather than
  // hand-written cases, so help/completion/dispatch can't drift.
  if (cmd !== undefined && isClientId(cmd)) {
    const client = CLIENTS[cmd];
    if (client.id === "hermes") {
      return process.exit(await runHermesCommand(rest, clientFlags));
    }
    if (client.mode === "always-on") {
      return process.exit(await runRaycastCommand(rest, clientFlags));
    }
    // ONLY a LEADING -h/--help is ours; anywhere else it belongs to the client
    // (`openllm claude --resume -h` must reach the client). `--` forwards it.
    if (rest[0] === "-h" || rest[0] === "--help") {
      return usage(clientUsage(cmd), 0);
    }
    return process.exit(await runSessionClient(client, rest, clientFlags));
  }

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
    case "start":
    case "stop":
    case "restart":
      if (wantsHelp(rest)) return usage(DAEMON_LIFECYCLE_USAGE(cmd), 0);
      if (rest.length > 0) return usage(DAEMON_LIFECYCLE_USAGE(cmd), 2);
      return process.exit(
        await runManagedDaemonCommand(cmd as TDaemonLifecycleCommand),
      );
    case "auto-update": {
      if (wantsHelp(rest)) return usage(AUTO_UPDATE_USAGE, 0);
      const action = rest[0] ?? "";
      if (
        rest.length !== 1 ||
        !(AUTO_UPDATE_ACTIONS as readonly string[]).includes(action)
      ) {
        return usage(AUTO_UPDATE_USAGE, 2);
      }
      return process.exit(
        await runManagedDaemonCommand("auto-update", [action]),
      );
    }
    case "update":
      if (wantsHelp(rest)) return usage(UPDATE_USAGE, 0);
      if (rest.length > 0) return usage(UPDATE_USAGE, 2);
      return process.exit(await runUpdate());
    case "self-update":
      if (wantsHelp(rest)) return usage(SELF_UPDATE_USAGE, 0);
      await runSelfUpdate();
      break;
    case "sessions":
      return process.exit(await runSessionsCommand(rest));
    case "uninstall":
      return process.exit(await runUninstall(rest));
    case "doctor":
      return process.exit(await runDoctor(rest));
    case "version":
    case "-v":
    case "--version":
      process.stdout.write(`openllm v${CLI_VERSION}\n`);
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
    `[openllm] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
