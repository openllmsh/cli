/**
 * Filesystem layout + isolated-run environment for the daemon's OWN copies
 * of the vendor CLIs. Each CLI is installed under
 * `<stateDir>/cli/<provider>/` and ALWAYS run with its home/config pointed
 * inside that dir, so it never reads or writes the user's personal
 * `~/.claude` / `~/.codex` / `~/.kimi-code` state (which they may be using
 * interactively). The Claude harness
 * (`tests/matrix/claude-harness/harness.ts`) runs the SAME isolated CLI
 * via `cliBin`/`cliEnv` rather than installing its own.
 *
 *   <stateDir>/cli/<provider>/
 *     bin/<binary>     the isolated CLI executable
 *     home/            the CLI's home/config + credentials (isolated)
 */

import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TSubscriptionProviderSlug } from "@openllmsh/protocol";
import { stateDir } from "./env";
import { resolveOnPath } from "./path-utils";
import { daemonTempDir } from "./sandbox/working-set";

/** The providers with an isolated CLI — exactly the closed
 *  `SubscriptionProviderSlug` vocabulary of the control schema, so a slug
 *  that reaches a CLI path provably came through the typed command union. */
export type TCliProvider = TSubscriptionProviderSlug;

type TCliEnvCtx = {
  readonly home: string;
  readonly root: string;
  readonly config: string;
  readonly tmp: string;
};

// Where the vendor installer drops the binary, RELATIVE to the provider
// root, plus the CLI's command name as invoked from a shell (what a PATH
// scan looks for). Host drop-points, isolated config dir, and run/install
// env knobs live on the same record so adding a provider is one entry.
type TCliSpec = {
  readonly binRel: string;
  readonly cmd: string;
  /** Official-installer drop points, relative to the real user home. Lazy. */
  readonly hostCandidates: (home: string) => string[];
  /** Isolated config/credential dir as the CLI itself sees it. Lazy. */
  readonly configDir: (isolatedHome: string) => string;
  /** Isolated spawn env (HOME + TMPDIR + provider knobs). Lazy. */
  readonly env: (ctx: TCliEnvCtx) => Record<string, string>;
};

/**
 * Shared by official Muse login/logout and isolated SDK host spawns.
 * Env selector is `file` (name embedded as `TBH_CREDENTIAL_BACKEND` in the
 * installed binary). Spec 8053 `file/none` is the *observed telemetry
 * pairing* (backend/fallback), not proven here as the env literal.
 */
export const MUSE_CREDENTIAL_BACKEND = "file";

/**
 * Exact version grammar from the official Muse bash launcher's
 * `version_pattern` (muse-launcher). Used to resolve `muse-bin-<version>`
 * beside the launcher — never an arbitrary newest-glob.
 */
export const MUSE_LAUNCHER_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/;

/**
 * Resolve the active native Muse Mach-O/ELF next to an official launcher.
 * Mirrors launcher `active_binary`: realpath the launcher, read sibling
 * `.muse-version`, require the launcher regex, require `muse-bin-<version>`
 * is an executable regular file. Returns null when any step fails.
 */
export const resolveMuseNativeBinaryBesideLauncher = (
  launcherPath: string,
): string | null => {
  let launcherReal: string;
  try {
    launcherReal = realpathSync(launcherPath);
  } catch {
    return null;
  }
  const dir = dirname(launcherReal);
  let version = "";
  try {
    version = readFileSync(join(dir, ".muse-version"), "utf8").trim();
  } catch {
    return null;
  }
  if (!MUSE_LAUNCHER_VERSION_PATTERN.test(version)) return null;
  const native = join(dir, `muse-bin-${version}`);
  try {
    if (!statSync(native).isFile()) return null;
    accessSync(native, constants.X_OK);
  } catch {
    return null;
  }
  return native;
};

/** Default Muse installer launcher path (native resolved in hostCliCandidates). */
const museHostCandidates = (home: string): string[] => [
  join(home, ".local", "bin", "muse"),
];

