/**
 * The daemon's isolated RUN-VIEW of the vendor CLIs — a SYMLINK, never a copy.
 * There is ONE binary per CLI, the user's NON-isolated copy (installed OUT of
 * band by the user-run daemon install script or the user themselves — the daemon
 * NEVER installs a vendor CLI). The isolated path under `<stateDir>/cli/<provider>/`
 * is always a symlink to that host binary; isolation is preserved by the RUN env
 * (`cliEnv` points HOME/config at the isolated dir), not by a separate binary, so
 * credentials + config never collide with the user's personal
 * `~/.claude` / `~/.codex` / `~/.kimi-code` while the binary itself is shared.
 *
 * `cliInstallState` is the single chokepoint every delegate's `installed`/`status`
 * reads (run on every status push). It is SELF-HEALING: if the isolated symlink is
 * missing but the host binary exists, it links it before probing — so a CLI the
 * user just installed shows up on the next status push with no command. The
 * host-binary candidate paths live in `cli-paths.ts` (`hostCliCandidates`).
 */
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { projectDoctorOutcomeLedger } from "@openllmsh/protocol";
import type { TCliProvider } from "./cli-paths";
import {
  cliBin,
  cliConfigDir,
  cliEnv,
  cliHome,
  cliInstalledVersion,
  cliRoot,
  hostCliCandidates,
} from "./cli-paths";
import { grantKeychainToolAccess } from "./delegation/keychain";
import { cliVersion } from "./delegation/util";
import type { TSafeDiagnosticMessage } from "./doctor-report/message";
import { envMs } from "./env-ms";
import {
  rememberInterpreterDir,
  rememberLauncherProfile,
} from "./launcher-profile-state";
import type { TLauncherResolver } from "./launcher-resolution";
import { defaultLauncherResolver } from "./launcher-resolution";
import type { TLauncherResolution } from "./launcher-resolution-types";
import { logWarn, safeDiagnosticMessage } from "./logger";
import type { TManagerRegistry } from "./manager-resolution";
import { defaultManagerRegistry } from "./manager-resolution";
import { isHostCliRunnable } from "./path-utils";
import { isMacKeychainProvider } from "./sandbox/policy";

export type TCliInstallState = {
  readonly installed: boolean;
  readonly version: string | null;
};

const cliFailStreak = new Map<string, number>();

/**
 * Per-provider doctor copy — `safeDiagnosticMessage` forbids interpolation, and
 * underscores (as in `claude_code`) fail message sanitization, so the shell
 * command name (`claude`, `codex`, …) is baked into each literal. The closed
 * `provider` ledger field carries the slug.
 */
const VERSION_UNREADABLE_MESSAGES: Readonly<
  Record<TCliProvider, TSafeDiagnosticMessage>
> = {
  claude_code: safeDiagnosticMessage`The installed claude client version could not be read repeatedly.`,
  chatgpt: safeDiagnosticMessage`The installed codex client version could not be read repeatedly.`,
  kimi_code: safeDiagnosticMessage`The installed kimi client version could not be read repeatedly.`,
  grok: safeDiagnosticMessage`The installed grok client version could not be read repeatedly.`,
  cursor: safeDiagnosticMessage`The installed cursor-agent client version could not be read repeatedly.`,
  muse: safeDiagnosticMessage`The installed muse client version could not be read repeatedly.`,
  antigravity: safeDiagnosticMessage`The installed antigravity agent version could not be read repeatedly.`,
};

const versionUnreadableMessage = (provider: string): TSafeDiagnosticMessage => {
  if (Object.hasOwn(VERSION_UNREADABLE_MESSAGES, provider)) {
    return VERSION_UNREADABLE_MESSAGES[provider as TCliProvider];
  }
  return safeDiagnosticMessage`The installed client version could not be read repeatedly.`;
};

export const noteCliInstallProbeResult = (opts: {
  readonly provider: string;
  readonly version: string | null;
  readonly installed: boolean;
}): void => {
  if (!opts.installed || opts.version !== null) {
    cliFailStreak.delete(opts.provider);
    return;
  }
  const n = (cliFailStreak.get(opts.provider) ?? 0) + 1;
  cliFailStreak.set(opts.provider, n);
  if (n !== 3) return;
  logWarn("cli-install", versionUnreadableMessage(opts.provider), undefined, {
    timings: { repeat_count: n },
    ...projectDoctorOutcomeLedger({ provider: opts.provider }),
  });
};

