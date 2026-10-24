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
 * through this command (`--start --json`, key on stdin), and `--json` reports
 * the outcome on stdout for callers that parse it.
 *
 * A key copied from "Set up device sessions" carries a device trust anchor
 * after it (`sk-llm-<key>.<anchor>`). Login splits it on the last dot: the
 * anchor goes to `openllm daemon anchor` over stdin (pinning the account
 * device-control key locally, never trust-on-first-use) and ONLY the bare
 * `sk-llm-<key>` is saved, exported, or ever used as a bearer.
 *
 * `--lock-device-sessions` makes the daemon refuse a REMOTE enable of device
 * sessions; only `openllm daemon device enable` on this machine turns them on.
 */

import { daemonPort, daemonReachable } from "./clients/gateway";
import { daemonInvocation } from "./daemon-delegation";
import { cliConfig } from "./env";
import { defaultTerminal, saveEnvVars } from "./onboarding";
import type { TCredentialGateTerminal } from "./runtime-contracts";
import { splitAnchoredApiKey } from "./runtime-contracts";

export const LOGIN_USAGE = `usage: openllm login [sk-llm-...] [--key <sk-llm-...>] [--lock-device-sessions] [--start] [--json]

Save your OpenLLM API key to ~/.openllm/.env, replacing any existing key.
With no key argument, the key is read from piped stdin, or prompted for
(hidden) on an interactive terminal. A running daemon is restarted to pick
it up. Get a key under Keys after signing in.

A key from Manage device > Set up device sessions ends in a device trust
anchor (sk-llm-KEY.ANCHOR). It is kept on this machine only; the bare key
is what gets saved.

  --lock-device-sessions
                       refuse a remote enable of device sessions; only
                       openllm daemon device enable on this machine can
                       turn them on
  --start              also start the daemon when it isn't running
  --json               print {"saved":true,"daemon":"restarted"|"started"|
                       "not_running"} on stdout; everything else on stderr
`;

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
  /** Run `openllm daemon anchor` with `anchoredKey` on stdin; its exit
   *  status. Defaults to a self-spawn of the daemon half. */
  readonly anchorDaemon?: (anchoredKey: string) => Promise<number>;
  /** Run `openllm daemon device lock`; its exit status. */
  readonly lockDeviceSessions?: (quiet: boolean) => Promise<number>;
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

const runDaemonArgs = async (
  args: readonly string[],
  quiet: boolean,
): Promise<number> => {
  try {
    const proc = Bun.spawn([...daemonInvocation(), ...args], {
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

const runDaemon = (
  command: "restart" | "start",
  quiet: boolean,
): Promise<number> => runDaemonArgs([command], quiet);

/** The anchored key travels on stdin (never argv, which `ps` shows); the
 *  daemon's stdout (the bare key) is discarded. */
const anchorDaemon = async (anchoredKey: string): Promise<number> => {
  try {
    const proc = Bun.spawn([...daemonInvocation(), "anchor"], {
      stdin: new TextEncoder().encode(anchoredKey),
      stdout: "ignore",
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

const lockDeviceSessions = (quiet: boolean): Promise<number> =>
  runDaemonArgs(["device", "lock"], quiet);

const defaultIo: TLoginIo = {
  terminal: defaultTerminal,
  readStdin: readPipedStdin,
  daemonRunning: () => daemonReachable(daemonPort()),
  runDaemon,
  writeStdout: (text) => process.stdout.write(text),
  anchorDaemon,
  lockDeviceSessions,
};

type TLoginArgs = {
  readonly key: string | null;
  readonly lock: boolean;
  readonly start: boolean;
  readonly json: boolean;
};

const parseLoginArgs = (args: readonly string[]): TLoginArgs | null => {
  let key: string | null = null;
  let lock = false;
  let start = false;
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
    } else if (arg === "--lock-device-sessions") {
      lock = true;
    } else if (key === null && arg !== undefined && arg.startsWith("sk-llm-")) {
      // `openllm login sk-llm-<key>.<anchor>` — the one-line setup command.
      key = arg;
    } else if (arg === "--start") {
      start = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      return null;
    }
  }
  return { key, lock, start, json };
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

  const split = splitAnchoredApiKey(key);
  if (split === null) {
    io.terminal.write("[openllm] The API key format is invalid.\n");
    return 1;
  }
  // From here on only the bare key exists in this process's config surface.
  const trimmed = split.key;

  // Pin the device-control key from the anchor BEFORE saving the key and
  // restarting: the restarted daemon boots anchored.
  if (split.anchor !== null) {
    const anchor = io.anchorDaemon ?? anchorDaemon;
    if ((await anchor(`${split.key}.${split.anchor}`)) !== 0) {
      io.terminal.write(
        "[openllm] The device trust anchor was rejected. Copy the command from Manage device again.\n",
      );
      return 1;
    }
  }
  if (parsed.lock) {
    const lock = io.lockDeviceSessions ?? lockDeviceSessions;
    if ((await lock(parsed.json)) !== 0) {
      io.terminal.write("[openllm] Could not lock remote device sessions.\n");
      return 1;
    }
  }

  const vars: Record<string, string> = { OPENLLM_API_KEY: trimmed };
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