const SPECS: Readonly<Record<TCliProvider, TCliSpec>> = {
  // `claude install` (run by claude.ai/install.sh under our HOME) places
  // the launcher at $HOME/.local/bin/claude.
  claude_code: {
    binRel: "home/.local/bin/claude",
    cmd: "claude",
    // The official installer's launcher → resolves to
    // ~/.local/share/claude/versions/<v> (the self-contained binary).
    hostCandidates: (home) => [join(home, ".local", "bin", "claude")],
    configDir: (home) => join(home, ".claude"),
    env: ({ home, config, tmp }) => ({
      HOME: home,
      TMPDIR: tmp,
      // Claude reads its config/credentials from CLAUDE_CONFIG_DIR
      // (defaults to $HOME/.claude); pin it to the isolated home so
      // login/status/usage all use it, never the user's.
      CLAUDE_CONFIG_DIR: config,
    }),
  },
  // codex install.sh with CODEX_INSTALL_DIR=<root>/bin → <root>/bin/codex.
  chatgpt: {
    binRel: "bin/codex",
    cmd: "codex",
    hostCandidates: (home) => [
      join(home, ".local", "bin", "codex"),
      join(home, ".codex", "bin", "codex"),
    ],
    configDir: (home) => join(home, ".codex"),
    env: ({ home, root, config, tmp }) => ({
      HOME: home,
      TMPDIR: tmp,
      CODEX_HOME: config,
      CODEX_INSTALL_DIR: join(root, "bin"),
      // Skip interactive prompts during the scripted install.
      CODEX_NON_INTERACTIVE: "1",
    }),
  },
  // kimi install.sh with KIMI_INSTALL_DIR=<root> → <root>/bin/kimi.
  kimi_code: {
    binRel: "bin/kimi",
    cmd: "kimi",
    hostCandidates: (home) => [
      join(home, ".kimi-code", "bin", "kimi"),
      join(home, ".local", "bin", "kimi"),
    ],
    configDir: (home) => join(home, ".kimi-code"),
    env: ({ home, root, config, tmp }) => ({
      HOME: home,
      TMPDIR: tmp,
      KIMI_CODE_HOME: config,
      KIMI_INSTALL_DIR: root,
      // Don't edit the user's shell rc files.
      KIMI_NO_MODIFY_PATH: "1",
    }),
  },
  // grok (Grok Build, x.ai/cli) is HOME-rooted like claude, so its isolated
  // symlink lives under the isolated HOME's bin, paralleling claude's launcher.
  // NB: this is only where the ISOLATED SYMLINK is created — the real installer
  // drops the host launcher at ~/.grok/bin/grok (see `hostCandidates`), and
  // that is what gets symlinked here.
  grok: {
    binRel: "home/.local/bin/grok",
    cmd: "grok",
    // The official x.ai/cli installer's default BIN_DIR is ~/.grok/bin
    // (`BIN_DIR="${GROK_BIN_DIR:-$HOME/.grok/bin}"`), and it only adds a
    // ~/.local/bin/grok symlink WHEN ~/.grok/bin isn't already on PATH — so
    // the primary location must come first, with ~/.local/bin/grok as the
    // conditional fallback. (Verified against the live installer 2026-06-30.)
    hostCandidates: (home) => [
      join(home, ".grok", "bin", "grok"),
      join(home, ".local", "bin", "grok"),
    ],
    // grok caches its OAuth token at <home>/.grok/auth.json.
    configDir: (home) => join(home, ".grok"),
    // grok is HOME-rooted (like claude): it reads/writes its config +
    // `auth.json` under <home>/.grok, so pinning HOME isolates it from the
    // user's real ~/.grok. The host binary lives at its DEFAULT location
    // (~/.grok/bin, installed out of band by the user-run installer) and the
    // isolated path is a symlink to it — the daemon only runs it, never installs.
    env: ({ home, tmp }) => ({
      HOME: home,
      TMPDIR: tmp,
    }),
  },
  // ⚠️ RESEARCH-UNVERIFIED: Cursor's official installer is reported to place
  // this launcher at ~/.local/bin/cursor-agent.
  cursor: {
    binRel: "home/.local/bin/cursor-agent",
    cmd: "cursor-agent",
    // ⚠️ RESEARCH-UNVERIFIED: best-known Cursor installer launcher path;
    // `resolveOnPath` below covers other installation layouts.
    hostCandidates: (home) => [join(home, ".local", "bin", "cursor-agent")],
    // Live-verified (Linux, cursor-agent 2026.07.23): the credential store is
    // the XDG path `$XDG_CONFIG_HOME/cursor/auth.json`, i.e. `<home>/.config/
    // cursor/auth.json` once HOME is isolated (the CLI's own app data —
    // cli-config, acp-sessions, skills — is HOME-rooted under `<home>/.cursor`
    // and is NOT the credential dir). `cliEnv` pins `XDG_CONFIG_HOME` at
    // `<home>/.config` so this is where the token lands regardless of any
    // ambient `XDG_CONFIG_HOME`, keeping write + read on the same isolated path
    // (Codex parity via `CODEX_HOME`).
    configDir: (home) => join(home, ".config", "cursor"),
    // cursor-agent resolves its credential store as
    // `($XDG_CONFIG_HOME || $HOME/.config)/cursor/auth.json`. Pin
    // `XDG_CONFIG_HOME` at the isolated `<home>/.config` so the token can never
    // land in the user's real `~/.config/cursor` even when the host exports an
    // ambient `XDG_CONFIG_HOME` (Codex parity via `CODEX_HOME`). `config` here
    // is `<home>/.config/cursor` (see `configDir`), so its parent is the
    // XDG config root. macOS Keychain credentials remain host-managed.
    env: ({ home, tmp }) => ({
      HOME: home,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: join(home, ".config"),
    }),
  },
  // Meta Muse Code — official `muse` CLI. Durable auth is the XDG path
  // `$XDG_CONFIG_HOME/muse/auth.json` (muse-code-acp + native binary config
  // root). Installer: `curl -fsSL https://dev.meta.ai/install.sh | sh`.
  //
  // Prefer the launcher-active native `muse-bin-<version>` (`.muse-version`
  // beside the realpath'd launcher) so login/serve never enter the bash
  // launcher's download / device-login path. Launcher remains a fallback
  // candidate; `MUSE_NO_AUTO_UPDATE=1` + `MUSE_LOGIN=0` then make a missing
  // native binary fail closed instead of fetching or prompting.
  //
  // `MUSE_AUTH_PATH` is the official **launcher** override for reading that
  // store during download auth (launcher never writes credentials; native
  // `muse-bin` strings do not reference `MUSE_AUTH_PATH`). The native binary
  // keys off `XDG_CONFIG_HOME` + `TBH_CREDENTIAL_BACKEND=file`.
  //
  // macOS KeychainStore is NOT HOME-isolated (SecItem / fixed service); the
  // daemon never assumes an isolated login.keychain. File backend + inline
  // `providers.meta.access_token` is the supported durable store.
  muse: {
    binRel: "home/.local/bin/muse",
    cmd: "muse",
    hostCandidates: museHostCandidates,
    configDir: (home) => join(home, ".config", "muse"),
    env: ({ home, tmp }) => ({
      HOME: home,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: join(home, ".config"),
      TBH_CREDENTIAL_BACKEND: MUSE_CREDENTIAL_BACKEND,
      MUSE_AUTH_PATH: join(home, ".config", "muse", "auth.json"),
      MUSE_NO_AUTO_UPDATE: "1",
      MUSE_LOGIN: "0",
    }),
  },
};

