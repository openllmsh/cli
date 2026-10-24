/**
 * Durable session-host discovery and spawn client.
 *
 * The daemon never opens a session unix socket itself — the CLI owns that
 * path. Spawn launches the detached `__session-host` sibling (same binary)
 * so the host is ready before a client dials it locally.
 */

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TDeviceSessionCli } from "@openllmsh/protocol";
import { DeviceSessionCli, SESSION_ID_PATTERN } from "@openllmsh/protocol";
import { Schema as S } from "effect";
import { daemonSelfInvocation } from "../child-supervisor/self-exec";
import type { TDeadlineBudget } from "../deadline-budget";
import {
  budgetFromSignal,
  createDeadlineBudget,
  firstOfBudget,
} from "../deadline-budget";
import { stateDir } from "../env";
import { withoutCommandReplayContext } from "../op-context";
import type { TSessionHostMeta } from "./main";

const DEFAULT_SPAWN_SOCKET_TIMEOUT_MS = 2_000;
const PROCESS_IDENTITY_TIMEOUT_MS = 250;
const DISCOVERY_CONCURRENCY = 4;
/**
 * Outer bound for one registry scan (and attach-path slot wait). Per-pid checks
 * stay at {@link PROCESS_IDENTITY_TIMEOUT_MS}; this caps N slow probes so status
 * and boot cannot wait N/concurrency waves. Shared with boot reconcile — the
 * scan honors the budget (no abandoned post-expiry reap).
 */
const DISCOVERY_TIMEOUT_MS = 1_000;
const DEFAULT_SPAWN_SOCKET_POLL_MS = 25;

export type TLiveSessionHost = TSessionHostMeta & {
  readonly socketPath: string;
};

export type TSpawnSessionHostProc = {
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly title?: string;
  readonly dangerous?: boolean;
  readonly resume?: string;
  readonly vendorArgs?: readonly string[];
};

export type TProcessIdentity = "alive" | "dead" | "unknown";

export type TProcessIdentityReader = (
  meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
  budget: TDeadlineBudget,
) => Promise<TProcessIdentity>;

type TSpawnSessionHostProcFn = (
  args: TSpawnSessionHostProc,
) => Promise<string | null>;

export type TSessionHostClientDeps = {
  readonly discoveryTimeoutMs?: number;
  readonly processIdentityTimeoutMs?: number;
  readonly spawnSocketPollMs?: number;
  readonly spawnSocketTimeoutMs?: number;
  readonly readProcessIdentity?: TProcessIdentityReader;
  readonly spawnSessionHostProc?: TSpawnSessionHostProcFn;
};

export type TSessionHostClient = {
  readonly discoverSessionHosts: () => Promise<readonly TLiveSessionHost[]>;
  readonly spawnSessionHostProc: (
    args: TSpawnSessionHostProc,
  ) => Promise<string | null>;
};

const isCli: (value: unknown) => value is TDeviceSessionCli =
  S.is(DeviceSessionCli);

const sessionHostsRoot = (): string => join(stateDir(), "sessions");
const sessionHostDir = (id: string): string => join(sessionHostsRoot(), id);
const sessionHostSocketPath = (id: string): string =>
  join(sessionHostDir(id), "ctl.sock");

const isSessionHostMeta = (value: unknown): value is TSessionHostMeta => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    SESSION_ID_PATTERN.test(meta.id) &&
    isCli(meta.cli) &&
    typeof meta.cwd === "string" &&
    meta.cwd.length > 0 &&
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

/**
 * Bounded async `lstart` read. `undefined` means the deadline expired or the
 * helper could not be observed — never treat that as a dead pid.
 */
const readProcessStartTime = async (
  pid: number,
  budget: TDeadlineBudget,
): Promise<string | null | undefined> => {
  if (budget.expired()) return undefined;
  try {
    const proc = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const raced = await firstOfBudget(
      budget,
      Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
        ([out, code]) => ({ out, code }),
      ),
    );
    if (raced.kind === "expired") {
      try {
        proc.kill();
      } catch {
        // The helper may already have exited.
      }
      return undefined;
    }
    if (raced.value.code !== 0) return null;
    const value = raced.value.out.trim();
    return value.length > 0 ? value : null;
  } catch {
    return undefined;
  }
};

const defaultProcessIdentity: TProcessIdentityReader = async (meta, budget) => {
  const startTime = await readProcessStartTime(meta.pid, budget);
  if (startTime === undefined) return "unknown";
  if (startTime === null) return "dead";
  return startTime === meta.processStartTime ? "alive" : "dead";
};

const forEachLimited = async <T>(
  values: readonly T[],
  limit: number,
  visit: (value: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> => {
  if (values.length === 0) return;
  const maxConcurrency = Math.max(1, Math.min(limit, values.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: maxConcurrency }, async () => {
      for (;;) {
        if (shouldStop?.()) return;
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        await visit(values[index] as T);
      }
    }),
  );
};

const socketPresent = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

type TDiscoveryCandidate = {
  readonly id: string;
  readonly directory: string;
  readonly socketPath: string;
  readonly meta: TSessionHostMeta;
  readonly socketReady: boolean;
};

const reapSessionHostDir = (directory: string): void => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A concurrently exiting host owns final cleanup.
  }
};

