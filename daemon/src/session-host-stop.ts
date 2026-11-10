/**
 * Session-host stop helpers shared by the CLI and daemon uninstall.
 *
 * Identity uses the unpinned `ps -o lstart=` form so hosts started by a prior
 * release (which stored locale/TZ-local lstart) stay recognizable after upgrade.
 * Child-supervisor registries keep their own LC_ALL=C/TZ=UTC pin separately.
 *
 * Leaf module: depends only on posix helpers + the clients registry — never on
 * `packages/cli/src/session-host.ts`, so daemon uninstall can import it without
 * a daemon ↔ CLI cycle.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TDaemonCli } from "../../src/clients/registry";
import { DAEMON_CLIS } from "../../src/clients/registry";
import {
  processAlive,
  processGroupExists,
  terminateOwnedPidSync,
  terminateProcessGroup,
} from "./child-supervisor/posix";

export type TSessionHostStopTarget = {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly pid: number;
  readonly processStartTime: string;
  readonly socketPath: string;
  /** Detached PTY child process-group leader, when recorded in meta.json. */
  readonly childPid?: number;
  /** Unpinned `ps -o lstart=` for `childPid` (TOCTOU identity). */
  readonly childProcessStartTime?: string;
};

export type TSessionChildStopTarget = {
  readonly id: string;
  readonly childPid: number;
  readonly childProcessStartTime?: string;
};

/** True when a pid is safe to signal (never 0/1/negative). */
const isSafePid = (pid: number): boolean => Number.isInteger(pid) && pid > 1;

/**
 * Parse optional detached-child identity from a session-host meta record.
 * Missing on hosts written before child tracking; never invents values.
 */
export const readSessionChildStopTarget = (
  id: string,
  meta: Record<string, unknown>,
): TSessionChildStopTarget | null => {
  if (
    typeof meta.childPid !== "number" ||
    !Number.isInteger(meta.childPid) ||
    !isSafePid(meta.childPid)
  ) {
    return null;
  }
  const childProcessStartTime =
    typeof meta.childProcessStartTime === "string" &&
    meta.childProcessStartTime.length > 0
      ? meta.childProcessStartTime
      : undefined;
  return childProcessStartTime === undefined
    ? { id, childPid: meta.childPid }
    : { id, childPid: meta.childPid, childProcessStartTime };
};

/**
 * True while the recorded session child (process-group leader) is still alive
 * under the stored start-time identity, or while its process group still has
 * members after the leader exited.
 */
export const sessionChildGroupAlive = (
  child: TSessionChildStopTarget,
): boolean => {
  if (!isSafePid(child.childPid)) return false;
  if (processAlive(child.childPid)) {
    if (child.childProcessStartTime !== undefined) {
      const live = readSessionHostProcessStartTime(child.childPid);
      if (live !== null) return live === child.childProcessStartTime;
      // Leader disappeared mid-check — fall through to the group probe.
    } else {
      return true;
    }
  }
  return processGroupExists(child.childPid);
};

/**
 * SIGTERM → grace → SIGKILL the detached session child's process group.
 * Returns true when the group is gone afterwards.
 */
export const terminateSessionChildGroup = async (
  child: TSessionChildStopTarget,
  graceMs?: number,
  finalReapMs?: number,
): Promise<boolean> => {
  if (!sessionChildGroupAlive(child)) return true;
  const stillOwned = (): boolean => sessionChildGroupAlive(child);
  const outcome = await terminateProcessGroup(
    child.childPid,
    graceMs,
    stillOwned,
    finalReapMs,
  );
  return outcome === "exited" || outcome === "terminated";
};

/**
 * Unpinned process start identity for durable session hosts. Must stay free of
 * LC_ALL/TZ overrides so it matches hosts written by prior releases.
 */