/** The closed runtime list of CLI providers — derived from `SPECS` keys so it
 *  can never drift from the `Record<TCliProvider, …>` (adding a provider to the
 *  type forces a `SPECS` entry, which appears here automatically). Consumers that
 *  must iterate every provider (e.g. the sandbox exec-dir resolver in
 *  `working-set/`) use this instead of re-listing the slugs. */
export const CLI_PROVIDERS = Object.keys(SPECS) as readonly TCliProvider[];

export const cliRoot = (provider: TCliProvider, home?: string): string =>
  join(stateDir(home), "cli", provider);

/** The CLI's isolated home/config dir (passed as the CLI's home env). */
export const cliHome = (provider: TCliProvider, home?: string): string =>
  join(cliRoot(provider, home), "home");

/** Absolute path to the installed isolated binary. */
export const cliBin = (provider: TCliProvider, home?: string): string =>
  join(cliRoot(provider, home), SPECS[provider].binRel);

/** Shell command name for a provider CLI (`codex`, `claude`, `cursor-agent`, …). */
export const cliCommand = (provider: TCliProvider): string =>
  SPECS[provider].cmd;

/**
 * Candidate paths to the user's EXISTING non-isolated vendor CLI, in priority
 * order — `cli-install.ts` `cliInstallState` returns the first that exists and
 * SYMLINKS the isolated path to it (no copy, zero duplicate bytes). The daemon
 * NEVER installs the CLI; installs are user-run + unsandboxed. The single binary
 * on disk is the non-isolated one; the isolated CLI is always a link to it.
 *
 * Static vendor-default locations come FIRST (the official installer's drop
 * point wins), then a generic PATH scan (`resolveOnPath`) appended as the
 * fallback — so a CLI installed anywhere else (system-wide `/usr/bin`,
 * Homebrew, an npm-prefix global, `claude migrate-installer`, a distro
 * package) is still found instead of being reported not-installed. The scan
 * is generic across every provider, closing the class of bug rather than one
 * path (see issue #203).
 *
 * The symlink target must be EXEC-able under the OS sandbox: the codex home
 * (`~/.codex`, a read-write working-set setup target), claude's binary dir
 * (`~/.local/share/claude`, read+exec in `working-set/`), grok's bin dirs
 * (`~/.grok/{bin,downloads}`, read+exec) + anything outside `$HOME` all
 * qualify. Any OTHER in-`$HOME` location (kimi's `~/.kimi-code/bin`, a
 * non-standard dir a PATH scan surfaces) is covered too: `working-set/`
 * seeds `resolveCliExecDirs` from THIS list and follows the real symlink
 * chain, granting read+exec on whatever dirs the binary actually lives in
 * (bounded — never `$HOME`/root/a sensitive root).
 */