/** Create the isolated provider dirs (root + home + config) before a write. */
const ensureIsolatedDirs = async (provider: TCliProvider): Promise<void> => {
  await mkdir(cliRoot(provider), { recursive: true });
  await mkdir(cliHome(provider), { recursive: true });
  await mkdir(cliConfigDir(provider), { recursive: true });
};

/**
 * Point the isolated CLI path (`cliBin(provider)`) at the host binary via a
 * SYMLINK — never a copy, so the isolated CLI takes no disk space. Replaces any
 * existing link/file at the isolated path so it always tracks the current host
 * binary (e.g. after the user updates their CLI). Writes ONLY into the
 * always-granted state dir (`<stateDir>/cli/<provider>/`); it merely READS the
 * host binary, so it needs no grant on the host CLI's own dir.
 */
/**
 * Per-provider "re-grant pending" — set whenever a relink changes the target
 * (passive OR demand). Keychain work stays demand-only: a passive call that
 * relinks must not spawn `security`, but the next demand call must still
 * re-grant even when that later call does not itself relink.
 */
const regrantPending = new Set<TCliProvider>();

export const linkIsolatedCli = async (
  provider: TCliProvider,
  hostBin: string,
): Promise<{ readonly targetChanged: boolean }> => {
  await ensureIsolatedDirs(provider);
  const dst = cliBin(provider);
  let previousReal: string | null = null;
  try {
    previousReal = realpathSync(dst);
  } catch {
    try {
      // Dangling link: existsSync is false, but the prior target still
      // identifies a change (version switch / self-update removed the old bin).
      const previousLink = readlinkSync(dst);
      previousReal = isAbsolute(previousLink)
        ? previousLink
        : join(dirname(dst), previousLink);
    } catch {
      previousReal = null;
    }
  }
  await mkdir(dirname(dst), { recursive: true });
  await rm(dst, { force: true });
  symlinkSync(hostBin, dst);
  linkSidecars(dst);
  let nextReal: string | null = null;
  try {
    nextReal = realpathSync(dst);
  } catch {
    nextReal = hostBin;
  }
  // Target change (incl. replacing a prior binary) leaves keychain items ACL'd
  // to the previous executable path. Record pending here; demand callers flush
  // via regrantKeychainAfterRelink — passive status must not spawn `security`.
  const targetChanged =
    previousReal !== null && nextReal !== null && previousReal !== nextReal;
  if (targetChanged) regrantPending.add(provider);
  return { targetChanged };
};

/** Re-grant isolated-keychain ACLs after a demand-time launcher relink. */
const regrantKeychainAfterRelink = async (
  provider: TCliProvider,
): Promise<boolean> => {
  if (platform() !== "darwin" || !isMacKeychainProvider(provider)) return true;
  return grantKeychainToolAccess(cliHome(provider)).catch(() => false);
};

/**
 * Link executable SIDECARS that ship NEXT TO THE REAL host binary (the
 * resolved end of the symlink chain) into the isolated bin dir, alongside the
 * main link. Codex's tool router spawns `codex-code-mode-host` — the
 * 5.6-family web-search / code-mode host — from the INVOKED binary's own
 * directory (our isolated `bin/`), NOT the resolved target's; without the
 * sidecar link, web search on gpt-5.6-* dies with "failed to spawn code-mode
 * host … No such file or directory" (observed live 2026-07-15) while 5.4
 * (hosted-tool route) keeps working. Generic: every sibling named
 * `<binary>-*` is linked, so a future vendor sidecar is picked up without a
 * code change. Idempotent (an up-to-date link is left alone — safe on the
 * 30s `cliInstallState` self-heal path) and best-effort per entry: a sidecar
 * failure must never break the main CLI link.
 */
