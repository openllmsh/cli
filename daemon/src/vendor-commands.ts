/**
 * Shared vendor-command recognition — a leaf module (no daemon imports) so
 * both `session-host.ts` (orphan reaping) and `local-sessions/live-run.ts`
 * (run-dir liveness) use ONE list and cannot drift.
 *
 * Conservative by design: a match only gates "is this pid still one of our
 * session CLIs", never anything destructive on its own.
 */

import { basename } from "node:path";

/** Vendor CLI command names we launch or wrap. Includes the openllm wrapper. */
export const VENDOR_CLI_NAMES: readonly string[] = [
  "claude",
  "codex",
  "kimi",
  "grok",
  "cursor-agent",
  "muse",
  "opencode",
  "hermes",
  // Preferred launch path: openllm [-d] <client>
  "openllm",
  "openllmc",
];

const executableFromCommand = (command: string): string | null => {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : null;
  }
  const space = trimmed.search(/\s/);
  return space === -1 ? trimmed : trimmed.slice(0, space);
};

/** Extract and validate the executable token from `ps -o command=` output. */
export const isVendorSessionCommand = (command: string): boolean => {
  const executable = executableFromCommand(command);
  if (executable === null || executable.length === 0) return false;
  const name = basename(executable).toLowerCase();
  return VENDOR_CLI_NAMES.includes(name);
};
