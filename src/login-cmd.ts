/**
 * `openllm login` — save (or replace) the OpenLLM API key in this
 * environment's env file (`~/.openllm/.env`, `.dev.env` in dev).
 *
 * Ways in, so both people and tools can call it:
 *
 *   openllm login                      interactive: browser OAuth handover
 *   openllm login --api-key            interactive: hidden paste prompt
 *   openllm login --key sk-llm-…       explicit argument (scripts)
 *   echo sk-llm-… | openllm login      piped stdin (keeps the key out of argv)
 *
 * Unlike the credential gate in `onboarding.ts`, login ALWAYS acquires a key —
 * an already-configured key is replaced, which is how a key gets rotated.
 * Interactive default is OpenLLM OAuth; explicit API-key entry still works.
 * Non-interactive shells never hang: they need `--key` or a piped key.
 *
 * A daemon already running reads its key at start, so login restarts it; one
 * that isn't running is left alone unless `--start`. In dev mode
 * (`OPENLLM_DAEMON_DEV=1`) neither: the dev daemon is `bun dev`'s, which
 * restarts it when `.dev.env` changes, and `restart` / `start` would act on
 * the production service instead. The desktop app pairs
 * through this command (`--start --json`, key on stdin), and `--json` reports
 * the outcome on stdout for callers that parse it.
 *
 * `--start` is the ask to use the local daemon, so it also switches a Minimal
 * machine to Full (`OPENLLM_SETUP_MODE=full` in the env file): Minimal sends
 * every client launch cloud-direct, so a started daemon would otherwise sit
 * unused. Plain `login` and `--no-restart` (the installer's path) leave the
 * mode alone.
 *
 * A key copied with Device sessions on carries a device trust anchor after
 * it (`sk-llm-<key>.<anchor>`). Login splits it on the last dot: the anchored
 * key goes to `openllm daemon anchor` over stdin, which writes
 * `OPENLLM_API_KEY=<bare>` and `OPENLLM_DEVICE_ANCHOR=<anchor>` to the
 * runtime's env file (the daemon derives its pin from that line, never
 * trust-on-first-use). ONLY the bare `sk-llm-<key>` is exported or ever used
 * as a bearer; the anchor never enters process.env. Sessions on == the
 * anchor is present; disable blanks that line.
 */

import type { TCliAuthLoginResult, TSignalProcess } from "./cli-auth-login";
import {
  abortOnProcessSignals,
  runCliAuthLogin,
  unsavedKeyNotice,
} from "./cli-auth-login";
import { daemonPort, daemonReachable } from "./clients/gateway";
import { daemonInvocation } from "./daemon-delegation";
import { apiKeyEnvVars, cliConfig, cliEnvFile } from "./env";
import { apiKeyShadowNote, defaultTerminal, saveEnvVars } from "./onboarding";
import type { TCredentialGateTerminal } from "./runtime-contracts";
import { isOpenllmDevMode, splitAnchoredApiKey } from "./runtime-contracts";
import type { TSetupMode } from "./setup-mode";
import {
  exportedSetupMode,
  readSetupMode,
  SETUP_MODE_ENV,
  savedSetupMode,
  saveSetupMode,
} from "./setup-mode";

export const LOGIN_USAGE = `usage: openllm login [sk-llm-...] [--key <sk-llm-...>] [--api-key] [--start] [--no-restart] [--json]

Sign in to OpenLLM and save an API key to ~/.openllm/.env, replacing any
existing key. On an interactive terminal with no key argument, opens a
browser authorization link (also printed for another device) and waits for
approval. Pass --api-key to paste a key instead; --key or piped stdin for
scripts. A running daemon is restarted to pick the key up unless
--no-restart is set (installer uses that so it can start the daemon itself
after vendor provisioning).

A key copied with Device sessions on ends in a device trust anchor
(sk-llm-KEY.ANCHOR). It is kept on this machine only, as a separate
line of the env file; the bare key is the bearer. Sessions on == the
anchor is present; disable blanks it (Manage device, or
openllm daemon device disable).

  --api-key            paste an API key (hidden prompt) instead of browser login
  --key <sk-llm-...>   save this key (non-interactive / scripts)
  --start              also start the daemon when it isn't running, and switch
                       a Minimal setup to Full so client launches use it
  --no-restart         save the key only — never restart or start the daemon,
                       never change the setup mode
  --json               print {"saved":true,"daemon":"restarted"|"started"|
                       "not_running"|"unchanged","setupMode":"full"|"minimal"}
                       on stdout; everything else on stderr
`;

export type TLoginDaemonOutcome =
  | "restarted"
  | "started"
  | "not_running"
  | "unchanged";

/** The `--json` line on stdout. `setupMode` is the mode in effect after login. */
export type TLoginJson = {
  readonly saved: true;
  readonly daemon: TLoginDaemonOutcome;
  readonly setupMode: TSetupMode;
};

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
  /** Injectable OAuth handover (tests). Defaults to `runCliAuthLogin`. */
  readonly runOAuth?: (
    origin: string,
    signal?: AbortSignal,
  ) => Promise<TCliAuthLoginResult>;
  /** Injectable process signal bus for OAuth Ctrl-C (tests). */
  readonly signalProcess?: TSignalProcess;
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

const defaultIo: TLoginIo = {
  terminal: defaultTerminal,
  readStdin: readPipedStdin,
  daemonRunning: () => daemonReachable(daemonPort()),
  runDaemon,
  writeStdout: (text) => process.stdout.write(text),
  anchorDaemon,
};

/**
 * `--start` on a Minimal machine: save Full, so the daemon this login starts
 * is the one client launches use. An exported `OPENLLM_SETUP_MODE=minimal`
 * outranks the file, so the file is still switched but only the note is
 * printed: the export keeps Minimal in effect, so nothing "switched".
 */
