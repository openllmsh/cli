/** Public CLI mirrors for daemon-owned lifecycle commands. */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { executableName } from "../../pty-native/session/local-runtime";
import {
  CLI_VERSION,
  isIsolatedStateRoot,
  isProductionOpenllmPath,
  openllmDir,
} from "./env";

export const DAEMON_LIFECYCLE_COMMANDS = ["start", "stop", "restart"] as const;

export type TDaemonLifecycleCommand =
  (typeof DAEMON_LIFECYCLE_COMMANDS)[number];

/** Upper bound on the `openllmd --version` probe — the version command must
 *  never hang on a wedged binary. */
const DAEMON_VERSION_TIMEOUT_MS = 2_000;
const DAEMON_VERSION_MAX_BYTES = 256;

export const isDaemonReleaseLineCompatible = (
  cliVersion: string,
  daemonOutput: string,
): boolean => {
  const cliLine = cliVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  const daemonLine = daemonOutput
    .trim()
    .match(/^openllmd v?(\d+)\.(\d+)\.(\d+)/);
  if (cliVersion === "0.0.0-dev")
    return daemonOutput.trim() === "openllmd v0.0.0-dev";
  return (
    cliLine !== null &&
    cliLine !== undefined &&
    daemonLine !== null &&
    daemonLine !== undefined &&
    cliLine[1] === daemonLine[1] &&
    cliLine[2] === daemonLine[2] &&
    cliLine[3] === daemonLine[3]
  );
};

/** The installer-owned daemon location; daemon state may be elsewhere. */
export const managedDaemonBinary = (): string =>
  join(openllmDir(), "bin", executableName("openllmd"));

/**
 * Resolve a daemon executable for commands that can deliberately use a developer
 * override or a normal PATH installation. Lifecycle delegation still prefers the
 * canonical installer location.
 */
export const findDaemonBinary = (): string | null => {
  const override = process.env.OPENLLM_DAEMON_BIN_OVERRIDE;
  if (
    override !== undefined &&
    override.length > 0 &&
    existsSync(override) &&
    !(isIsolatedStateRoot() && isProductionOpenllmPath(override))
  )
    return override;
  const installed = managedDaemonBinary();
  if (existsSync(installed)) return installed;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, executableName("openllmd"));
    // A PATH entry can point straight back into the production install. Under
    // state-root isolation, don't even stat that implicit candidate.
    if (isIsolatedStateRoot() && isProductionOpenllmPath(candidate)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * The managed daemon's baked version line (`openllmd --version` prints
 * `openllmd vX.Y.Z`), or null when no daemon binary is installed or the probe
 * fails/times out. Spawns the binary directly rather than probing the running
 * service, so the reported version is the installed artifact's — available even
 * when the daemon is not started.
 */
const probeDaemonVersion = async (binary: string): Promise<string | null> => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn([binary, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = proc.stdout;
    if (stdout === undefined || typeof stdout === "number") return null;
    // Race the bounded read against the timeout. A timer that only kills the
    // child is not enough if a descendant keeps stdout open.
    // On timeout we resolve null and drop the pending read.
    const read = (async (): Promise<string | null> => {
      const reader = stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > DAEMON_VERSION_MAX_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc?.kill();
        } catch {
          // already exited
        }
        resolve(null);
      }, DAEMON_VERSION_TIMEOUT_MS);
    });
    const out = await Promise.race([read, timeout]);
    if (out === null) return null;
    const exitCode = await Promise.race([proc.exited, timeout]);
    if (exitCode === null || exitCode !== 0) return null;
    const line = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
    return line.length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const daemonVersion = async (): Promise<string | null> => {
  const binary = findDaemonBinary();
  return binary === null ? null : probeDaemonVersion(binary);
};

/** Resolve only a daemon whose bounded version probe matches this CLI build.
 *  Session startup uses this to avoid attaching to an incompatible daemon. */
export const findCompatibleDaemonBinary = async (): Promise<string | null> => {
  const binary = findDaemonBinary();
  if (binary === null) return null;
  const version = await probeDaemonVersion(binary);
  return version !== null && isDaemonReleaseLineCompatible(CLI_VERSION, version)
    ? binary
    : null;
};

/**
 * Delegate a public lifecycle command to the product-managed daemon binary.
 * The daemon owns service and automatic-update policy; this function only
 * preserves its stdout, stderr, and exit status for the CLI caller.
 */
export const runManagedDaemonCommand = async (
  command: TDaemonLifecycleCommand | "auto-update" | "uninstall" | "status",
  args: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<number> => {
  const binary = findDaemonBinary();
  if (binary === null) {
    process.stderr.write(
      `[openllm] managed daemon binary not found at ${managedDaemonBinary()}; reinstall OpenLLM with \`curl -fsSL https://www.openllm.sh/install | bash\`\n`,
    );
    return 1;
  }

  if (isIsolatedStateRoot()) {
    const version = await daemonVersion();
    if (
      version === null ||
      !isDaemonReleaseLineCompatible(CLI_VERSION, version)
    ) {
      process.stderr.write(
        `[openllm] refusing daemon delegation under OPENLLM_DAEMON_STATE_DIR: installed daemon version is unavailable or does not match CLI release line ${CLI_VERSION}\n`,
      );
      return 1;
    }
  }

  try {
    const proc = Bun.spawn([binary, command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    return await proc.exited;
  } catch (error) {
    process.stderr.write(
      `[openllm] could not run managed daemon: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};
