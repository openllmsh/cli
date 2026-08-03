/** Durable local session-host process discovery and launch helpers. */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { TDaemonCli } from "./clients/registry";
import { daemonStateDir } from "./env";

export type TSessionHostMeta = {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly cwd: string;
  readonly pid: number;
  readonly vendorSessionId: string | null;
  readonly title: string | null;
  readonly startedAtMs: number;
  readonly generation: number;
};

export type TLiveSessionHost = TSessionHostMeta & {
  readonly socketPath: string;
};

export const sessionHostsRoot = (): string =>
  join(daemonStateDir(), "sessions");
export const sessionHostDir = (id: string): string =>
  join(sessionHostsRoot(), id);
export const sessionHostSocketPath = (id: string): string =>
  join(sessionHostDir(id), "ctl.sock");

const isDaemonCli = (value: unknown): value is TDaemonCli =>
  value === "claude_code" ||
  value === "chatgpt" ||
  value === "grok" ||
  value === "opencode";

/** Validate metadata before treating an on-disk entry as a live host. */
export const isSessionHostMeta = (
  value: unknown,
): value is TSessionHostMeta => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(meta.id) &&
    isDaemonCli(meta.cli) &&
    typeof meta.cwd === "string" &&
    typeof meta.pid === "number" &&
    Number.isInteger(meta.pid) &&
    meta.pid > 0 &&
    (meta.vendorSessionId === null ||
      typeof meta.vendorSessionId === "string") &&
    (meta.title === null || typeof meta.title === "string") &&
    typeof meta.startedAtMs === "number" &&
    Number.isFinite(meta.startedAtMs) &&
    typeof meta.generation === "number" &&
    Number.isInteger(meta.generation) &&
    meta.generation >= 1
  );
};

export const sessionHostProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readSessionHostMeta = (dir: string): TSessionHostMeta | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "meta.json"), "utf8"),
    );
    return isSessionHostMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Scan the process-owned registry. Invalid, dead, or socket-less entries are
 * stale and are removed here; a live entry is never touched.
 */
const HOST_STARTUP_GRACE_MS = 10_000;

const directoryAgeMs = (directory: string): number => {
  try {
    return Date.now() - statSync(directory).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const reapDirectory = (directory: string): void => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: a concurrently exiting host owns final cleanup.
  }
};

export const discoverLiveSessionHosts = (): readonly TLiveSessionHost[] => {
  let entries: string[];
  try {
    entries = readdirSync(sessionHostsRoot());
  } catch {
    return [];
  }
  const sessions: TLiveSessionHost[] = [];
  for (const name of entries) {
    const directory = sessionHostDir(name);
    const meta = readSessionHostMeta(directory);
    const socketPath = join(directory, "ctl.sock");

    // A directory with no valid metadata may be mid-write. Leave it alone until
    // the grace period expires so a concurrent scan cannot delete a host that is
    // still starting.
    if (meta === null || meta.id !== name) {
      if (directoryAgeMs(directory) > HOST_STARTUP_GRACE_MS) {
        reapDirectory(directory);
      }
      continue;
    }

    // A dead pid is unambiguously stale regardless of age.
    if (!sessionHostProcessAlive(meta.pid)) {
      reapDirectory(directory);
      continue;
    }

    if (!existsSync(socketPath)) {
      if (Date.now() - meta.startedAtMs > HOST_STARTUP_GRACE_MS) {
        reapDirectory(directory);
      }
      continue;
    }

    sessions.push({ ...meta, socketPath });
  }
  return sessions.sort((a, b) => b.startedAtMs - a.startedAtMs);
};

/** Wait briefly for the detached host to publish its authenticated control socket. */
export const waitForSessionHostSocket = async (
  id: string,
  timeoutMs = 2_000,
): Promise<string | null> => {
  const socketPath = sessionHostSocketPath(id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return socketPath;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(socketPath) ? socketPath : null;
};

/**
 * Resolve the durable-host binary, allowing a normal PATH install.
 *
 * `OPENLLM_DAEMON_BIN_OVERRIDE` wins first: in the source-watch dev harness
 * (`scripts/dev.ts` / `scripts/dev-cli.ts`) it points at an executable shim
 * (`.dev/openllmd` → `exec bun packages/daemon/src/main.ts "$@"`), so a LOCAL
 * `openllm <client>` session spawns a host running THIS working tree's daemon
 * source instead of the stale compiled `~/.openllm/bin/openllmd`. The shim must
 * be executable — `spawnSessionHost` runs `Bun.spawn([binary, ...argv])`, so
 * `[shim, "__session-host", …]` execs `bun main.ts __session-host …`.
 */
export const findDaemonBinary = (): string | null => {
  const override = process.env.OPENLLM_DAEMON_BIN_OVERRIDE;
  if (override !== undefined && override.length > 0 && existsSync(override))
    return override;
  const installed = join(daemonStateDir(), "bin", "openllmd");
  if (existsSync(installed)) return installed;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "openllmd");
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

export const sessionHostSpawnArgv = (args: {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly title: string;
  readonly dangerous: boolean;
  readonly resumeSessionId?: string;
  readonly vendorArgs: readonly string[];
}): readonly string[] => [
  "__session-host",
  "--id",
  args.id,
  "--cli",
  args.cli,
  "--cwd",
  args.cwd,
  "--title",
  args.title,
  "--cols",
  String(args.cols),
  "--rows",
  String(args.rows),
  ...(args.dangerous ? ["--dangerous"] : []),
  ...(args.resumeSessionId === undefined
    ? []
    : ["--resume", args.resumeSessionId]),
  ...args.vendorArgs.flatMap((arg) => ["--vendor-arg", arg]),
];

/**
 * Spawn the host as a sibling process so it survives the invoking CLI.
 * Returns the child process so the caller may clean up on fallback.
 */
export const spawnSessionHost = (args: {
  readonly binary: string;
  readonly argv: readonly string[];
}): ReturnType<typeof Bun.spawn> | null => {
  try {
    const proc = Bun.spawn([args.binary, ...args.argv], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    return proc;
  } catch {
    return null;
  }
};
