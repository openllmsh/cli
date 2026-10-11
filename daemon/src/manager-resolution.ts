/**
 * Behavior-neutral coordinator for resolving a host CLI candidate that may be
 * a version-manager shim (e.g. mise) rather than an ordinary executable.
 *
 * This module is ADDITIVE and, with zero adapters registered, is a pure
 * passthrough: `resolveManagerCandidate` returns the ordinary candidate
 * unchanged. It exists so a later adapter (mise, asdf, …) can be registered
 * without touching `cli-paths.ts` / `cli-install.ts` call sites again.
 *
 * Scope contract (see execution plan): resolution never inspects request- or
 * cwd-scoped state — it must select the same target regardless of the
 * daemon process's current working directory (global manager semantics).
 * Adapters run with a short bounded timeout, explicit argv only (no shell),
 * and must reject cyclic / self-referential / relative output.
 */
import {
  accessSync,
  constants,
  existsSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import type { TDoctorFailureSignature } from "@openllmsh/protocol";
import { classifyFailureOutput } from "@openllmsh/protocol";
import { runCaptureResult, spawnCwd } from "./delegation/spawn";
import { logWarn, safeDiagnosticMessage } from "./logger";
import { misePaths } from "./mise-paths";
import { resolveOnPath } from "./path-utils";

export type TManagerResolutionKind =
  | "ordinary" // not recognized as any manager shim
  | "resolved" // recognized AND resolved to a real, absolute, existing binary
  | "unresolved"; // recognized as a manager shim but could not be resolved

export type TManagerResolution = {
  readonly kind: TManagerResolutionKind;
  /** The absolute path a link/probe step should use. For "ordinary" this is
   *  always the input candidate. For "resolved" it is the manager's answer.
   *  For "unresolved" it is `null` — callers must NOT link/execute the
   *  original shim. */
  readonly target: string | null;
  /** Stable identity string folded into the reconcile fingerprint so a
   *  changed manager selection (not merely elapsed TTL) triggers a re-link.
   *  `null` for "ordinary" (nothing manager-specific to fingerprint). */
  readonly identity: string | null;
};

export type TManagerAdapter = {
  readonly name: string;
  /** Cheap, synchronous, subprocess-free check: does this candidate path
   *  look like this manager's shim? Bounded path/file evidence only. */
  readonly recognizes: (candidate: string) => boolean;
  /** Bounded, cancellable resolution to the real target binary. Must reject
   *  cycles, relative paths, and self-reference; return `null` on any
   *  failure (timeout, bad output, missing binary). `signal` is an
   *  observer-only early-cancel — an aborted caller stops waiting, it does
   *  not retroactively un-spawn the child. */
  readonly resolve: (
    candidate: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  /** Cheap, synchronous, subprocess-free signal for the manager's current
   *  GLOBAL SELECTION state (e.g. mise's global config file mtime+size) —
   *  folded into the cache fingerprint alongside the candidate's own on-disk
   *  shape, so an interpreter/version SWITCH (`mise use -g …`) invalidates a
   *  cached resolution even when the shim FILE itself never changed (shims
   *  are rewritten by `mise reshim`, not by a plain selection change).
   *  Optional; a coordinator without this hook still fingerprints the
   *  candidate itself via `candidateFingerprint`. */
  readonly fingerprint?: (candidate: string) => string | null;
};

const adapters: TManagerAdapter[] = [];

/**
 * Cache of the last EXPLICIT-DEMAND resolution per candidate path, consulted
 * only by {@link peekManagerResolution}. Never written by a passive read —
 * only {@link resolveManagerCandidate} (the demand primitive) writes it, as a
 * side effect, so a passive observation can reuse a demand call's answer
 * without itself spawning anything. Keyed by the fingerprint captured at
 * write time so a "relevant bounded change" to the candidate itself (its
 * symlink target, or its mtime/size if it's a plain file) invalidates the
 * entry rather than serving a stale identity forever.
 */
const peekCache = new Map<
  string,
  {
    readonly fingerprint: string | null;
    readonly resolution: TManagerResolution;
  }
>();

/** Cheap, synchronous fingerprint of a candidate path: its symlink target
 *  when it is one (mise shims typically are not, but some manager layouts
 *  are), else its mtime+size. `null` when the path can't be stat'd at all
 *  (caller must then treat any cache entry as stale). */
const candidateFingerprint = (candidate: string): string | null => {
  try {
    return `link:${readlinkSync(candidate)}`;
  } catch {
    // not a symlink — fall through to a plain stat
  }
  try {
    const st = statSync(candidate);
    return `stat:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
};

/**
 * Composite cache key: the candidate's own on-disk shape PLUS the adapter's
 * global-selection signal (when it has one). Either half changing invalidates
 * the cache — a re-created shim file AND a `mise use -g` interpreter switch
 * both count as a "relevant bounded change", not just the shim's mtime.
 */
const compositeFingerprint = (
  adapter: TManagerAdapter,
  candidate: string,
): string | null => {
  const own = candidateFingerprint(candidate);
  const selection = adapter.fingerprint?.(candidate) ?? null;
  if (own === null && selection === null) return null;
  return `own:${own ?? "\u0000"}|sel:${selection ?? "\u0000"}`;
};

/** Test/registration hook. Adapters are appended; there are none by default,
 *  so default behavior is the "ordinary" passthrough below. */
export const registerManagerAdapter = (adapter: TManagerAdapter): void => {
  adapters.push(adapter);
};

/** Test-only reset so adapter registration doesn't leak across test files.
 *  Clears to a TRULY empty registry (no mise default) — used by fixtures
 *  that need the pure zero-adapter passthrough or that register their own
 *  fakes in its place. Also drops the demand-resolution peek cache, so a
 *  fake adapter from one test never leaks an answer into another. */
export const resetManagerAdaptersForTests = (): void => {
  adapters.length = 0;
  peekCache.clear();
};

/** Test-only: restore the production default registry (mise only) after a
 *  test mutated it with `resetManagerAdaptersForTests` / its own fakes, so
 *  later tests in the same process see the same default a real daemon
 *  boots with. Prefer this over `resetManagerAdaptersForTests` in `afterEach`
 *  unless the test specifically exercises the zero-adapter passthrough. */
export const restoreDefaultManagerAdaptersForTests = (): void => {
  adapters.length = 0;
  peekCache.clear();
  adapters.push(miseManagerAdapter);
};

/**
 * Test-only escape hatch for A5 sandbox fixtures: restore the current
 * registry (whatever `resetManagerAdaptersForTests` left it as) after a test
 * mutates it, without re-running the module's default registration.
 */
export const managerAdaptersForTests = (): readonly TManagerAdapter[] =>
  adapters;

export type TResolveManagerCandidateOpts = {
  /** Observer-only early-cancel, forwarded to the adapter's subprocess. */
  readonly signal?: AbortSignal;
};

/**
 * EXPLICIT-DEMAND resolution: resolve `candidate` (an ordinary host-CLI path
 * already chosen by `hostCliCandidates()` precedence) through any registered
 * manager adapters, spawning the adapter's bounded subprocess when the
 * candidate is recognized. With zero adapters registered this is a no-op:
 * returns `{ kind: "ordinary", target: candidate, identity: null }` for every
 * input, so existing behavior (link the candidate as-is) is entirely
 * unchanged.
 *
 * This is the ONLY function in this module that spawns a subprocess. Callers
 * on a passive/periodic path (a status read, a TTL-throttled reconcile) must
 * use {@link peekManagerResolution} instead — never this function — so an
 * idle daemon never re-launches a manager query on its own. Call this only
 * from an explicit demand: a user-initiated connect/logout, or inference
 * preparation that is about to actually invoke the CLI.
 */
export const resolveManagerCandidate = async (
  candidate: string,
  opts?: TResolveManagerCandidateOpts,
): Promise<TManagerResolution> => {
  for (const adapter of adapters) {
    if (!adapter.recognizes(candidate)) continue;
    // Captured BEFORE the await: this is the candidate's shape at the moment
    // we committed to resolving it. Reading it only AFTER `adapter.resolve`
    // returns would fingerprint whatever the candidate looks like NOW, which
    // can silently mismatch what it looked like when resolution actually ran
    // — a shim re-created, or an interpreter/version switch, WHILE we were
    // awaiting would otherwise get masked, letting an answer computed for the
    // OLD state get cached and served as valid for the NEW one.
    const fingerprintBeforeResolve = compositeFingerprint(adapter, candidate);
    const target = await adapter.resolve(candidate, opts?.signal);
    const resolution: TManagerResolution =
      target === null
        ? { kind: "unresolved", target: null, identity: adapter.name }
        : { kind: "resolved", target, identity: `${adapter.name}:${target}` };
    // Cancellation is not evidence that the installation stopped resolving.
    if (opts?.signal?.aborted) return resolution;
    // Populate the passive-read cache as a side effect of this demand call —
    // but ONLY if the candidate's composite fingerprint (its own on-disk
    // shape AND the adapter's selection-state signal) is still identical to
    // what it was right before we started resolving. Any mutation observed
    // during the await means this resolution no longer describes the
    // candidate's current state, so it must not be cached at all (the
    // aborted-cache guard above is preserved unchanged: this check runs
    // strictly after it, never in place of it).
    const fingerprintAfterResolve = compositeFingerprint(adapter, candidate);
    if (fingerprintAfterResolve === fingerprintBeforeResolve) {
      peekCache.set(candidate, {
        fingerprint: fingerprintAfterResolve,
        resolution,
      });
    }
    return resolution;
  }
  return { kind: "ordinary", target: candidate, identity: null };
};

/**
 * Cache-only, subprocess-free lookup for a PASSIVE observation. Never spawns
 * a manager subprocess, regardless of any elapsed TTL — a retry timer is not
 * demand-only behavior, and an idle daemon must not autonomously re-query a
 * version manager just because a periodic status read happened to run.
 *
 * Returns:
 *   - `{ kind: "ordinary", ... }` immediately for a candidate no adapter
 *     recognizes — such a path never has, and never will, cause a spawn;
 *   - the last EXPLICIT-DEMAND resolution ({@link resolveManagerCandidate})
 *     for a recognized shim, as long as the candidate's own on-disk
 *     fingerprint has not changed since that demand call ran;
 *   - `undefined` when the candidate is recognized as a manager shim but no
 *     fresh demand resolution exists yet (never resolved, or the candidate
 *     changed since). Callers MUST treat this as "not yet known, do not
 *     link or version-probe the raw shim" — never as "ordinary", and never
 *     as license to resolve it themselves from a passive path.
 */
export const peekManagerResolution = (
  candidate: string,
): TManagerResolution | undefined => {
  for (const adapter of adapters) {
    if (!adapter.recognizes(candidate)) continue;
    const hit = peekCache.get(candidate);
    if (hit === undefined) return undefined;
    if (hit.fingerprint !== compositeFingerprint(adapter, candidate)) {
      return undefined;
    }
    return hit.resolution;
  }
  return { kind: "ordinary", target: candidate, identity: null };
};

// ---------------------------------------------------------------------------
// mise adapter (A3)
// ---------------------------------------------------------------------------

/** Numeric env override (tests only) — mirrors `cli-install.ts`'s `envMs`. */
const envMsLocal = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Bounded deadline for the `mise which <cmd>` explicit-argv query. Resolved
 *  lazily (per-call) so a test can override it without a module reload. */
const miseResolveTimeoutMs = (): number =>
  envMsLocal("OPENLLM_MISE_RESOLVE_TIMEOUT_MS", 2_000);

/**
 * Test-only home override for `miseHomeDir()` below. `node:os`'s `homedir()`
 * is resolved once and CACHED for the life of the process (verified: a later
 * `process.env.HOME` write is not observed) — the same gotcha
 * `working-set/base.ts` documents for the sandbox fixtures. This is a plain
 * module-level value a test sets directly; nothing in production ever calls
 * the setter, so — unlike an env var — there is no reachable production
 * redirect of which binary is trusted as "mise".
 */
let miseHomeOverrideForTests: string | undefined;

/** Test-only: point `miseBinCandidates()`/`miseGlobalConfigPath()`'s default
 *  at a fixture home instead of the process's real (cached) `homedir()`. */
export const setMiseHomeOverrideForTests = (home: string | undefined): void => {
  miseHomeOverrideForTests = home;
};

const miseHomeDir = (): string => miseHomeOverrideForTests ?? homedir();

/**
 * Fixed, bounded set of locations mise's OWN launcher is known to install to,
 * checked in this order. Deliberately NOT a bare `"mise"` handed to the
 * spawn call to let it resolve via the daemon process's inherited PATH — an
 * unqualified name is not an "identified" executable: whatever a project- or
 * session-scoped shell init prepended to PATH would win. `resolveOnPath`
 * scans the daemon's own effective search space the same bounded,
 * existence-checked way `hostCliCandidates()` does for vendor CLIs, so this
 * still finds a Homebrew/custom-root install without trusting an ambient
 * override.
 */
const miseBinCandidates = (): readonly string[] => [
  join(miseHomeDir(), ".local", "bin", "mise"),
  join(miseHomeDir(), ".local", "share", "mise", "bin", "mise"),
  ...resolveOnPath("mise"),
];

/**
 * The `mise` launcher to invoke, resolved to an absolute, existing path from
 * the fixed candidate list above — never a bare `"mise"`, and never an env
 * var read as a production redirect (an env-var override of WHICH binary is
 * trusted as "mise" would itself be an untrusted-selection hole, exactly the
 * class of bug this adapter exists to close). `undefined` when no candidate
 * exists: the caller must then treat the shim as unresolved. Hermetic tests
 * install a fake `mise` at one of these real candidate paths (under a
 * temp `HOME`) rather than redirecting via an env var — see
 * `tests/daemon/mise-adapter.test.ts`.
 */
const resolvedMiseBin = (): string | undefined =>
  miseBinCandidates().find((p) => existsSync(p));

/** A mise-managed shim lives at `.../mise/shims/<cmd>` (asdf-compatible
 *  layout mise also honors: `.../<data-dir>/shims/<cmd>` where the parent
 *  segment is literally named `mise`). Path-segment match only — cheap,
 *  synchronous, no filesystem probe beyond the string itself, per the
 *  `TManagerAdapter.recognizes` contract. */
const isMiseShimPath = (candidate: string): boolean => {
  const segments = candidate.split(sep);
  const shimsIdx = segments.lastIndexOf("shims");
  if (shimsIdx <= 0) return false;
  return segments[shimsIdx - 1] === "mise";
};

/**
 * Resolve a recognized mise shim to the real, absolute, existing binary it
 * currently activates, via a bounded `mise which <cmd>` explicit-argv call
 * (no shell, no arbitrary script execution). Rejects:
 *   - non-zero exit / empty output / timeout (→ null, per `runCapture`),
 *   - a relative answer (mise always prints absolute paths; anything else is
 *     untrusted output, not a real resolution),
 *   - self-reference (`mise which` echoing the shim path back — would cause
 *     `linkIsolatedCli` to symlink the shim to itself),
 *   - a cyclic answer that is itself another mise shim path (would leave the
 *     isolated link pointing at a shim, defeating the whole point of
 *     resolution and risking infinite indirection if something re-probes).
 * Any rejection returns `null` — the coordinator then reports "unresolved"
 * and the caller must NOT link or version-probe the original shim.
 */
/**
 * Env vars that select a PROJECT- or SESSION-scoped mise configuration
 * rather than identifying where mise's global store lives. Blanket-deleting
 * every `MISE_*` var is not enough on its own: it also erases legitimate
 * custom GLOBAL roots (`MISE_CONFIG_DIR`, `MISE_DATA_DIR`, `MISE_STATE_DIR`,
 * `MISE_CACHE_DIR`, `MISE_GLOBAL_CONFIG_FILE`) that a user may have
 * deliberately relocated — stripping those would make a validly-configured
 * global mise install look unresolvable. Only the ancestry/selector vars
 * below are stripped, so the query runs in a TRUSTED GLOBAL selection
 * context: mise still finds its real global config/install roots, but an
 * inherited project- or environment-scoped override the daemon process
 * happens to carry can no longer steer which tool version it answers with.
 * See https://mise.jdx.dev/configuration.html and
 * https://mise.jdx.dev/configuration/environments.html.
 */
const MISE_SELECTOR_ENV_KEYS = [
  // Which single config file mise reads instead of the global one.
  "MISE_CONFIG_FILE",
  "MISE_OVERRIDE_CONFIG_FILENAMES",
  "MISE_DEFAULT_CONFIG_FILENAMES",
  // Environment-profile selection (`.mise.<env>.toml`), and the ancestry
  // roots mise walks from a cwd to find project files.
  "MISE_ENV",
  "MISE_ENV_FILE",
  "MISE_PROFILE",
  "MISE_CONFIG_ROOT",
  "MISE_PROJECT_ROOT",
  "MISE_MONOREPO_ROOT",
  "MISE_CD",
  "MISE_CWD",
  "MISE_TASK",
  "MISE_TASK_DIR",
  "MISE_SHELL",
] as const;

const trustedGlobalMiseEnvOverrides = (): Record<
  string,
  string | undefined
> | null => {
  // mise excludes the ceiling directory itself and every ancestor from local
  // config discovery. Match the child's physical cwd, including when the
  // state directory has a symlinked ancestor (e.g. macOS /var → /private/var).
  let ceiling: string;
  try {
    ceiling = realpathSync(spawnCwd(undefined));
  } catch {
    return null; // No verified ceiling: do not query potentially local config.
  }
  const overrides: Record<string, string | undefined> = {
    MISE_CEILING_PATHS: ceiling,
  };
  for (const key of MISE_SELECTOR_ENV_KEYS) {
    if (key in process.env) overrides[key] = undefined;
  }
  return overrides;
};

/**
 * `mise`'s own global config file — `MISE_GLOBAL_CONFIG_FILE` if the user
 * set one, else `$MISE_CONFIG_DIR/config.toml`, else the documented XDG
 * default `~/.config/mise/config.toml` (or `$XDG_CONFIG_HOME/mise/config.toml`).
 * See https://mise.jdx.dev/configuration.html. Read-only: this module never
 * writes it — it exists purely so the coordinator's cache can tell a real
 * `mise use -g …` selection change from an untouched shim file.
 */
const miseGlobalConfigPath = (): string =>
  misePaths(miseHomeDir()).globalConfigFile;

/** {@link TManagerAdapter.fingerprint} for mise: the global config file's
 *  mtime+size (or its documented absence) — a selection SWITCH rewrites this
 *  file even when the shim binary itself is untouched. */
const miseSelectionFingerprint = (): string => {
  const path = miseGlobalConfigPath();
  try {
    const st = statSync(path);
    return `cfg:${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `cfg-absent:${path}`;
  }
};

/**
 * Record WHY `mise which` failed — a closed signature of its stderr (e.g.
 * `mise_permission_denied` when confinement blocks mise's own config), never
 * the text. Without this a sandbox-blocked mise was indistinguishable from an
 * uninstalled CLI in remote diagnostics (2026-10-04 Linux report).
 */
const noteMiseResolveFailure = (
  kind: "failed" | "timeout",
  signature: TDoctorFailureSignature | null,
): void => {
  logWarn(
    "manager-resolution",
    kind === "timeout"
      ? safeDiagnosticMessage`Version-manager resolution timed out.`
      : safeDiagnosticMessage`Version-manager resolution failed.`,
    undefined,
    {
      failure_signature:
        kind === "timeout" ? "unclassified" : (signature ?? "no_output"),
    },
  );
};

const resolveMiseShim = async (
  candidate: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  const cmd = basename(candidate);
  if (cmd.length === 0) return null;
  const mise = resolvedMiseBin();
  if (mise === undefined) return null; // no identified absolute mise executable — never trust a bare "mise"
  // `runCapture`'s `spawnCwd` deliberately computes the child's cwd from
  // `env.HOME` alone (see `delegation/spawn.ts`), and this override map never
  // sets `HOME` — so the child ALWAYS lands in a neutral state/tmp dir, never
  // this daemon process's own `cwd()` (which could be anything, including a
  // user's project directory). That is the "actual cwd policy": mise still
  // sees the REAL inherited `HOME` (so it finds its genuine global config,
  // preserving valid custom global roots), but it can never walk UP from a
  // project-scoped working directory to pick up ancestry config, because it
  // never starts in one.
  const env = trustedGlobalMiseEnvOverrides();
  if (env === null) return null;
  let signature: TDoctorFailureSignature | null = null;
  const result = await runCaptureResult([mise, "which", cmd], env, {
    probe: true,
    timeoutMs: miseResolveTimeoutMs(),
    maxBytes: 4_096,
    ...(signal !== undefined ? { signal } : {}),
    onFailureStderr: (stderr) => {
      signature = classifyFailureOutput(stderr);
    },
  });
  if (result.kind !== "ok") {
    if (result.kind !== "aborted")
      noteMiseResolveFailure(result.kind, signature);
    return null;
  }
  const answer = result.text.trim();
  if (answer.length === 0 || /[\r\n\0]/.test(answer)) return null;
  if (!isAbsolute(answer)) return null;
  if (answer === candidate) return null; // self-reference
  if (isMiseShimPath(answer)) return null; // cyclic — still a shim
  let real: string;
  try {
    real = realpathSync(answer);
  } catch {
    return null; // dangling — mise pointed at a binary that doesn't exist
  }
  try {
    if (!statSync(real).isFile()) return null;
    accessSync(real, constants.X_OK);
  } catch {
    return null;
  }
  if (real === candidate || isMiseShimPath(real)) return null;
  return real;
};

export const miseManagerAdapter: TManagerAdapter = {
  name: "mise",
  recognizes: isMiseShimPath,
  resolve: resolveMiseShim,
  fingerprint: (): string | null => miseSelectionFingerprint(),
};

/**
 * Default production registration — additive, per design decision §2.1: the
 * coordinator still runs the SAME `hostCliCandidates()` → `linkIsolatedCli`
 * pipeline; this only teaches it to recognize one more shim shape. A
 * candidate that never looks like a mise shim (`isMiseShimPath` false) never
 * triggers a subprocess, so every non-mise provider/path is unaffected.
 *
 * Tests that need a clean registry call `resetManagerAdaptersForTests()` and
 * register their own fakes; production takes this one adapter by default.
 */
registerManagerAdapter(miseManagerAdapter);