export const hostCliCandidates = (
  provider: TCliProvider,
  homeOverride?: string,
): string[] => {
  // Hermetic-test guard. A test that drives a REAL delegate `.connect()` (e.g.
  // `cursor-agent login`) must never let this probe discover the developer's
  // real host CLI: the self-heal in `cliInstallState`/`reconcileIsolatedLink`
  // would re-point the isolated symlink from the test's mock to that real
  // binary, and spawning it opens a LIVE browser login on the dev's machine
  // (CI has no such binary, so it only bit locally). Such a test sets this flag
  // and provides its mock at the isolated `cliBin` path instead. NEVER set in
  // production; unset there, so host discovery is unchanged.
  if (process.env.OPENLLM_NO_HOST_CLI_DISCOVERY === "1") return [];
  const home = homeOverride ?? homedir();
  const vendorDefaults = SPECS[provider].hostCandidates(home);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...vendorDefaults, ...resolveOnPath(SPECS[provider].cmd)]) {
    // Muse: prefer launcher-active native muse-bin-<version> beside ANY
    // discovered launcher (default ~/.local/bin or a PATH custom install).
    if (provider === "muse") {
      const native = resolveMuseNativeBinaryBesideLauncher(p);
      if (native !== null && !seen.has(native)) {
        seen.add(native);
        out.push(native);
      }
    }
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
};

