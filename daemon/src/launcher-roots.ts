/**
 * Single source of truth for version-manager / packager install roots.
 *
 * Consumers (spawn PATH candidates for RESOLUTION, child data-root env,
 * sandbox RO grants, privacy markers, manager-bin candidates) MUST derive
 * from this module — do not re-list mise/asdf/volta/proto/fnm/nix/… elsewhere.
 *
 * Built on {@link misePaths} for mise's XDG-aware layout; other managers keep
 * their documented default roots here.
 */
import { join } from "node:path";
import { DOCTOR_LAUNCHER_ADAPTERS } from "@openllmsh/protocol";
import { misePaths } from "./mise-paths";

/** The four shim adapters doctor + manager-resolution share — never re-list. */
export const SHIM_LAUNCHER_ADAPTERS = DOCTOR_LAUNCHER_ADAPTERS;

const nonEmpty = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t !== undefined && t.length > 0 ? t : undefined;
};

export type TLauncherManagerId =
  | "mise"
  | "asdf"
  | "volta"
  | "proto"
  | "fnm"
  | "nix"
  | "linuxbrew"
  | "snap"
  | "npm";

export type TLauncherManagerSpec = {
  readonly id: TLauncherManagerId;
  /**
   * Env var that relocates the manager's data/home root, when one exists.
   * `null` for system-scoped managers (nix/linuxbrew/snap) or npm's prefix.
   */
  readonly dataRootEnvVar: string | null;
  /** Absolute data/home root, or `null` when not applicable / unknown. */
  readonly dataRoot: (home: string, env: NodeJS.ProcessEnv) => string | null;
  /** Shim dirs that belong on a RESOLUTION search PATH when they exist. */
  readonly shimDirs: (
    home: string,
    env: NodeJS.ProcessEnv,
  ) => readonly string[];
  /** Bin dirs (non-shim) for RESOLUTION search PATH / sandbox. */
  readonly binDirs: (home: string, env: NodeJS.ProcessEnv) => readonly string[];
  /**
   * Absolute paths to the manager's own CLI (`mise`, `asdf`, …), checked
   * before a bare PATH scan. Empty when the manager has no dedicated binary
   * we invoke (fnm/nix/linuxbrew/snap/npm).
   */
  readonly managerBinCandidates: (
    home: string,
    env: NodeJS.ProcessEnv,
  ) => readonly string[];
  /**
   * Path-segment markers used only for the privacy-safe
   * `under_manager_root` boolean — never uploaded as a path.
   */
  readonly rootMarkers: ReadonlyArray<readonly string[]>;
};

const asdfDataRoot = (home: string, env: NodeJS.ProcessEnv): string =>
  nonEmpty(env.ASDF_DATA_DIR) ?? join(home, ".asdf");

const voltaDataRoot = (home: string, env: NodeJS.ProcessEnv): string =>
  nonEmpty(env.VOLTA_HOME) ?? join(home, ".volta");

const protoDataRoot = (home: string, env: NodeJS.ProcessEnv): string =>
  nonEmpty(env.PROTO_HOME) ?? join(home, ".proto");

/**
 * Ordered fnm data-root candidates matching Schniz/fnm `directories.rs`
 * `default_base_dir`: explicit `FNM_DIR`, else modern XDG
 * (`$XDG_DATA_HOME/fnm` or `~/.local/share/fnm`), legacy `~/.fnm`, and on
 * macOS the install-script / Apple-strategy path under Application Support.
 * Callers existence-filter; fnm itself picks the first existing, else modern.
 */
export const fnmDataRootCandidates = (
  home: string,
  env: NodeJS.ProcessEnv,
): readonly string[] => {
  const explicit = nonEmpty(env.FNM_DIR);
  if (explicit !== undefined) return [explicit];
  const modern = join(
    nonEmpty(env.XDG_DATA_HOME) ?? join(home, ".local", "share"),
    "fnm",
  );
  const out: string[] = [modern, join(home, ".fnm")];
  if (process.platform === "darwin") {
    out.push(join(home, "Library", "Application Support", "fnm"));
  }
  return out;
};

/** Primary fnm root (FNM_DIR or the modern XDG default create-target). */
const fnmDataRoot = (home: string, env: NodeJS.ProcessEnv): string | null =>
  fnmDataRootCandidates(home, env)[0] ?? null;

