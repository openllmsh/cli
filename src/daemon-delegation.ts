/** Public CLI mirrors for daemon-owned lifecycle commands. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openllmDir } from "./env";

export const DAEMON_LIFECYCLE_COMMANDS = ["start", "stop", "restart"] as const;

export type TDaemonLifecycleCommand =
  (typeof DAEMON_LIFECYCLE_COMMANDS)[number];

/** Upper bound on the `openllm daemon --version` probe — the version command
 *  must never hang on a wedged binary. */
const DAEMON_VERSION_TIMEOUT_MS = 2_000;

/** The installer-owned binary — the single `openllm` that is both CLI and
 *  daemon. Daemon state may be elsewhere. */
export const managedDaemonBinary = (): string =>
  join(openllmDir(), "bin", "openllm");

/** A compiled standalone run: Bun embeds the entry under a virtual root
 *  (`/$bunfs/…`, `B:/~BUN/…` on Windows) at `argv[1]`. A source run has the
 *  real script path there instead. */
const isCompiledRun = (): boolean => {
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs/") || entry.includes("~BUN");
};

/**
 * The argv prefix that runs the daemon half: a developer override binary
 * (`OPENLLM_DAEMON_BIN_OVERRIDE`, e.g. the dev source shim) as-is, otherwise
 * THIS binary with the `daemon` token — the compiled binary, or `bun <entry>`
 * for a source run. Never null: the daemon ships inside every CLI.
 */
export const daemonInvocation = (): readonly string[] => {
  const override = process.env.OPENLLM_DAEMON_BIN_OVERRIDE;
  if (override !== undefined && override.length > 0 && existsSync(override))
    return [override];
  const entry = process.argv[1];
  return isCompiledRun() || entry === undefined
    ? [process.execPath, "daemon"]
    : [process.execPath, entry, "daemon"];
};

/**
 * The daemon half's baked version line (`openllmd vX.Y.Z`), or null when the
 * probe fails/times out. Spawns the binary rather than probing the running
 * service, so the reported version is the artifact's — available even when
 * the daemon is not started.
 */
export const daemonVersion = async (): Promise<string | null> => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn([...daemonInvocation(), "--version"], {
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
 * Run a public lifecycle command in the daemon half (a child process: daemon
 * commands `process.exit` and load the daemon module graph, which CLI commands
 * should not). Preserves its stdout, stderr, and exit status for the caller.
 *
 * Performance note (cli-startup audit §6): `status` / `auth` always pay this
 * spawn (~70–100 ms) even when a daemon is already up. A loopback shortcut is
 * intentionally NOT used here — `status` is a rich supervisor/service report
 * (not just `GET /status`), and `auth` drives native CLI login / keychain
 * flows that live in the daemon module graph. Prefer spawn for correctness.
 */
export const runManagedDaemonCommand = async (
  command:
    | TDaemonLifecycleCommand
    | "auto-update"
    | "uninstall"
    | "status"
    | "auth",
  args: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<number> => {
  try {
    const proc = Bun.spawn([...daemonInvocation(), command, ...args], {
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
