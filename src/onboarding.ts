import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  TCredentialGateMode,
  TCredentialGateTerminal,
} from "@openllmsh/protocol";
import { isUsableOpenllmApiKey } from "@openllmsh/protocol";
import type { TCliConfig } from "./env";
import { cliConfig, sharedEnvFile } from "./env";

export type {
  TCredentialGateMode,
  TCredentialGateTerminal,
} from "@openllmsh/protocol";

export type TCredentialGateResult =
  | { readonly ok: true; readonly config: TCliConfig }
  | { readonly ok: false; readonly message: string };

/** A local envelope check only; the gateway remains authoritative for validity. */
export const isUsableApiKey = isUsableOpenllmApiKey;

const signInUrl = (config: TCliConfig = cliConfig()): string =>
  `${config.gatewayUrl}/sign-in`;

const keyDiagnostic = (
  problem: "required" | "invalid",
  config?: TCliConfig,
): string =>
  `[openllm] ${problem === "required" ? "API key required." : "API key format is invalid."}\nRun \`openllm start\` in an interactive terminal and sign in at ${signInUrl(config)}. New users receive a key during onboarding; returning users can open Keys after signing in. Paste the key when prompted.\n`;

export const missingKeyDiagnostic = (config?: TCliConfig): string =>
  keyDiagnostic("required", config);

export const invalidKeyDiagnostic = (config?: TCliConfig): string =>
  keyDiagnostic("invalid", config);

type THiddenInputSignalProcess = {
  readonly on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly kill: (pid: number, signal: NodeJS.Signals) => boolean;
};

/**
 * Restore echo before forwarding a terminating signal. Hidden input uses a
 * synchronous terminal read, so this handler must be installed before that
 * read begins rather than relying solely on the normal `finally` path.
 */
