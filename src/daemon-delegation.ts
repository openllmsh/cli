/** Public CLI mirrors for daemon-owned lifecycle commands. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openllmDir } from "./env";

export const DAEMON_LIFECYCLE_COMMANDS = ["start", "stop", "restart"] as const;

export type TDaemonLifecycleCommand =
  (typeof DAEMON_LIFECYCLE_COMMANDS)[number];

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
 * Delegate a public lifecycle command to the product-managed daemon binary.
 * The daemon owns service and automatic-update policy; this function only
 * preserves its stdout, stderr, and exit status for the CLI caller.
 */
export const runManagedDaemonCommand = async (
  command: TDaemonLifecycleCommand | "auto-update" | "uninstall",
  args: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<number> => {
  const binary = findDaemonBinary();
  if (binary === null) {
    process.stderr.write(
      `[openllm] managed daemon binary not found at ${managedDaemonBinary()}; reinstall OpenLLM with \`curl -fsSL https://openllm.sh/install | bash\`\n`,
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
