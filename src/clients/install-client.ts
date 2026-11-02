/**
 * On-demand installation for a single missing session client.
 *
 * Trusted installers only — URLs and shells come from registry-owned
 * `curlInstall` metadata (`CLIENTS` in `registry.ts`). Never build a shell
 * command from user input. Always-on apps (ChatGPT Mac app, Raycast) have no
 * curl installer; callers print `installHint`.
 */

import type { Readable } from "node:stream";
import { awaitPipeCodes, bunSubprocessPeer } from "../process-pipe";
import type { TClient, TClientCurlInstall, TClientId } from "./registry";
import { CLIENTS } from "./registry";

/** Explicit authorize for non-interactive missing-client installs. */
export const INSTALL_MISSING_CLIENT_ENV = "OPENLLM_INSTALL_MISSING_CLIENT";

/** Display form of a trusted install — what we print and what tests assert. */
export const formatCurlInstallCommand = (spec: TClientCurlInstall): string =>
  `curl -fsSL ${spec.url} | ${spec.shell}`;

/**
 * Curl-installable session clients, derived from `CLIENTS.curlInstall`.
 * Keys are client ids — this map serves `openllm <client>`, not the
 * Providers UI.
 */
export const TRUSTED_CLIENT_INSTALL_CMD: Readonly<
  Partial<Record<TClientId, string>>
> = Object.fromEntries(
  (Object.keys(CLIENTS) as TClientId[])
    .map((id): [TClientId, string] | null => {
      const spec = CLIENTS[id].curlInstall;
      return spec === undefined ? null : [id, formatCurlInstallCommand(spec)];
    })
    .filter((entry): entry is [TClientId, string] => entry !== null),
);

/** Official install command for a client id, or `null` when not curl-installable. */
export const trustedClientInstallCmd = (id: TClientId): string | null =>
  TRUSTED_CLIENT_INSTALL_CMD[id] ?? null;

/** Registry-owned curl install for a client, or `null`. */
export const trustedClientCurlInstall = (
  id: TClientId,
): TClientCurlInstall | null => CLIENTS[id].curlInstall ?? null;

/** True when non-interactive launches may run the trusted installer. */
export const isMissingClientInstallAuthorized = (): boolean =>
  process.env[INSTALL_MISSING_CLIENT_ENV]?.trim() === "1";

export type TInstallClientRunner = (command: string) => Promise<number>;
export type TConfirmInstall = (message: string) => Promise<boolean>;

export type TEnsureClientInstalledDeps = {
  readonly findBinary?: (client: TClient) => string | null;
  readonly isInteractive?: () => boolean;
  readonly confirm?: TConfirmInstall;
  readonly runInstall?: TInstallClientRunner;
  readonly write?: (message: string) => void;
  readonly isAuthorized?: () => boolean;
};

export type TEnsureClientInstalledResult =
  | { readonly ok: true; readonly bin: string }
  | { readonly ok: false; readonly code: number };

const defaultIsInteractive = (): boolean =>
  process.stdin.isTTY === true && process.stderr.isTTY === true;

const defaultWrite = (message: string): void => {
  process.stderr.write(message);
};

/**
 * Env for trusted installer children. Keeps HOME / PATH / proxy vars and the
 * rest of the process environment, but never forwards the account API key to a
 * vendor curl|shell script. (Device-anchor scrubbing is done at CLI entry.)
 */
export const installChildEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...source };
  delete env.OPENLLM_API_KEY;
  return env;
};

/**
 * Run a trusted `curl | shell` installer with argv arrays — the URL never
 * reaches a shell evaluator. Mirrors `update-cmd.ts`'s pipeline pattern.
 */
export const runTrustedInstallCommand = async (
  command: string,
): Promise<number> => {
  const spec = specForCommand(command);
  if (spec === null) return 1;
  return runCurlPipeShell(spec);
};

const specForCommand = (command: string): TClientCurlInstall | null => {
  for (const id of Object.keys(CLIENTS) as TClientId[]) {
    const spec = CLIENTS[id].curlInstall;
    if (spec !== undefined && formatCurlInstallCommand(spec) === command)
      return spec;
  }
  return null;
};