const switchToFullForStart = (terminal: TCredentialGateTerminal): void => {
  const exportedMinimal = exportedSetupMode() === "minimal";
  if (savedSetupMode() === "minimal") {
    if (!saveSetupMode("full")) {
      terminal.write(
        `[openllm] Could not switch setup to Full; client launches stay cloud-direct. Set ${SETUP_MODE_ENV}=full in ${cliEnvFile()}.\n`,
      );
      return;
    }
    // Only claim the switch when it takes effect; an exported Minimal still
    // wins, and the note below says so instead.
    if (!exportedMinimal) {
      terminal.write(
        "Setup switched to Full: client launches now use the local daemon.\n",
      );
    }
  }
  if (exportedMinimal) {
    terminal.write(
      `[openllm] Note: ${SETUP_MODE_ENV}=minimal is set in your environment and keeps Minimal in effect. Unset it to use the local daemon.\n`,
    );
  }
};

const loginJson = (daemon: TLoginDaemonOutcome): string =>
  `${JSON.stringify({ saved: true, daemon, setupMode: readSetupMode() } satisfies TLoginJson)}\n`;

type TLoginArgs = {
  readonly key: string | null;
  readonly apiKeyEntry: boolean;
  readonly start: boolean;
  readonly noRestart: boolean;
  readonly json: boolean;
};

const parseLoginArgs = (args: readonly string[]): TLoginArgs | null => {
  let key: string | null = null;
  let apiKeyEntry = false;
  let start = false;
  let noRestart = false;
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
    } else if (key === null && arg !== undefined && arg.startsWith("sk-llm-")) {
      // `openllm login sk-llm-<key>.<anchor>` — the one-line setup command.
      key = arg;
    } else if (arg === "--api-key") {
      apiKeyEntry = true;
    } else if (arg === "--start") {
      start = true;
    } else if (arg === "--no-restart") {
      noRestart = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      return null;
    }
  }
  return { key, apiKeyEntry, start, noRestart, json };
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
  // Set when the key came from the OAuth claim: the server already holds it,
  // so a failure to save it must say so (the revoke notice).
  let claimed: { readonly keyId?: string } | null = null;
  if (key === null) {
    const piped = await io.readStdin();
    if (piped !== null && piped.trim().length > 0) {
      key = piped;
    } else if (piped === null && io.terminal.isInteractive()) {
      if (parsed.apiKeyEntry) {
        io.terminal.write(
          `Paste your OpenLLM API key (from ${cliConfig().gatewayUrl}/keys).\n`,
        );
        key = io.terminal.promptForKey();
        if (key === null || key.trim().length === 0) {
          io.terminal.write("[openllm] Login cancelled.\n");
          return 1;
        }
      } else {
        const origin = cliConfig().gatewayUrl;
        const controller = new AbortController();
        const detach = abortOnProcessSignals(
          controller,
          io.signalProcess ?? process,
        );
        try {
          const runOAuth =
            io.runOAuth ??
            ((
              oauthOrigin: string,
              signal?: AbortSignal,
            ): Promise<TCliAuthLoginResult> =>
              runCliAuthLogin(oauthOrigin, { signal }));
          const oauth = await runOAuth(origin, controller.signal);
          if (!oauth.ok) {
            io.terminal.write(oauth.message);
            return 1;
          }
          key = oauth.apiKey;
          claimed = { keyId: oauth.keyId };
        } finally {
          detach();
        }
      }
    } else {
      io.terminal.write(
        "[openllm] No API key given. Pass --key <key>, pipe it on stdin (e.g. `echo $KEY | openllm login`), or run interactively for browser login.\n",
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
  // restarting: the restarted daemon boots anchored. Sessions default on
  // once anchored — no separate enable step.
  if (split.anchor !== null) {
    const anchor = io.anchorDaemon ?? anchorDaemon;
    if ((await anchor(`${split.key}.${split.anchor}`)) !== 0) {
      io.terminal.write(
        "[openllm] The device trust anchor was rejected. Copy the command from Manage device again.\n",
      );
      return 1;
    }
  }

  // `openllm daemon anchor` already wrote OPENLLM_DEVICE_ANCHOR beside an
  // anchored key; a bare key blanks an anchor that is stale for it.
  const vars =
    split.anchor === null
      ? apiKeyEnvVars(trimmed)
      : { OPENLLM_API_KEY: trimmed };
  if (!saveEnvVars(vars)) {
    io.terminal.write(
      `[openllm] Could not save the API key.\n${claimed === null ? "" : unsavedKeyNotice(cliConfig().gatewayUrl, claimed.keyId)}`,
    );
    return 1;
  }
  if (!parsed.json) io.terminal.write("API key saved.\n");
  const shadowNote = apiKeyShadowNote(trimmed);
  if (shadowNote !== null) io.terminal.write(shadowNote);
  process.env.OPENLLM_API_KEY = trimmed;

  const running = await io.daemonRunning();
  if (parsed.noRestart) {
    // Installer path: persist only. The caller starts/restarts the daemon
    // after its own ordered setup (vendors first in full mode).
    if (parsed.json)
      io.writeStdout(loginJson(running ? "unchanged" : "not_running"));
    return 0;
  }
  if (parsed.start) switchToFullForStart(io.terminal);
  if (isOpenllmDevMode()) {
    if (!parsed.json && running) {
      io.terminal.write("bun dev restarts its daemon with the new key.\n");
    }
    if (parsed.json)
      io.writeStdout(loginJson(running ? "restarted" : "not_running"));
    return 0;
  }
  const command = running ? "restart" : parsed.start ? "start" : null;
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
  if (parsed.json) io.writeStdout(loginJson(daemon));
  return 0;
};
