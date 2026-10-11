/**
 * CLI (`openllm`) converger — the daemon keeps the INSTALLED CLI binary on
 * the cloud's pinned release, on the same auto-update tick and under the same
 * opt-out toggle as its own self-update (`self-update.ts`). One flow, one
 * toggle: disabling daemon auto-update pins the CLI too.
 *
 * Same converge-to-published policy (update on ANY mismatch, so republishing
 * an older tag rolls CLIs back) and the same trust gates (SHA-256 of the
 * decompressed bytes against the published digest; atomic same-dir temp +
 * rename swap; darwin dequarantine + ad-hoc sign). Differences from the
 * daemon's own updater:
 *
 *   - No drain / no restart — the CLI is not this process; the swap is just a
 *     file replace. A running `openllm` keeps its old inode (POSIX rename).
 *   - The daemon NEVER installs the CLI — an absent binary at
 *     `~/.openllm/bin/openllm` (or the legacy `openllmc` path) is a skip, mirroring the vendor-CLI policy in
 *     `cli-install.ts`. Manual `openllm self-update` also still works; both
 *     paths write verified bytes via distinct pid-suffixed temps, so a race is
 *     last-writer-wins with a complete binary either way.
 *   - Its own attempt SLOT (`cli`) in the shared `state.json` so a daemon
 *     attempt never masks a CLI attempt (or vice versa).
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { autoUpdateEnabled } from "./auto-update-pref";
import { invalidateMatchingCliVersionOutput } from "./cli-version-cache";
import { cliVersion } from "./delegation/spawn";
import { daemonEnv, stateDir } from "./env";
import { hardenMacBinary } from "./harden-binary";
import { logError, logInfo, logWarn, safeDiagnosticMessage } from "./logger";
import { currentTarget, fetchBinary, fetchDigest } from "./self-update";
import { recentlyAttempted, recordAttempt } from "./state-file";

/** Where the install script places the CLI (`~/.openllm/bin/openllm`). */
export const cliBinaryPath = (): string => join(stateDir(), "bin", "openllm");

/** Pre-rename install location (`~/.openllm/bin/openllmc`) — still converged
 *  (and migrated to the new name) so existing machines pick up the renamed
 *  binary through auto-update alone. */
export const legacyCliBinaryPath = (): string =>
  join(stateDir(), "bin", "openllmc");

/**
 * DEV-ONLY override: an absolute path to a runnable `openllm` the daemon should
 * spawn/probe INSTEAD of the installed binary. Set by `scripts/dev.ts` (a shim
 * that execs the working-tree CLI source) so browser-triggered sessions run
 * this repo's CLI, not the shipped `~/.openllm/bin/openllm`. Unset in
 * production — `resolveOpenllmCli` then falls back to the installed paths, so
 * prod behaviour is unchanged. The self-update convergers deliberately do NOT
 * consult this (they must always converge the real installed binary).
 */
export const cliBinaryOverride = (): string | null => {
  const p = process.env.OPENLLM_CLI_PATH;
  return p !== undefined && p.length > 0 && existsSync(p) ? p : null;
};

/**
 * Resolve the `openllm` CLI the daemon should run: the dev override first (when
 * present + existing), then the installed binary (current name, then legacy).
 * Null when none exist. This is the ONE resolver every spawn/attach/probe site
 * shares so dev and prod never drift.
 */
export const resolveOpenllmCli = (): string | null =>
  cliBinaryOverride() ??
  [cliBinaryPath(), legacyCliBinaryPath()].find(existsSync) ??
  null;

/**
 * The installed CLI's version via the shared stamp-keyed `cliVersion` cache
 * (output `openllm vX.Y.Z`; legacy binaries print `openllmc vX.Y.Z`). Null
 * when the binary is absent, won't run, or prints something unparseable —
 * the converger then leaves it alone. Shares in-flight work with
 * `device-state`; an unchanged binary is not re-spawned.
 */
const parseProductCliVersion = (out: string | null): string | null =>
  out?.match(/openllmc? v(\S+)/)?.[1] ?? null;

const installedCliVersion = async (
  bin: string,
  opts?: { readonly reprobeUnknown?: boolean },
): Promise<string | null> => {
  const versionOpts =
    opts?.reprobeUnknown === true ? { reprobe: true } : undefined;
  const out = await cliVersion(bin, undefined, versionOpts);
  const parsed = parseProductCliVersion(out);
  if (parsed !== null) return parsed;
  if (opts?.reprobeUnknown !== true) return null;
  if (out === null) return null;
  if (!invalidateMatchingCliVersionOutput(bin, out)) return null;
  const again = await cliVersion(bin, undefined, { reprobe: true });
  return parseProductCliVersion(again);
};

