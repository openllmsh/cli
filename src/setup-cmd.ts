/**
 * `openllmc setup` — the ONE post-install command: put `openllmc` on PATH
 * (symlink into /usr/local/bin or ~/.local/bin) and install shell
 * completion for the current shell. Idempotent; safe to re-run.
 *
 * Exists because a DAEMON-DRIVEN install runs sandboxed, where the PATH
 * dirs are deliberately read-only (launcher-trojan guard) — the installer
 * skips the symlink there and the dashboard shows this command for the
 * user to run unsandboxed:
 *
 *   ~/.openllm/bin/openllmc setup
 */

import {
  existsSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installCompletion } from "./completion";

const BIN_PATH = join(homedir(), ".openllm", "bin", "openllmc");

/** Best-effort symlink into the first writable PATH-friendly dir. Returns the
 *  link path or null when no dir was writable. */
const linkOntoPath = (): string | null => {
  const candidates = [
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ] as const;
  for (const dir of candidates) {
    const link = join(dir, "openllmc");
    try {
      mkdirSync(dir, { recursive: true });
      // Replace only a symlink (ours points at BIN_PATH) — never clobber a
      // foreign regular file named openllmc.
      if (existsSync(link)) {
        try {
          if (readlinkSync(link) === BIN_PATH) return link; // already correct
        } catch {
          continue; // a real file — leave it alone, try the next dir
        }
        unlinkSync(link);
      }
      symlinkSync(BIN_PATH, link);
      return link;
    } catch {
      // unwritable — try the next candidate
    }
  }
  return null;
};

export const runSetup = (): number => {
  let failures = 0;

  const link = linkOntoPath();
  if (link !== null) {
    process.stdout.write(`✓ PATH     ${link} → ${BIN_PATH}\n`);
    const dir = link.slice(0, link.lastIndexOf("/"));
    if (!(process.env.PATH ?? "").split(":").includes(dir)) {
      process.stdout.write(
        `  note: ${dir} is not on your PATH — add it to your shell rc\n`,
      );
    }
  } else {
    failures += 1;
    process.stdout.write(
      `✗ PATH     no writable bin dir — link manually:\n           ln -sf ${BIN_PATH} ~/.local/bin/openllmc\n`,
    );
  }

  const rc = installCompletion();
  if (rc !== null) {
    process.stdout.write(`✓ complete shell completion installed → ${rc}\n`);
    process.stdout.write(
      "\nRestart your shell (or source the rc) to pick both up.\n",
    );
  } else {
    failures += 1;
    process.stdout.write(
      "✗ complete could not install (unsupported shell — set $SHELL to bash/zsh/fish — or unwritable rc); or run: openllmc completion <shell>\n",
    );
  }

  return failures === 0 ? 0 : 1;
};
