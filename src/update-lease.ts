/**
 * The ONE cross-process lease on replacing the `openllm` binary.
 *
 * Five things can swap `~/.openllm/bin/openllm`: the daemon's auto-update
 * (`daemon/src/updater.ts`), the CLI's launch check and `openllm self-update`
 * (`self-update.ts`), the installer (`install.sh`, which `openllm update` and
 * the desktop app run) and the desktop app's Update. Each used to guard only
 * itself, so two could download and rename over the same file at once, or a
 * daemon restart could land mid-swap.
 *
 * The lease is a file next to the binary, `<bin dir>/.update.lock`, created
 * with `O_EXCL` — the same lock-file shape as the env-file lock, which the
 * installer can take from bash with `set -C` (no `flock` on fresh installs).
 * Its body is the update's progress: who holds it, the version it installs,
 * the phase, and download bytes. The holder rewrites it (tmp + rename) as it
 * goes, which doubles as a heartbeat; readers — the daemon's `/status`, the
 * desktop app — show it, and anyone else who wants to update backs off.
 *
 * A holder that died leaves the file behind: it is stale once its pid is gone
 * or its heartbeat is older than {@link UPDATE_LEASE_STALE_MS}, and the next
 * acquirer takes it over. Release removes the file only while it still names
 * the releasing pid, so a takeover is never undone by the old holder.
 *
 * Node built-ins only: the CLI half imports this, and so does the daemon.
 * The wire shape is mirrored by `DaemonUpdateState` in
 * `packages/protocol/daemon.ts` and by the desktop app's reader
 * (`packages/native/src-tauri/src/update_lease.rs`); a parity test pins all
 * three to this file.
 */
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Who is updating. `app` is the desktop app (it runs the installer). */
export const UPDATE_SOURCES = ["daemon", "cli", "installer", "app"] as const;
export type TUpdateSource = (typeof UPDATE_SOURCES)[number];

/** Where the update is. `restart` is the daemon about to exit into the new binary. */
export const UPDATE_PHASES = [
  "download",
  "verify",
  "install",
  "restart",
] as const;
export type TUpdatePhase = (typeof UPDATE_PHASES)[number];

/** The lease file's body — also what `/status` and the desktop app report. */
export type TUpdateLease = {
  readonly pid: number;
  readonly source: TUpdateSource;
  /** The version being installed, when the holder knows it. */
  readonly version: string | null;
  readonly phase: TUpdatePhase;
  /** Download bytes so far / expected; null outside `download` or when unknown. */
  readonly received: number | null;
  readonly total: number | null;
  readonly started_at: number;
  /** Last write by the holder — the heartbeat staleness is judged by. */
  readonly updated_at: number;
};

/**
 * A heartbeat this old means the holder hung. Long enough for a slow ~120 MB
 * download whose holder only writes on phase changes (the installer).
 */
export const UPDATE_LEASE_STALE_MS = 15 * 60 * 1000;

/** Minimum gap between two download-progress writes. */
export const UPDATE_PROGRESS_INTERVAL_MS = 250;

export const UPDATE_LOCK_NAME = ".update.lock";

/** The lease file guarding `binaryPath`. */
export const updateLockPath = (binaryPath: string): string =>
  join(dirname(binaryPath), UPDATE_LOCK_NAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** Parse a lease body; null when it isn't one (half-written, garbage). */
export const parseUpdateLease = (raw: string): TUpdateLease | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { pid, source, version, phase, received, total } = value;
  const startedAt = value.started_at;
  const updatedAt = value.updated_at;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (!(UPDATE_SOURCES as readonly unknown[]).includes(source)) return null;
  if (!(UPDATE_PHASES as readonly unknown[]).includes(phase)) return null;
  if (version !== null && typeof version !== "string") return null;
  if (!isCount(received) || !isCount(total)) return null;
  if (typeof startedAt !== "number" || typeof updatedAt !== "number") {
    return null;
  }
  return {
    pid,
    source: source as TUpdateSource,
    version,
    phase: phase as TUpdatePhase,
    received,
    total,
    started_at: startedAt,
    updated_at: updatedAt,
  };
};

/** Whether `pid` is a live process (EPERM still means it exists). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type TUpdateLeaseDeps = {
  readonly now?: () => number;
  readonly pidAlive?: (pid: number) => boolean;
  readonly pid?: number;
};

/** A lease whose holder is gone or silent. Unparseable bodies count as stale. */
export const isStaleUpdateLease = (
  lease: TUpdateLease | null,
  deps: TUpdateLeaseDeps = {},
): boolean => {
  if (lease === null) return true;
  const now = (deps.now ?? Date.now)();
  if (now - lease.updated_at > UPDATE_LEASE_STALE_MS) return true;
  return !(deps.pidAlive ?? pidAlive)(lease.pid);
};

