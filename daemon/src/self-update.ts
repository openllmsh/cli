/**
 * Daemon self-update.
 *
 * The daemon ships as a compiled binary at `process.execPath`, supervised by
 * launchd (`KeepAlive`) / systemd (`Restart=always`) — so EXITING relaunches it
 * within ~2s. On each cloud bootstrap the daemon learns the published version
 * (`latest_version`); when it differs from the compiled `DAEMON_VERSION` we
 * download the matching target binary, verify its SHA-256 against the published
 * checksum, atomically swap it in, wait for in-flight `/v1` requests to drain,
 * then exit so the supervisor relaunches the new binary.
 *
 * Policy: CONVERGE to the published version (update on any mismatch, not just
 * "newer") — the cloud is the source of truth, so republishing an older tag
 * rolls daemons back. See `docs/proposals/daemon-device-aware-this-machine.md`'s
 * sibling plan / the bootstrap `latest_version` field.
 *
 * Trust + safety: only managed compiled binaries self-update (a from-source dev
 * run reports `0.0.0-dev` and is skipped); the download is rejected unless its
 * SHA-256 matches the published digest (the same checksum the install script
 * verifies); the swap is atomic (same-dir temp + rename); and a persisted
 * attempt marker + cooldown bounds restart loops if a release is mis-published.
 */

import { createHash } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DAEMON_RELEASE } from "../manifest";
import type { TDaemonTarget } from "../release-types";
import { DAEMON_TARGETS } from "../release-types";
import { autoUpdateEnabled } from "./auto-update-pref";
import { drainDisposableChildren } from "./child-supervisor";
import { endDaemonApply, tryBeginDaemonApply } from "./delegation/login-flow";
import { daemonEnv } from "./env";
import { hardenMacBinary } from "./harden-binary";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import { recentlyAttempted, recordAttempt } from "./state-file";
import { DAEMON_VERSION } from "./version";

// Cap on how long we hold the restart waiting for `/v1` requests to drain.
const DRAIN_MAX_MS = 30_000;
const DRAIN_POLL_MS = 250;
// Abort a stalled binary/checksum download — without this a hung connection
// would leave `updating = true` for the rest of the process lifetime, blocking
// every later update attempt.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// ─── In-flight `/v1` request tracking (for wait-until-idle restart) ──────────
let inFlightCount = 0;
export const beginRequest = (): void => {
  inFlightCount += 1;
};
export const endRequest = (): void => {
  if (inFlightCount > 0) inFlightCount -= 1;
};
export const inFlight = (): number => inFlightCount;

/**
 * Wrap a streaming response body so `onDone` fires EXACTLY once when the stream
 * finishes — normal end, error, or client cancel. A `/v1` response body keeps
 * flowing after the fetch handler returns, so this is how the in-flight count
 * stays accurate for long streams (and the wait-until-idle restart actually
 * waits for them).
 */
