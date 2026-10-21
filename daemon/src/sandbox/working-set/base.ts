/**
 * Working-set FOUNDATIONS — shared helpers + the base grant set every daemon
 * sub-process layer sits on top of. See `./index.ts` for the composition and
 * `docs/proposals/daemon-subprocess-isolation.md` §3.1 for the layer split.
 *
 * This module holds the pieces that are NOT specific to any one sub-process
 * layer:
 *   - the `TWorkingSet` shape,
 *   - the path-safety helpers (`existing`, `SENSITIVE_ROOTS`) both layers and
 *     the sandbox backends rely on,
 *   - the dynamic vendor-CLI exec-dir resolver (`resolveCliExecDirs`) + the
 *     hardcoded vendor exec-dir floor (`vendorExecDirs`) — shared because BOTH
 *     the `auth-state` layer (login/usage delegation) and the
 *     `vendor-cli-tunnel` layer (device PTY sessions) exec the vendor CLIs,
 *   - `daemonTempDir`,
 *   - `baseWorkingSet()` — the state dir, the daemon-owned temp, the binary's
 *     own dir, `/dev`, and the read-only system trees: everything shared by all
 *     four layers (the parent supervisor lives here too).
 *
 * The layer modules (`auth-state.ts`, `browser-chat.ts`, `fleet.ts`,
 * `vendor-cli-tunnel.ts`) import from here; they NEVER import each other, so no
 * process can pull in another layer's working set (R2-T9).
 *
 * Original single-file rationale (2026-07-03 working-set-exposure audit
 * §5-A/B/C and the `daemon-os-sandbox-and-typed-control.md` §3.1 derivation)
 * moves here verbatim — it is load-bearing audit trail:
 *
 *   read-write
 *     - the state dir (`~/.openllm`): the shared .env (0600, holds the key + device
 *       id + config) and state.json, logs, the isolated vendor CLIs under `cli/<provider>/`
 *       (homes + binaries + config), AND the daemon binary itself + its
 *       atomic-swap temp (`bin/openllmd`, `.openllmd.update.<pid>.tmp` —
 *       the installer places the binary inside the state dir);
 *     - the executable's real directory (belt-and-braces when `execPath`
 *       lives outside the state dir — a manual install);
 *     - the claude XDG STATE + CACHE dirs (isolated claude writes these at run
 *       time on Linux; absent on macOS) — SCOPED to the claude subdirs;
 *     - bun's global install cache (`~/.bun/install/cache`) — the RW half of the
 *       split `~/.bun` grant (the bin dir is read+exec only).
 *
 *   read-only
 *     - the system trees the runtime + spawned tools (`bash`, `curl`, the
 *       vendor CLIs' loaders) need: `/usr`, `/lib*`, `/bin`, `/sbin`, `/opt`,
 *       `/etc` (resolv.conf + TLS trust), `/proc`, `/sys`, `/run`, `/var`;
 *     - the vendor-CLI binary dirs — READ+EXEC only (the daemon runs the CLIs
 *       but never installs or updates them; that is user-run + unsandboxed);
 *     - `~/.bun/bin` (exec `bun` — read+exec only, launcher-trojan guard).
 *
 *   deny (implicit — everything else, notably the rest of `$HOME`)
 *     - `~/.ssh`, `~/.aws`, `~/.gnupg`, browser profiles, documents,
 *       `~/.claude/.credentials.json`, the shell rc files (`~/.zshrc` etc.),
 *       and WRITES to the provider-CLI binary dirs.
 *
 * Note the system `/tmp` is deliberately NOT granted (granting it would leak
 * every other process's temp files — and the user unit no longer sets
 * `PrivateTmp=yes`, which broke `--user` units). Instead the daemon owns
 * `<state>/tmp` (`daemonTempDir()`, granted as part of the state dir) and
 * points every isolated CLI's `TMPDIR` at it (`cli-paths.ts` `cliEnv`), so the
 * codex/kimi installers' `mktemp -d` stages inside the working set rather than
 * EACCESing on the ungranted `/tmp`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CLI_PROVIDERS, cliBin, hostCliCandidates } from "../../cli-paths";
import { stateDir } from "../../env";
import { misePaths } from "../../mise-paths";
import { DAEMON_VERSION } from "../../version";

export type TWorkingSet = {
  /** Paths (recursive) the daemon and its children may read AND write. */
  readonly readWrite: readonly string[];
  /** Paths (recursive) the daemon and its children may read + execute. */
  readonly readOnly: readonly string[];
};

