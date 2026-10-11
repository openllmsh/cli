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
import { daemonEnv, stateDir } from "./env";
import { hardenMacBinary } from "./harden-binary";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import {
  currentTarget,
  fetchBinary,
  fetchDigest,
  waitUntilIdle,
  withSelfUpdateApply,
} from "./self-update";
import { recentlyAttempted, recordAttempt } from "./state-file";
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

/** The daemon fingerprint baked into the binary at `path`, or null when it
 *  can't be read (a pre-merge binary has no `--fingerprint`). */
export const binaryFingerprint = async (
  path: string,
): Promise<string | null> => {
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
): Promise<boolean> => {
  const onDisk = await binaryFingerprint(path);
  if (onDisk === null) {
    logWarn(
      "update",
      "binary on disk reports no daemon fingerprint — not restarting onto it",
    );
    return false;
  }
  return onDisk !== running;
};

/** Download, verify and atomically install `version` at `dest`. Returns
 *  whether the file was replaced. Never throws. */
const swapBinary = async (
  dest: string,
  version: string,
  from: string,
): Promise<boolean> => {
  const target = currentTarget();
  if (target === null) {
    logWarn(
      "update",
      `unsupported host ${process.platform}-${process.arch} — no prebuilt openllm for this arch; build from source: https://github.com/openllmsh/cli#build-from-source`,
    );
    return false;
  }
  const tmp = join(dirname(dest), `.openllm.update.${process.pid}.tmp`);
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
        safeDiagnosticMessage`checksum mismatch — refusing update`,
        {
          target,
          version,
          expected,
          actual,
        },
      );
      return false;
    }
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755); // force mode regardless of umask
    // The file being replaced IS the daemon (the service execs it). Only ever
    // install a binary that carries a daemon half: a cloud still pinning a
    // pre-merge standalone CLI must not overwrite the daemon with it.
    if ((await binaryFingerprint(tmp)) === null) {
      logError(
        "update",
        safeDiagnosticMessage`downloaded binary has no daemon half — refusing update`,
        { target, version },
      );
      rmSync(tmp, { force: true });
      recordAttempt("cli", version); // back off; retrying won't change the bytes
      return false;
    }
    renameSync(tmp, dest); // atomic; the running daemon keeps its old inode
    hardenMacBinary(dest); // dequarantine + ad-hoc sign so arm64 can exec it
    // Record only AFTER a swap — a transient failure retries next tick, but a
    // swap that never converges (mis-publish) must back off.
    recordAttempt("cli", version);
    logInfo("update", `updated openllm ${from} → ${version}`);
    return true;
  } catch (err) {
    logError("update", safeDiagnosticMessage`Binary update apply failed.`, {
      target,
      version,
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

// One convergence at a time: a bootstrap tick, a CLI nudge and the dashboard's
// "update now" can all fire together.
let running = false;
// The binary's identity when the daemon last decided "no restart needed", so a
// tick only re-probes the fingerprint after the file actually changed.
let settledSignature: string | null = null;

export const resetUpdaterForTests = (): void => {
  running = false;
  settledSignature = null;
};

export type TConvergeOpts = {
  /** Explicit user request — bypasses the auto-update opt-out. */
  readonly force?: boolean;
  /** The caller already holds the apply lease (the `update` command lane). */
  readonly applyHeld?: boolean;
};

/** Seams for tests: the baked identity and the process exit. */
export type TConvergeDeps = {
  readonly version: string;
  readonly fingerprint: string;
  readonly exit: () => void;
};

const defaultDeps = (): TConvergeDeps => ({
  version: DAEMON_VERSION,
  fingerprint: DAEMON_FINGERPRINT,
  exit: () => process.exit(0),
});

/**
 * Converge the binary to `latest` (the cloud's pinned version), then restart
 * the daemon only if its code changed. Also handles a file someone ELSE
 * swapped (the CLI's launch check, the installer): a changed signature
 * triggers the same fingerprint comparison. No-op off a compiled build.
 */
export const convergeBinary = async (
  latest: string | null,
  opts: TConvergeOpts = {},
  deps: TConvergeDeps = defaultDeps(),
): Promise<void> => {
  if (running) return;
  if (deps.version === "0.0.0-dev") return;
  running = true;
  try {
    const dest = updateTarget();
    const wantSwap =
      (opts.force === true || autoUpdateEnabled()) &&
      latest !== null &&
      latest.length > 0 &&
      latest !== deps.version &&
      !recentlyAttempted("cli", latest);
    if (wantSwap) await swapBinary(dest, latest, deps.version);

    const signature = binarySignature(dest);
    if (signature === null || signature === settledSignature) return;
    if (!(await daemonCodeChanged(dest, deps.fingerprint))) {
      settledSignature = signature;
      return;
    }
    await withSelfUpdateApply(opts.applyHeld === true, async () => {
      logInfo("update", "daemon code changed on disk; restarting when idle");
      // Still busy past the drain window → defer, never cut work off. The
      // signature stays unsettled, so the next tick retries the restart.
      if (!(await waitUntilIdle())) {
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

const WATCH_INTERVAL_MS = 30_000;

/**
 * Notice a binary someone else swapped (the CLI's launch check, the installer)
 * between bootstrap ticks. A stat every {@link WATCH_INTERVAL_MS}; only a
 * changed signature runs the fingerprint probe. Unref'd so it never holds the
 * process open.
 */
export const watchBinary = (): void => {
  if (DAEMON_VERSION === "0.0.0-dev") return;
  let last = binarySignature(updateTarget());
  const timer = setInterval(() => {
    const now = binarySignature(updateTarget());
    if (now === last) return;
    last = now;
    void convergeBinary(null).catch((err) => logError("update", err));
  }, WATCH_INTERVAL_MS);
  timer.unref();
};
