/** Public CLI mirrors for daemon-owned lifecycle commands. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openllmDir } from "./env";

export const DAEMON_LIFECYCLE_COMMANDS = ["start", "stop", "restart"] as const;

export type TDaemonLifecycleCommand =
  (typeof DAEMON_LIFECYCLE_COMMANDS)[number];

/** Upper bound on the `openllmd --version` probe — the version command must
 *  never hang on a wedged binary. */
const DAEMON_VERSION_TIMEOUT_MS = 2_000;

/** The installer-owned daemon location; daemon state may be elsewhere. */
export const managedDaemonBinary = (): string =>
  join(openllmDir(), "bin", "openllmd");

/**
 * Resolve a daemon executable for commands that can deliberately use a developer
 * override or a normal PATH installation. Lifecycle delegation still prefers the
 * canonical installer location.
 */
export const findDaemonBinary = (): string | null => {
  const override = process.env.OPENLLM_DAEMON_BIN_OVERRIDE;
  if (override !== undefined && override.length > 0 && existsSync(override))
    return override;
  const installed = managedDaemonBinary();
  if (existsSync(installed)) return installed;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "openllmd");
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
export const daemonVersion = async (): Promise<string | null> => {
  const binary = findDaemonBinary();
  if (binary === null) return null;
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
    // RACE the read against the timeout — a timer that only kills the child is
    // not enough: if a descendant keeps stdout open, `.text()` would still hang
    // after the kill. On timeout we resolve null and drop the pending read.
    const read = new Response(stdout).text();
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
    const line = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
    return line.length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
