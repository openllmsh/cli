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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TCliConfig } from "./env";
import { cliConfig, sharedEnvFile } from "./env";

export type TCredentialGateMode = "human" | "machine";

export type TCredentialGateTerminal = {
  readonly isInteractive: () => boolean;
  readonly promptForKey: () => string | null;
  readonly write: (message: string) => void;
};

export type TCredentialGateResult =
  | { readonly ok: true; readonly config: TCliConfig }
  | { readonly ok: false; readonly message: string };

/** A local envelope check only; the gateway remains authoritative for validity. */
export const isUsableApiKey = (value: string | null | undefined): boolean => {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  return (
    trimmed.length > "sk-llm-".length &&
    !/[\r\n\0\s]/.test(trimmed) &&
    /^sk-llm-[A-Za-z0-9._-]+$/.test(trimmed)
  );
};

const signInUrl = (): string => `${cliConfig().gatewayUrl}/sign-in`;

export const missingKeyDiagnostic = (): string =>
  `[openllm] API key required.\nRun \`openllm start\` in an interactive terminal and sign in at ${signInUrl()}. New users receive a key during onboarding; returning users can open Keys after signing in. Paste the key when prompted.\n`;

export const invalidKeyDiagnostic = (): string =>
  `[openllm] API key format is invalid.\nRun \`openllm start\` in an interactive terminal and sign in at ${signInUrl()}. New users receive a key during onboarding; returning users can open Keys after signing in. Paste the key when prompted.\n`;

const readHiddenLine = (): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync("/dev/tty", "r+");
    if (spawnSync("stty", ["-echo"], { stdio: [fd, fd, fd] }).status !== 0)
      return null;
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
      spawnSync("stty", ["echo"], { stdio: [fd, fd, fd] });
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

const updateEnvFile = (key: string): boolean => {
  const target = sharedEnvFile();
  try {
    if (/[\r\n\0]/.test(key)) return false;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
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
      message: invalid ? invalidKeyDiagnostic() : missingKeyDiagnostic(),
    };
  }
  if (invalid)
    terminal.write(
      "The configured API key format is invalid. Please paste a new key.\n",
    );
  terminal.write(
    `OpenLLM needs an API key.\nSign in at ${signInUrl()}.\nNew users will receive a key during onboarding. Already have an account? Open Keys after signing in.\n`,
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
    return { ok: true, config: { ...cliConfig(), apiKey: key } };
  }
};
