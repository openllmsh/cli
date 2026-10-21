/**
 * Generic launcher resolution (audit L1 / Phase 3).
 *
 * At DEMAND time (install / connect / relink — never a passive status probe),
 * resolve a host CLI candidate to the executable the daemon should link and
 * the interpreter / manager profile it needs:
 *
 *   1. optional login-shell probe (`$SHELL -lc 'command -v <cli>'`)
 *   2. realpath the symlink chain
 *   3. classify by content (ELF / Mach-O / shebang / known manager shim /
 *      opaque wrapper) — manager adapters are an optimisation, not a
 *      requirement
 *
 * Results are fingerprint-cached (mtime+size) so a version-manager switch or
 * self-update invalidates without a TTL, and (Phase 4) optionally persisted
 * under `<state>/launcher-resolution-cache.json` so a daemon restart can peek
 * without re-spawning. Exec ENOENT/EACCES invalidates via
 * `launcher-exec-invalidate.ts` so the next demand re-resolves. Passive
 * privacy-safe profile ({@link TLauncherProfile}) is what doctor / telemetry
 * may upload — never raw paths.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, sep } from "node:path";
import {
  dropPersistedLauncherResolution,
  loadLauncherResolutionCache,
  persistLauncherResolution,
  recordToResolution,
} from "./launcher-resolution-cache";
import type { TLauncherResolution } from "./launcher-resolution-types";
import type { TManagerAdapter, TManagerRegistry } from "./manager-resolution";
import { parseShebangInterpreter, resolveOnPath } from "./path-utils";

const requireFromHere = createRequire(import.meta.url);

/** Cache fingerprint for a shim resolution: candidate shape + manager selection. */
const shimCacheFingerprint = (
  own: string,
  adapter: TManagerAdapter | undefined,
  candidate: string,
): string => {
  const sel = adapter?.fingerprint?.(candidate) ?? "";
  return `${own}|sel:${sel}`;
};

export {
  interpreterDirFor,
  launcherProfileFor,
  rememberInterpreterDir,
  rememberLauncherProfile,
} from "./launcher-profile-state";
export type {
  TLauncherKind,
  TLauncherProfile,
  TLauncherResolution,
} from "./launcher-resolution-types";
export { launcherProfileOf } from "./launcher-resolution-types";

export type TLauncherShellProbe = (
  cmd: string,
  opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<string | null>;

export type TResolveLauncherOpts = {
  /**
   * Explicit demand. Only a demand call may spawn the shell probe or a
   * manager-adapter subprocess. Passive default is false (passive).
   */
  readonly demand?: boolean;
  readonly signal?: AbortSignal;
  /** When true (and demand), try the login-shell `command -v` probe first. */
  readonly enableShellProbe?: boolean;
  /**
   * Extra dirs searched when resolving a shebang interpreter (e.g. the
   * login PATH captured by a probe). Defaults to the daemon spawn PATH.
   */
  readonly probePathDirs?: readonly string[];
};

export type TClassifyLauncherDeps = {
  readonly resolveInterpreter?: (
    name: string,
    pathDirs: readonly string[],
  ) => string | null;
  readonly pathDirs?: readonly string[];
};

export type TLauncherResolver = {
  readonly resolveLauncher: (
    candidate: string,
    opts?: TResolveLauncherOpts,
  ) => Promise<TLauncherResolution | null>;
  readonly peekLauncherResolution: (
    candidate: string,
  ) => TLauncherResolution | undefined;
  readonly invalidateLauncherResolution: (candidate: string) => void;
};

export type TCreateLauncherResolverDeps = {
  readonly managers?: TManagerRegistry;
  readonly shellProbe?: TLauncherShellProbe;
  readonly shellProbeTimeoutMs?: number;
  readonly resolveInterpreter?: (
    name: string,
    pathDirs: readonly string[],
  ) => string | null;
  readonly underManagerRoot?: (path: string) => boolean;
  /**
   * When true (default for the production resolver), seed the in-memory cache
   * from `<state>/launcher-resolution-cache.json` and write through on every
   * successful demand resolve. Hermetic tests pass `false` (or omit — tests
   * that want disk pass `true` explicitly with a temp state dir).
   */
  readonly persist?: boolean;
};

// ---------------------------------------------------------------------------
// Magic / fingerprint helpers
// ---------------------------------------------------------------------------

const HEADER_BYTES = 512;

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;
/** Mach-O 32/64 + fat (incl. byte-swapped). */
const MACHO_MAGICS: ReadonlyArray<ReadonlyArray<number>> = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];

