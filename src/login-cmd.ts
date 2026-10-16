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
 * that isn't running is left alone. The desktop app pairs through this
 * command (key on stdin), so terminal and app behave the same.
 */

import { daemonPort, daemonReachable } from "./clients/gateway";
import { runManagedDaemonCommand } from "./daemon-delegation";
import { cliConfig } from "./env";
import { defaultTerminal, isUsableApiKey, saveApiKey } from "./onboarding";
import type { TCredentialGateTerminal } from "./runtime-contracts";

export const LOGIN_USAGE = `usage: openllm login [--key <sk-llm-...>]

Save your OpenLLM API key to ~/.openllm/.env, replacing any existing key.
With no --key, the key is read from piped stdin, or prompted for (hidden)
on an interactive terminal. A running daemon is restarted to pick it up.
Get a key under Keys after signing in.
`;

export type TLoginIo = {
  readonly terminal: TCredentialGateTerminal;
  /** Piped stdin, or null when stdin is a terminal. */
  readonly readStdin: () => Promise<string | null>;
  /** Restart the daemon if it is running; its exit status, 0 when it isn't. */
  readonly restartRunningDaemon: () => Promise<number>;
};

const readPipedStdin = async (): Promise<string | null> => {
  if (process.stdin.isTTY === true) return null;
  return await Bun.stdin.text();
};

const restartRunningDaemon = async (): Promise<number> =>
  (await daemonReachable(daemonPort()))
    ? await runManagedDaemonCommand("restart")
    : 0;

const defaultIo: TLoginIo = {
  terminal: defaultTerminal,
  readStdin: readPipedStdin,
  restartRunningDaemon,
};

export const runLogin = async (
  args: readonly string[],
  io: TLoginIo = defaultIo,
): Promise<number> => {
  const err = (message: string): number => {
    io.terminal.write(message);
    return 2;
  };
  let key: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--key" || arg === "-k") {
      const value = args[i + 1];
      if (value === undefined) return err(LOGIN_USAGE);
      key = value;
      i += 1;
    } else if (arg?.startsWith("--key=")) {
      key = arg.slice("--key=".length);
    } else {
      return err(`unknown argument "${arg}"\n\n${LOGIN_USAGE}`);
    }
  }

  if (key === null) {
    const piped = await io.readStdin();
    if (piped !== null) {
      key = piped;
    } else if (io.terminal.isInteractive()) {
      io.terminal.write(
        `Paste your OpenLLM API key (from ${cliConfig().gatewayUrl}/keys).\n`,
      );
      key = io.terminal.promptForKey();
      if (key === null || key.trim().length === 0) {
        io.terminal.write("[openllm] Login cancelled.\n");
        return 1;
      }
    } else {
      return err(
        "[openllm] No API key given. Pass --key <key> or pipe it on stdin.\n",
      );
    }
  }

  const trimmed = key.trim();
  if (!isUsableApiKey(trimmed)) {
    io.terminal.write("[openllm] The API key format is invalid.\n");
    return 1;
  }
  if (!saveApiKey(trimmed)) {
    io.terminal.write("[openllm] Could not save the API key.\n");
    return 1;
  }
  const shadowed = process.env.OPENLLM_API_KEY;
  io.terminal.write("API key saved.\n");
  if (shadowed !== undefined && shadowed.trim() !== trimmed) {
    io.terminal.write(
      "[openllm] Note: OPENLLM_API_KEY is set in your environment and overrides the saved key. Unset it to use the new one.\n",
    );
  }
  process.env.OPENLLM_API_KEY = trimmed;
  if ((await io.restartRunningDaemon()) !== 0) {
    io.terminal.write(
      "[openllm] The key is saved, but restarting the daemon failed. Run `openllm restart`.\n",
    );
    return 1;
  }
  return 0;
};
