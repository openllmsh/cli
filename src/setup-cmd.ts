/**
 * `openllm setup` — the ONE post-install command: put `openllm` (and the
 * short alias `ollm`) on PATH (symlinks into /usr/local/bin or
 * ~/.local/bin), write the owned shell-rc block (PATH + `alias
 * ollm=openllm`), and install shell completion for the current shell.
 * Idempotent; safe to re-run. Invoked automatically by the install
 * scripts so both names work in the next shell with no extra step.
 *
 * Also migrates a legacy `openllmc` install: an existing `openllmc`
 * symlink pointing at our bin dir is rewritten to a transitional
 * `openllmc → openllm` symlink (kept one major so in-flight scripts and
 * old MCP entries keep working).
 *
 * Exists standalone because a DAEMON-DRIVEN install runs sandboxed, where
 * the PATH dirs + rc files are deliberately read-only (launcher-trojan
 * guard) — the installer skips the wiring there and the dashboard shows
 * this command for the user to run unsandboxed:
 *
 *   ~/.openllm/bin/openllm setup
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { COMPLETION_SHELLS } from "./commands";
import type { TCompletionShell } from "./commands";
import { completionTargetPath, installCompletion } from "./completion";
import { userHome } from "./env";

/** Path of `~/.openllm/bin` for the current HOME. */
const binDir = (): string => join(userHome(), ".openllm", "bin");
/** Path of the `openllm` binary under `~/.openllm/bin`. */
const binPath = (): string => join(binDir(), "openllm");
/** Legacy binary path (pre-rename installs). */
const legacyBinPath = (): string => join(binDir(), "openllmc");

/** The owned rc block markers — install/uninstall operate on exactly this
 *  region, never on the rest of the user's rc. */
export const RC_BEGIN = "# >>> openllm (managed) >>>";
export const RC_END = "# <<< openllm (managed) <<<";

/** Names we link onto PATH — the binary and its short alias. */
const LINK_NAMES = ["openllm", "ollm"] as const;

/** True for bash/zsh/fish — the shells `runSetup` can wire. */
const isKnownShell = (name: string): name is TCompletionShell =>
  (COMPLETION_SHELLS as readonly string[]).includes(name);

/** Strip a login-shell leading dash (`-bash` → `bash`) and take the basename. */
export const shellBasename = (shellPathOrName: string): string => {
  const base = basename(shellPathOrName.trim());
  return base.startsWith("-") ? base.slice(1) : base;
};

/**
 * Injectable seams for {@link resolveShell}. Production uses env → passwd
 * login shell → parent process; tests stub each stage.
 */
export type TResolveShellDeps = {
  /** When provided (including `undefined`), replaces `process.env.SHELL`. */
  readonly envShell?: string | undefined;
  /** Login shell from the passwd entry (`os.userInfo` / getent / `/etc/passwd`). */
  readonly loginShell?: () => string | null;
  /** Parent process command name (`/proc/<ppid>/comm` or `ps`). */
  readonly parentShell?: () => string | null;
};

export type TResolvedShell = {
  /** Basename of the best candidate (known or not), or null when nothing found. */
  readonly name: string | null;
  readonly known: boolean;
};