const linkSidecars = (isolatedBin: string): void => {
  try {
    const real = realpathSync(isolatedBin);
    const realDir = dirname(real);
    const isolatedDir = dirname(isolatedBin);
    const prefix = `${basename(isolatedBin)}-`;
    const current = new Set<string>();
    for (const entry of readdirSync(realDir)) {
      if (!entry.startsWith(prefix)) continue;
      current.add(entry);
      const target = join(realDir, entry);
      const link = join(isolatedDir, entry);
      try {
        if (readlinkSync(link) === target) continue; // already current
      } catch {
        // absent or not a symlink — (re)create below
      }
      try {
        rmSync(link, { force: true });
        symlinkSync(target, link);
      } catch {
        // per-sidecar best effort — the main CLI still runs without it
      }
    }
    // Reconcile: drop managed sidecar links whose target no longer ships
    // beside the real binary (a host update that removed/renamed one) — a
    // dangling link would otherwise shadow the vendor's own resolution.
    for (const entry of readdirSync(isolatedDir)) {
      if (!entry.startsWith(prefix) || current.has(entry)) continue;
      try {
        rmSync(join(isolatedDir, entry), { force: true });
      } catch {
        // best effort — a stale link is degraded behaviour, not a crash
      }
    }
  } catch {
    // unresolvable host binary / unreadable dir — main-link errors surface
    // through the install-state probe; sidecars just stay absent
  }
};

/**
 * Re-point the isolated main symlink at the currently-preferred host binary when
 * they diverge — the fix for an out-of-band vendor update that installs to a
 * DIFFERENT preferred path (e.g. a new `~/.codex/bin/codex` while an older
 * `~/.local/bin/codex` still exists, or a brew/npm relocation). Without this the
 * link, once created, would track the old binary forever and freeze the reported
 * version. Cheap: a `realpath` compare, with `linkIsolatedCli` (rm + symlink)
 * only when they actually differ. Best-effort — a stat/link failure leaves the
 * existing link intact and surfaces through the probe below.
 *
 * Returns `true` when the link was re-pointed (the caller must then recompute the
 * binary signature, since the resolved target changed).
 */
/**
 * Resolve the preferred host candidate through the manager-resolution
 * coordinator. With zero adapters registered (default), this returns the
 * first existing candidate unchanged — identical to the pre-coordinator
 * behavior. A candidate recognized as a manager shim that cannot be
 * resolved is treated as absent (never linked, never version-probed),
 * rather than silently falling through to a lower-priority candidate.
 *
 * `demand` gates whether this may actually SPAWN the manager adapter:
 *   - `demand: true` (an explicit user/system action — connect, logout,
 *     inference preparation) runs the real resolution and populates the
 *     passive-read cache for later callers.
 *   - `demand` false/absent (a passive status read, including the
 *     TTL-throttled periodic reconcile below) NEVER spawns — it only
 *     consults the cache a prior demand call left behind. An ordinary
 *     (non-manager) candidate is unaffected either way, since
 *     `peekManagerResolution` answers it without ever needing a cache entry.
 */
const noteLauncherResolution = (
  provider: TCliProvider,
  resolution: Awaited<ReturnType<TLauncherResolver["resolveLauncher"]>>,
): void => {
  rememberLauncherProfile(provider, resolution);
  // Prefer the shebang interpreter dir; otherwise, when demand proved a
  // manager shim / under-manager install, remember that path so cliEnv can
  // prepend its dirname onto THIS provider's PATH only.
  const pathForDir =
    resolution?.interpreter ??
    (resolution !== null &&
    resolution !== undefined &&
    (resolution.kind.startsWith("shim:") || resolution.underManagerRoot)
      ? resolution.path
      : undefined);
  rememberInterpreterDir(provider, pathForDir);
};

const isExecutableAbsolutePath = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runnability for a launcher resolution. Any proven executable interpreter
 * (script or shim→script) is accepted — a remembered interpreter *directory*
 * alone is not enough. Native / shim / wrapper without an interpreter keep
 * the spawnPathDirs check.
 */
export const isResolvedLauncherRunnable = (
  resolution: TLauncherResolution,
): boolean => {
  if (resolution.interpreter !== undefined) {
    return isExecutableAbsolutePath(resolution.interpreter);
  }
  if (resolution.kind === "script") {
    return false;
  }
  return isHostCliRunnable(resolution.path);
};