/** Walk up to the nearest existing ancestor for each path. Landlock's
 *  `open(O_PATH)` fails on a missing path; granting a not-yet-created target
 *  directly is meaningless, but we must grant an existing ancestor so the
 *  bootstrap install/setup scripts can CREATE the missing target. For first-run
 *  bootstrap targets like ~/.claude that don't yet exist, this walks up to the
 *  existing parent (e.g. ~/.local/) and grants that, letting the install mkdir.
 *
 *  SECURITY: stops at the user's home directory AND at the filesystem root,
 *  returning the original path unchanged when the target doesn't exist and
 *  would climb to or above either. This prevents widening grants to the entire
 *  home directory — or the entire filesystem — when a bootstrap or system
 *  target is missing (e.g. `/lib64`, absent on arm64 Linux, would otherwise
 *  climb to `/` and grant the whole root tree). Callers must pre-create
 *  bootstrap targets or handle the grant failure. */
/** Secret-bearing `$HOME` roots whose contents must NEVER be granted wholesale.
 *  A scoped grant like `~/.bun/install/cache`, `~/.grok/{bin,downloads}`,
 *  `~/.config/raycast/ai`, or any `~/.claude/*` subtree is fine, but the BARE
 *  root holds the secrets the scoping exists to keep out: `~/.bun/bin` (write =
 *  §5-B launcher trojan), `~/.grok/auth.json`, `~/.config`'s gcloud/gh tokens,
 *  and `~/.claude/.credentials.json` (the §5-A Linux OAuth token). Shared by
 *  `existing()` (no-climb into a root when a scoped leaf is missing) and
 *  `resolveCliExecDirs()` (never grant a bare root a symlink chain resolves
 *  into). `~/.cache`/`~/.local` are deliberately NOT here — `~/.cache/openllm`
 *  legitimately climbs to `~/.cache` (documented + tested, no secrets). */
export const SENSITIVE_ROOTS = (home: string): readonly string[] => [
  join(home, ".bun"),
  join(home, ".grok"),
  join(home, ".config"),
  join(home, ".claude"),
];

export const existing = (paths: readonly string[]): string[] => {
  const home = homedir();
  const sensitiveRoots = SENSITIVE_ROOTS(home);
  const underSensitiveRoot = (p: string): boolean =>
    sensitiveRoots.some((root) => p.startsWith(`${root}/`));
  return paths.map((p) => {
    // Exact/no-climb for scoped grants beneath a secret-bearing root: a missing
    // leaf is DROPPED (returned unchanged → fails to grant safely), never
    // substituted by its parent.
    if (!existsSync(p) && underSensitiveRoot(p)) {
      return p;
    }
    let candidate = p;
    while (candidate !== "/" && !existsSync(candidate)) {
      const parent = dirname(candidate);
      // Stop climbing at home OR root: do NOT return home (or `/`) as the
      // granted ancestor when the original target didn't exist — that would
      // widen the grant to the whole home tree or the entire filesystem.
      // Return the original path instead so callers can pre-create it or handle
      // the missing grant.
      if ((parent === home || parent === "/") && candidate !== home) {
        return p; // original path (non-existent, will fail to grant)
      }
      candidate = parent;
    }
    return candidate;
  });
};

/** Max symlink hops to follow before giving up — bounds a pathological or
 *  cyclic chain (a real launcher is 0-2 hops). */
const MAX_SYMLINK_HOPS = 16;

