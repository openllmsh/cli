/**
 * Self-update — converge the installed binary to the gateway's pinned CLI
 * release, the `openllm` twin of the daemon's converge policy:
 *
 *   - `openllm self-update` fetches `GET /api/cli/version` (the committed
 *     manifest tag the gateway serves), compares with the baked
 *     `CLI_VERSION`, and on ANY difference (upgrade or rollback) downloads
 *     `GET /api/cli/binary/<target>` (302 → gzipped release asset), verifies
 *     the DECOMPRESSED bytes against `<target>.sha256`, and atomically
 *     swaps itself via same-directory rename.
 *   - `0.0.0-dev` source builds never self-update (dev guard).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  acquireUpdateLock,
  updateLockDirFor,
} from "@openllmsh/protocol/update-lock";
import type { TUpdateRouteConfig } from "@openllmsh/protocol/update-policy";
import {
  evaluateUpdatePolicy,
  mayReplaceProductVersion,
} from "@openllmsh/protocol/update-policy";
import { CLI_RELEASE } from "../manifest";
import { CLI_TARGETS } from "../release-types";
import { CLI_VERSION, cliConfig, cliUpdateRoute, daemonStateDir } from "./env";

const FETCH_TIMEOUT_MS = 30_000;
/**
 * Hard cap on a downloaded artifact (compressed AND decompressed), mirroring
 * the daemon's self-updater — refuse a hostile/corrupt endpoint before it
 * fills memory.
 */
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
/** Cap on the small `.sha256` digest body. */
const DIGEST_MAX_BYTES = 4_096;
/** Bounds on the pre-swap `<binary> --self-test` health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const HEALTH_PROBE_MAX_BYTES = 4_096;
/** How long a manual update waits on the shared swap lock before giving up. */
const UPDATE_LOCK_WAIT_MS = 30_000;

/** This host's release target suffix (`<os>-<arch>`), or null when the
 *  platform/arch isn't one we publish. `process.arch` reports `arm64` / `x64`;
 *  x64 maps to the `-baseline` variant (the single x64 release target).
 *  Windows is rejected BEFORE the canonical mapping even though `win32-x64` is
 *  a published install target: self-update swaps the running binary via a
 *  same-directory rename, which Windows forbids for a running executable —
 *  matching the daemon's `selfUpdateTargetForHost` (Windows self-update is
 *  unavailable during Phase 2; install a current package instead). The result
 *  is checked against `CLI_TARGETS` so any other unsupported OS (e.g. freebsd)
 *  returns null too — matching `hostTarget()` in `scripts/verify.ts` — letting
 *  the caller fail with a clear message instead of 404ing on a bogus target. */