const magicEquals = (buf: Buffer, magic: ReadonlyArray<number>): boolean => {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
};

const isNativeBinaryMagic = (buf: Buffer): boolean => {
  if (magicEquals(buf, ELF_MAGIC)) return true;
  return MACHO_MAGICS.some((m) => magicEquals(buf, m));
};

const readHeader = (path: string): Buffer | null => {
  let fd: number | null = null;
  try {
    if (!statSync(path).isFile()) return null;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

/** Cheap `mtimeMs:size` fingerprint; `null` when the path can't be statted. */
export const fileFingerprint = (path: string): string | null => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
};

const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
]);

/**
 * Known manager install-root path segments. Used only for the privacy-safe
 * `under_manager_root` boolean — never uploaded as a path.
 */
const MANAGER_ROOT_MARKERS: ReadonlyArray<readonly string[]> = [
  ["mise", "installs"],
  ["mise", "shims"],
  ["asdf", "installs"],
  ["asdf", "shims"],
  [".asdf", "installs"],
  [".asdf", "shims"],
  ["volta", "tools"],
  ["volta", "bin"],
  [".volta", "tools"],
  [".volta", "bin"],
  ["proto", "tools"],
  ["proto", "shims"],
  ["proto", "bin"],
  [".proto", "tools"],
  [".proto", "shims"],
  [".proto", "bin"],
];