/** Best-effort login shell from passwd/getent when `SHELL` is unset. */
const loginShellFromPasswd = (): string | null => {
  let username: string | null = null;
  try {
    const info = userInfo();
    if (typeof info.shell === "string" && info.shell.length > 0) {
      return info.shell;
    }
    username = info.username;
  } catch {
    // userInfo can throw when the uid has no passwd row
  }
  if (username === null) {
    try {
      username = userInfo().username;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("getent", ["passwd", username], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    const shell = out.split(":")[6];
    if (shell) return shell;
  } catch {
    // getent missing (macOS) or no row — fall through to /etc/passwd
  }
  try {
    const content = readFileSync("/etc/passwd", "utf8");
    for (const line of content.split("\n")) {
      const parts = line.split(":");
      if (parts[0] === username && parts[6]) return parts[6];
    }
  } catch {
    // unreadable
  }
  return null;
};

/** Parent process command name — shell hint when `SHELL` is unset. */
const parentProcessShell = (): string | null => {
  const ppid = process.ppid;
  if (!Number.isInteger(ppid) || ppid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const comm = readFileSync(`/proc/${ppid}/comm`, "utf8").trim();
      if (comm.length > 0) return comm;
    } catch {
      // fall through to ps
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * Resolve the user's shell for rc + completion wiring.
 *
 * When `SHELL` is set in the environment, that value decides (known or
 * unsupported) — no fallback. When it is absent/empty, try the passwd login
 * shell, then the parent process's command, accepting only bash/zsh/fish.
 */
export const resolveShell = (deps: TResolveShellDeps = {}): TResolvedShell => {
  const envShell =
    "envShell" in deps ? deps.envShell : process.env.SHELL;
  if (envShell !== undefined && envShell !== "") {
    const name = shellBasename(envShell);
    return { name: name.length > 0 ? name : null, known: isKnownShell(name) };
  }

  const login = (deps.loginShell ?? loginShellFromPasswd)();
  if (login !== null && login !== "") {
    const name = shellBasename(login);
    if (isKnownShell(name)) return { name, known: true };
  }

  const parent = (deps.parentShell ?? parentProcessShell)();
  if (parent !== null && parent !== "") {
    const name = shellBasename(parent);
    if (isKnownShell(name)) return { name, known: true };
    // Prefer a concrete unsupported name over a blank one when nothing known.
    if (!isKnownShell(shellBasename(login ?? ""))) {
      return { name: name.length > 0 ? name : null, known: false };
    }
  }

  if (login !== null && login !== "") {
    const name = shellBasename(login);
    return { name: name.length > 0 ? name : null, known: false };
  }

  return { name: null, known: false };
};

/** Candidate directories for owned PATH symlinks. */
const pathDirCandidates = (): readonly string[] =>
  ["/usr/local/bin", join(userHome(), ".local", "bin")] as const;

/** True when a path exists, including as a dangling symlink. */
const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** True when `link` is a symlink whose target is one of OUR binaries (the
 *  new path, the legacy path, or a sibling `openllm` link). */
const pointsAtOurs = (link: string): boolean => {
  const path = binPath();
  const legacyPath = legacyBinPath();
  try {
    const target = readlinkSync(link);
    return (
      target === path || target === legacyPath || basename(target) === "openllm"
    );
  } catch {
    return false; // not a symlink (or unreadable) — not ours
  }
};

/** Best-effort symlink of one name into the first writable PATH dir.
 *  Returns the link path or null when no dir was writable. */
const linkName = (name: string): string | null => {
  for (const dir of pathDirCandidates()) {
    const link = join(dir, name);
    try {
      mkdirSync(dir, { recursive: true });
      // Replace only a symlink pointing at our binary — never clobber a
      // foreign regular file (or foreign symlink) with this name.
      const path = binPath();
      if (existsSync(link)) {
        if (readlinkSync(link) === path) return link; // already correct
        if (!pointsAtOurs(link)) continue; // foreign — try the next dir
        unlinkSync(link);
      }
      symlinkSync(path, link);
      return link;
    } catch {
      // unwritable / not a symlink — try the next candidate
    }
  }
  return null;
};

/**
 * Legacy-name migration: wherever an `openllmc` PATH symlink points at our
 * bin, repoint it at the renamed binary (transitional — dropped next major).
 * Also rewrites an existing `openllmc → ...` link/file in ~/.openllm/bin when we
 * need compatibility for absolute-path callers (old MCP entries, old hooks).
 */
const migrateLegacyLinks = (): void => {
  for (const dir of pathDirCandidates()) {
    const link = join(dir, "openllmc");
    try {
      const path = binPath();
      if (pathExists(link) && pointsAtOurs(link)) {
        unlinkSync(link);
        symlinkSync(path, link);
      }
    } catch {
      // best-effort — a foreign or unwritable link is left alone
    }
  }
  try {
    const path = binPath();
    const legacyPath = legacyBinPath();

    if (!pathExists(legacyPath)) {
      return;
    }

    try {
      if (readlinkSync(legacyPath) === path) {
        return;
      }
    } catch {
      // regular file (old binary) or broken symlink → replace below
    }

    unlinkSync(legacyPath);
    symlinkSync(path, legacyPath);
  } catch {
    // best-effort
  }
};

/** The rc file for a known shell name, or null when unsupported. */
export const rcFileForShellName = (
  shellName: string,
): { rc: string; fish: boolean } | null => {
  const home = userHome();
  if (shellName === "zsh") return { rc: join(home, ".zshrc"), fish: false };
  if (shellName === "bash") return { rc: join(home, ".bashrc"), fish: false };
  if (shellName === "fish")
    return {
      rc: join(home, ".config", "fish", "config.fish"),
      fish: true,
    };
  return null;
};

/** The managed rc block body (shell-dialect aware). PATH covers shells that
 *  don't have ~/.openllm/bin via symlink dirs; the alias covers interactive
 *  use even when the `ollm` symlink couldn't be created. */
const rcBlock = (fish: boolean): string => {
  const lines = fish
    ? [
        RC_BEGIN,
        'fish_add_path -g "$HOME/.openllm/bin"',
        "alias ollm openllm",
        RC_END,
      ]
    : [
        RC_BEGIN,
        'export PATH="$HOME/.openllm/bin:$PATH"',
        "alias ollm=openllm",
        RC_END,
      ];
  return lines.join("\n");
};

export type TInstallRcResult =
  | { readonly ok: true; readonly rc: string }
  | {
      readonly ok: false;
      readonly kind: "unsupported";
      readonly shell: string | null;
    }
  | {
      readonly ok: false;
      readonly kind: "unwritable";
      readonly rc: string;
      readonly reason: string;
    };

/**
 * Write (or refresh) the owned rc block. Idempotent: an existing block is
 * replaced in place; otherwise the block is appended.
 */
export const installRcBlock = (
  deps?: TResolveShellDeps,
): TInstallRcResult => {
  const resolved = resolveShell(deps);
  if (!resolved.known || resolved.name === null) {
    return { ok: false, kind: "unsupported", shell: resolved.name };
  }
  const target = rcFileForShellName(resolved.name);
  if (target === null) {
    return { ok: false, kind: "unsupported", shell: resolved.name };
  }
  const { rc, fish } = target;
  const block = rcBlock(fish);
  try {
    let content = "";
    try {
      content = readFileSync(rc, "utf-8");
    } catch {
      // rc doesn't exist yet — created below
    }
    const begin = content.indexOf(RC_BEGIN);
    const end = content.indexOf(RC_END);
    let next: string;
    if (begin >= 0 && end > begin) {
      next =
        content.slice(0, begin) + block + content.slice(end + RC_END.length);
    } else {
      next = `${content.replace(/\n*$/, "\n")}\n${block}\n`;
    }
    if (next !== content) {
      mkdirSync(join(rc, ".."), { recursive: true });
      writeFileSync(rc, next);
    }
    return { ok: true, rc };
  } catch (error) {
    const reason =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, kind: "unwritable", rc, reason };
  }
};

/**
 * Remove the owned rc block from every supported rc target (uninstall path),
 * not only the currently resolved shell — a prior install may have written a
 * different shell's file. Best-effort; silent; preserves other content.
 */
export const removeRcBlock = (): void => {
  for (const name of COMPLETION_SHELLS) {
    const target = rcFileForShellName(name);
    if (target === null) continue;
    try {
      const content = readFileSync(target.rc, "utf-8");
      const begin = content.indexOf(RC_BEGIN);
      const end = content.indexOf(RC_END);
      if (begin < 0 || end <= begin) continue;
      const next = (
        content.slice(0, begin) + content.slice(end + RC_END.length)
      ).replace(/\n{3,}/g, "\n\n");
      writeFileSync(target.rc, next);
    } catch {
      // best-effort
    }
  }
};

/** Remove every PATH symlink we own (uninstall path). Best-effort. */
export const removeOwnedLinks = (): void => {
  const legacyPath = legacyBinPath();
  for (const dir of pathDirCandidates()) {
    for (const name of [...LINK_NAMES, "openllmc"]) {
      const link = join(dir, name);
      try {
        if (existsSync(link) && pointsAtOurs(link)) unlinkSync(link);
      } catch {
        // best-effort
      }
    }
  }
  try {
    if (existsSync(legacyPath) && pointsAtOurs(legacyPath))
      unlinkSync(legacyPath);
  } catch {
    // best-effort
  }
};

/** Exact session PATH line printed when `~/.openllm/bin` is not already on PATH. */
export const sessionPathExportLine = (): string =>
  'export PATH="$HOME/.openllm/bin:$PATH"';

/** Whether `~/.openllm/bin` is already on PATH for this process. */
const openllmBinOnPath = (): boolean => {
  const homeBin = binDir();
  const pathEnv = process.env.PATH ?? "";
  for (const entry of pathEnv.split(":")) {
    if (entry === homeBin || entry === "$HOME/.openllm/bin") return true;
    // Also accept a home-expanded form written by a previous session.
    try {
      if (entry === join(userHome(), ".openllm", "bin")) return true;
    } catch {
      // ignore
    }
  }
  return false;
};

export type TRunSetupOptions = {
  readonly resolveShellDeps?: TResolveShellDeps;
};

/**
 * Link the binary and seed PATH/completions for the resolved shell.
 * Returns the number of failed steps (0 = success).
 */
export const runSetup = (options: TRunSetupOptions = {}): number => {
  const path = binPath();
  let failures = 0;
  const deps = options.resolveShellDeps;

  migrateLegacyLinks();

  for (const name of LINK_NAMES) {
    const link = linkName(name);
    if (link !== null) {
      process.stdout.write(`✓ PATH     ${link} → ${path}\n`);
    } else {
      failures += 1;
      process.stdout.write(
        `✗ PATH     no writable bin dir for ${name} — link manually:\n           ln -sf ${path} ~/.local/bin/${name}\n`,
      );
    }
  }

  const resolved = resolveShell(deps);
  const resolvedCompletionShell =
    resolved.name !== null && isKnownShell(resolved.name)
      ? resolved.name
      : undefined;

  const rcResult = installRcBlock(deps);
  if (rcResult.ok) {
    process.stdout.write(
      `✓ rc       PATH + ollm alias written → ${rcResult.rc}\n`,
    );
  } else if (rcResult.kind === "unsupported") {
    failures += 1;
    const label = rcResult.shell ?? "unknown";
    process.stdout.write(`✗ rc       unsupported shell (${label})\n`);
  } else {
    failures += 1;
    process.stdout.write(
      `✗ rc       could not write ${rcResult.rc}: ${rcResult.reason}\n`,
    );
  }

  // Only an explicitly resolved shell: never fall back to detectShell here.
  const comp =
    resolvedCompletionShell === undefined
      ? null
      : installCompletion(resolvedCompletionShell);
  if (comp !== null) {
    process.stdout.write(`✓ complete shell completion installed → ${comp}\n`);
    process.stdout.write(
      "\nRestart your shell (or source the rc) to pick everything up.\n",
    );
  } else if (!resolved.known) {
    failures += 1;
    const label = resolved.name ?? "unknown";
    process.stdout.write(
      `✗ complete unsupported shell (${label}); or run: openllm completion <shell>\n`,
    );
  } else {
    failures += 1;
    const shellName =
      resolved.name === "zsh" || resolved.name === "fish"
        ? resolved.name
        : "bash";
    const target = completionTargetPath(shellName);
    process.stdout.write(
      `✗ complete could not write ${target}: unwritable; or run: openllm completion <shell>\n`,
    );
  }

  // Show whenever the binary isn't on PATH — even if rc/completion failed —
  // so the current session can still reach the just-installed binary.
  if (!openllmBinOnPath()) {
    process.stdout.write(
      `\n# for this session:\n${sessionPathExportLine()}\n`,
    );
  }

  return failures === 0 ? 0 : 1;
};
