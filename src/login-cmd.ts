/**
 * `openllm login` — save (or replace) the OpenLLM API key in this
 * environment's env file (`~/.openllm/.env`, `.dev.env` in dev).
 *
 * Three ways in, so both people and tools can call it:
 *
 *   openllm login                      hidden prompt on the terminal
 *   openllm login --key sk-llm-…       explicit argument (scripts)
 *   echo sk-llm-… | openllm login      piped stdin (keeps the key out of argv)
 *
 * Unlike the credential gate in `onboarding.ts`, login ALWAYS asks for a key —
 * an already-configured key is replaced, which is how a key gets rotated.
 *
 * A daemon already running reads its key at start, so login restarts it; one
 * that isn't running is left alone unless `--start`. The desktop app pairs
 * through this command (`--start --json`, key on stdin), so terminal and app
 * share one path: `--pty-sessions` / `--no-pty-sessions` set the daemon's
 * remote-terminal switch in the same write, and `--json` reports the outcome
 * on stdout for callers that parse it.
 */

import { daemonPort, daemonReachable } from "./clients/gateway";
import { daemonInvocation } from "./daemon-delegation";
import { cliConfig } from "./env";
import { defaultTerminal, isUsableApiKey, saveEnvVars } from "./onboarding";
import type { TCredentialGateTerminal } from "./runtime-contracts";

export const LOGIN_USAGE = `usage: openllm login [--key <sk-llm-...>] [--start]
                     [--pty-sessions | --no-pty-sessions] [--json]

Save your OpenLLM API key to ~/.openllm/.env, replacing any existing key.
With no --key, the key is read from piped stdin, or prompted for (hidden)
on an interactive terminal. A running daemon is restarted to pick it up.
Get a key under Keys after signing in.

  --start              also start the daemon when it isn't running
  --pty-sessions       allow remote terminal sessions on this machine
  --no-pty-sessions    disallow them (unchanged when neither is given)
  --json               print {"saved":true,"daemon":"restarted"|"started"|
                       "not_running"} on stdout; everything else on stderr
`;

const PTY_SESSIONS_VAR = "OPENLLM_DAEMON_PTY_SESSIONS";

export type TLoginDaemonOutcome = "restarted" | "started" | "not_running";

export type TLoginIo = {
  readonly terminal: TCredentialGateTerminal;
  /** Piped stdin, or null when stdin is a terminal. */
  readonly readStdin: () => Promise<string | null>;
  readonly daemonRunning: () => Promise<boolean>;
  /** Run `restart` / `start` in the daemon half; its exit status. With
   *  `quiet`, its stdout goes to stderr so `--json` stdout stays parseable. */
  readonly runDaemon: (
    command: "restart" | "start",
    quiet: boolean,
  ) => Promise<number>;
  /** Machine-readable output (`--json`). */
  readonly writeStdout: (text: string) => void;
};

/** How long piped stdin may stay silent. A caller that inherits an open but
 *  unused stdin (a tool, a service manager) must fail, not block forever. */
export const STDIN_TIMEOUT_MS = 15_000;

/**
 * Piped stdin, or null when stdin is a terminal. Empty input (`</dev/null`,
 * a closed pipe) and a pipe that stays silent past `STDIN_TIMEOUT_MS` are
 * both "no key": a non-interactive shell gets the usage error, never a
 * format error or a hang.
 */
const readPipedStdin = async (): Promise<string | null> => {
  if (process.stdin.isTTY === true) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Bun.stdin.text(), timeout]);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
};

