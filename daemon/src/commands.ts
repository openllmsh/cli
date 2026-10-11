/**
 * Canonical `openllmd` CLI surface — the SINGLE source of truth for the
 * subcommands, flags, providers, and completion shells. `cli.ts` dispatches and
 * renders `--help` from this, and `completion.ts` derives its bash/zsh/fish
 * scripts from it, so the help text and the completion scripts can't drift
 * apart (they did, which is what this consolidation fixes).
 *
 * Descriptions are deliberately free of `:` and `'` so they embed into the
 * zsh/bash/fish completion grammars without escaping.
 */
import { AUTH_COMMANDS } from "@openllmsh/protocol";

export type TCommand = {
  readonly name: string;
  /** Positional-arg hint shown in help, e.g. `<provider> <token>`. */
  readonly args?: string;
  readonly description: string;
};

export const COMMANDS: readonly TCommand[] = [
  {
    name: "auth",
    args: `<${AUTH_COMMANDS.map((item) => item.name).join("|")}>`,
    description: "Manage provider authentication on this machine",
  },
  { name: "start", description: "Register and start in self-restore mode" },
  { name: "stop", description: "Stop and disable all self-restore" },
  { name: "status", description: "Show service registration and run status" },
  { name: "restart", description: "Stop then start the daemon" },
  {
    name: "logs",
    args: "[-f] [-n N]",
    description: "Show or follow daemon logs",
  },
  {
    name: "auto-update",
    args: "<on|off|status>",
    description:
      "Enable or disable automatic daemon self-updates (on by default)",
  },
  {
    name: "sessions",
    args: "<on|off|status>",
    description: "Enable or disable remote terminal sessions (off by default)",
  },
  {
    name: "uninstall",
    args: "[--yes] [--keep-logins|--remove-logins]",
    description:
      "Remove the daemon + its state (leaves the CLI; see openllm uninstall)",
  },
  {
    name: "completion",
    args: "<bash|zsh|fish|install>",
    description: "Print or install shell completion",
  },
  { name: "help", description: "Show help" },
  { name: "version", description: "Print the version" },
] as const;

export type TFlag = { readonly name: string; readonly description: string };

export const FLAGS: readonly TFlag[] = [
  { name: "-h", description: "Show help" },
  { name: "--help", description: "Show help" },
  { name: "-v", description: "Print the version" },
  { name: "--version", description: "Print the version" },
] as const;

export const PROVIDERS = [
  "claude_code",
  "chatgpt",
  "kimi_code",
  "grok",
  "cursor",
  "muse",
] as const;

/** Argument choices for the `auto-update` and `sessions` subcommands. */
export const AUTO_UPDATE_ACTIONS = ["on", "off", "status"] as const;

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

/**
 * Per-command second-level completion tokens. Keys are canonical subcommand names.
 * This powers shell completion for subcommand arguments.
 */
export const COMMAND_ARGS: Readonly<Record<string, readonly string[]>> = {
  auth: AUTH_COMMANDS.map((item) => item.name),
  completion: [...COMPLETION_SHELLS, "install"],
  "auto-update": [...AUTO_UPDATE_ACTIONS],
  sessions: [...AUTO_UPDATE_ACTIONS],
  logs: ["-f", "--follow", "-n", "--lines"],
  uninstall: ["--yes", "-y", "--keep-logins", "--remove-logins"],
};

const padRight = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;

export const formatHelpRows = (
  rows: ReadonlyArray<{ readonly left: string; readonly right: string }>,
): string => {
  const width = Math.max(1, ...rows.map((row) => row.left.length));
  return rows
    .map((row) => `  ${padRight(row.left, width)}  ${row.right}`)
    .join("\n");
};

export type TCompletionShell = (typeof COMPLETION_SHELLS)[number];