/** Exported for tests — production goes through `runTrustedInstallCommand`. */
export const runCurlPipeShell = async (
  spec: TClientCurlInstall,
): Promise<number> => {
  const childEnv = installChildEnv();
  const curl = Bun.spawn(["curl", "-fsSL", spec.url], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env: childEnv,
  });
  const shell = Bun.spawn([spec.shell, "-s", "--"], {
    stdin: curl.stdout,
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
  });
  const [curlCode, shellCode] = await awaitPipeCodes(
    bunSubprocessPeer(curl),
    bunSubprocessPeer(shell),
  );
  if (curlCode !== 0) return curlCode;
  return shellCode;
};

/**
 * Read one yes/no answer from stdin without leaving readline listeners behind.
 * Empty / anything other than y/yes is a decline.
 */
const defaultConfirm = async (message: string): Promise<boolean> => {
  process.stderr.write(message);
  const line = await readConfirmLine();
  return /^(y|yes)$/i.test(line.trim());
};

/**
 * Read one confirm line from a readable stream (defaults to `process.stdin`).
 * Stdin end/error, Ctrl-C, and Ctrl-D all settle as a decline (`"n"`), once,
 * with every listener removed.
 */
export const readConfirmLine = async (
  stdin: Readable = process.stdin,
): Promise<string> =>
  new Promise<string>((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onDecline);
      stdin.off("error", onDecline);
      stdin.pause();
      resolve(value);
    };
    const onDecline = (): void => {
      process.stderr.write("\n");
      finish("n");
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const byte of bytes) {
        if (byte === 0x03 || byte === 0x04) {
          process.stderr.write("\n");
          finish("n");
          return;
        }
        if (byte === 0x0a || byte === 0x0d) {
          process.stderr.write("\n");
          finish(buffer);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += String.fromCharCode(byte);
      }
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", onDecline);
    stdin.on("error", onDecline);
  });

const manualGuidance = (client: TClient, command: string | null): string => {
  if (command !== null) {
    return (
      `${client.name} is not installed. Install it with:\n  ${command}\n\n` +
      `Or re-run with ${INSTALL_MISSING_CLIENT_ENV}=1 to install automatically.\n`
    );
  }
  return `${client.name} is not installed. Install it first:\n  ${client.installHint}\n`;
};

const confirmPrompt = (client: TClient, command: string): string =>
  `${client.name} is not installed. Install it now?\n  ${command}\n[y/N] `;

/**
 * Ensure `client`'s binary is on disk. When missing, offer (or, when
 * authorized, run) the trusted installer for that client alone — never a
 * vendor bundle, never a daemon start.
 */
export const ensureClientInstalled = async (
  client: TClient,
  deps: TEnsureClientInstalledDeps = {},
): Promise<TEnsureClientInstalledResult> => {
  // Dynamic import breaks the session ↔ install-client cycle: session owns
  // findClientBinary and calls ensureClientInstalled on the missing path.
  const findBinary =
    deps.findBinary ?? (await import("./session")).findClientBinary;
  const write = deps.write ?? defaultWrite;
  const isInteractive = deps.isInteractive ?? defaultIsInteractive;
  const confirm = deps.confirm ?? defaultConfirm;
  const runInstall = deps.runInstall ?? runTrustedInstallCommand;
  const isAuthorized = deps.isAuthorized ?? isMissingClientInstallAuthorized;

  const existing = findBinary(client);
  if (existing !== null) return { ok: true, bin: existing };

  const command = trustedClientInstallCmd(client.id);
  if (command === null) {
    write(manualGuidance(client, null));
    return { ok: false, code: 127 };
  }

  const interactive = isInteractive();
  if (!interactive && !isAuthorized()) {
    write(manualGuidance(client, command));
    return { ok: false, code: 127 };
  }

  if (interactive) {
    const accepted = await confirm(confirmPrompt(client, command));
    if (!accepted) {
      write(manualGuidance(client, command));
      return { ok: false, code: 127 };
    }
  } else {
    write(`[openllm] installing ${client.name}…\n  ${command}\n`);
  }

  const code = await runInstall(command);
  if (code !== 0) {
    write(
      `[openllm] ${client.name} install failed (exit ${code}). Install it with:\n  ${command}\n`,
    );
    return { ok: false, code: 127 };
  }

  const resolved = findBinary(client);
  if (resolved === null) {
    write(
      `[openllm] ${client.name} install finished but the binary still could not be found.\n` +
        `Install it with:\n  ${command}\n`,
    );
    return { ok: false, code: 127 };
  }
  return { ok: true, bin: resolved };
};
