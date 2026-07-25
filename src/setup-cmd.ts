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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { installCompletion } from "./completion";

const BIN_DIR = join(homedir(), ".openllm", "bin");
const BIN_PATH = join(BIN_DIR, "openllm");
/** Legacy binary path (pre-rename installs). */
const LEGACY_BIN_PATH = join(BIN_DIR, "openllmc");

/** The owned rc block markers — install/uninstall operate on exactly this
 *  region, never on the rest of the user's rc. */
export const RC_BEGIN = "# >>> openllm (managed) >>>";
export const RC_END = "# <<< openllm (managed) <<<";

/** Names we link onto PATH — the binary and its short alias. */
const LINK_NAMES = ["openllm", "ollm"] as const;

const PATH_DIR_CANDIDATES = [
  "/usr/local/bin",
  join(homedir(), ".local", "bin"),
] as const;

/** True when `link` is a symlink whose target is one of OUR binaries (the
 *  new path, the legacy path, or a sibling `openllm` link). */
const pointsAtOurs = (link: string): boolean => {
  try {
    const target = readlinkSync(link);
    return (
      target === BIN_PATH ||
      target === LEGACY_BIN_PATH ||
      basename(target) === "openllm"
    );
  } catch {
    return false; // not a symlink (or unreadable) — not ours
  }
};

/** Best-effort symlink of one name into the first writable PATH dir.
 *  Returns the link path or null when no dir was writable. */
const linkName = (name: string): string | null => {
  for (const dir of PATH_DIR_CANDIDATES) {
    const link = join(dir, name);
    try {
      mkdirSync(dir, { recursive: true });
      // Replace only a symlink pointing at our binary — never clobber a
      // foreign regular file (or foreign symlink) with this name.
      if (existsSync(link)) {
        if (readlinkSync(link) === BIN_PATH) return link; // already correct
        if (!pointsAtOurs(link)) continue; // foreign — try the next dir
        unlinkSync(link);
      }
      symlinkSync(BIN_PATH, link);
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
 * Also leaves a `openllmc → openllm` symlink inside ~/.openllm/bin when a
 * legacy binary file was replaced by the rename, so absolute-path callers
 * (old MCP entries, old hooks) keep working.
 */
const migrateLegacyLinks = (): void => {
  for (const dir of PATH_DIR_CANDIDATES) {
    const link = join(dir, "openllmc");
    try {
      if (existsSync(link) && pointsAtOurs(link)) {
        unlinkSync(link);
        symlinkSync(BIN_PATH, link);
      }
    } catch {
      // best-effort — a foreign or unwritable link is left alone
    }
  }
  try {
    // ~/.openllm/bin/openllmc: replace a stale regular file (the pre-rename
    // binary) or wrong-target link with a transitional symlink to openllm.
    if (existsSync(LEGACY_BIN_PATH)) {
      try {
        if (readlinkSync(LEGACY_BIN_PATH) === BIN_PATH) return; // already done
      } catch {
        // regular file (old binary) — replace below
      }
      unlinkSync(LEGACY_BIN_PATH);
    }
    if (existsSync(BIN_PATH)) symlinkSync(BIN_PATH, LEGACY_BIN_PATH);
  } catch {
    // best-effort
  }
};

/** The rc file for the user's login shell, or null when unsupported. */
const rcFileForShell = (): { rc: string; fish: boolean } | null => {
  const shell = basename(process.env.SHELL ?? "");
  if (shell === "zsh") return { rc: join(homedir(), ".zshrc"), fish: false };
  if (shell === "bash") return { rc: join(homedir(), ".bashrc"), fish: false };
  if (shell === "fish")
    return {
      rc: join(homedir(), ".config", "fish", "config.fish"),
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

/**
 * Write (or refresh) the owned rc block. Idempotent: an existing block is
 * replaced in place; otherwise the block is appended. Returns the rc path,
 * or null when the shell is unsupported or the rc is not writable.
 */
export const installRcBlock = (): string | null => {
  const target = rcFileForShell();
  if (target === null) return null;
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
    return rc;
  } catch {
    return null; // read-only rc (sandbox) — reported by the caller
  }
};

/** Remove the owned rc block (uninstall path). Best-effort; silent. */
export const removeRcBlock = (): void => {
  const target = rcFileForShell();
  if (target === null) return;
  try {
    const content = readFileSync(target.rc, "utf-8");
    const begin = content.indexOf(RC_BEGIN);
    const end = content.indexOf(RC_END);
    if (begin < 0 || end <= begin) return;
    const next = (
      content.slice(0, begin) + content.slice(end + RC_END.length)
    ).replace(/\n{3,}/g, "\n\n");
    writeFileSync(target.rc, next);
  } catch {
    // best-effort
  }
};

/** Remove every PATH symlink we own (uninstall path). Best-effort. */
export const removeOwnedLinks = (): void => {
  for (const dir of PATH_DIR_CANDIDATES) {
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
    if (existsSync(LEGACY_BIN_PATH) && pointsAtOurs(LEGACY_BIN_PATH))
      unlinkSync(LEGACY_BIN_PATH);
  } catch {
    // best-effort
  }
};

export const runSetup = (): number => {
  let failures = 0;

  migrateLegacyLinks();

  for (const name of LINK_NAMES) {
    const link = linkName(name);
    if (link !== null) {
      process.stdout.write(`✓ PATH     ${link} → ${BIN_PATH}\n`);
    } else {
      failures += 1;
      process.stdout.write(
        `✗ PATH     no writable bin dir for ${name} — link manually:\n           ln -sf ${BIN_PATH} ~/.local/bin/${name}\n`,
      );
    }
  }

  const rc = installRcBlock();
  if (rc !== null) {
    process.stdout.write(`✓ rc       PATH + ollm alias written → ${rc}\n`);
  } else {
    failures += 1;
    process.stdout.write(
      "✗ rc       could not write the shell rc (unsupported shell — set $SHELL to bash/zsh/fish — or unwritable rc)\n",
    );
  }

  const comp = installCompletion();
  if (comp !== null) {
    process.stdout.write(`✓ complete shell completion installed → ${comp}\n`);
    process.stdout.write(
      "\nRestart your shell (or source the rc) to pick everything up.\n",
    );
  } else {
    failures += 1;
    process.stdout.write(
      "✗ complete could not install (unsupported shell — set $SHELL to bash/zsh/fish — or unwritable rc); or run: openllm completion <shell>\n",
    );
  }

  return failures === 0 ? 0 : 1;
};