export const pathUnderManagerRoot = (path: string): boolean => {
  const segments = path.split(sep);
  for (const marker of MANAGER_ROOT_MARKERS) {
    for (let i = 0; i + marker.length <= segments.length; i += 1) {
      let ok = true;
      for (let j = 0; j < marker.length; j += 1) {
        if (segments[i + j] !== marker[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
};

const defaultResolveInterpreter = (
  name: string,
  pathDirs: readonly string[],
): string | null => {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  for (const dir of pathDirs) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        accessSync(p, constants.X_OK);
        // Keep the PATH hit, not its realpath. cliEnv prepends
        // dirname(interpreter) so the child `#!/usr/bin/env X` can resolve X;
        // a mise/asdf shim realpaths to the manager binary's directory, which
        // does not contain X.
        return p;
      } catch {
        // keep scanning
      }
    }
  }
  // Fall through to the daemon's bounded PATH scan.
  const hits = resolveOnPath(name);
  return hits[0] !== undefined ? hits[0] : null;
};

const defaultPathDirs = (): string[] => {
  const home = process.env.HOME?.trim() || homedir();
  return [
    ...(process.env.PATH?.split(delimiter) ?? []),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((d) => d.length > 0);
};

/**
 * Classify an already-realpath'd file by content. Does NOT consult manager
 * adapters — callers that have a shim match short-circuit before this.
 */
export const classifyLauncherContent = (
  path: string,
  deps: TClassifyLauncherDeps = {},
): TLauncherResolution | null => {
  const header = readHeader(path);
  if (header === null) return null;
  const fp = fileFingerprint(path);
  if (fp === null) return null;
  const under = pathUnderManagerRoot(path);

  if (isNativeBinaryMagic(header)) {
    return {
      kind: "binary",
      path,
      fingerprint: fp,
      underManagerRoot: under,
    };
  }

  // Shebang?
  if (header.length >= 2 && header[0] === 0x23 && header[1] === 0x21) {
    let end = header.length;
    for (let i = 2; i < header.length; i += 1) {
      if (header[i] === 0x0a) {
        end = i;
        break;
      }
    }
    const shebangLine = Buffer.from(header.subarray(0, end)).toString("utf8");
    const interpToken = parseShebangInterpreter(shebangLine);
    if (interpToken === null) {
      return {
        kind: "wrapper",
        path,
        fingerprint: fp,
        underManagerRoot: under,
      };
    }
    const interpBase = basename(interpToken);
    if (SHELL_INTERPRETERS.has(interpBase)) {
      return {
        kind: "wrapper",
        path,
        fingerprint: fp,
        underManagerRoot: under,
      };
    }
    const pathDirs = deps.pathDirs ?? defaultPathDirs();
    const resolve = deps.resolveInterpreter ?? defaultResolveInterpreter;
    const interpreter = resolve(interpToken, pathDirs) ?? undefined;
    return {
      kind: "script",
      path,
      ...(interpreter !== undefined ? { interpreter } : {}),
      fingerprint: fp,
      underManagerRoot: under,
    };
  }

  // No shebang, no known native magic — treat as opaque wrapper (could be a
  // PE/Mach-O variant we don't recognise; keep runnable via the link as-is).
  return {
    kind: "wrapper",
    path,
    fingerprint: fp,
    underManagerRoot: under,
  };
};

// ---------------------------------------------------------------------------
// Login-shell probe
// ---------------------------------------------------------------------------

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Default `$SHELL -lc 'command -v <cmd>'` probe. Bounded, stdin closed, output
 * capped. Implemented with a direct `Bun.spawn` (not `runCaptureResult`) so
 * this module does not import `delegation/spawn` and create an init cycle
 * through `cli-paths`. Only an absolute-path single-line answer is accepted;
 * anything else (timeout, relative, multiline, failure) → null.
 */
export const defaultShellProbe: TLauncherShellProbe = async (
  cmd,
  opts,
): Promise<string | null> => {
  // Refuse anything that could break out of the single-quoted -c payload.
  if (!/^[A-Za-z0-9_+=.-]+$/.test(cmd)) return null;
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  if (!isAbsolute(shell) || !existsSync(shell)) return null;
  if (opts.signal?.aborted) return null;
  try {
    const proc = Bun.spawn([shell, "-lc", `command -v ${cmd}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const unbind =
      opts.signal !== undefined
        ? (() => {
            const onAbort = (): void => {
              try {
                proc.kill();
              } catch {
                // already dead
              }
            };
            opts.signal?.addEventListener("abort", onAbort, { once: true });
            return (): void =>
              opts.signal?.removeEventListener("abort", onAbort);
          })()
        : (): void => {};
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), opts.timeoutMs).unref?.();
    });
    const settled = await Promise.race([
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
      timeout,
    ]);
    if (settled === "timeout") {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      unbind();
      return null;
    }
    unbind();
    if (settled.code !== 0) return null;
    const raw = await new Response(proc.stdout).text();
    if (raw.length > 4_096) return null;
    const answer = raw.trim();
    if (answer.length === 0 || /[\r\n\0]/.test(answer)) return null;
    if (!isAbsolute(answer)) return null;
    return answer;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Resolver (demand-gated cache)
// ---------------------------------------------------------------------------

export const createLauncherResolver = (
  deps: TCreateLauncherResolverDeps = {},
): TLauncherResolver => {
  const shellProbe = deps.shellProbe ?? defaultShellProbe;
  let resolvedManagers: TManagerRegistry | undefined = deps.managers;
  /**
   * Sync manager load for peek (selection fingerprint) and demand resolve.
   * Lazy + createRequire (not a top-level import) so the
   * launcher-resolution → manager-resolution → spawn →
   * launcher-exec-invalidate → launcher-resolution init cycle stays broken.
   */
  const ensureManagers = (): TManagerRegistry => {
    if (resolvedManagers !== undefined) return resolvedManagers;
    const mod = requireFromHere("./manager-resolution") as {
      defaultManagerRegistry: TManagerRegistry;
    };
    resolvedManagers = mod.defaultManagerRegistry;
    return resolvedManagers;
  };
  const managersOf = async (): Promise<TManagerRegistry> => ensureManagers();
  const shellProbeTimeoutMs = (): number =>
    deps.shellProbeTimeoutMs ??
    envMs("OPENLLM_LAUNCHER_SHELL_PROBE_TIMEOUT_MS", 3_000);
  const resolveInterpreter =
    deps.resolveInterpreter ?? defaultResolveInterpreter;
  const underManagerRoot = deps.underManagerRoot ?? pathUnderManagerRoot;
  const persist = deps.persist === true;

  const cache = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly resolution: TLauncherResolution;
    }
  >();

  // Seed from disk once at construction (Phase 4 / L1 persist).
  if (persist) {
    for (const rec of loadLauncherResolutionCache()) {
      cache.set(rec.candidate, {
        fingerprint: rec.fingerprint,
        resolution: recordToResolution(rec),
      });
    }
  }

  const remember = (
    candidate: string,
    fingerprint: string,
    resolution: TLauncherResolution,
  ): void => {
    cache.set(candidate, { fingerprint, resolution });
    if (persist) persistLauncherResolution(candidate, resolution);
  };

  const peekLauncherResolution = (
    candidate: string,
  ): TLauncherResolution | undefined => {
    const hit = cache.get(candidate);
    if (hit === undefined) return undefined;
    const own = fileFingerprint(candidate);
    if (own === null) {
      cache.delete(candidate);
      if (persist) dropPersistedLauncherResolution(candidate);
      return undefined;
    }
    let expectedFp = own;
    if (hit.resolution.kind.startsWith("shim:")) {
      // Include the manager's selection fingerprint so `mise use -g` (shim
      // file unchanged, old target still on disk) invalidates the peek.
      const managers = ensureManagers();
      const adapter =
        managers.listManagerAdapters().find((a) => a.recognizes(candidate)) ??
        managers
          .listManagerAdapters()
          .find((a) => a.name === hit.resolution.adapterId);
      expectedFp = shimCacheFingerprint(own, adapter, candidate);
    }
    if (expectedFp !== hit.fingerprint) {
      cache.delete(candidate);
      if (persist) dropPersistedLauncherResolution(candidate);
      return undefined;
    }
    // Also invalidate when the RESOLVED target itself vanished. For ordinary
    // binaries the candidate IS the target (own fingerprint already compared).
    const targetFp = fileFingerprint(hit.resolution.path);
    if (targetFp === null) {
      cache.delete(candidate);
      if (persist) dropPersistedLauncherResolution(candidate);
      return undefined;
    }
    return hit.resolution;
  };

  const invalidateLauncherResolution = (candidate: string): void => {
    // Drop the candidate key AND any entry whose resolved path is the
    // failed target (host shim → resolved binary; isolated link → host).
    const doomed = new Set<string>([candidate]);
    for (const [key, hit] of cache) {
      if (key === candidate || hit.resolution.path === candidate) {
        doomed.add(key);
      }
    }
    for (const key of doomed) {
      cache.delete(key);
      if (persist) dropPersistedLauncherResolution(key);
    }
  };

  const resolveLauncher = async (
    candidate: string,
    opts?: TResolveLauncherOpts,
  ): Promise<TLauncherResolution | null> => {
    const demand = opts?.demand === true;
    if (!demand) {
      return peekLauncherResolution(candidate) ?? null;
    }

    let start = candidate;
    if (opts?.enableShellProbe === true && !isAbsolute(candidate)) {
      const probed = await shellProbe(candidate, {
        timeoutMs: shellProbeTimeoutMs(),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (probed !== null) start = probed;
      else return null;
    }
    if (!isAbsolute(start) || !existsSync(start)) return null;

    // Fingerprint the candidate BEFORE any await so a concurrent mutation
    // during manager resolve cannot be cached under the new shape.
    const fingerprintBefore = fileFingerprint(start);

    let real: string;
    try {
      real = realpathSync(start);
    } catch {
      return null;
    }

    // Manager shim? Prefer adapter resolution (unsandboxed) over treating
    // the shim script as a wrapper.
    const managers = await managersOf();
    const managed = await managers.resolveManagerCandidate(start, {
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (managed.kind === "unresolved") return null;
    if (managed.kind === "resolved" && managed.target !== null) {
      let targetReal: string;
      try {
        targetReal = realpathSync(managed.target);
      } catch {
        return null;
      }
      const adapter =
        managers.listManagerAdapters().find((a) => a.recognizes(start)) ??
        managers
          .listManagerAdapters()
          .find((a) => a.name === managed.identity?.split(":")[0]);
      const adapterName =
        managed.identity?.split(":")[0] ?? adapter?.name ?? "manager";
      const classified = classifyLauncherContent(targetReal, {
        resolveInterpreter,
        pathDirs: opts?.probePathDirs ?? defaultPathDirs(),
      });
      // Prefer the manager's answer even when the target is itself a script;
      // the kind is still shim:<adapter> so telemetry knows a manager ran.
      const own = fingerprintBefore ?? fileFingerprint(start);
      if (own === null) return null;
      // Fold selection state into the cache fingerprint so a plain
      // `mise use -g` (shim bytes unchanged) invalidates passive peeks.
      const fp = shimCacheFingerprint(own, adapter, start);
      const resolution: TLauncherResolution = {
        kind: `shim:${adapterName}`,
        path: targetReal,
        adapterId: adapterName,
        fingerprint: fp,
        underManagerRoot:
          underManagerRoot(targetReal) || underManagerRoot(start),
        ...(classified?.interpreter !== undefined
          ? { interpreter: classified.interpreter }
          : {}),
      };
      const fingerprintAfter = fileFingerprint(start);
      if (fingerprintAfter === fingerprintBefore) {
        remember(start, fp, resolution);
        if (start !== candidate) remember(candidate, fp, resolution);
      }
      return resolution;
    }

    // Ordinary path — classify the realpath'd file.
    const classified = classifyLauncherContent(real, {
      resolveInterpreter,
      pathDirs: opts?.probePathDirs ?? defaultPathDirs(),
    });
    if (classified === null) return null;
    const fingerprintAfter = fileFingerprint(start);
    if (fingerprintAfter === fingerprintBefore) {
      remember(start, classified.fingerprint, classified);
      if (start !== candidate) {
        remember(candidate, classified.fingerprint, classified);
      }
    }
    return classified;
  };

  return {
    resolveLauncher,
    peekLauncherResolution,
    invalidateLauncherResolution,
  };
};

/**
 * Production resolver (default manager registry + real shell probe + disk
 * persistence). Lazily constructed on first access so module init cannot race
 * the manager-resolution registry's own initialization.
 */
let cachedDefaultResolver: TLauncherResolver | undefined;
export const defaultLauncherResolver: TLauncherResolver = {
  resolveLauncher: (candidate, opts) => {
    cachedDefaultResolver ??= createLauncherResolver({ persist: true });
    return cachedDefaultResolver.resolveLauncher(candidate, opts);
  },
  peekLauncherResolution: (candidate) => {
    cachedDefaultResolver ??= createLauncherResolver({ persist: true });
    return cachedDefaultResolver.peekLauncherResolution(candidate);
  },
  invalidateLauncherResolution: (candidate) => {
    cachedDefaultResolver ??= createLauncherResolver({ persist: true });
    cachedDefaultResolver.invalidateLauncherResolution(candidate);
  },
};