export const restoreEchoOnSignal = (
  restore: () => void,
  signalProcess: THiddenInputSignalProcess = process,
): (() => void) => {
  let restored = false;
  const restoreOnce = (): void => {
    if (restored) return;
    restored = true;
    restore();
  };
  const forward = (signal: NodeJS.Signals): void => {
    cleanup();
    restoreOnce();
    signalProcess.kill(process.pid, signal);
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  const cleanup = (): void => {
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
  };
  signalProcess.on("SIGINT", onSigint);
  signalProcess.on("SIGTERM", onSigterm);
  return (): void => {
    cleanup();
    restoreOnce();
  };
};

const readHiddenLine = (): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync("/dev/tty", "r+");
    if (spawnSync("stty", ["-echo"], { stdio: [fd, fd, fd] }).status !== 0)
      return null;
    const restore = (): void => {
      spawnSync("stty", ["echo"], { stdio: [fd, fd, fd] });
    };
    const cleanupSignals = restoreEchoOnSignal(restore);
    try {
      const bytes: number[] = [];
      const byte = Buffer.alloc(1);
      while (true) {
        if (readSync(fd, byte, 0, 1, null) === 0) return null;
        if (byte[0] === 10 || byte[0] === 13) break;
        bytes.push(byte[0]);
      }
      return Buffer.from(bytes).toString("utf8");
    } finally {
      cleanupSignals();
      process.stderr.write("\n");
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const defaultTerminal: TCredentialGateTerminal = {
  isInteractive: (): boolean =>
    process.stdin.isTTY === true && process.stderr.isTTY === true,
  promptForKey: (): string | null => {
    process.stderr.write("API key: ");
    return readHiddenLine();
  },
  write: (message: string): void => {
    process.stderr.write(message);
  },
};

const ENV_UPDATE_LOCK_TIMEOUT_MS = 5_000;
const ENV_UPDATE_LOCK_RETRY_MS = 25;
const ENV_UPDATE_LOCK_STALE_MS = 30_000;

/** Block briefly between lock attempts without spawning a shell process. */
const waitForEnvUpdateLock = (): void => {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    ENV_UPDATE_LOCK_RETRY_MS,
  );
};

/**
 * Serialize read-modify-rename updates across CLI processes. Re-reading only
 * after acquiring the lock prevents one interactive setup from erasing another
 * writer's unrelated daemon configuration. The final rename remains atomic for
 * daemon readers that do not participate in the lock.
 */
const updateEnvFile = (key: string): boolean => {
  const target = sharedEnvFile();
  const lock = `${target}.lock`;
  let locked = false;
  try {
    if (/[\r\n\0]/.test(key)) return false;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + ENV_UPDATE_LOCK_TIMEOUT_MS;
    while (!locked && Date.now() < deadline) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        locked = true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          return false;
        try {
          const held = lstatSync(lock);
          if (
            held.isDirectory() &&
            Date.now() - held.mtimeMs > ENV_UPDATE_LOCK_STALE_MS
          ) {
            rmdirSync(lock);
          }
        } catch {
          // Another writer may have released or replaced the lock.
        }
        waitForEnvUpdateLock();
      }
    }
    if (!locked) return false;

    let lines: string[] = [];
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      lines = readFileSync(target, "utf8").split("\n");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        return false;
    }
    let replaced = false;
    const next = lines.flatMap((line): string[] => {
      const match = /^\s*OPENLLM_API_KEY\s*=/.test(line);
      if (!match) return [line];
      if (replaced) return [];
      replaced = true;
      return [`OPENLLM_API_KEY=${key}`];
    });
    while (next.length > 0 && next[next.length - 1]?.trim() === "") next.pop();
    if (!replaced) next.push(`OPENLLM_API_KEY=${key}`);
    const temp = join(
      dirname(target),
      `.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temp, `${next.join("\n")}\n`, { mode: 0o600, flag: "wx" });
      const fd = openSync(temp, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
      chmodSync(target, 0o600);
      return true;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // renamed or never created
      }
    }
  } catch {
    return false;
  } finally {
    if (locked) {
      try {
        rmdirSync(lock);
      } catch {
        // Preserve a lock we cannot prove is removable.
      }
    }
  }
};

/**
 * Resolve a key for an authenticated CLI operation. Machine mode is deliberately
 * noninteractive so protocol-bearing commands can fail before writing stdout.
 */
export const requireCliApiKey = (
  mode: TCredentialGateMode,
  terminal: TCredentialGateTerminal = defaultTerminal,
): TCredentialGateResult => {
  const configured = cliConfig();
  if (isUsableApiKey(configured.apiKey)) {
    return {
      ok: true,
      config: { ...configured, apiKey: configured.apiKey.trim() },
    };
  }
  const invalid = configured.apiKey.trim().length > 0;
  if (mode === "machine" || !terminal.isInteractive()) {
    return {
      ok: false,
      message: invalid
        ? invalidKeyDiagnostic(configured)
        : missingKeyDiagnostic(configured),
    };
  }
  if (invalid)
    terminal.write(
      "The configured API key format is invalid. Please paste a new key.\n",
    );
  terminal.write(
    `OpenLLM needs an API key.\nSign in at ${signInUrl(configured)}.\nNew users will receive a key during onboarding. Already have an account? Open Keys after signing in.\n`,
  );
  while (true) {
    const pasted = terminal.promptForKey();
    if (pasted === null || pasted.trim().length === 0)
      return { ok: false, message: "[openllm] API key setup cancelled.\n" };
    if (!isUsableApiKey(pasted)) {
      terminal.write("The API key format is invalid. Please try again.\n");
      continue;
    }
    const key = pasted.trim();
    if (!updateEnvFile(key))
      return { ok: false, message: "[openllm] Could not save the API key.\n" };
    process.env.OPENLLM_API_KEY = key;
    terminal.write("API key saved.\n");
    return { ok: true, config: { ...configured, apiKey: key } };
  }
};