/**
 * Resolve the directories a spawned vendor CLI must be able to READ+EXEC, by
 * FOLLOWING the launcher's symlink chain from `seed`. The daemon execs the
 * launcher and the kernel reads THROUGH every symlink to the real ELF, so each
 * dir along the way must be granted or the spawn EACCESes. Hardcoding these is
 * brittle — each vendor buries its real binary in a different, sometimes
 * version-specific, dir (claude `~/.local/share/claude/versions/<v>`, codex
 * `~/.codex/packages/standalone/releases/<v>-<arch>/bin` behind a `current` DIR
 * symlink, grok `~/.grok/downloads/grok-<arch>` behind `~/.grok/bin/grok`), and
 * a custom install dir (`GROK_BIN_DIR`, `CODEX_HOME`, …) moves them anywhere.
 * Following the ACTUAL chain is self-correcting.
 *
 * Two passes, both needed:
 *   1. per-hop walk (`lstat`→`readlink`) collecting `dirname()` of every node —
 *      catches FILE-symlink chains;
 *   2. `dirname(realpath(seed))` — catches INTERMEDIATE DIR symlinks a file walk
 *      steps over (codex's `current → releases/<v>`).
 *
 * Each collected dir is emitted in BOTH forms — the canonical (realpath'd) path
 * AND the RAW path as the chain spells it. The two backends enforce on different
 * things: Landlock resolves a rule to an INODE, so the canonical form is the only
 * one that matters, but macOS Seatbelt matches the PATH the kernel walks, and
 * that walk must be able to `stat()` every intermediate component AS WRITTEN.
 * Canonicalizing codex's `~/.codex/packages/standalone/current/bin` to its
 * `releases/<v>-<arch>/bin` target silently dropped the `current` symlink node
 * from the profile, so `seatbelt.ts`'s `homeAncestorPaths` never emitted a
 * metadata literal for it and every `codex` spawn — plus the `existsSync` probe
 * behind `cli_installed` — EPERM'd at that node, surfacing in the dashboard as
 * "ChatGPT (Codex) CLI not found on this machine" on a box where codex WAS
 * installed (audit `2026-07-25-codex-exec-dir-symlink-seatbelt.md`). Emitting the
 * raw path too keeps the ancestor walk honest; on Linux it is a duplicate rule
 * for the same inode, which Landlock ignores.
 *
 * SECURITY: emits READ+EXEC dir grants only (binaries, never credentials — auth
 * stores like `~/.grok/auth.json` are SIBLINGS, not under any bin/downloads
 * dir). Every candidate must EXIST and must not be `/`, `$HOME`, an ancestor of
 * `$HOME`, or a bare `SENSITIVE_ROOTS` entry — checked in BOTH forms, so neither
 * a raw nor a canonical bare/broken/hostile chain can widen the grant onto the
 * home tree, the filesystem root, or a secret-bearing root. All fs reads are
 * best-effort: a missing/broken/looping link just stops the walk with whatever
 * was safely collected (never throws).
 */
export const resolveCliExecDirs = (seed: string, home: string): string[] => {
  const out = new Set<string>();
  // Canonicalize the reference roots so the bound checks below survive
  // realpath-canonicalization of the CANDIDATE dirs (macOS resolves
  // `/var → /private/var`, and any tmp/home may itself sit behind a symlink — so
  // a raw-vs-realpath string compare would silently miss `$HOME`/a sensitive
  // root and wrongly grant it). Compare canonical-to-canonical throughout.
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p; // missing — keep raw; existsSync check below drops it anyway
    }
  };
  const canonHome = canon(home);
  // Both forms of every bound: a RAW path is granted alongside its canonical
  // one (see the doc comment), so a raw `$HOME`/ancestor/sensitive-root spelling
  // must be rejected just as hard as the canonical one.
  const forbidden = new Set<string>([canonHome, home, "/"]);
  for (const start of [canonHome, home]) {
    for (let a = dirname(start); a !== dirname(a); a = dirname(a)) {
      forbidden.add(a); // ancestors of home: /Users, / (mac); /home, / (linux)
    }
  }
  for (const root of SENSITIVE_ROOTS(home)) {
    forbidden.add(root);
    forbidden.add(canon(root));
  }
  const addExecDir = (dir: string): void => {
    if (!existsSync(dir)) return; // Landlock can't grant a missing path
    const real = canon(dir);
    // Reject $HOME, filesystem root, any ancestor of $HOME, or a bare
    // secret-bearing root — a bare/broken/hostile chain must never widen the
    // grant onto the home tree, `/`, or a credential root.
    if (forbidden.has(dir) || forbidden.has(real)) return;
    // The CANONICAL path (what Landlock enforces on, as an inode) AND the RAW
    // path (what Seatbelt's path walk stats, component by component). A Set
    // collapses the two when the dir carries no symlink.
    out.add(real);
    out.add(dir);
  };

  // Pass 1: per-hop symlink walk (does NOT follow — inspects each link itself).
  const seen = new Set<string>();
  let cur = seed;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    if (seen.has(cur)) break; // cycle
    seen.add(cur);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      break; // missing / broken — stop; whatever was collected stands
    }
    addExecDir(dirname(cur));
    if (!st.isSymbolicLink()) break; // reached the real node
    let target: string;
    try {
      target = readlinkSync(cur);
    } catch {
      break;
    }
    cur = isAbsolute(target) ? target : resolve(dirname(cur), target);
  }

  // Pass 2: fully-resolved realpath (catches intermediate DIR symlinks).
  try {
    addExecDir(dirname(realpathSync(seed)));
  } catch {
    // seed missing / broken chain — pass 1 already collected what it could.
  }

  return [...out];
};