export type TRunnableHostPick = {
  readonly candidate: string;
  readonly resolution: TLauncherResolution;
};

/**
 * Walk host candidates the demand path uses: skip missing paths, null
 * `resolveLauncher` results, and non-runnable resolutions; return the first
 * runnable pick. Shared by {@link resolveHostBinary} and `doctor launchers`.
 */
export const pickFirstRunnableHostCandidate = async (
  candidates: readonly string[],
  resolveLauncher: (candidate: string) => Promise<TLauncherResolution | null>,
): Promise<TRunnableHostPick | null> => {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const resolution = await resolveLauncher(candidate);
    if (resolution === null) continue;
    if (!isResolvedLauncherRunnable(resolution)) continue;
    return { candidate, resolution };
  }
  return null;
};

const cachedLauncherForTarget = (
  launchers: TLauncherResolver,
  provider: TCliProvider,
  linkedTarget: string,
): TLauncherResolution | undefined => {
  const direct = launchers.peekLauncherResolution(linkedTarget);
  if (direct !== undefined) return direct;
  for (const candidate of hostCliCandidates(provider)) {
    const peeked = launchers.peekLauncherResolution(candidate);
    if (peeked === undefined) continue;
    if (peeked.path === linkedTarget) return peeked;
    try {
      if (realpathSync(peeked.path) === linkedTarget) return peeked;
    } catch {
      // keep scanning
    }
  }
  return undefined;
};

const resolveHostBinary = async (
  provider: TCliProvider,
  opts?: TCliInstallStateOpts,
): Promise<string | undefined> => {
  const managers = opts?.managers ?? defaultManagerRegistry;
  // Production uses the process-wide default launcher resolver (stable
  // fingerprint cache). Hermetic tests that inject `managers` without a
  // matching `launchers` skip the generic layer so demand/passive gating
  // assertions against the injected registry stay accurate — a fresh
  // per-call resolver would drop the cache between calls.
  const launchers =
    opts?.launchers ??
    (opts?.managers !== undefined ? undefined : defaultLauncherResolver);
  // Demand + launchers: walk every candidate via the shared helper (doctor
  // uses the same decision). A PATH-hit shebang whose interpreter is missing
  // must not win over a later native install, and must not count as
  // "installed" when it is the only hit. resolveLauncher already ran
  // resolveManagerCandidate — do NOT re-enter the legacy manager path
  // (CodeRabbit 4341596146).
  if (launchers !== undefined && opts?.demand === true) {
    const pick = await pickFirstRunnableHostCandidate(
      hostCliCandidates(provider),
      (candidate) =>
        launchers.resolveLauncher(candidate, {
          demand: true,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        }),
    );
    if (pick !== null) {
      noteLauncherResolution(provider, pick.resolution);
      return pick.resolution.path;
    }
    return undefined;
  }

  // Passive / no-launchers: walk candidates with cache peek + spawnPathDirs.
  for (const candidate of hostCliCandidates(provider)) {
    if (!existsSync(candidate)) continue;

    if (launchers !== undefined) {
      // Passive: reuse a prior demand resolution when the fingerprint still
      // matches; never spawn. A cached script keeps its interpreter-aware
      // check (not spawnPathDirs alone). Miss → fall through.
      const peeked = launchers.peekLauncherResolution(candidate);
      if (peeked !== undefined) {
        if (!isResolvedLauncherRunnable(peeked)) continue;
        noteLauncherResolution(provider, peeked);
        return peeked.path;
      }
    }

    // Passive miss / no launchers: keep the existing spawnPathDirs gate —
    // never spawn to prove a sibling/manager interpreter.
    if (!isHostCliRunnable(candidate)) continue;

    // Demand + launchers already handled above (continue on null). This
    // demand branch only runs when tests inject managers without launchers.
    const resolved =
      opts?.demand === true
        ? await managers.resolveManagerCandidate(candidate, {
            signal: opts.signal,
          })
        : managers.peekManagerResolution(candidate);
    if (resolved === undefined || resolved.kind === "unresolved") {
      continue;
    }
    const target = resolved.target ?? undefined;
    if (target === undefined) continue;
    // Manager resolution can point at another script; re-check the final target.
    if (!isHostCliRunnable(target)) continue;
    return target;
  }
  return undefined;
};