// ─── device-session env (interactive CLI, real user home) ───────────
//
// Device chat sessions (feature §2.2) run the user's REAL interactive CLI
// with the real `$HOME` / PATH so credentials and vendor session stores
// work without re-login. There is no per-session workspace under
// `~/.openllm/sessions/` — cwd is `$HOME` (or a validated resume cwd).
// The `cliEnv()` isolated-HOME rewrite is not applied here, and the session
// PTY is deliberately NOT wrapped in the per-child OS sandbox shim
// (`sandbox/exec.ts`) — it runs the user's real CLI over their real files,
// which deny-by-default confinement would break
// (`docs/audits/daemon-sandbox-scoping.md`).
//
// Legacy helpers `sessionRoot` / `sessionWorkspace` remain exported for
// any residual callers/tests but are unused by session-host.

/** @deprecated Device PTYs no longer use a sessions workspace root. */
export const sessionRoot = (): string => join(stateDir(), "sessions");

/** @deprecated Prefer `$HOME` / resume cwd via session-host.resolveSessionCwd. */
export const sessionWorkspace = (sessionId: string): string =>
  join(sessionRoot(), sessionId);

/**
 * Environment overrides for a DEVICE SESSION spawn. Keeps the real HOME so
 * vendor CLIs read the user's actual login/settings; only sets TERM and a
 * daemon temp dir. PATH is inherited via `spawnEnv`. Session-host layers
 * `OPENLLM_DEVICE_SESSION_ID` on top for live.json indexing. Provider-agnostic
 * — every device CLI (incl. opencode) gets the same real-HOME + daemon TMPDIR.
 *
 * `daemonTempDir` must succeed — a missing temp root would leave vendor CLIs
 * writing under an unusable TMPDIR and surface as opaque spawn failures.
 */
const verifiedDaemonTempDir = (): string => {
  const tmp = daemonTempDir();
  // daemonTempDir swallows mkdir errors; fail closed before spawn if unusable.
  try {
    if (statSync(tmp).isDirectory()) return tmp;
  } catch {
    // Fall through to the consistent failure below.
  }
  throw new Error(`daemon temp dir missing: ${tmp}`);
};

export const sessionEnv = (): Record<string, string> => {
  const tmp = verifiedDaemonTempDir();
  return {
    HOME: homedir(),
    TMPDIR: tmp,
    TERM: "xterm-256color",
  };
};

/**
 * The CLI's home/config root as the CLI itself sees it (the value of its
 * home env var). Delegates derive their credential-store paths from this
 * so the read location and the `cliEnv` run location never drift.
 *   claude → <home>/.claude   codex → <home>/.codex   kimi → <home>/.kimi-code
 */
export const cliConfigDir = (provider: TCliProvider): string =>
  SPECS[provider].configDir(cliHome(provider));

/**
 * Environment overrides that (1) isolate the CLI's runtime home and
 * (2) — at INSTALL time — redirect where the vendor script drops the
 * binary. Merge onto `process.env` for every spawn of an isolated CLI.
 *
 * All three get `HOME` pointed at the isolated home (isolates Claude's
 * binary + state, and is the floor for the others). Codex/Kimi also get
 * their explicit install-dir + home knobs and PATH-edit suppression so
 * the installer doesn't touch the user's shell profiles.
 *
 * ALL three additionally get `TMPDIR` pointed at the daemon-owned temp dir
 * (`<state>/tmp`). The OS sandbox (`./sandbox/working-set/`) does NOT grant
 * the system `/tmp` — only `<state>/tmp`. The codex + kimi vendor installers
 * stage their download/extract in `mktemp -d`, which falls back to `/tmp`
 * when `TMPDIR` is unset; under the sandbox that first `mktemp -d` EACCESes
 * and the `set -e` script exits with no binary. (Claude was unaffected: its
 * installer stages under `$HOME`, already granted.) Pinning `TMPDIR` at the
 * granted daemon temp dir keeps every isolated spawn's temp inside the
 * working set, so the install lands the binary on a remote/sandboxed box too.
 */
export const cliEnv = (provider: TCliProvider): Record<string, string> => {
  const home = cliHome(provider);
  const root = cliRoot(provider);
  const config = cliConfigDir(provider);
  // The daemon-owned, sandbox-granted staging dir for `mktemp -d` (see above).
  const tmp = verifiedDaemonTempDir();
  return SPECS[provider].env({ home, root, config, tmp });
};
