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
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { envMs } from "./env-ms";
import { registerLauncherResolutionInvalidator } from "./launcher-invalidate-hook";
import {
  dropPersistedLauncherResolution,
  loadLauncherResolutionCache,
  persistLauncherResolution,
  recordToResolution,
} from "./launcher-resolution-cache";
import type { TLauncherResolution } from "./launcher-resolution-types";
import { allManagerRootMarkers } from "./launcher-roots";
import type { TManagerAdapter, TManagerRegistry } from "./manager-resolution";
import { defaultManagerRegistry } from "./manager-resolution";
import {
  fileFingerprint,
  managerPackagerBinDirs,
  parseShebangInterpreter,
  readExecutableHeader,
  resolveOnPath,
  spawnPathDirs,
} from "./path-utils";

export { fileFingerprint };

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

/** Reuses {@link readExecutableHeader} so a prior `isHostCliRunnable` hit is free. */
const readHeader = (path: string): Buffer | null => readExecutableHeader(path);

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
 * `under_manager_root` boolean — never uploaded as a path. Derived from
 * {@link allManagerRootMarkers}.
 */
const MANAGER_ROOT_MARKERS: ReadonlyArray<readonly string[]> =
  allManagerRootMarkers();

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

/**
 * Dirs searched when classifying a shebang interpreter at DEMAND time:
 * the daemon spawn PATH ({@link spawnPathDirs}) plus manager/packager shim
 * bins so resolution can prove a need. Those manager dirs are NOT on every
 * spawn PATH; a proven interpreter dir is prepended per provider via `cliEnv`.
 */
const defaultPathDirs = (): string[] => [
  ...spawnPathDirs(),
  ...managerPackagerBinDirs(),
];

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

const SHELL_PROBE_MAX_BYTES = 4_096;

const killShellProbeTree = (proc: ReturnType<typeof Bun.spawn>): void => {
  // Prefer the process group so a login-shell rc that backgrounds a helper
  // holding stdout cannot outlive the probe (CodeRabbit 4341596181).
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // Not a group leader / already reaped — fall through to the root pid.
    }
  }
  try {
    proc.kill();
  } catch {
    // already dead
  }
};

/**
 * Read stdout up to `maxBytes`, racing against `deadlineMs` from now. Stops
 * early on EOF, byte cap, or deadline — never awaits an unbounded stream
 * drain after the child has already exited with a background holder on the
 * pipe.
 */
const readStdoutCapped = async (
  stdout: ReadableStream<Uint8Array> | number | null | undefined,
  maxBytes: number,
  deadlineMs: number,
): Promise<string | null> => {
  if (stdout === null || stdout === undefined || typeof stdout === "number") {
    return null;
  }
  const reader = stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadlineAt = Date.now() + Math.max(0, deadlineMs);
  // The shell already exited before this reader runs; a newline-terminated
  // buffered line is its complete answer even when a background helper still
  // holds the pipe open past the deadline.
  const partial = (): string | null => {
    if (total === 0) return null;
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      "utf8",
    );
    return text.includes("\n") ? text : null;
  };
  try {
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return partial();
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), remaining).unref?.();
        }),
      ]);
      if (next === "timeout") return partial();
      if (next.done) break;
      const value = next.value;
      if (value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) return null;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  if (total === 0) return "";
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
};

