/**
 * The single-binary updater. ONE file (`~/.openllm/bin/openllm`) is both the
 * CLI and the daemon, so there is one download + verify + swap, and a separate
 * decision about whether the RUNNING daemon must restart.
 *
 * Two triggers converge the binary to the cloud's pinned release:
 *  - the daemon's own bootstrap tick (so a machine whose CLI is never run still
 *    updates), and
 *  - the CLI at launch (`cli-update-check.ts`), which swaps the file and then
 *    nudges the daemon over loopback.
 *
 * Restart rule: the daemon restarts only when the binary on disk carries a
 * DIFFERENT daemon fingerprint than the one baked into this process
 * (`openllm daemon --fingerprint`, see `scripts/daemon-fingerprint.ts`). A
 * CLI-only release swaps the file and leaves the daemon running. A restart
 * waits until the daemon is idle — no in-flight `/v1` request and no login /
 * apply holding the lease — then drains disposable children and exits so
 * launchd/systemd relaunch the new code. Detached session hosts survive it.
 *
 * Trust + safety (unchanged from the two old updaters): only compiled binaries
 * update (`0.0.0-dev` skips); bytes are rejected unless their SHA-256 matches
 * the published digest; the swap is an atomic same-directory rename; a
 * persisted attempt marker bounds loops on a mis-published release.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { autoUpdateEnabled } from "./auto-update-pref";
import { binarySignature } from "./bin-signature";
import { drainDisposableChildren } from "./child-supervisor";
import type { TSafeDiagnosticMessage } from "./doctor-report/message";
import { daemonEnv, stateDir } from "./env";
import { hardenMacBinary } from "./harden-binary";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import type { TWaitUntilIdleOpts } from "./self-update";
import {
  currentTarget,
  fetchBinary,
  fetchDigest,
  waitUntilIdle,
  withSelfUpdateApply,
} from "./self-update";
import {
  clearUpdateFailure,
  recentlyAttempted,
  recordAttempt,
  recordUpdateFailure,
  updateBlocked,
} from "./state-file";
import { DAEMON_FINGERPRINT, DAEMON_VERSION } from "./version";

// NOTE: never import `../../manifest` here. The daemon half's code fingerprint
// covers everything it imports, and the manifest's pin changes every release —
// importing it would restart the daemon on every CLI-only update.

/** The installer-owned single binary. */
export const managedBinaryPath = (): string =>
  join(stateDir(), "bin", "openllm");

/** The binary the updater converges: the managed install when present, else
 *  the running file (a pre-migration `openllmd` boot). */
const updateTarget = (): string =>
  existsSync(managedBinaryPath()) ? managedBinaryPath() : process.execPath;

const PROBE_TIMEOUT_MS = 5_000;

export type TProbeFingerprint = (path: string) => Promise<string | null>;

export type TBinaryFingerprintOpts = {
  readonly probe?: TProbeFingerprint;
};

/** The daemon fingerprint baked into the binary at `path`, or null when it
 *  can't be read (a pre-merge binary has no `--fingerprint`). */
