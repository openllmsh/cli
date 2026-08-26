/** Public CLI mirrors for daemon-owned lifecycle commands. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { daemonStateDir } from "./env";

export const DAEMON_LIFECYCLE_COMMANDS = ["start", "stop", "restart"] as const;

export type TDaemonLifecycleCommand =
  (typeof DAEMON_LIFECYCLE_COMMANDS)[number];

export const managedDaemonBinary = (): string =>
  join(daemonStateDir(), "bin", "openllmd");

/**
 * Delegate a public lifecycle command to the product-managed daemon binary.
 * The daemon owns service and automatic-update policy; this function only
 * preserves its stdout, stderr, and exit status for the CLI caller.
 */
export const runManagedDaemonCommand = async (
  command: TDaemonLifecycleCommand | "auto-update",
  args: readonly string[] = [],
): Promise<number> => {
  const binary = managedDaemonBinary();
  if (!existsSync(binary)) {
    process.stderr.write(
      `[openllm] managed daemon binary not found at ${binary}; reinstall OpenLLM with \`openllm update\`\n`,
    );
    return 1;
  }

  try {
    const proc = Bun.spawn([binary, command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    return await proc.exited;
  } catch (error) {
    process.stderr.write(
      `[openllm] could not run managed daemon: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};