/**
 * Default `$SHELL -lc 'command -v <cmd>'` probe. Bounded, stdin closed, output
 * capped. Implemented with a direct `Bun.spawn` (not `runCaptureResult`) so
 * this module does not import `delegation/spawn` and create an init cycle
 * through `cli-paths`. Only an absolute-path single-line answer is accepted;
 * anything else (timeout, relative, multiline, failure) → null.
 *
 * The stdout read is raced against the remaining timeout and capped at
 * {@link SHELL_PROBE_MAX_BYTES}: a login-shell rc that backgrounds a process
 * holding stdout must not hang `openllm doctor launchers` forever
 * (CodeRabbit 4341596181). On timeout the process group is SIGKILL'd.
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
      // New session/process group so timeout can SIGKILL the whole tree.
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    const unbind =
      opts.signal !== undefined
        ? (() => {
            const onAbort = (): void => {
              killShellProbeTree(proc);
            };
            opts.signal?.addEventListener("abort", onAbort, { once: true });
            return (): void =>
              opts.signal?.removeEventListener("abort", onAbort);
          })()
        : (): void => {};
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), opts.timeoutMs).unref?.();
    });
    // Start the capped read immediately so the shell's newline-terminated
    // answer is buffered even when a background rc helper holds the pipe
    // open past exit (deadline then returns the partial line).
    const rawPromise = readStdoutCapped(
      proc.stdout,
      SHELL_PROBE_MAX_BYTES,
      opts.timeoutMs,
    );
    const settled = await Promise.race([
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
      timeout,
    ]);
    if (settled === "timeout") {
      killShellProbeTree(proc);
      unbind();
      await rawPromise.catch(() => null);
      return null;
    }
    const raw = await rawPromise;
    // The shell has exited; reap any rc-spawned helper still in its group
    // (deadline-truncated reads return a non-null line and used to skip this).
    killShellProbeTree(proc);
    unbind();
    if (raw === null) return null;
    if (settled.code !== 0) return null;
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
  // Static import is safe: launcher-exec-invalidate no longer imports this
  // module (it goes through launcher-invalidate-hook), so the old
  // launcher-resolution → manager-resolution → spawn →
  // launcher-exec-invalidate → launcher-resolution cycle is gone.
  const managers: TManagerRegistry = deps.managers ?? defaultManagerRegistry;
  const shellProbeTimeoutMs = (): number =>
    deps.shellProbeTimeoutMs ??
    envMs("OPENLLM_LAUNCHER_SHELL_PROBE_TIMEOUT_MS", 3_000);
  const resolveInterpreter =
    deps.resolveInterpreter ?? defaultResolveInterpreter;
  const underManagerRoot = deps.underManagerRoot ?? pathUnderManagerRoot;
  const persist = deps.persist === true;

  /**
   * Prefer a real interpreter next to the unresolved launcher (npm globals:
   * `<prefix>/bin/codex` → package script, with `node` beside the launcher),
   * then beside the realpath'd script, else resolve a recognized manager shim
   * on the demand path so `cliEnv` does not put an isolated-HOME-blind shim
   * dir first on PATH.
   */
  const refineScriptInterpreter = async (
    scriptReal: string,
    interpreter: string | undefined,
    signal?: AbortSignal,
    launcherPath?: string,
  ): Promise<string | undefined> => {
    if (interpreter === undefined) return undefined;
    // Realpath each search dir (the directory itself — not the launcher
    // symlink) so macOS /var vs /private/var collapses, while npm-global
    // layouts still see `<prefix>/bin` before the package script dir.
    const searchDir = (filePath: string): string => {
      const dir = dirname(filePath);
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    };
    const launcherDirs =
      launcherPath !== undefined ? [launcherPath] : ([] as string[]);
    const dirs = [...launcherDirs, scriptReal].map((p) => ({
      raw: dirname(p),
      real: searchDir(p),
    }));
    // A manager shim is never a usable interpreter: under the isolated
    // HOME/XDG it can't read the user's version selection. That includes a
    // sibling — `mise use -g npm:…` puts the `node` shim right beside the
    // launcher shim — so skip recognized siblings and fall through. Check
    // both spellings of the dir: the realpath (macOS /var → /private/var)
    // can differ from the path an adapter was configured with.
    const isManagerShim = (path: string): boolean =>
      managers
        .listManagerAdapters()
        .some((adapter) => adapter.recognizes(path));
    const seen = new Set<string>();
    for (const { raw, real } of dirs) {
      if (seen.has(real)) continue;
      seen.add(real);
      const name = basename(interpreter);
      if (isManagerShim(join(raw, name)) || isManagerShim(join(real, name))) {
        continue;
      }
      const sibling = join(real, name);
      try {
        accessSync(sibling, constants.X_OK);
        return sibling;
      } catch {
        // try next / fall through to manager resolution
      }
    }
    if (!isManagerShim(interpreter)) return interpreter;
    const viaManager = await managers.resolveManagerCandidate(interpreter, {
      ...(signal !== undefined ? { signal } : {}),
    });
    if (viaManager.kind === "resolved" && viaManager.target !== null) {
      return viaManager.target;
    }
    return interpreter;
  };

  const cache = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly resolution: TLauncherResolution;
    }
  >();

  // Persist is lazy: first memory miss for a candidate may load the durable
  // file (once per state dir). Construction of persist:true resolvers —
  // including the process-wide default used by passive peeks — must not
  // synchronously read launcher-resolution-cache.json for every user.

  const remember = (
    candidate: string,
    fingerprint: string,
    resolution: TLauncherResolution,
  ): void => {
    cache.set(candidate, { fingerprint, resolution });
    if (persist) persistLauncherResolution(candidate, resolution);
  };

  const seedFromPersist = (candidate: string): boolean => {
    if (!persist) return false;
    const rec = loadLauncherResolutionCache().find(
      (r) => r.candidate === candidate,
    );
    if (rec === undefined) return false;
    cache.set(candidate, {
      fingerprint: rec.fingerprint,
      resolution: recordToResolution(rec),
    });
    return true;
  };

  const peekLauncherResolution = (
    candidate: string,
  ): TLauncherResolution | undefined => {
    let hit = cache.get(candidate);
    if (hit === undefined) {
      if (!seedFromPersist(candidate)) return undefined;
      hit = cache.get(candidate);
      if (hit === undefined) return undefined;
    }
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
    const selectionAdapterBefore = managers
      .listManagerAdapters()
      .find((a) => a.recognizes(start));
    const shimFpBefore =
      fingerprintBefore === null
        ? null
        : shimCacheFingerprint(
            fingerprintBefore,
            selectionAdapterBefore,
            start,
          );

    let real: string;
    try {
      real = realpathSync(start);
    } catch {
      return null;
    }

    // Manager shim? Prefer adapter resolution (unsandboxed) over treating
    // the shim script as a wrapper.
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
      const interpreter = await refineScriptInterpreter(
        targetReal,
        classified?.interpreter,
        opts?.signal,
        start,
      );
      const resolution: TLauncherResolution = {
        kind: `shim:${adapterName}`,
        path: targetReal,
        adapterId: adapterName,
        fingerprint: fp,
        underManagerRoot:
          underManagerRoot(targetReal) || underManagerRoot(start),
        ...(interpreter !== undefined ? { interpreter } : {}),
      };
      const fingerprintAfter = fileFingerprint(start);
      // Mirror resolveManagerCandidate: only cache when the pre-await
      // selection fingerprint is still current.
      if (fingerprintAfter === fingerprintBefore && fp === shimFpBefore) {
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
    const interpreter = await refineScriptInterpreter(
      real,
      classified.interpreter,
      opts?.signal,
      start,
    );
    const resolution: TLauncherResolution =
      interpreter === classified.interpreter
        ? classified
        : {
            ...classified,
            ...(interpreter !== undefined ? { interpreter } : {}),
          };
    const fingerprintAfter = fileFingerprint(start);
    if (fingerprintAfter === fingerprintBefore) {
      remember(start, resolution.fingerprint, resolution);
      if (start !== candidate) {
        remember(candidate, resolution.fingerprint, resolution);
      }
    }
    return resolution;
  };

  return {
    resolveLauncher,
    peekLauncherResolution,
    invalidateLauncherResolution,
  };
};

/**
 * Production resolver (default manager registry + real shell probe + disk
 * persistence). Lazily constructed on first access.
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

// Register after the proxy exists so spawn-side invalidation never needs to
// import this module (see launcher-invalidate-hook.ts).
registerLauncherResolutionInvalidator((candidate) => {
  defaultLauncherResolver.invalidateLauncherResolution(candidate);
});