export const readSessionHostProcessStartTime = (pid: number): string | null => {
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

/** True when the host pid is live and its recorded start time still matches. */
export const sessionHostProcessAlive = (
  meta: Pick<TSessionHostStopTarget, "pid" | "processStartTime">,
): boolean => {
  const startTime = readSessionHostProcessStartTime(meta.pid);
  return startTime !== null && startTime === meta.processStartTime;
};

/** Await ms between stop polls without busy-waiting. */
const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop a standalone host through its private control socket.
 *
 * When the host-owned `ctl.sock` exists and the recorded pid is still alive,
 * dial the socket and send a kill close — the socket itself is the TOCTOU-safe
 * identity (start-time mismatch after an upgrade must not block this path).
 * Returns false when the socket is missing, the pid is gone, or dial fails.
 */
export const killSessionHostViaCtl = async (
  host: TSessionHostStopTarget,
): Promise<boolean> => {
  if (!existsSync(host.socketPath) || !processAlive(host.pid)) return false;

  const socketPath = host.socketPath;
  const pid = host.pid;
  // Post-close wait is zombie-aware pid liveness only — a start-time
  // mismatch must not keep this path waiting on a dead/zombie host.
  const alive = (): boolean => processAlive(pid);

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    /** Resolve the outer promise at most once. */
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(
        socketPath.startsWith("/") ? `ws+unix://${socketPath}` : socketPath,
      );
    } catch {
      settle(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      settle(!processAlive(pid));
    }, 2_000);

    ws.binaryType = "arraybuffer";
    ws.onopen = (): void => {
      if (!processAlive(pid)) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        settle(false);
        return;
      }
      ws.send(
        JSON.stringify({
          t: "open",
          open: {
            session_id: host.id,
            cli: host.cli,
            cols: 80,
            rows: 24,
            mode: "attach",
          },
        }),
      );
    };
    ws.onmessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { t?: unknown }).t !== "ctrl"
      ) {
        return;
      }
      const p = (parsed as { p?: { t?: unknown; ok?: unknown } }).p;
      if (p?.t !== "open_ack") return;
      if (p.ok !== true) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        settle(false);
        return;
      }
      ws.send(JSON.stringify({ t: "ctrl", p: { t: "close", intent: "kill" } }));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onerror = (): void => {
      clearTimeout(timer);
      settle(false);
    };
    ws.onclose = (): void => {
      clearTimeout(timer);
      void (async () => {
        for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
          await sleep(50);
          if (!alive()) {
            settle(true);
            return;
          }
        }
        settle(false);
      })();
    };
  });
};

/**
 * Prefer ctl.sock kill (PID TOCTOU-safe), then identity-checked SIGTERM →
 * SIGKILL. Used by uninstall so older daemons and socket-unreachable hosts
 * still get reaped.
 */
export const stopSessionHost = async (
  host: TSessionHostStopTarget,
): Promise<boolean> => {
  let hostGone = false;
  if (existsSync(host.socketPath) && processAlive(host.pid)) {
    if (await killSessionHostViaCtl(host)) hostGone = true;
  }
  if (!hostGone) {
    if (!sessionHostProcessAlive(host)) {
      hostGone = !processAlive(host.pid);
    } else {
      terminateOwnedPidSync(host.pid, () => sessionHostProcessAlive(host));
      hostGone = !sessionHostProcessAlive(host);
    }
  }
  if (host.childPid !== undefined && isSafePid(host.childPid)) {
    const child: TSessionChildStopTarget =
      host.childProcessStartTime === undefined
        ? { id: host.id, childPid: host.childPid }
        : {
            id: host.id,
            childPid: host.childPid,
            childProcessStartTime: host.childProcessStartTime,
          };
    const childGone = await terminateSessionChildGroup(child);
    return hostGone && childGone;
  }
  return hostGone;
};

/** Narrow unknown input to a known daemon-managed client id. */
const isDaemonCli = (value: unknown): value is TDaemonCli =>
  typeof value === "string" &&
  (DAEMON_CLIS as readonly string[]).includes(value);