export const targetSuffix = (
  platform: string = process.platform,
  architecture: string = process.arch,
): string | null => {
  if (platform === "win32") return null;
  const arch =
    architecture === "x64"
      ? "x64-baseline"
      : architecture === "arm64"
        ? "arm64"
        : null;
  if (arch === null) return null;
  const t = `${platform}-${arch}`;
  return (CLI_TARGETS as readonly string[]).includes(t) ? t : null;
};

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Remove quarantine and preserve a valid signature, or ad-hoc sign on macOS. */
export const hardenCliBinary = (
  path: string,
  platform: NodeJS.Platform = process.platform,
): void => {
  if (platform !== "darwin") return;
  try {
    Bun.spawnSync(["xattr", "-dr", "com.apple.quarantine", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // No quarantine attribute or xattr unavailable.
  }
  try {
    const verification = Bun.spawnSync(["codesign", "--verify", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (verification.exitCode === 0) return;
  } catch {
    // Missing or invalid signature; attempt an ad-hoc signature below.
  }
  try {
    Bun.spawnSync(["codesign", "--force", "--sign", "-", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Best effort, matching daemon self-update hardening behavior.
  }
};

export const prepareUpdatedCliBinary = (
  path: string,
  platform: NodeJS.Platform = process.platform,
  harden: (
    binaryPath: string,
    targetPlatform: NodeJS.Platform,
  ) => void = hardenCliBinary,
): void => {
  fs.chmodSync(path, 0o755);
  harden(path, platform);
};

export const mayUpdateCliVersion = (
  currentVersion: string,
  latestVersion: string | null,
  route: TUpdateRouteConfig,
): boolean =>
  mayReplaceProductVersion({ currentVersion, latestVersion, ...route });

/** Self-update downloads + swaps the running binary — the origin must be
 *  HTTPS (plain HTTP only for loopback dev gateways), or a network MITM
 *  could serve both the binary AND the checksum it's verified against. */
export const isSecureOrigin = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

/**
 * A download-stage failure carrying a content-derived discriminator for the
 * artifact that failed (`artifactKey` = sha256 of the bytes actually seen) —
 * used as the rejection key when the advertised digest isn't what failed, so
 * a corrected re-publish of the same version is allowed through.
 */
export class ArtifactFetchError extends Error {
  readonly artifactKey?: string;

  constructor(message: string, artifactKey?: string) {
    super(message);
    this.artifactKey = artifactKey;
  }
}

/**
 * Stream a response body with a hard byte cap — count while reading so an
 * oversized payload is rejected BEFORE it is fully buffered (content-length
 * is an early hint only; a lying endpoint is still caught by the count).
 */
const readBodyCapped = async (
  res: Response,
  maxBytes: number,
  label: string,
): Promise<Buffer> => {
  // Hash whatever arrives so an oversize rejection is keyed to the exact
  // bytes that failed (a corrected re-publish yields a different prefix).
  const keyHash = createHash("sha256");
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      // best-effort abort
    }
    throw new ArtifactFetchError(`${label} exceeds the ${maxBytes}-byte cap`);
  }
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    keyHash.update(value);
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort abort
      }
      throw new ArtifactFetchError(
        `${label} exceeds the ${maxBytes}-byte cap`,
        keyHash.digest("hex"),
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/** The manual remedy printed on a refused update — one clear line. */
const manualRemedy = (gatewayUrl: string): string =>
  `to update manually, re-run the installer: curl -fsSL ${gatewayUrl}/install | bash`;

/**
 * Pre-swap health probe (TCB-3): run the staged binary's `--self-test` — NOT
 * `--version`, which exits before the lazy command graph loads and therefore
 * can't catch a binary that crashes on every real command — with a bounded
 * timeout and bounded output, and require it to report the version we
 * intended to install. Returns the parsed version (or null when the binary
 * won't exec, fails the self-test, or reports nothing parseable). Exported
 * for tests.
 */
export const probeCliHealth = (
  path: string,
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): string | null => {
  try {
    const proc = spawn([path, "--self-test"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: HEALTH_PROBE_TIMEOUT_MS,
      maxBuffer: HEALTH_PROBE_MAX_BYTES,
    });
    if (proc.exitCode !== 0) return null;
    const out = Buffer.concat([proc.stdout, proc.stderr])
      .toString("utf-8")
      .slice(0, HEALTH_PROBE_MAX_BYTES);
    return out.match(/openllmc? v(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

// ── Daemon state-file markers ────────────────────────────────────────────────
// `<stateDir>/state.json` is owned by the daemon (`packages/daemon/src/
// state-file.ts`), but a manual update MUST write the same markers the
// converger does: `updateAttempts.cli` is what lets the daemon's recovery
// path restore `.prev` and pin a bad version rejected when the CLI we just
// installed won't run, and `rejectedUpdates.cli` keeps a deterministic
// failure from being retried forever. Only these two fields are touched —
// every other top-level key is passed through untouched (read-modify-write
// with a pid-suffixed temp + rename, same atomicity contract as the daemon).
// The marker write happens under the swap lock, so it can't interleave with
// the converger's own mutation of the same fields.

/** Mirror of the daemon's first-failure backoff delay (its 15-minute base). */
const CLI_ATTEMPT_RETRY_AFTER_MS = 15 * 60 * 1000;
/** Bound on the per-slot rejected list, matching `REJECTED_UPDATES_MAX`. */
const REJECTED_MAX = 16;

type TJsonObject = Record<string, unknown>;

/** A rejection entry as stored in `rejectedUpdates.<slot>` (round-3 shape). */
type TCliRejectedUpdate = {
  readonly version: string;
  /** Artifact sha256, or `""` for legacy/artifact-unknown rejects (wildcard). */
  readonly digest: string;
};

const daemonStateFilePath = (): string => join(daemonStateDir(), "state.json");

/**
 * Fail-closed suspension (round-3): a state dir lands here the moment ANY
 * `state.json` write fails. While listed, this process refuses to update —
 * an unpersisted reject means another process can retry the same bad
 * artifact, so joining the churn is unsafe. Cleared by the next successful
 * write probe (a transient full-disk window self-heals).
 */
const suspendedStateDirs = new Set<string>();

/**
 * Exported for tests. While suspended, probes a real write — the first
 * success lifts the suspension (mirrors the daemon's `autoUpdateSuspended`).
 */
export const updateStateSuspended = (): boolean => {
  const dir = daemonStateDir();
  if (!suspendedStateDirs.has(dir)) return false;
  if (mutateDaemonState((s) => s)) {
    suspendedStateDirs.delete(dir);
    return false;
  }
  return true;
};

/**
 * Process-local rejection mirror per state dir — a reject that could not be
 * persisted still blocks THIS artifact for the rest of the process (the
 * persisted record protects other processes). Keyed `"<version>\0<digest>"`.
 */
const memoryRejectedByDir = new Map<string, Set<string>>();

const memoryRejectedFor = (dir: string): Set<string> => {
  const existing = memoryRejectedByDir.get(dir);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  memoryRejectedByDir.set(dir, created);
  return created;
};

const rejectedMemoryKey = (version: string, digest: string): string =>
  `${version}${digest}`;

/** Read-modify-write `state.json` atomically. Best-effort: false on any error. */
const mutateDaemonState = (fn: (s: TJsonObject) => TJsonObject): boolean => {
  const path = daemonStateFilePath();
  const tmp = join(dirname(path), `.state.json.${process.pid}.tmp`);
  try {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
    } catch {
      parsed = {};
    }
    const base: TJsonObject =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as TJsonObject)
        : {};
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(fn(base)), { mode: 0o600 });
    fs.renameSync(tmp, path);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    return false;
  }
};

/**
 * Prove `state.json` is writable BEFORE downloading anything: if the safety
 * state cannot be persisted, a deterministic-failure reject would protect
 * nobody — fail closed and refuse the update entirely.
 */
const probeUpdateStateWritable = (): boolean => {
  const dir = daemonStateDir();
  const ok = mutateDaemonState((s) => s);
  if (ok) suspendedStateDirs.delete(dir);
  else suspendedStateDirs.add(dir);
  return ok;
};

const isJsonObject = (v: unknown): v is TJsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const coerceRejectionEntry = (v: unknown): TCliRejectedUpdate | null => {
  // Legacy entries were bare version strings — treat as artifact-unknown
  // rejects (blank digest = wildcard, still blocks the version outright).
  if (typeof v === "string")
    return v.length > 0 ? { version: v, digest: "" } : null;
  if (
    isJsonObject(v) &&
    typeof v.version === "string" &&
    v.version.length > 0
  ) {
    return {
      version: v.version,
      digest: typeof v.digest === "string" ? v.digest : "",
    };
  }
  return null;
};

/**
 * Read the CLI slot's rejection list from `state.json`, understanding both
 * the per-slot `{daemon:[], cli:[]}` shape and the legacy flat string array
 * (product-ambiguous — applies to the CLI too).
 */
const readCliRejections = (): TCliRejectedUpdate[] => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(daemonStateFilePath(), "utf-8"),
    );
    if (!isJsonObject(parsed)) return [];
    const raw = parsed.rejectedUpdates;
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : isJsonObject(raw) && Array.isArray(raw.cli)
        ? raw.cli
        : [];
    return list
      .map(coerceRejectionEntry)
      .filter((e): e is TCliRejectedUpdate => e !== null);
  } catch {
    return [];
  }
};

/**
 * True when `(version, digest)` is rejected — an exact digest entry blocks
 * that artifact only; a blank-digest entry blocks every artifact of the
 * version. A digest-less query matches only blank-digest entries (a
 * version-only pre-check must not hide a corrected re-publish).
 */
export const isCliUpdateRejected = (
  version: string,
  digest?: string,
): boolean => {
  const memory = memoryRejectedFor(daemonStateDir());
  if (
    memory.has(rejectedMemoryKey(version, digest ?? "")) ||
    (digest !== undefined && memory.has(rejectedMemoryKey(version, "")))
  ) {
    return true;
  }
  return readCliRejections().some(
    (e) =>
      e.version === version &&
      (e.digest === "" || (digest !== undefined && e.digest === digest)),
  );
};

/**
 * Record `updateAttempts.cli` — the SAME shape the daemon's `recordAttempt`
 * writes — so a manual update is visible to the daemon's recovery path and
 * its `recentlyAttempted` backoff gate. `digest` is the artifact sha256 the
 * attempt ran against (omitted when unknown).
 */
export const recordCliUpdateAttempt = (
  version: string,
  digest?: string,
): void => {
  const ok = mutateDaemonState((s) => {
    const attempts = isJsonObject(s.updateAttempts) ? s.updateAttempts : {};
    const prev = isJsonObject(attempts.cli) ? attempts.cli : {};
    const failures =
      (prev.version === version && typeof prev.failures === "number"
        ? prev.failures
        : 0) + 1;
    return {
      ...s,
      updateAttempts: {
        ...attempts,
        cli: {
          version,
          ts: Date.now(),
          failures,
          retryAfterMs: CLI_ATTEMPT_RETRY_AFTER_MS,
          ...(digest !== undefined && digest.length > 0 ? { digest } : {}),
        },
      },
    };
  });
  if (!ok) suspendedStateDirs.add(daemonStateDir());
};

/**
 * Pin `(version, digest)` rejected for the CLI slot — written for the same
 * reason the daemon rejects: a deterministic artifact failure or a failed
 * health probe can never heal by re-downloading the same bytes. `digest` is
 * the advertised artifact sha256 when known; a content-derived key (sha256 of
 * the bytes that failed) when the advertised digest itself was unreadable; or
 * `""` for an artifact-unknown reject. A corrected re-publish of the same
 * version advertises a different digest and is allowed. The reject lands in
 * the process-local mirror BEFORE persistence so a failed write still blocks
 * this artifact for the rest of the process (fail closed).
 */
export const rejectCliUpdateVersion = (
  version: string,
  digest: string = "",
): boolean => {
  const dir = daemonStateDir();
  memoryRejectedFor(dir).add(rejectedMemoryKey(version, digest));
  const ok = mutateDaemonState((s) => {
    const raw = s.rejectedUpdates;
    const base: TJsonObject = Array.isArray(raw)
      ? // Legacy flat list was product-ambiguous — carry it on both slots.
        {
          daemon: raw.map(coerceRejectionEntry).filter((e) => e !== null),
          cli: raw.map(coerceRejectionEntry).filter((e) => e !== null),
        }
      : isJsonObject(raw)
        ? raw
        : {};
    const cli: TCliRejectedUpdate[] = (Array.isArray(base.cli) ? base.cli : [])
      .map(coerceRejectionEntry)
      .filter((e): e is TCliRejectedUpdate => e !== null);
    const ix = cli.findIndex(
      (e) => e.version === version && e.digest === digest,
    );
    if (ix !== -1) cli.splice(ix, 1);
    // Refresh to the tail so the CURRENTLY advertised bad artifact is the
    // last eviction candidate — it is never silently evicted.
    cli.push({ version, digest });
    return {
      ...s,
      rejectedUpdates: { ...base, cli: cli.slice(-REJECTED_MAX) },
    };
  });
  if (!ok) suspendedStateDirs.add(dir);
  return ok;
};

/** Test-only: drop every in-memory fallback record. Never called in production. */
export const clearCliUpdateGuardsForTests = (): void => {
  memoryRejectedByDir.clear();
  suspendedStateDirs.clear();
};

// ── Atomic swap ──────────────────────────────────────────────────────────────

/**
 * Write `<self>.prev` ATOMICALLY (temp + fsync + rename, mode-preserving) —
 * the rollback copy the daemon's self-heal restores if the new binary won't
 * run. A torn `.prev` (power loss, disk-full mid-copy) is worse than none:
 * the restore path now probes it before swapping it back.
 */
const writePrevBinaryAtomic = (src: string, prev: string): void => {
  const tmp = `${prev}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, prev);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }
};

export type TCliSwapOutcome =
  | "updated"
  | "probe-failed"
  | "backup-failed"
  | "busy";

/**
 * The serialized swap region for a verified staged binary: acquire the shared
 * cross-process lock (same dir the daemon converger uses), health-probe the
 * staged binary, atomically back the current binary up to `.prev` (FAIL
 * CLOSED — no backup, no swap), rename it in, and record the attempt marker.
 * Exported for tests; `runSelfUpdate` maps the outcome to messages + codes.
 */
export const commitCliSwap = async (args: {
  /** The running binary's path (`process.execPath`). */
  readonly self: string;
  /** The downloaded+verified staged binary to swap in. */
  readonly staged: string;
  readonly latest: string;
  readonly digest?: string;
  readonly probe?: (path: string) => string | null;
  readonly lockWaitMs?: number;
}): Promise<TCliSwapOutcome> => {
  const release = await acquireUpdateLock(updateLockDirFor(args.self), {
    waitMs: args.lockWaitMs ?? UPDATE_LOCK_WAIT_MS,
  });
  if (release === null) return "busy";
  try {
    if ((args.probe ?? probeCliHealth)(args.staged) !== args.latest) {
      return "probe-failed";
    }
    try {
      writePrevBinaryAtomic(args.self, `${args.self}.prev`);
    } catch {
      return "backup-failed";
    }
    fs.renameSync(args.staged, args.self);
    recordCliUpdateAttempt(args.latest, args.digest);
    return "updated";
  } finally {
    release();
  }
};

export const runSelfUpdate = async (): Promise<void> => {
  if (CLI_VERSION === "0.0.0-dev") {
    process.stderr.write(
      "[self-update] dev build (0.0.0-dev) never self-updates\n",
    );
    process.exit(0);
  }
  const { gatewayUrl } = cliConfig();
  if (!isSecureOrigin(gatewayUrl)) {
    process.stderr.write(
      `[self-update] refusing to update over an insecure origin (${gatewayUrl}) — use https:// (http:// is allowed only for localhost)\n`,
    );
    process.exit(1);
  }

  const vRes = await fetch(`${gatewayUrl}/api/cli/version`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!vRes.ok) {
    process.stderr.write(
      `[self-update] version check failed: HTTP ${vRes.status}\n`,
    );
    process.exit(1);
  }
  const payload = (await vRes.json().catch(() => null)) as {
    latest_version?: unknown;
  } | null;
  if (payload === null || typeof payload.latest_version !== "string") {
    process.stderr.write(
      "[self-update] malformed version response (no latest_version string)\n",
    );
    process.exit(1);
  }
  const latest = payload.latest_version.replace(/^v/, "");
  if (latest.length === 0) {
    process.stderr.write("[self-update] no CLI release published yet\n");
    process.exit(1);
  }
  if (latest === CLI_VERSION) {
    process.stdout.write(`openllm v${CLI_VERSION} is up to date\n`);
    process.exit(0);
  }
  const route = cliUpdateRoute();
  const verdict = evaluateUpdatePolicy({
    currentVersion: CLI_VERSION,
    latestVersion: latest,
    ...route,
  });
  if (!verdict.allow) {
    process.stderr.write(
      `[self-update] refusing ${CLI_VERSION} → ${latest}: ${verdict.reason ?? "update policy"} — ${manualRemedy(gatewayUrl)}\n`,
    );
    process.exit(1);
  }
  // Fail closed (round-3): if the safety state cannot be persisted, a
  // deterministic-failure reject protects nobody — another process would
  // retry the same bad artifact. Refuse rather than join the churn.
  if (!probeUpdateStateWritable()) {
    process.stderr.write(
      "[self-update] update state is not writable — refusing to update without a persistent rejection guard\n",
    );
    process.exit(1);
  }

  const target = targetSuffix();
  if (target === null && process.platform === "win32") {
    // win32-x64 IS published, but a running Windows executable cannot be
    // renamed over, so in-place self-update is unavailable.
    process.stderr.write(
      "[self-update] in-place self-update is unavailable on Windows — install the current package instead.\n",
    );
    process.exit(1);
  }
  if (target === null) {
    // No prebuilt binary for this arch — point at the source repo, whose
    // README documents building the host binary (`bun run compile:host`).
    process.stderr.write(
      `[self-update] unsupported host ${process.platform}/${process.arch} — no prebuilt openllm for this arch.\n` +
        `  Build from source: https://github.com/${CLI_RELEASE.repo}#build-from-source\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[self-update] v${CLI_VERSION} → v${latest} (${target})\n`,
  );

  const shaRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}.sha256`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!shaRes.ok) {
    process.stderr.write(
      `[self-update] checksum fetch failed: ${shaRes.status}\n`,
    );
    process.exit(1);
  }
  // The tiny digest fetch comes FIRST: the advertised artifact sha256 is the
  // rejection key, so it must be known before the ~40 MB binary download is
  // spent on an artifact already proven bad.
  let digestBody: string;
  try {
    digestBody = (
      await readBodyCapped(shaRes, DIGEST_MAX_BYTES, "checksum download")
    )
      .toString("utf-8")
      .trim();
  } catch (err) {
    const key =
      err instanceof ArtifactFetchError ? (err.artifactKey ?? "") : "";
    rejectCliUpdateVersion(latest, key);
    recordCliUpdateAttempt(latest, key.length > 0 ? key : undefined);
    process.stderr.write(
      `[self-update] ${err instanceof Error ? err.message : String(err)} — aborting\n`,
    );
    process.exit(1);
  }
  const expected = (digestBody.split(/\s+/)[0] ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    // Key the reject to sha256 of the BAD BODY — a corrected re-publish
    // serves a valid digest, hashes differently, and is allowed through.
    const key = createHash("sha256").update(digestBody).digest("hex");
    rejectCliUpdateVersion(latest, key);
    recordCliUpdateAttempt(latest, key);
    process.stderr.write(
      "[self-update] checksum response was not a sha-256 digest — aborting\n",
    );
    process.exit(1);
  }
  if (isCliUpdateRejected(latest, expected)) {
    // This exact advertised artifact already failed deterministic checks on
    // this host — a corrected re-publish advertises a different digest.
    recordCliUpdateAttempt(latest, expected);
    process.stderr.write(
      `[self-update] v${latest} (artifact ${expected.slice(0, 12)}…) previously failed verification on this host — refusing to retry; ${manualRemedy(gatewayUrl)}\n`,
    );
    process.exit(1);
  }

  const binRes = await fetch(`${gatewayUrl}/api/cli/binary/${target}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!binRes.ok) {
    process.stderr.write(`[self-update] download failed: ${binRes.status}\n`);
    process.exit(1);
  }
  let bytes: Buffer;
  try {
    bytes = await readBodyCapped(binRes, MAX_BINARY_BYTES, "binary download");
  } catch (err) {
    rejectCliUpdateVersion(latest, expected);
    recordCliUpdateAttempt(latest, expected);
    process.stderr.write(
      `[self-update] ${err instanceof Error ? err.message : String(err)} — aborting\n`,
    );
    process.exit(1);
  }
  // `maxOutputLength` bounds a gzip bomb the same way the wire cap bounds the
  // compressed payload.
  if (bytes.subarray(0, 2).equals(GZIP_MAGIC)) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: MAX_BINARY_BYTES });
    } catch (err) {
      rejectCliUpdateVersion(latest, expected);
      recordCliUpdateAttempt(latest, expected);
      process.stderr.write(
        `[self-update] decompress failed: ${err instanceof Error ? err.message : String(err)} — aborting\n`,
      );
      process.exit(1);
    }
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    // A checksum mismatch is a mis-published artifact — deterministic, so the
    // artifact is pinned rejected (the daemon converger won't retry it either).
    rejectCliUpdateVersion(latest, expected);
    recordCliUpdateAttempt(latest, expected);
    process.stderr.write(
      `[self-update] checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — aborting\n`,
    );
    process.exit(1);
  }

  // Atomic same-directory swap: write next to the running binary, chmod,
  // rename over. The running process keeps its inode; the next invocation
  // picks up the new binary.
  const self = process.execPath;
  const staging = join(dirname(self), `.openllm.next-${process.pid}`);
  fs.writeFileSync(staging, bytes, { mode: 0o755 });
  prepareUpdatedCliBinary(staging);
  const swap = await commitCliSwap({
    self,
    staged: staging,
    latest,
    digest: expected,
  });
  if (swap === "busy") {
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    process.stderr.write(
      "[self-update] another update holds the CLI swap lock — try again in a moment\n",
    );
    process.exit(1);
  }
  if (swap === "probe-failed") {
    // The staged binary failed its `--self-test` health check (won't exec,
    // crashes loading its command graph, or reports the wrong version) —
    // deterministic, so pin this artifact rejected instead of swapping.
    rejectCliUpdateVersion(latest, expected);
    recordCliUpdateAttempt(latest, expected);
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    process.stderr.write(
      `[self-update] downloaded v${latest} failed its health check — refusing to swap; ${manualRemedy(gatewayUrl)}\n`,
    );
    process.exit(1);
  }
  if (swap === "backup-failed") {
    // FAIL CLOSED: no rollback copy, no swap. (Round-1 swapped anyway and
    // left the daemon nothing reliable to restore; the daemon updater has
    // always refused to swap without a rollback path — the CLI now matches.)
    recordCliUpdateAttempt(latest, expected);
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    process.stderr.write(
      `[self-update] could not create the rollback backup at ${self}.prev — refusing to swap without a recovery path\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`openllm updated to v${latest}\n`);
};