export const binaryFingerprint = async (
  path: string,
  opts: TBinaryFingerprintOpts = {},
): Promise<string | null> => {
  if (opts.probe !== undefined) return opts.probe(path);
  try {
    const proc = Bun.spawn([path, "daemon", "--fingerprint"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const value = out.trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
};

/** Whether the on-disk binary carries DIFFERENT daemon code than this
 *  process. A fingerprint that can't be read is NOT a change: that file is not
 *  a merged binary we can vouch for (a pre-merge CLI, a truncated write), and
 *  restarting the service onto it could crash-loop. Leave the running daemon
 *  alone; the next swap of a real binary re-probes. */
export const daemonCodeChanged = async (
  path: string,
  running: string = DAEMON_FINGERPRINT,
  opts: TBinaryFingerprintOpts = {},
): Promise<boolean> => {
  const onDisk = await binaryFingerprint(path, opts);
  if (onDisk === null) {
    logWarn(
      "update",
      "Binary on disk reports no daemon fingerprint; not restarting onto it.",
    );
    return false;
  }
  return onDisk !== running;
};

/** The step of a swap that threw: fetching bytes, writing the temp file, or
 *  renaming it over the installed binary. */
type TSwapStage = "download" | "write" | "install";

/** Filesystem errors that recur on every retry until the user acts. */
const PERMANENT_FS_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
]);

const errorCode = (err: unknown): string | null =>
  typeof err === "object" &&
  err !== null &&
  typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : null;

/**
 * Closed, sanitizer-safe message per failure class — the only part of a swap
 * failure that leaves the device, so it has to name the cause on its own.
 */
const swapFailureMessage = (
  stage: TSwapStage,
  code: string | null,
): TSafeDiagnosticMessage => {
  if (stage === "download")
    return safeDiagnosticMessage`Binary update download failed.`;
  if (code === "EACCES" || code === "EPERM")
    return safeDiagnosticMessage`Binary update failed: no permission to replace the installed binary.`;
  if (code === "EROFS")
    return safeDiagnosticMessage`Binary update failed: the install location is read-only.`;
  if (code === "ENOSPC" || code === "EDQUOT")
    return safeDiagnosticMessage`Binary update failed: the disk is full.`;
  return stage === "write"
    ? safeDiagnosticMessage`Binary update failed writing the new binary.`
    : safeDiagnosticMessage`Binary update failed installing the new binary.`;
};

type TSwapBinaryDeps = {
  readonly probeFingerprint: TProbeFingerprint;
  readonly harden: (path: string) => void;
};

/** Download, verify and atomically install `version` at `dest`. Returns
 *  whether the file was replaced. Never throws. */
const swapBinary = async (
  dest: string,
  version: string,
  from: string,
  deps: TSwapBinaryDeps,
): Promise<boolean> => {
  const target = currentTarget();
  if (target === null) {
    logWarn(
      "update",
      "Unsupported host architecture; no prebuilt binary for this arch.",
      {
        platform: process.platform,
        arch: process.arch,
        hint: "build from source: https://github.com/openllmsh/cli#build-from-source",
      },
    );
    return false;
  }
  const tmp = join(dirname(dest), `.openllm.update.${process.pid}.tmp`);
  let stage: TSwapStage = "download";
  try {
    const base = `${daemonEnv().cloudOrigin}/api/cli/binary/${target}`;
    const [bytes, expected] = await Promise.all([
      fetchBinary(base),
      fetchDigest(`${base}.sha256`),
    ]);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      logError(
        "update",
        safeDiagnosticMessage`Checksum mismatch; refusing update.`,
        {
          target,
          version,
          expected,
          actual,
        },
      );
      // Transient backoff: a corrupt download clears on retry, a mis-publish
      // keeps failing and the wait grows instead of re-downloading each tick.
      recordUpdateFailure("cli", version, false);
      return false;
    }
    stage = "write";
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755); // force mode regardless of umask
    // The file being replaced IS the daemon (the service execs it). Only ever
    // install a binary that carries a daemon half: a cloud still pinning a
    // pre-merge standalone CLI must not overwrite the daemon with it.
    if ((await deps.probeFingerprint(tmp)) === null) {
      logError(
        "update",
        safeDiagnosticMessage`Downloaded binary has no daemon half; refusing update.`,
        { target, version },
      );
      rmSync(tmp, { force: true });
      recordAttempt("cli", version); // back off; retrying won't change the bytes
      return false;
    }
    stage = "install";
    renameSync(tmp, dest); // atomic; the running daemon keeps its old inode
    deps.harden(dest); // dequarantine + ad-hoc sign so arm64 can exec it
    // A swap that never converges (mis-publish) must back off too.
    recordAttempt("cli", version);
    clearUpdateFailure("cli");
    logInfo("update", `updated openllm ${from} → ${version}`);
    return true;
  } catch (err) {
    // Every failure backs off: a permanent one (the user must fix the install)
    // waits a day, a transient one doubles its wait per repeat. Without this
    // a failing device re-downloaded the whole binary on every tick.
    const code = errorCode(err);
    const permanent =
      stage !== "download" && PERMANENT_FS_CODES.has(code ?? "");
    recordUpdateFailure("cli", version, permanent);
    logError("update", swapFailureMessage(stage, code), {
      target,
      version,
      stage,
      code,
      permanent,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    return false;
  }
};

export type TConvergeOpts = {
  /** Explicit user request — bypasses the auto-update opt-out. */
  readonly force?: boolean;
  /** The caller already holds the apply lease (the `update` command lane). */
  readonly applyHeld?: boolean;
};

/** Collaborators for a converge pass — production defaults when omitted. */
export type TConvergeDeps = {
  readonly version: string;
  readonly fingerprint: string;
  readonly exit: () => void;
  /** Override the on-disk fingerprint probe (defaults to spawning the binary). */
  readonly probeFingerprint?: TProbeFingerprint;
  /** Override macOS harden (defaults to `hardenMacBinary`). */
  readonly harden?: (path: string) => void;
  /** Override idle-drain timing / clock / sleep for the restart wait. */
  readonly idleWait?: TWaitUntilIdleOpts;
  /**
   * Idle wait implementation. Defaults to the process-wide
   * {@link waitUntilIdle}; tests pass a tracker-bound wait so begin/end
   * and the drain share one counter.
   */
  readonly waitUntilIdle?: (opts?: TWaitUntilIdleOpts) => Promise<boolean>;
};

const defaultDeps = (): TConvergeDeps => ({
  version: DAEMON_VERSION,
  fingerprint: DAEMON_FINGERPRINT,
  exit: () => process.exit(0),
});

export type TBinaryUpdater = {
  readonly convergeBinary: (
    latest: string | null,
    opts?: TConvergeOpts,
    deps?: TConvergeDeps,
  ) => Promise<void>;
  readonly watchBinary: () => void;
};

/**
 * Binary converge + file-watch loop with its own running/settled latch.
 * Production uses {@link binaryUpdater}; tests build a fresh instance so
 * latch state never leaks across cases.
 */
export const createBinaryUpdater = (): TBinaryUpdater => {
  // One convergence at a time: a bootstrap tick, a CLI nudge and the
  // dashboard's "update now" can all fire together.
  let running = false;
  // The binary's identity when the daemon last decided "no restart needed",
  // so a tick only re-probes the fingerprint after the file actually changed.
  let settledSignature: string | null = null;

  const convergeBinary = async (
    latest: string | null,
    opts: TConvergeOpts = {},
    deps: TConvergeDeps = defaultDeps(),
  ): Promise<void> => {
    if (running) return;
    if (deps.version === "0.0.0-dev") return;
    running = true;
    try {
      const probeFingerprint: TProbeFingerprint =
        deps.probeFingerprint ?? ((path) => binaryFingerprint(path));
      const harden = deps.harden ?? hardenMacBinary;
      const idle = deps.waitUntilIdle ?? waitUntilIdle;
      const dest = updateTarget();
      const wantSwap =
        (opts.force === true || autoUpdateEnabled()) &&
        latest !== null &&
        latest.length > 0 &&
        latest !== deps.version &&
        !recentlyAttempted("cli", latest) &&
        // An explicit "update now" retries past a failure's backoff.
        (opts.force === true || !updateBlocked("cli", latest));
      if (wantSwap) {
        await swapBinary(dest, latest, deps.version, {
          probeFingerprint,
          harden,
        });
      }

      const signature = binarySignature(dest);
      if (signature === null || signature === settledSignature) return;
      if (
        !(await daemonCodeChanged(dest, deps.fingerprint, {
          probe: probeFingerprint,
        }))
      ) {
        settledSignature = signature;
        return;
      }
      await withSelfUpdateApply(opts.applyHeld === true, async () => {
        logInfo("update", "daemon code changed on disk; restarting when idle");
        // Still busy past the drain window → defer, never cut work off. The
        // signature stays unsettled, so the next tick retries the restart.
        if (!(await idle(deps.idleWait))) {
          logInfo("update", "daemon busy; restart deferred to the next check");
          return;
        }
        // The new binary is in place; bounded cleanup must not block the exit
        // that lets launchd/systemd start the replacement daemon.
        await drainDisposableChildren();
        deps.exit();
      });
    } finally {
      running = false;
    }
  };

  /**
   * Formerly a 30s signature poll. Coalesced into the bootstrap tick
   * (`main.ts` → `convergeBinary(latestCliVersion())`) so idle hosts do not
   * pay an extra ~120 wakeups/hour (audit §5). Kept as a no-op export so
   * callers / tests that still invoke it stay safe.
   */
  const watchBinary = (): void => {
    // no-op — bootstrap loop owns binary convergence
  };

  return { convergeBinary, watchBinary };
};

/** Process-wide updater used by the daemon. */
export const binaryUpdater = createBinaryUpdater();

/**
 * Converge the binary to `latest` (the cloud's pinned version), then restart
 * the daemon only if its code changed. Also handles a file someone ELSE
 * swapped (the CLI's launch check, the installer): a changed signature
 * triggers the same fingerprint comparison. No-op off a compiled build.
 */
export const convergeBinary = (
  latest: string | null,
  opts?: TConvergeOpts,
  deps?: TConvergeDeps,
): Promise<void> => binaryUpdater.convergeBinary(latest, opts, deps);

export const watchBinary = (): void => {
  binaryUpdater.watchBinary();
};