/**
 * The user's `mise` GLOBAL roots, for hosts whose vendor CLIs are mise-managed.
 * Without these, `mise which <cli>` (manager resolution) and any mise shim the
 * daemon execs abort under confinement with `failed read_to_string
 * ~/.config/mise/config.toml: Permission denied (os error 13)` — so the CLI is
 * never resolved and native login exits before it starts (the 2026-10-04
 * Linux/Landlock report).
 *
 *   read+exec  — the config dir (global `config.toml`; `~/.config` stays
 *                ungranted, only its `mise` leaf), the data dir (mise's own
 *                launcher, `installs/`, `shims/`), the state dir (tracked
 *                configs + trust records), and the cache dir. All four are
 *                read-only (L3): cache/config/state writes land in the
 *                isolated XDG dirs from L2; the real mise tree is only needed
 *                to FIND installs. A compromised daemon therefore cannot mark
 *                a project config trusted or poison the cache.
 *
 * Only EXISTING dirs are emitted (a mise-less host contributes nothing, and a
 * missing leaf must never climb onto `~/.local/share` or `$HOME`), and a
 * relocated root that is `/`, `$HOME`, an ancestor of `$HOME`, or a bare
 * `SENSITIVE_ROOTS` entry is dropped.
 */
export const miseDirs = (
  home: string,
): { readonly readOnly: string[]; readonly readWrite: string[] } => {
  const p = misePaths(home);
  const forbidden = new Set<string>(["/", home, ...SENSITIVE_ROOTS(home)]);
  for (let a = dirname(home); a !== dirname(a); a = dirname(a)) {
    forbidden.add(a);
  }
  const keep = (dirs: readonly string[]): string[] =>
    dirs.filter((d) => isAbsolute(d) && !forbidden.has(d) && existsSync(d));
  // L3: every mise root is read-only. Cache/config/state writes land in the
  // isolated XDG dirs (L2); the real mise tree is only needed to FIND installs.
  return {
    readOnly: keep([p.configDir, p.dataDir, p.stateDir, p.cacheDir]),
    readWrite: [],
  };
};

/**
 * Get the daemon's temp directory path (under the state dir). Creates it if
 * missing (mode 0o700). Returns the path even if creation fails — callers
 * can handle the failure as needed.
 */
export const daemonTempDir = (home?: string): string => {
  const daemonTmp = join(stateDir(home), "tmp");
  try {
    mkdirSync(daemonTmp, { recursive: true, mode: 0o700 });
  } catch {
    // Creation failure is non-fatal — the sandbox will still apply, but
    // operations needing temp will fail. Callers can log/handle as needed.
  }
  return daemonTmp;
};

/**
 * The hardcoded vendor-CLI exec-dir FLOOR + the dynamic `resolveCliExecDirs`
 * resolution, as a READ+EXEC set. Shared by the `auth-state` layer (the daemon
 * execs vendor CLIs for login/usage/credential delegation) AND the
 * `vendor-cli-tunnel` layer (device PTY sessions exec the same binaries). The
 * daemon RUNS the vendor CLIs but never WRITES them: installs are user-run +
 * unsandboxed, and vendor self-update happens out of band. Read+exec, not
 * read-write.
 *
 * Emits the hardcoded floor (grok bin/downloads, ~/.local/bin, cursor + claude
 * versioned dirs) AND, for every provider, the real dir of every node along its
 * isolated run-view symlink chain (`cliBin`) and its host launcher candidates
 * (`hostCliCandidates`) — self-correcting for whatever non-standard /
 * version-specific / custom-install dir a vendor buries its ELF in. Bounded by
 * `resolveCliExecDirs` (existing dirs only, never $HOME/root/a bare sensitive
 * root). Absent CLIs contribute nothing (missing seeds skip).
 */