// Re-entrancy guard: a bootstrap tick and a forced dashboard update could both
// fire `maybeUpdateCli`; only one download+swap should run. Independent of the
// daemon updater's flag — the two converge different files and may overlap.
let updating = false;

/**
 * Converge the installed `openllm` CLI to `latest` (the cloud's published CLI
 * version) when it differs. No-op (returns) when not applicable — auto-update
 * opted out, CLI not installed, dev-linked binary, already converged, unknown
 * target, no release, or a recent attempt. Never throws into the caller.
 *
 * Gated on the SAME preference as the daemon's self-update
 * ({@link autoUpdateEnabled}); an explicit user request (the dashboard's
 * "update now" command) passes `force: true` to bypass it.
 */
export type TMaybeUpdateCliOpts = {
  readonly force?: boolean;
  /**
   * Explicit `update` only. Bypass a process-local miss / invalidate one
   * unparseable product observation and allow a single recovery probe.
   * Not `force` (preference override). Bootstrap, periodic ticks, status
   * readers, and auto-update-enable catch-up must omit this.
   */
  readonly reprobeUnknown?: boolean;
};

export const maybeUpdateCli = async (
  latest: string | null,
  opts?: TMaybeUpdateCliOpts,
): Promise<void> => {
  if (updating) return;
  if (opts?.force !== true && !autoUpdateEnabled()) return;
  if (latest === null || latest.length === 0) return;
  let bin = cliBinaryPath();
  // Rename migration: a machine installed before the openllmc → openllm
  // rename has only the legacy path. Converge THAT file — the swap below
  // writes the renamed binary to the NEW path and leaves a compat symlink.
  const legacy = legacyCliBinaryPath();
  const legacyOnly = !existsSync(bin) && existsSync(legacy);
  if (legacyOnly) bin = legacy;
  // The daemon never installs the CLI — absent means skip, not install.
  if (!existsSync(bin)) return;
  const current = await installedCliVersion(bin, {
    reprobeUnknown: opts?.reprobeUnknown === true,
  });
  if (current === null) {
    logWarn(
      "cli-update",
      safeDiagnosticMessage`installed openllm CLI did not report a version — skipping`,
    );
    return;
  }
  // A from-source dev link never auto-updates (same guard as both updaters).
  if (current === "0.0.0-dev") return;
  if (current === latest) return; // already converged
  const target = currentTarget();
  if (target === null) {
    // No prebuilt binary for this arch — the openllm CLI repo README documents
    // building the host binary (`bun run compile:host`).
    logWarn(
      "cli-update",
      `unsupported host ${process.platform}-${process.arch} — no prebuilt openllm CLI for this arch; build from source: https://github.com/openllmsh/cli#build-from-source`,
    );
    return;
  }
  if (recentlyAttempted("cli", latest)) return;

  updating = true;
  const dest = cliBinaryPath(); // always land on the NEW name
  const tmp = join(dirname(dest), `.openllm.update.${process.pid}.tmp`);
  try {
    const origin = daemonEnv().cloudOrigin;
    const base = `${origin}/api/cli/binary/${target}`;
    const [bytes, expected] = await Promise.all([
      fetchBinary(base),
      fetchDigest(`${base}.sha256`),
    ]);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      logError(
        "cli-update",
        safeDiagnosticMessage`checksum mismatch — refusing update`,
        {
          target,
          latest,
          expected,
          actual,
        },
      );
      return;
    }
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755); // force mode regardless of umask
    renameSync(tmp, dest); // atomic on POSIX; a running CLI keeps its inode
    hardenMacBinary(dest); // dequarantine + ad-hoc sign so arm64 can exec it
    if (legacyOnly) {
      // Replace the old binary file with a transitional symlink so
      // absolute-path callers (old MCP entries, hooks) keep working.
      try {
        rmSync(legacy, { force: true });
        symlinkSync(dest, legacy);
      } catch {
        // best-effort — the new path is authoritative either way
      }
    }
    // Record only AFTER a successful swap — a transient download failure should
    // retry on the next tick, but a swap that doesn't converge (mis-publish)
    // must back off.
    recordAttempt("cli", latest);
    logInfo("cli-update", `updated openllm CLI ${current} → ${latest}`);
  } catch (err) {
    logError(
      "cli-update",
      safeDiagnosticMessage`CLI self-update apply failed.`,
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
  } finally {
    updating = false; // no exit path here — always allow the next attempt
  }
};