const runDaemon = async (
  command: "restart" | "start",
  quiet: boolean,
): Promise<number> => {
  try {
    const proc = Bun.spawn([...daemonInvocation(), command], {
      stdin: "ignore",
      stdout: quiet ? 2 : "inherit",
      stderr: "inherit",
    });
    return await proc.exited;
  } catch (error) {
    process.stderr.write(
      `[openllm] could not run managed daemon: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};

const defaultIo: TLoginIo = {
  terminal: defaultTerminal,
  readStdin: readPipedStdin,
  daemonRunning: () => daemonReachable(daemonPort()),
  runDaemon,
  writeStdout: (text) => process.stdout.write(text),
};

type TLoginArgs = {
  readonly key: string | null;
  readonly start: boolean;
  readonly ptySessions: boolean | null;
  readonly json: boolean;
};

const parseLoginArgs = (args: readonly string[]): TLoginArgs | null => {
  let key: string | null = null;
  let start = false;
  let ptySessions: boolean | null = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--key" || arg === "-k") {
      const value = args[i + 1];
      if (value === undefined) return null;
      key = value;
      i += 1;
    } else if (arg?.startsWith("--key=")) {
      key = arg.slice("--key=".length);
    } else if (arg === "--start") {
      start = true;
    } else if (arg === "--pty-sessions" || arg === "--no-pty-sessions") {
      const value = arg === "--pty-sessions";
      if (ptySessions !== null && ptySessions !== value) return null;
      ptySessions = value;
    } else if (arg === "--json") {
      json = true;
    } else {
      return null;
    }
  }
  return { key, start, ptySessions, json };
};

export const runLogin = async (
  args: readonly string[],
  io: TLoginIo = defaultIo,
): Promise<number> => {
  const parsed = parseLoginArgs(args);
  if (parsed === null) {
    io.terminal.write(LOGIN_USAGE);
    return 2;
  }

  let key = parsed.key;
  if (key === null) {
    const piped = await io.readStdin();
    if (piped !== null && piped.trim().length > 0) {
      key = piped;
    } else if (piped === null && io.terminal.isInteractive()) {
      io.terminal.write(
        `Paste your OpenLLM API key (from ${cliConfig().gatewayUrl}/keys).\n`,
      );
      key = io.terminal.promptForKey();
      if (key === null || key.trim().length === 0) {
        io.terminal.write("[openllm] Login cancelled.\n");
        return 1;
      }
    } else {
      io.terminal.write(
        "[openllm] No API key given. Pass --key <key> or pipe it on stdin (e.g. `echo $KEY | openllm login`).\n",
      );
      return 2;
    }
  }

  const trimmed = key.trim();
  if (!isUsableApiKey(trimmed)) {
    io.terminal.write("[openllm] The API key format is invalid.\n");
    return 1;
  }
  const vars: Record<string, string> = { OPENLLM_API_KEY: trimmed };
  if (parsed.ptySessions !== null)
    vars[PTY_SESSIONS_VAR] = parsed.ptySessions ? "1" : "0";
  if (!saveEnvVars(vars)) {
    io.terminal.write("[openllm] Could not save the API key.\n");
    return 1;
  }
  if (!parsed.json) io.terminal.write("API key saved.\n");
  const shadowed = process.env.OPENLLM_API_KEY;
  if (shadowed !== undefined && shadowed.trim() !== trimmed) {
    io.terminal.write(
      "[openllm] Note: OPENLLM_API_KEY is set in your environment and overrides the saved key. Unset it to use the new one.\n",
    );
  }
  process.env.OPENLLM_API_KEY = trimmed;

  const command = (await io.daemonRunning())
    ? "restart"
    : parsed.start
      ? "start"
      : null;
  if (command !== null && (await io.runDaemon(command, parsed.json)) !== 0) {
    io.terminal.write(
      `[openllm] The key is saved, but ${command === "restart" ? "restarting" : "starting"} the daemon failed. Run \`openllm ${command}\`.\n`,
    );
    return 1;
  }
  const daemon: TLoginDaemonOutcome =
    command === "restart"
      ? "restarted"
      : command === "start"
        ? "started"
        : "not_running";
  if (parsed.json)
    io.writeStdout(`${JSON.stringify({ saved: true, daemon })}\n`);
  return 0;
};