/**
 * Is the vendor CLI the daemon runs installed + runnable? SELF-HEALING: the
 * daemon never installs, so the isolated run-view symlink is created lazily here —
 * if `cliBin(provider)` is absent but the user's host binary exists
 * (`hostCliCandidates`), link it first, then probe. A user who installs the CLI
 * out of band (the daemon install script, or by hand) therefore shows as
 * installed on the next status read with no command. Best-effort version read.
 *
 * VENDOR updates happen OUT OF BAND, WITHOUT a daemon restart (the user runs
 * `codex`/`claude`/`kimi` self-update, brew, npm, etc.), so freshness cannot
 * assume a restart clears anything. Two paths defend against a frozen version:
 *   1. The isolated main symlink is RE-RECONCILED against the preferred host
 *      candidate on a throttled refresh (not only when absent) — an update that
 *      moves the binary to a different preferred path re-points the link.
 *   2. `--version` is owned by the shared stamp-keyed cache (`cliVersion`):
 *      an unchanged resolved binary is never re-spawned, including after a
 *      timeout. Cached timeout means installed / version unknown, not absent.
 * The short TTL only throttles how often periodic status observations re-stat /
 * re-reconcile the isolated link; it never pins or expires a version.
 */

/** Cache TTL — 30 s throttles the re-stat / re-reconcile on the hot status
 *  path. Version identity is NOT gated here. */
const CLI_INSTALL_STATE_TTL_MS = envMs("OPENLLM_CLI_STATE_TTL_MS", 30_000);

/**
 * Per-spawn kill deadline for a `--version` probe. A vendor CLI can wedge
 * under the isolated HOME/config; the shared cache stores that completed
 * timeout until the binary stamp changes. Resolved LAZILY because `.env` is
 * loaded by `daemonPort()` AFTER this module is first evaluated.
 */
const cliVersionProbeTimeoutMs = (): number =>
  envMs("OPENLLM_CLI_VERSION_PROBE_TIMEOUT_MS", 3_000);

/** Throttle / in-flight maps are keyed by the provider's install root, so a
 *  re-pointed state dir gets its own reconcile instead of a stale one. */
const installKey = (provider: TCliProvider): string => cliRoot(provider);

/** Per-provider last-reconcile throttle. Version spawns live in `cliVersion`. */
const cliInstallReconcileUntil = new Map<string, number>();

/** In-flight PASSIVE `cliInstallState` probes — overlapping passive callers
 *  share one reconcile. Kept separate from the demand map below so a demand
 *  caller is never starved behind (or silently downgraded to) a concurrent
 *  passive read that would not spawn a manager subprocess. */
const cliInstallStateInFlight = new Map<string, Promise<TCliInstallState>>();

/** In-flight DEMAND `cliInstallState` probes — overlapping demand callers
 *  (e.g. two near-simultaneous connect attempts) share one manager-adapter
 *  subprocess rather than each spawning their own. */
const cliInstallStateDemandInFlight = new Map<
  string,
  Promise<TCliInstallState>
>();

const parseVendorVersion = (out: string | null): string | null =>
  out?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;

export type TCliInstallStateOpts = {
  /**
   * Explicit demand: this call is an actual user/system action (connect,
   * logout, inference preparation) rather than a periodic passive status
   * read. Only a demand call may spawn a manager adapter's subprocess
   * (`resolveManagerCandidate`) — see `resolveHostBinary` above. A retry TTL
   * is not demand-only behavior: a passive call NEVER spawns one, even once
   * its reconcile window has elapsed, and reuses whatever a prior demand
   * call cached instead.
   */
  readonly demand?: boolean;
  /** Forwarded to a demand resolution's manager-adapter subprocess. Ignored
   *  on a passive (non-demand) call, since no subprocess runs there. */
  readonly signal?: AbortSignal;
  /** Manager-shim registry to resolve candidates through. Defaults to the
   *  production {@link defaultManagerRegistry}. */
  readonly managers?: TManagerRegistry;
  /** Generic launcher resolver (audit L1). Defaults to
   *  {@link defaultLauncherResolver}. */
  readonly launchers?: TLauncherResolver;
};