/**
 * Count durable session hosts under `sessionsRoot` whose recorded pid is still
 * alive. Used by uninstall to snapshot before stopping the daemon — host
 * processes can exit with the daemon, which would otherwise make a later
 * stop pass report "none running".
 */
export const countLiveSessionHostsIn = (sessionsRoot: string): number => {
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(sessionsRoot, name, "meta.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const meta = parsed as Record<string, unknown>;
    if (
      typeof meta.pid !== "number" ||
      !Number.isInteger(meta.pid) ||
      meta.pid <= 0
    ) {
      continue;
    }
    if (processAlive(meta.pid)) live += 1;
  }
  return live;
};

/**
 * Scan `sessionsRoot` for recorded session children whose process group is
 * still alive. Used by uninstall so a detached child surviving its host
 * cannot be reported as a clean removal.
 */
export const listSurvivingSessionChildrenIn = (
  sessionsRoot: string,
): readonly TSessionChildStopTarget[] => {
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  const survivors: TSessionChildStopTarget[] = [];
  for (const name of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(sessionsRoot, name, "meta.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const id =
      typeof (parsed as { id?: unknown }).id === "string"
        ? (parsed as { id: string }).id
        : name;
    const child = readSessionChildStopTarget(
      id,
      parsed as Record<string, unknown>,
    );
    if (child !== null && sessionChildGroupAlive(child)) survivors.push(child);
  }
  return survivors;
};

/**
 * Stop every live durable session host under `sessionsRoot`. Prefers ctl.sock
 * when present and the pid is alive; falls back to unpinned start-time identity
 * for signals. Always reaps a recorded detached session-child process group,
 * including when the host is already dead. Exported for daemon uninstall (and
 * tests).
 */
export const stopLiveSessionHostsIn = async (
  sessionsRoot: string,
): Promise<number> => {
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  let stopped = 0;
  for (const name of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(sessionsRoot, name, "meta.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const meta = parsed as Record<string, unknown>;
    if (
      typeof meta.pid !== "number" ||
      !Number.isInteger(meta.pid) ||
      meta.pid <= 0 ||
      typeof meta.processStartTime !== "string" ||
      meta.processStartTime.length === 0
    ) {
      continue;
    }
    const pid = meta.pid;
    const start = meta.processStartTime;
    const socketPath = join(sessionsRoot, name, "ctl.sock");
    const cli = isDaemonCli(meta.cli) ? meta.cli : null;
    const id = typeof meta.id === "string" ? meta.id : name;
    const child = readSessionChildStopTarget(id, meta);
    let touched = false;

    // ctl.sock + live pid: try the host-owned kill even when start-time cannot
    // be confirmed yet (upgrade across pin changes). Need a known cli to attach.
    if (cli !== null && existsSync(socketPath) && processAlive(pid)) {
      const viaCtl = await killSessionHostViaCtl({
        id,
        cli,
        pid,
        processStartTime: start,
        socketPath,
      });
      if (viaCtl || !processAlive(pid)) {
        touched = true;
      }
    }

    /** True while the pid still carries the recorded unpinned start time. */
    const stillOwned = (): boolean => {
      const live = readSessionHostProcessStartTime(pid);
      return live !== null && live === start;
    };
    if (!touched && stillOwned()) {
      // Count as stopped once we have signalled an identity-checked pid —
      // processStartTime can still match a just-SIGTERM'd zombie briefly.
      // ctl.sock was already tried above; call terminateOwnedPidSync directly
      // instead of stopSessionHost (which would redial ctl.sock).
      terminateOwnedPidSync(pid, stillOwned);
      touched = true;
    }

    // Detached PTY children lead their own process group — killing the host
    // (ctl or signal) does not reap them. Always try the recorded child group,
    // including when the host row is already stale/dead.
    if (child !== null && sessionChildGroupAlive(child)) {
      await terminateSessionChildGroup(child);
      touched = true;
    }

    if (touched) stopped += 1;
  }
  return stopped;
};