export const LAUNCHER_MANAGERS: readonly TLauncherManagerSpec[] = [
  {
    id: "mise",
    dataRootEnvVar: "MISE_DATA_DIR",
    dataRoot: (home, env) => misePaths(home, env).dataDir,
    shimDirs: (home, env) => [join(misePaths(home, env).dataDir, "shims")],
    binDirs: (home, env) => [join(misePaths(home, env).dataDir, "bin")],
    managerBinCandidates: (home, env) => {
      const data = misePaths(home, env).dataDir;
      return [join(home, ".local", "bin", "mise"), join(data, "bin", "mise")];
    },
    rootMarkers: [
      ["mise", "installs"],
      ["mise", "shims"],
    ],
  },
  {
    id: "asdf",
    dataRootEnvVar: "ASDF_DATA_DIR",
    dataRoot: asdfDataRoot,
    shimDirs: (home, env) => [join(asdfDataRoot(home, env), "shims")],
    binDirs: (home, env) => [join(asdfDataRoot(home, env), "bin")],
    managerBinCandidates: (home, env) => [
      join(asdfDataRoot(home, env), "bin", "asdf"),
    ],
    rootMarkers: [
      ["asdf", "installs"],
      ["asdf", "shims"],
      [".asdf", "installs"],
      [".asdf", "shims"],
    ],
  },
  {
    id: "volta",
    dataRootEnvVar: "VOLTA_HOME",
    dataRoot: voltaDataRoot,
    shimDirs: () => [],
    binDirs: (home, env) => [join(voltaDataRoot(home, env), "bin")],
    managerBinCandidates: (home, env) => [
      join(voltaDataRoot(home, env), "bin", "volta"),
    ],
    rootMarkers: [
      ["volta", "tools"],
      ["volta", "bin"],
      [".volta", "tools"],
      [".volta", "bin"],
    ],
  },
  {
    id: "proto",
    dataRootEnvVar: "PROTO_HOME",
    dataRoot: protoDataRoot,
    shimDirs: (home, env) => [join(protoDataRoot(home, env), "shims")],
    binDirs: (home, env) => [join(protoDataRoot(home, env), "bin")],
    managerBinCandidates: (home, env) => [
      join(protoDataRoot(home, env), "bin", "proto"),
    ],
    rootMarkers: [
      ["proto", "tools"],
      ["proto", "shims"],
      ["proto", "bin"],
      [".proto", "tools"],
      [".proto", "shims"],
      [".proto", "bin"],
    ],
  },
  {
    id: "fnm",
    dataRootEnvVar: "FNM_DIR",
    dataRoot: fnmDataRoot,
    // Default alias bin is a real node dir (not a shim wrapper).
    shimDirs: () => [],
    binDirs: (home, env) =>
      fnmDataRootCandidates(home, env).map((root) =>
        join(root, "aliases", "default", "bin"),
      ),
    managerBinCandidates: () => [],
    rootMarkers: [],
  },
  {
    id: "nix",
    dataRootEnvVar: null,
    dataRoot: (home) => join(home, ".nix-profile"),
    shimDirs: () => [],
    binDirs: (home) => [
      join(home, ".nix-profile", "bin"),
      "/nix/var/nix/profiles/default/bin",
    ],
    managerBinCandidates: () => [],
    rootMarkers: [],
  },
  {
    id: "linuxbrew",
    dataRootEnvVar: null,
    dataRoot: (home) => join(home, ".linuxbrew"),
    shimDirs: () => [],
    binDirs: (home) => [
      "/home/linuxbrew/.linuxbrew/bin",
      join(home, ".linuxbrew", "bin"),
    ],
    managerBinCandidates: () => [],
    rootMarkers: [],
  },
  {
    id: "snap",
    dataRootEnvVar: null,
    dataRoot: () => "/snap",
    shimDirs: () => [],
    binDirs: () => ["/snap/bin"],
    managerBinCandidates: () => [],
    rootMarkers: [],
  },
  {
    id: "npm",
    dataRootEnvVar: "npm_config_prefix",
    dataRoot: (_home, env) =>
      nonEmpty(env.npm_config_prefix) ??
      nonEmpty(env.NPM_CONFIG_PREFIX) ??
      null,
    shimDirs: () => [],
    binDirs: (_home, env) => {
      const prefix =
        nonEmpty(env.npm_config_prefix) ?? nonEmpty(env.NPM_CONFIG_PREFIX);
      return prefix !== undefined ? [join(prefix, "bin")] : [];
    },
    managerBinCandidates: () => [],
    rootMarkers: [],
  },
];

