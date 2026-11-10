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
import { processAlive, terminateOwnedPidSync } from "./child-supervisor/posix";

export type TSessionHostStopTarget = {
  readonly id: string;
  readonly cli: TDaemonCli;
  readonly pid: number;
  readonly processStartTime: string;
  readonly socketPath: string;
};

/**
 * Unpinned process start identity for durable session hosts. Must stay free of
 * LC_ALL/TZ overrides so it matches hosts written by prior releases.
 */
export const readSessionHostProcessStartTime = (
  pid: number,
): string | null => {
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
  if (existsSync(host.socketPath) && processAlive(host.pid)) {
    if (await killSessionHostViaCtl(host)) return true;
  }
  if (!sessionHostProcessAlive(host)) {
    return !processAlive(host.pid);
  }
  terminateOwnedPidSync(host.pid, () => sessionHostProcessAlive(host));
  return !sessionHostProcessAlive(host);
};

/** Narrow unknown input to a known daemon-managed client id. */
const isDaemonCli = (value: unknown): value is TDaemonCli =>
  typeof value === "string" &&
  (DAEMON_CLIS as readonly string[]).includes(value);

/**
 * Stop every live durable session host under `sessionsRoot`. Prefers ctl.sock
 * when present and the pid is alive; falls back to unpinned start-time identity
 * for signals. Exported for daemon uninstall (and tests).
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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
        stopped += 1;
        continue;
      }
    }

    /** True while the pid still carries the recorded unpinned start time. */
    const stillOwned = (): boolean => {
      const live = readSessionHostProcessStartTime(pid);
      return live !== null && live === start;
    };
    if (!stillOwned()) continue;

    // Count as stopped once we have signalled an identity-checked pid —
    // processStartTime can still match a just-SIGTERM'd zombie briefly.
    // ctl.sock was already tried above; call terminateOwnedPidSync directly
    // instead of stopSessionHost (which would redial ctl.sock).
    terminateOwnedPidSync(pid, stillOwned);
    stopped += 1;
  }
  return stopped;
};