const readRaw = (lockPath: string): string | null => {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
};

/**
 * The update in progress for `binaryPath`, or null when none is — a missing,
 * unparseable or stale lease reads as null. Never throws.
 */
export const readUpdateLease = (
  binaryPath: string,
  deps: TUpdateLeaseDeps = {},
): TUpdateLease | null => {
  const raw = readRaw(updateLockPath(binaryPath));
  if (raw === null) return null;
  const lease = parseUpdateLease(raw);
  return isStaleUpdateLease(lease, deps) ? null : lease;
};

export type TUpdateLeaseHandle = {
  /** Record the phase (and download bytes). Download writes are throttled. */
  readonly progress: (
    phase: TUpdatePhase,
    bytes?: { readonly received: number; readonly total: number | null },
  ) => void;
  /** Drop the lease. Idempotent; leaves a lease another process took alone. */
  readonly release: () => void;
};

export type TAcquireUpdateLeaseResult =
  | { readonly ok: true; readonly lease: TUpdateLeaseHandle }
  | {
      readonly ok: false;
      /** The live holder, or null when the lock couldn't be read or made. */
      readonly holder: TUpdateLease | null;
    };

const createExclusive = (lockPath: string, body: string): boolean => {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return true;
};

/**
 * Take the lease for replacing `binaryPath`, or report who holds it. A stale
 * lease is taken over once; a live one is never waited on — background
 * updaters skip, explicit ones tell the user.
 */
export const tryAcquireUpdateLease = (
  binaryPath: string,
  init: { readonly source: TUpdateSource; readonly version: string | null },
  deps: TUpdateLeaseDeps = {},
): TAcquireUpdateLeaseResult => {
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const lockPath = updateLockPath(binaryPath);
  const startedAt = now();
  let current: TUpdateLease = {
    pid,
    source: init.source,
    version: init.version,
    phase: "download",
    received: null,
    total: null,
    started_at: startedAt,
    updated_at: startedAt,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createExclusive(lockPath, JSON.stringify(current))) break;
    const raw = readRaw(lockPath);
    // Gone between the failed create and the read: try again.
    if (raw === null) continue;
    const holder = parseUpdateLease(raw);
    if (!isStaleUpdateLease(holder, deps)) return { ok: false, holder };
    // Stale: remove it only if it is still the same stale body, then retry.
    if (readRaw(lockPath) === raw) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else took it over first; the retry decides.
      }
    }
    if (attempt === 1) return { ok: false, holder: null };
  }
  if (!ownsLock(lockPath, pid)) return { ok: false, holder: null };

  let released = false;
  let lastWrite = Number.NEGATIVE_INFINITY;
  const write = (): void => {
    if (released || !ownsLock(lockPath, pid)) return;
    const tmp = `${lockPath}.${pid}.tmp`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(current));
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, lockPath);
    } catch {
      rmSync(tmp, { force: true });
    }
  };

  return {
    ok: true,
    lease: {
      progress: (phase, bytes) => {
        const at = now();
        const samePhase = phase === current.phase;
        // Download bytes arrive per chunk: throttle those, never a phase change.
        if (
          samePhase &&
          bytes !== undefined &&
          at - lastWrite < UPDATE_PROGRESS_INTERVAL_MS
        ) {
          return;
        }
        current = {
          ...current,
          phase,
          received: bytes?.received ?? null,
          total: bytes?.total ?? null,
          updated_at: at,
        };
        lastWrite = at;
        write();
      },
      release: () => {
        if (released) return;
        released = true;
        if (!ownsLock(lockPath, pid)) return;
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      },
    },
  };
};

const ownsLock = (lockPath: string, pid: number): boolean => {
  const raw = readRaw(lockPath);
  return raw !== null && parseUpdateLease(raw)?.pid === pid;
};

/** "openllm is being updated by the desktop app (downloading 42%)". */
export const describeUpdateLease = (lease: TUpdateLease): string => {
  const by =
    lease.source === "daemon"
      ? "the OpenLLM daemon"
      : lease.source === "app"
        ? "the OpenLLM desktop app"
        : lease.source === "installer"
          ? "the installer"
          : "another openllm command";
  const pct =
    lease.phase === "download" &&
    lease.received !== null &&
    lease.total !== null &&
    lease.total > 0
      ? ` ${Math.min(100, Math.floor((lease.received / lease.total) * 100))}%`
      : "";
  const step =
    lease.phase === "download"
      ? `downloading${pct}`
      : lease.phase === "verify"
        ? "verifying"
        : lease.phase === "install"
          ? "installing"
          : "restarting";
  const to = lease.version === null ? "" : ` to v${lease.version}`;
  return `openllm is being updated${to} by ${by} (${step})`;
};
