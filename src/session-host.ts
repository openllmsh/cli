/** Durable local session-host process discovery and launch helpers. */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type { TDaemonCli } from "./clients/registry";
import { DAEMON_CLIS } from "./clients/registry";
import { daemonStateDir } from "./env";

export type TSessionHostMeta = {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly cwd: string;
  readonly pid: number;
  readonly vendorSessionId: string | null;
  readonly title: string | null;
  readonly startedAtMs: number;
  /** Process start identity, preventing a reused pid from impersonating a host. */
  readonly processStartTime: string;
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
  typeof value === "string" &&
  (DAEMON_CLIS as readonly string[]).includes(value);

const validSessionHostSpawnArgs = (args: {
  readonly cwd: string;
  readonly title: string;
  readonly vendorArgs: readonly string[];
}): boolean =>
  isAbsolute(args.cwd) &&
  args.cwd.length >= 1 &&
  args.cwd.length <= 1_024 &&
  !args.cwd.includes("\0") &&
  args.title.length <= 80 &&
  !args.title.includes("\0") &&
  args.vendorArgs.length <= 64 &&
  args.vendorArgs.every(
    (arg) => arg.length >= 1 && arg.length <= 512 && !arg.includes("\0"),
  );

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
    typeof meta.processStartTime === "string" &&
    meta.processStartTime.length > 0 &&
    typeof meta.generation === "number" &&
    Number.isInteger(meta.generation) &&
    meta.generation >= 1
  );
};

const processStartTime = (pid: number): string | null => {
  try {
    const output = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (output.exitCode !== 0) return null;
    const value = new TextDecoder().decode(output.stdout).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/** PID liveness only — used for legacy meta that predates processStartTime. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EPERM"
    );
  }
};

export const sessionHostProcessAlive = (
  meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
): boolean => {
  const startTime = processStartTime(meta.pid);
  return startTime !== null && startTime === meta.processStartTime;
};

export const sessionHostProcessStartTime = (): string | null =>
  processStartTime(process.pid);

/**
 * Pre-processStartTime meta.json shape. Kept only for reap decisions: the host
 * process may still be alive after an upgrade, but attach requires the current
 * identity fields so these records stay non-attachable until the process exits.
 */
type TLegacySessionHostMeta = {
  readonly id: string;
  readonly pid: number;
  readonly startedAtMs: number | null;
};

const readLegacySessionHostMeta = (
  value: unknown,
): TLegacySessionHostMeta | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const meta = value as Record<string, unknown>;
  if (
    typeof meta.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(meta.id) ||
    typeof meta.pid !== "number" ||
    !Number.isInteger(meta.pid) ||
    meta.pid <= 0
  ) {
    return null;
  }
  return {
    id: meta.id,
    pid: meta.pid,
    startedAtMs:
      typeof meta.startedAtMs === "number" && Number.isFinite(meta.startedAtMs)
        ? meta.startedAtMs
        : null,
  };
};

const readSessionHostMeta = (
  dir: string,
):
  | { readonly kind: "current"; readonly meta: TSessionHostMeta }
  | { readonly kind: "legacy"; readonly meta: TLegacySessionHostMeta }
  | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "meta.json"), "utf8"),
    );
    if (isSessionHostMeta(parsed)) return { kind: "current", meta: parsed };
    const legacy = readLegacySessionHostMeta(parsed);
    return legacy === null ? null : { kind: "legacy", meta: legacy };
  } catch {
    return null;
  }
};

/**
 * Scan the process-owned registry. Invalid, dead, or socket-less entries are
 * stale and are removed here; a live entry is never touched. Legacy records
 * (missing processStartTime) are preserved while their pid is alive but never
 * returned as attachable — they are reaped only after the process exits.
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
    const record = readSessionHostMeta(directory);
    const socketPath = join(directory, "ctl.sock");

    // A directory with no recognizable metadata may be mid-write. Leave it
    // alone until the grace period expires so a concurrent scan cannot delete
    // a host that is still starting.
    if (record === null) {
      if (directoryAgeMs(directory) > HOST_STARTUP_GRACE_MS) {
        reapDirectory(directory);
      }
      continue;
    }

    if (record.kind === "legacy") {
      // Non-attachable: keep while the recorded pid is alive, reap once gone.
      // processStartTime is required for attach/kill identity, so legacy stays
      // out of the live list even though the host process may still be running.
      if (record.meta.id !== name || !pidAlive(record.meta.pid)) {
        reapDirectory(directory);
      }
      continue;
    }

    const meta = record.meta;
    if (meta.id !== name) {
      if (directoryAgeMs(directory) > HOST_STARTUP_GRACE_MS) {
        reapDirectory(directory);
      }
      continue;
    }

    // A dead (or recycled) pid is unambiguously stale regardless of age.
    if (!sessionHostProcessAlive(meta)) {
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
}): readonly string[] | null => {
  if (!validSessionHostSpawnArgs(args)) return null;
  return [
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
};

/**
 * Spawn the host as a sibling process so it survives the invoking CLI.
 * Returns the child process so the caller may clean up on fallback.
 */
export const spawnSessionHost = (args: {
  readonly binary: string;
  readonly argv: readonly string[];
}): ReturnType<typeof Bun.spawn> | null => {
  try {
    const command =
      process.platform === "win32" &&
      extname(args.binary).toLowerCase() === ".cmd"
        ? ["cmd.exe", "/c", args.binary, ...args.argv]
        : [args.binary, ...args.argv];
    const reapWithHarness =
      process.env.OPENLLM_SESSION_HOST_KILL_ON_PARENT_EXIT === "1";
    const proc = Bun.spawn(command, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        ...(reapWithHarness
          ? { OPENLLM_SESSION_HOST_OWNER_PID: String(process.pid) }
          : {}),
      },
    });
    proc.unref();
    return proc;
  } catch {
    return null;
  }
};