export const trackBodyDone = (
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let settled = false;
  const finish = (): void => {
    if (!settled) {
      settled = true;
      onDone();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
};

/**
 * This host's release target (`darwin-arm64` / `darwin-x64-baseline` /
 * `linux-x64-baseline` / `linux-arm64`), or null if it isn't one we publish.
 * `process.arch` reports `arm64` / `x64`; x64 maps to the `-baseline` variant
 * (the single x64 release target).
 */
export const currentTarget = (): TDaemonTarget | null => {
  const arch =
    process.arch === "x64"
      ? "x64-baseline"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  if (arch === null) return null;
  const t = `${process.platform}-${arch}`;
  return (DAEMON_TARGETS as readonly string[]).includes(t)
    ? (t as TDaemonTarget)
    : null;
};

/** Shared by the daemon self-updater and the CLI converger (`cli-self-update.ts`). */
export const fetchBinary = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`binary download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // The published asset is gzipped (`openllmd-<target>.gz`); decompress when the
  // gzip magic bytes (0x1f 0x8b) are present, tolerating a raw binary too. The
  // sha256 is checked against the DECOMPRESSED bytes (what runs), so the gate is
  // gzip-determinism-independent.
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return Buffer.from(gunzipSync(buf));
  }
  return buf;
};

// The `.sha256` endpoint returns `"<hex>  openllmd-<target>\n"` — take the hex.
// Shared by the daemon self-updater and the CLI converger (`cli-self-update.ts`).
export const fetchDigest = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`checksum download failed: ${res.status}`);
  const text = (await res.text()).trim();
  const hex = text.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("checksum response was not a sha-256 digest");
  }
  return hex.toLowerCase();
};

const waitUntilIdle = async (): Promise<void> => {
  const deadline = Date.now() + DRAIN_MAX_MS;
  while (inFlight() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
};

// Re-entrancy guard: a bootstrap-refresh tick and a force-update command could
// both fire `maybeSelfUpdate`; only one swap+exit should run.
let updating = false;

/**
 * Exclusive apply lease for a daemon swap. `alreadyHeld` is the explicit
 * `update` command (scheduler apply lane). Passive/catch-up acquire here or
 * skip when auth/apply already owns the process. Successful `process.exit`
 * never reaches the release.
 */
export const withSelfUpdateApply = async (
  alreadyHeld: boolean,
  work: () => Promise<void>,
): Promise<void> => {
  const acquired = alreadyHeld ? false : tryBeginDaemonApply();
  if (!alreadyHeld && !acquired) return;
  try {
    await work();
  } finally {
    if (acquired) endDaemonApply();
  }
};

/**
 * Update to `latest` (the cloud's published version) when it differs from this
 * binary, then exit so the supervisor relaunches it. No-op (returns) when not
 * applicable — auto-update opted out, running from source, already converged,
 * unknown target, no release, or a recent failed attempt. Never throws into the
 * caller.
 *
 * Self-update is OPT-OUT (on by default): the automatic callers (boot + each
 * bootstrap tick) are gated on {@link autoUpdateEnabled}, which only returns
 * false once the user has explicitly disabled it. An EXPLICIT user request —
 * the dashboard's "update now" command — passes `force: true` to run the
 * convergence even when disabled. See `packages/cli/daemon/src/auto-update-pref.ts`.
 */
export const maybeSelfUpdate = async (
  latest: string | null,
  opts?: { readonly force?: boolean; readonly applyHeld?: boolean },
): Promise<void> => {
  if (updating) return;
  // Opt-out gate: skip automatic updates only when the user disabled them
  // (default on). A forced (explicit) check bypasses it — the user asked for
  // this one update.
  if (opts?.force !== true && !autoUpdateEnabled()) return;
  // Only managed compiled binaries self-update; a from-source run is `0.0.0-dev`.
  if (DAEMON_VERSION === "0.0.0-dev") return;
  if (latest === null || latest.length === 0) return;
  if (latest === DAEMON_VERSION) return; // already converged
  const target = currentTarget();
  if (target === null) {
    // No prebuilt binary for this arch — point at the source repo (build from
    // source / request the arch) via DAEMON_RELEASE.repo.
    logWarn(
      "self-update",
      `unsupported host ${process.platform}-${process.arch} — no prebuilt openllmd for this arch; see https://github.com/${DAEMON_RELEASE.repo}`,
    );
    return;
  }
  if (recentlyAttempted("daemon", latest)) return;

  await withSelfUpdateApply(opts?.applyHeld === true, async () => {
    updating = true;
    const dest = process.execPath;
    const tmp = join(dirname(dest), `.openllmd.update.${process.pid}.tmp`);
    try {
      const origin = daemonEnv().cloudOrigin;
      const base = `${origin}/api/daemon/binary/${target}`;
      const [bin, expected] = await Promise.all([
        fetchBinary(base),
        fetchDigest(`${base}.sha256`),
      ]);
      const actual = createHash("sha256").update(bin).digest("hex");
      if (actual !== expected) {
        logError(
          "self-update",
          safeDiagnosticMessage`checksum mismatch — refusing update`,
          {
            target,
            latest,
            expected,
            actual,
          },
        );
        updating = false;
        return;
      }
      writeFileSync(tmp, bin, { mode: 0o755 });
      chmodSync(tmp, 0o755); // force mode regardless of umask
      renameSync(tmp, dest); // atomic on POSIX; running process keeps old inode
      hardenMacBinary(dest); // dequarantine + ad-hoc sign so arm64 can exec it
      // Record only AFTER a successful swap — a transient download/rename failure
      // should retry on the next tick, but a swap that doesn't converge (the
      // relaunched binary still reports the old version) must back off.
      recordAttempt("daemon", latest);
      logInfo(
        "self-update",
        `updated ${DAEMON_VERSION} → ${latest}; restarting when idle`,
      );
      await waitUntilIdle();
      // The binary has already swapped; bounded cleanup must not prevent the exit
      // that lets launchd/systemd start the replacement daemon.
      await drainDisposableChildren();
      process.exit(0);
    } catch (err) {
      logError(
        "self-update",
        safeDiagnosticMessage`Daemon self-update apply failed.`,
        {
          target,
          latest,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      updating = false; // allow a retry on the next bootstrap tick
    }
  });
};