export const vendorExecDirs = (home: string): string[] => {
  // Pre-create the vendor-CLI dirs the daemon EXECS through. REQUIRED on
  // Linux: Landlock can only grant an EXISTING path (`existing()` drops a
  // missing leaf rather than widening the grant to bare $HOME), so a fresh box
  // would leave these ungranted and every vendor spawn would EACCES. macOS
  // Seatbelt grants by pattern, so pre-creating is a harmless no-op there.
  const floor = [
    // grok (x.ai/cli): the daemon EXECS grok via ~/.grok/bin/grok, but that is
    // only a SYMLINK — the real ELF lives at ~/.grok/downloads/grok-<arch>. So
    // EXEC reads through to downloads/, and BOTH need READ+EXEC. Pre-create
    // both so the grants land on real leaves (NOT bare ~/.grok — the user's
    // ~/.grok/auth.json must stay out of the working set).
    join(home, ".grok", "bin"),
    join(home, ".grok", "downloads"),
    // ⚠️ RESEARCH-UNVERIFIED: Cursor's launcher and versioned binaries live
    // under ~/.local, so grant only executable-bearing leaves, never ~/.cursor.
    join(home, ".local", "bin"),
    join(home, ".local", "share", "cursor-agent", "versions"),
    join(home, ".local", "share", "claude"),
  ];
  for (const d of floor) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      // best-effort — an ungranted leaf just means that vendor's install falls
      // back / fails visibly, not a daemon-boot failure.
    }
  }
  const dirs = new Set<string>([
    //   ~/.local/bin        — the `claude`/`codex` launchers + the `openllmd`
    //                         PATH symlink (the daemon install script writes
    //                         this one, unsandboxed; the daemon only reads it);
    join(home, ".local", "bin"),
    // ⚠️ RESEARCH-UNVERIFIED: Cursor's launcher resolves into this versioned
    // executable directory; hostCliCandidates + symlink resolution add any live path.
    join(home, ".local", "share", "cursor-agent", "versions"),
    //   ~/.local/share/claude — the claude launcher resolves to
    //                         `versions/<v>` here; exec reads through to it;
    join(home, ".local", "share", "claude"),
    //   ~/.grok/bin         — the grok launcher SYMLINK (bin/grok →
    //                         ../downloads/grok-<arch>); the isolated grok
    //                         symlink execs it;
    join(home, ".grok", "bin"),
    //   ~/.grok/downloads   — the REAL grok ELF the bin/grok symlink points at.
    //                         Exec of grok reads THROUGH bin/grok to this dir, so
    //                         it must be read+exec too (a dropped grant here
    //                         EACCESes every `grok` spawn — the connect/login
    //                         flow then never emits its device URL). Holds the
    //                         binary only, no credentials (auth.json is a sibling
    //                         under ~/.grok, left UNgranted).
    join(home, ".grok", "downloads"),
  ]);
  // DYNAMIC exec-dir resolution — the robustness backstop for the hardcoded
  // floor above. For every provider, FOLLOW the symlink chain of its isolated
  // run-view (`cliBin`, seeded lazily by `cliInstallState`) AND its host
  // launcher candidates (`hostCliCandidates`, present as soon as the CLI is
  // installed), and grant the real dir of every node read+exec.
  for (const provider of CLI_PROVIDERS) {
    for (const seed of [
      ...hostCliCandidates(provider, home),
      cliBin(provider, home),
    ]) {
      for (const dir of resolveCliExecDirs(seed, home)) dirs.add(dir);
    }
  }
  return [...dirs];
};