const probeCliInstallState = async (
  provider: TCliProvider,
  opts?: TCliInstallStateOpts,
): Promise<TCliInstallState> => {
  const now = Date.now();
  const bin = cliBin(provider);
  const demand = opts?.demand === true;
  try {
    return await probeCliInstallStateBody(provider, opts, now, bin, demand);
  } finally {
    // Flush a pending re-grant only on demand, and only clear after success so
    // a failed grant stays queued for the next demand call.
    if (demand && regrantPending.has(provider)) {
      const ok = await regrantKeychainAfterRelink(provider);
      if (ok) regrantPending.delete(provider);
    }
  }
};

const probeCliInstallStateBody = async (
  provider: TCliProvider,
  opts: TCliInstallStateOpts | undefined,
  now: number,
  bin: string,
  demand: boolean,
): Promise<TCliInstallState> => {
  if (!existsSync(bin)) {
    // No isolated link exists yet. A PASSIVE call here must NOT spawn a
    // manager subprocess, even once — cold bootstrap is not exempt from the
    // demand-only rule. `resolveHostBinary` already enforces this: for an
    // ORDINARY (non-manager) candidate it resolves for free (no adapter
    // recognizes it, so filesystem linking still self-heals passively, per
    // the file header's contract); for a candidate recognized as a manager
    // shim it fails closed on a passive call (peek-only, no cache yet) and
    // only actually resolves when `opts.demand` is true — an explicit
    // connect/logout/inference-prep call.
    const host = await resolveHostBinary(provider, opts);
    if (host === undefined) {
      return { installed: false, version: null };
    }
    await linkIsolatedCli(provider, host);
    cliInstallReconcileUntil.set(
      installKey(provider),
      now + CLI_INSTALL_STATE_TTL_MS,
    );
  } else {
    // The isolated link's OWN immediate target (not the fully-resolved
    // realpath — a resolved manager selection is a plain absolute path to a
    // real binary, never itself a shim) may be a manager shim on the FIRST
    // observation of a pre-existing link (no throttle entry yet — e.g. a
    // daemon restart finding a link created by a prior process/version, or
    // one hand-crafted before this resolution step existed). Check that
    // unconditionally, before any TTL gating, so a link that points directly
    // at an unresolvable shim can never be version-probed/delegated through
    // unconfined. On a PASSIVE call this is a cache-only peek — never a
    // subprocess; on a DEMAND call it actually resolves and populates the
    // cache for later passive callers.
    let immediateTarget: string | undefined;
    try {
      immediateTarget = readlinkSync(bin);
    } catch {
      immediateTarget = undefined;
    }
    if (immediateTarget !== undefined) {
      const managers = opts?.managers ?? defaultManagerRegistry;
      const resolved = demand
        ? await managers.resolveManagerCandidate(immediateTarget, {
            signal: opts?.signal,
          })
        : managers.peekManagerResolution(immediateTarget);
      if (resolved === undefined) {
        // Recognized as a manager shim but no demand resolution has ever
        // populated the cache for it (passive call, cold cache): fail
        // closed rather than trust an unconfirmed shim — the cache isn't
        // permanently unusable, an explicit demand call (connect/logout/
        // inference prep) will resolve and populate it.
        return { installed: false, version: null };
      }
      if (resolved.kind === "unresolved") {
        // Recognized as a manager shim but it no longer resolves: fail
        // closed rather than falling through to probe the shim unconfined.
        cliInstallReconcileUntil.set(
          installKey(provider),
          now + CLI_INSTALL_STATE_TTL_MS,
        );
        return { installed: false, version: null };
      }
      if (
        resolved.kind === "resolved" &&
        resolved.target !== null &&
        resolved.target !== immediateTarget
      ) {
        await linkIsolatedCli(provider, resolved.target);
      }
    }

    // Separately, on a throttled cadence, re-derive the PREFERRED host
    // candidate (`hostCliCandidates()` precedence) in case a higher-priority
    // path newly exists (e.g. a vendor update relocated the binary). Best
    // effort: if no preferred candidate is currently discoverable, the
    // existing (already shim-checked above) link is left as-is rather than
    // treated as absent — a transient PATH/candidate change must not evict a
    // link that is otherwise known-good. `resolveHostBinary` itself never
    // spawns on this cadence unless `opts.demand` is set — the TTL only
    // throttles how often this cheap re-derive/re-stat runs, it is never
    // itself a license to query a manager adapter.
    const until = cliInstallReconcileUntil.get(installKey(provider));
    if (until === undefined || until <= now) {
      cliInstallReconcileUntil.set(
        installKey(provider),
        now + CLI_INSTALL_STATE_TTL_MS,
      );
      const host = await resolveHostBinary(provider, opts);
      if (host !== undefined) {
        try {
          if (realpathSync(bin) !== realpathSync(host)) {
            await linkIsolatedCli(provider, host);
          }
        } catch {
          await linkIsolatedCli(provider, host);
        }
      }
    }
  }
  if (!existsSync(bin)) {
    return { installed: false, version: null };
  }

  // A leftover isolated link at an unrunnable shebang (npm shim without node
  // on the daemon PATH) must not keep reporting installed / burn version
  // probes — drop it so the next demand can take the vendor-install path.
  // Demand-proven scripts reuse the interpreter-aware check: spawnPathDirs
  // alone would false-negative after resolveLauncher found a manager/sibling
  // interpreter.
  let linkedTarget = bin;
  try {
    linkedTarget = realpathSync(bin);
  } catch {
    linkedTarget = bin;
  }
  const linkLaunchers =
    opts?.launchers ??
    (opts?.managers !== undefined ? undefined : defaultLauncherResolver);
  const cached =
    linkLaunchers !== undefined
      ? cachedLauncherForTarget(linkLaunchers, provider, linkedTarget)
      : undefined;
  const linkedRunnable =
    cached !== undefined
      ? isResolvedLauncherRunnable(cached)
      : isHostCliRunnable(linkedTarget);
  if (!linkedRunnable) {
    try {
      rmSync(bin, { force: true });
    } catch {
      // best effort — installed:false still blocks login on the bad link
    }
    return { installed: false, version: null };
  }

  linkSidecars(bin);
  if (!cliInstallReconcileUntil.has(installKey(provider))) {
    cliInstallReconcileUntil.set(
      installKey(provider),
      now + CLI_INSTALL_STATE_TTL_MS,
    );
  }

  // Agents with install metadata never pay a launch just to read a version.
  const installed = cliInstalledVersion(provider, linkedTarget);
  if (installed !== undefined) {
    return { installed: true, version: installed };
  }

  const out = await cliVersion(bin, cliEnv(provider), {
    timeoutMs: cliVersionProbeTimeoutMs(),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const state = { installed: true, version: parseVendorVersion(out) };
  noteCliInstallProbeResult({
    provider,
    version: state.version,
    installed: state.installed,
  });
  return state;
};

export const cliInstallState = async (
  provider: TCliProvider,
  opts?: TCliInstallStateOpts,
): Promise<TCliInstallState> => {
  const key = installKey(provider);
  if (opts?.demand === true) {
    // A caller carrying its OWN AbortSignal must never join (or replace) the
    // shared no-signal demand promise: aborting one signaled caller would
    // otherwise abort every other caller sharing that singleflight entry,
    // including unrelated no-signal callers. Run it as its own independent
    // probe instead — it still shares nothing, but its cancellation is its
    // own.
    if (opts.signal !== undefined) {
      return probeCliInstallState(provider, opts);
    }
    const existingDemand = cliInstallStateDemandInFlight.get(key);
    if (existingDemand !== undefined) return existingDemand;
    const pending = probeCliInstallState(provider, opts).finally(() => {
      if (cliInstallStateDemandInFlight.get(key) === pending) {
        cliInstallStateDemandInFlight.delete(key);
      }
    });
    cliInstallStateDemandInFlight.set(key, pending);
    return pending;
  }
  const existing = cliInstallStateInFlight.get(key);
  if (existing !== undefined) return existing;
  const pending = probeCliInstallState(provider, opts).finally(() => {
    if (cliInstallStateInFlight.get(key) === pending) {
      cliInstallStateInFlight.delete(key);
    }
  });
  cliInstallStateInFlight.set(key, pending);
  return pending;
};