export const launcherManagerById = (
  id: TLauncherManagerId,
): TLauncherManagerSpec => {
  const hit = LAUNCHER_MANAGERS.find((m) => m.id === id);
  if (hit === undefined) {
    throw new Error(`unknown launcher manager: ${id}`);
  }
  return hit;
};

/** Shim + bin dirs every manager exposes for RESOLUTION PATH scans. */
export const allManagerResolutionBinDirs = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of LAUNCHER_MANAGERS) {
    for (const d of [...m.shimDirs(home, env), ...m.binDirs(home, env)]) {
      if (d.length === 0 || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out;
};

/**
 * Data/home roots granted read-only to sandboxed children so shims can still
 * FIND installs after XDG isolation. Includes mise's config/state/cache via
 * {@link misePaths} (needed to read `config.toml`).
 */
export const allManagerDataRoots = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (d: string | null | undefined): void => {
    if (d === null || d === undefined || d.length === 0 || seen.has(d)) return;
    seen.add(d);
    out.push(d);
  };
  const mise = misePaths(home, env);
  push(mise.configDir);
  push(mise.dataDir);
  push(mise.stateDir);
  push(mise.cacheDir);
  for (const m of LAUNCHER_MANAGERS) {
    if (m.id === "mise" || m.id === "snap" || m.id === "npm") continue;
    // fnm may live under XDG, legacy ~/.fnm, or (macOS) Application Support —
    // grant every candidate; launcherDataRoots existence-filters.
    if (m.id === "fnm") {
      for (const root of fnmDataRootCandidates(home, env)) push(root);
      continue;
    }
    push(m.dataRoot(home, env));
    if (m.id === "nix") {
      push("/nix/var/nix/profiles/default");
      // Profile bin entries symlink into the store; Landlock O_PATH on the
      // profile grants only the resolved user-env dir, so grant the store RO
      // (existence-filtered by launcherDataRoots — never RW).
      push("/nix/store");
    }
    if (m.id === "linuxbrew") push("/home/linuxbrew/.linuxbrew");
  }
  return out;
};

/**
 * Env vars passed into the isolated child so version-manager shims can find
 * installs after `XDG_*` redirection. Manager resolution still uses ambient
 * `process.env`; the child only inherits these pointers.
 *
 * `FNM_DIR` is passthrough-only (no default) — the default alias bin is
 * PATH-added directly when present. Everyone else defaults to the real-home
 * root when that directory exists (caller existence-filters).
 */
export const buildLauncherDataRootEnv = (
  ambient: NodeJS.ProcessEnv,
  realHome: string,
  exists: (path: string) => boolean,
): Record<string, string> => {
  const out: Record<string, string> = {};
  const pass = (key: string): void => {
    const v = nonEmpty(ambient[key]);
    if (v !== undefined) out[key] = v;
  };
  const passOrDefault = (key: string, fallback: string): void => {
    const v = nonEmpty(ambient[key]);
    if (v !== undefined) out[key] = v;
    else if (exists(fallback)) out[key] = fallback;
  };

  passOrDefault("ASDF_DATA_DIR", asdfDataRoot(realHome, ambient));
  passOrDefault("VOLTA_HOME", voltaDataRoot(realHome, ambient));
  passOrDefault("PROTO_HOME", protoDataRoot(realHome, ambient));
  pass("FNM_DIR");
  passOrDefault("MISE_DATA_DIR", misePaths(realHome, ambient).dataDir);
  return out;
};

/** Privacy-safe path-segment markers for `under_manager_root`. */
export const allManagerRootMarkers = (): ReadonlyArray<readonly string[]> => {
  const out: Array<readonly string[]> = [];
  for (const m of LAUNCHER_MANAGERS) {
    for (const marker of m.rootMarkers) out.push(marker);
  }
  return out;
};