/**
 * The base grant set shared by ALL four sub-process layers (and the parent
 * supervisor). Resolved at call time so `OPENLLM_DAEMON_STATE_DIR` overrides
 * are honoured.
 *
 * `homeOverride` supplies the DAEMON's home explicitly instead of reading
 * `homedir()`. Load-bearing for the `--sandbox-exec` shim: it is spawned with
 * the CHILD's env, whose `HOME` points at an isolated CLI home
 * (`cli-paths.ts` `cliEnv`). Without the override the shim builds the working
 * set around THAT home — the real state dir is never granted and Seatbelt's
 * deny-`$HOME` read default lands on the isolated home itself, EPERM-ing the
 * very credential store the child was spawned to read. (Passing `HOME` through
 * the env instead does NOT work: Bun caches `os.homedir()` on first call, and
 * module-load code has already called it by then.)
 *
 * TODO(R2-M2): the whole `state` dir is granted here because it is genuinely
 * shared (auth-state, vendor-cli-tunnel, and the parent all sit under it) AND
 * to keep the M1.5 union byte-identical to the pre-split single builder. When
 * the `--sub` subprocesses actually drop the shared grant, decompose `state`
 * into its sub-paths (`<state>/cli` → auth-state, `<state>/run` +
 * `<state>/sessions` → vendor-cli-tunnel) so each subprocess carries only its
 * own slice.
 */
export const baseWorkingSet = (homeOverride?: string): TWorkingSet => {
  const state = stateDir(homeOverride);
  // Daemon-owned temp directory under the state dir. The unit hardening no
  // longer sets PrivateTmp (removed due to --user unit compatibility issues),
  // so granting global /tmp would leak access to every other process's temp
  // files. Instead we create and use our own isolated temp under stateDir.
  const daemonTmp = daemonTempDir(homeOverride);
  const readWrite = new Set<string>([
    // The whole state dir: the shared .env (config + key + device id) + logs + isolated CLI roots
    // (`cli/<provider>/{home,bin}` all nest under it — see `cli-paths.ts`)
    // + the installed binary and its self-update temp (`<state>/bin`)
    // + the local-session registry (`<state>/run`, `<state>/sessions`).
    state,
    // Belt-and-braces for a binary installed OUTSIDE the state dir (manual
    // placement): self-update renames a temp over `process.execPath`, so its
    // real directory must be writable.
    dirname(process.execPath),
    // Daemon-owned temp directory (NOT global /tmp). Vendor install scripts
    // stage downloads here. Created above with 0o700 so it's isolated.
    daemonTmp,
    // Device nodes the runtime + EVERY spawned child need: `/dev/null` (the
    // stdio target when a spawn uses `stdout: "ignore"` — without this, Bun's
    // `posix_spawn` of `bash`/the vendor CLIs fails `EACCES` setting up the
    // redirect, so connect + integration installs silently break), `/dev/
    // urandom`, etc. Devices hold no secrets, so granting `/dev` is safe.
    "/dev",
  ]);
  const readOnly = new Set<string>([
    // ── Dev-source-only grant (NEVER the shipped binary) ───────────────
    // A source/dev run executes `bun packages/cli/daemon/src/main.ts`, so the
    // runtime must READ the repo's `.ts` sources + hoisted `node_modules`
    // (e.g. `effect`) at import time. Both backends are read-WHITELISTs
    // (Landlock everywhere; macOS Seatbelt deny-by-default within `$HOME`), and
    // a dev checkout lives under `$HOME`, so the repo root must be granted or
    // the from-source daemon can't load its own modules under confinement. The
    // COMPILED binary (`DAEMON_VERSION !== "0.0.0-dev"`) is
    // a self-contained executable in the state dir, needs no source tree, and
    // gets NO such grant — production confinement is unchanged. The repo root
    // is derived from this module's own location, so it's correct regardless
    // of the daemon's cwd, and it's disjoint from `$HOME` secrets like
    // `~/.ssh`, so the confinement guarantee still holds.
    ...(DAEMON_VERSION === "0.0.0-dev"
      ? [resolve(import.meta.dir, "..", "..", "..", "..", "..", "..")]
      : []),
    // Toolchain + loaders for spawned children (bash, curl, vendor CLIs).
    "/usr",
    "/lib",
    "/lib64",
    "/bin",
    "/sbin",
    "/opt",
    // resolv.conf, TLS trust store, locale data.
    "/etc",
    // Runtime introspection some tools expect.
    "/proc",
    "/sys",
    "/run",
    "/var",
  ]);
  return {
    readWrite: [...readWrite],
    readOnly: [...readOnly],
  };
};