type TDiscoveryOutcome = {
  readonly hosts: readonly TLiveSessionHost[];
  readonly complete: boolean;
};

const daemonBinary = (): readonly string[] => {
  // The detached session host is what actually owns the PTY and spawns the
  // openllm CLI. Re-exec THIS daemon's own code: the source runner in dev (so
  // dev overrides apply and the host can't protocol-skew the source daemon),
  // otherwise the running binary itself — the single `openllm` binary routes
  // `__session-host` to the daemon under either install name.
  return daemonSelfInvocation();
};

const buildSessionHostClient = (
  deps: TSessionHostClientDeps = {},
): TSessionHostClient => {
  const discoveryTimeoutMs = deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const processIdentityTimeoutMs =
    deps.processIdentityTimeoutMs ?? PROCESS_IDENTITY_TIMEOUT_MS;
  const spawnSocketPollMs =
    deps.spawnSocketPollMs ?? DEFAULT_SPAWN_SOCKET_POLL_MS;
  const spawnSocketTimeoutMs =
    deps.spawnSocketTimeoutMs ?? DEFAULT_SPAWN_SOCKET_TIMEOUT_MS;
  const processIdentityReader =
    deps.readProcessIdentity ?? defaultProcessIdentity;
  const spawnOverride = deps.spawnSessionHostProc;

  type TProbeWaiter = {
    granted: boolean;
    settle: (granted: boolean) => void;
  };

  let probeActive = 0;
  const probeWaiters: TProbeWaiter[] = [];
  let discoveryInFlight: Promise<TDiscoveryOutcome> | null = null;
  let lastKnownLiveHosts: readonly TLiveSessionHost[] = [];

  const acquireProbeSlot = async (
    budget: TDeadlineBudget,
  ): Promise<boolean> => {
    if (budget.expired()) return false;
    if (probeActive < DISCOVERY_CONCURRENCY) {
      probeActive += 1;
      return true;
    }
    const waiter: TProbeWaiter = {
      granted: false,
      settle: () => {},
    };
    const slot = new Promise<boolean>((resolve) => {
      let settled = false;
      waiter.settle = (granted) => {
        if (settled) return;
        settled = true;
        waiter.granted = granted;
        resolve(granted);
      };
      probeWaiters.push(waiter);
    });
    const waited = await firstOfBudget(budget, slot);
    if (waited.kind === "value") {
      if (!waited.value || budget.expired()) {
        if (waited.value) releaseProbeSlot();
        return false;
      }
      return true;
    }
    // Expired won the race. If release already granted this waiter (shifted it
    // off the queue), the slot is held until we give it back.
    const index = probeWaiters.indexOf(waiter);
    if (index >= 0) {
      probeWaiters.splice(index, 1);
      return false;
    }
    releaseProbeSlot();
    return false;
  };

  const releaseProbeSlot = (): void => {
    const next = probeWaiters.shift();
    if (next !== undefined) {
      next.granted = true;
      next.settle(true);
      return;
    }
    probeActive = Math.max(0, probeActive - 1);
  };

  const sessionHostProcessIdentity = async (
    meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
    parent?: AbortSignal,
  ): Promise<TProcessIdentity> => {
    const budget = createDeadlineBudget(processIdentityTimeoutMs, parent);
    return processIdentityReader(meta, budget);
  };

  const boundedProcessIdentity = async (
    meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
    parent: AbortSignal,
  ): Promise<TProcessIdentity> => {
    const budget = budgetFromSignal(parent) ?? createDeadlineBudget(0, parent);
    const acquired = await acquireProbeSlot(budget);
    if (!acquired) return "unknown";
    try {
      if (parent.aborted) return "unknown";
      return await sessionHostProcessIdentity(meta, parent);
    } finally {
      releaseProbeSlot();
    }
  };

  const readSessionHostMeta = (id: string): TSessionHostMeta | null => {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const directory = sessionHostDir(id);
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(directory, "meta.json"), "utf8"),
      );
      return isSessionHostMeta(parsed) && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  };

  const liveHostIfAttachable = (
    meta: TSessionHostMeta,
    identity: TProcessIdentity,
    socketPath: string,
    socketReady: boolean,
  ): TLiveSessionHost | null => {
    if (!socketReady) return null;
    if (identity === "dead") return null;
    return { ...meta, socketPath };
  };

  const discoverSessionHostsOnce = async (): Promise<TDiscoveryOutcome> => {
    const budget = createDeadlineBudget(discoveryTimeoutMs);
    let entries: string[];
    try {
      entries = readdirSync(sessionHostsRoot());
    } catch {
      lastKnownLiveHosts = [];
      return { hosts: lastKnownLiveHosts, complete: true };
    }
    const candidates: TDiscoveryCandidate[] = [];
    for (const id of entries) {
      if (!SESSION_ID_PATTERN.test(id)) continue;
      const directory = sessionHostDir(id);
      const socketPath = sessionHostSocketPath(id);
      const meta = readSessionHostMeta(id);
      if (meta === null) {
        reapSessionHostDir(directory);
        continue;
      }
      candidates.push({
        id,
        directory,
        socketPath,
        meta,
        socketReady: socketPresent(socketPath),
      });
    }

    const hosts: TLiveSessionHost[] = [];
    await forEachLimited(
      candidates,
      DISCOVERY_CONCURRENCY,
      async (candidate) => {
        if (budget.expired()) return;
        const identity = await boundedProcessIdentity(
          candidate.meta,
          budget.signal,
        );
        if (budget.expired()) return;
        if (identity === "unknown") {
          // Uncertainty never authorizes deletion. Surface a socket-ready host so
          // attach/status keep the session; otherwise leave the directory.
          const host = liveHostIfAttachable(
            candidate.meta,
            identity,
            candidate.socketPath,
            candidate.socketReady,
          );
          if (host !== null) hosts.push(host);
          return;
        }
        if (identity === "dead") {
          reapSessionHostDir(candidate.directory);
          return;
        }
        // Alive process: never reap. A missing socket is not attachable yet
        // (bind lag or a later recreate); keep the registry until the socket
        // appears or identity later proves dead.
        const host = liveHostIfAttachable(
          candidate.meta,
          identity,
          candidate.socketPath,
          candidate.socketReady,
        );
        if (host !== null) hosts.push(host);
      },
      () => budget.expired(),
    );
    if (budget.expired()) {
      return { hosts: lastKnownLiveHosts, complete: false };
    }
    lastKnownLiveHosts = hosts.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return { hosts: lastKnownLiveHosts, complete: true };
  };

  const discoverSessionHostOutcome = async (): Promise<TDiscoveryOutcome> => {
    if (discoveryInFlight !== null) return discoveryInFlight;
    const run = withoutCommandReplayContext(discoverSessionHostsOnce);
    discoveryInFlight = run;
    void run.finally(() => {
      if (discoveryInFlight === run) discoveryInFlight = null;
    });
    return run;
  };

  const discoverSessionHosts = async (): Promise<readonly TLiveSessionHost[]> =>
    (await discoverSessionHostOutcome()).hosts;

  const waitForSessionHostSocket = async (
    id: string,
  ): Promise<string | null> => {
    const socketPath = sessionHostSocketPath(id);
    const deadline = Date.now() + spawnSocketTimeoutMs;
    // timeoutMs=0: one existence check, no sleep (hermetic fail-fast).
    if (spawnSocketTimeoutMs <= 0) {
      return socketPresent(socketPath) ? socketPath : null;
    }
    while (Date.now() < deadline) {
      if (socketPresent(socketPath)) return socketPath;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, spawnSocketPollMs),
      );
    }
    return socketPresent(socketPath) ? socketPath : null;
  };

  const spawnSessionHostProcDefault = async (
    args: TSpawnSessionHostProc,
  ): Promise<string | null> => {
    if (!SESSION_ID_PATTERN.test(args.id)) return null;
    const argv = [
      "__session-host",
      "--id",
      args.id,
      "--cli",
      args.cli,
      ...(args.cwd === undefined ? [] : ["--cwd", args.cwd]),
      ...(args.title === undefined ? [] : ["--title", args.title]),
      ...(args.dangerous === true ? ["--dangerous"] : []),
      ...(args.resume === undefined ? [] : ["--resume", args.resume]),
      ...(args.vendorArgs ?? []).flatMap((arg) => ["--vendor-arg", arg]),
      "--cols",
      String(args.cols),
      "--rows",
      String(args.rows),
    ];
    try {
      const proc = Bun.spawn([...daemonBinary(), ...argv], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.unref();
    } catch {
      return null;
    }
    return waitForSessionHostSocket(args.id);
  };

  /** Spawn a detached sibling session host and wait for its private control socket. */
  const spawnSessionHostProc = async (
    args: TSpawnSessionHostProc,
  ): Promise<string | null> => {
    if (spawnOverride !== undefined) return spawnOverride(args);
    return spawnSessionHostProcDefault(args);
  };

  return {
    discoverSessionHosts,
    spawnSessionHostProc,
  };
};

/**
 * Build a session-host client. Pure: returns an independent instance (its own
 * in-flight discovery, probe slots and last-known hosts) and installs nothing.
 * The module exports below use {@link defaultSessionHostClient}.
 */
export const createSessionHostClient = (
  deps: TSessionHostClientDeps = {},
): TSessionHostClient => buildSessionHostClient(deps);

/** The process's session-host client, built once from production defaults. */
export const defaultSessionHostClient: TSessionHostClient =
  buildSessionHostClient();

/** Scan, validate, and reap stale durable session-host registry entries. */
export const discoverSessionHosts = async (): Promise<
  readonly TLiveSessionHost[]
> => defaultSessionHostClient.discoverSessionHosts();

/** Spawn a detached sibling session host and wait for its private control socket. */
export const spawnSessionHostProc = async (
  args: TSpawnSessionHostProc,
): Promise<string | null> =>
  defaultSessionHostClient.spawnSessionHostProc(args);
