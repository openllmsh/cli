/**
 * `openllmd uninstall` — remove the OpenLLM DAEMON from this machine. It owns
 * only the daemon's own teardown; the CLI owns its own (`openllm uninstall`),
 * which delegates here first and then removes the CLI surface. So this leaves
 * CLI-owned state (the client ledgers, the `openllm` binary, run dir) in place.
 *
 * Order matters — we STOP the self-restoring service FIRST (so launchd /
 * systemd can't relaunch the daemon mid-teardown), then delete daemon state:
 *
 *   1. confirm (destructive + irreversible — daemon credentials are deleted)
 *   2. stop + unregister the background service (launch agent / systemd unit)
 *   3. remove shell completion (rc line + fish file)
 *   4. remove the `openllmd` PATH symlink (only if it's ours)
 *   5. delete DAEMON state under `~/.openllm` — the `openllmd` binary, paired
 *      API key, encryption keypair, sessions, logs — while PRESERVING CLI-owned
 *      entries (see `CLI_OWNED_ENTRIES`). OPTIONALLY also preserve
 *      `~/.openllm/cli` (the subscription logins) so a later reinstall reuses
 *      them instead of re-authenticating.
 *
 * The running process keeps executing from its already-loaded binary even
 * after its file is unlinked (the inode survives until exit), so deleting the
 * state dir from within is safe; we exit at the end.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { uninstallCompletion } from "./completion";
import { stateDir } from "./env";
import { serviceUninstall } from "./service";

const out = (s: string): void => {
  process.stdout.write(s);
};

/** The `openllmd` binary the installers drop under the state dir. */
const binPath = (): string => join(stateDir(), "bin", "openllmd");

/**
 * The subscription logins live under `~/.openllm/cli/<provider>/home` (see
 * `cli-paths.ts`) — each vendor CLI's authenticated home. Preserving this
 * subtree across an uninstall lets a later reinstall reuse those logins instead
 * of re-authenticating.
 */
export const loginsDir = (): string => join(stateDir(), "cli");

/** True when there is at least one subscription login worth keeping. */
const hasLogins = (): boolean => {
  try {
    return existsSync(loginsDir()) && readdirSync(loginsDir()).length > 0;
  } catch {
    return false;
  }
};

/**
 * The daemon's OWN top-level state under `~/.openllm` — the exact set
 * `openllmd uninstall` removes. Self-contained: the daemon knows only its own
 * files and never enumerates the CLI's, so it can never wipe CLI-owned state
 * (the `clients/` ledgers, `bin/openllm`, `run/`, …). `cli/` (subscription
 * logins) is handled separately so it can be preserved. The daemon binary
 * `bin/openllmd` lives in the shared `bin/` and is removed on its own below.
 */
const DAEMON_STATE_ENTRIES: readonly string[] = [
  ".env", // paired API key + origin
  "state.json", // daemon runtime state (update cooldowns, boot history)
  "x25519-priv", // the daemon's encryption private key
  "sessions", // remote PTY session state
  "debug", // debug artifacts
  "openllmd.log",
  "openllmd.out.log",
  "openllmd.err.log",
];

/**
 * Remove the daemon's own state, leaving every CLI-owned entry untouched. When
 * `keepLogins`, `~/.openllm/cli` is preserved too. Returns a one-line summary
 * for the caller to print. Exported for tests.
 */
export const pruneState = (keepLogins: boolean): string => {
  const dir = stateDir();
  if (!existsSync(dir)) return `state dir already gone (${dir})`;
  // The daemon binary is the daemon's, even though `bin/` is shared.
  rmSync(join(dir, "bin", "openllmd"), { force: true });
  for (const entry of DAEMON_STATE_ENTRIES) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
  if (!keepLogins) rmSync(loginsDir(), { recursive: true, force: true });
  return keepLogins
    ? `removed daemon state, kept your subscription logins (${loginsDir()})`
    : `removed daemon state (${dir})`;
};

/**
 * Remove an `openllmd` PATH symlink ONLY when it's one we own — a symlink
 * resolving to OUR `bin/openllmd`. A real binary, or a link to a different
 * install, is left untouched (we never delete an unrelated `openllmd`). The
 * installers try `/usr/local/bin` then `~/.local/bin`, so check both.
 */
const removeOwnedLinks = (): string[] => {
  const removed: string[] = [];
  const ours = binPath();
  for (const dir of ["/usr/local/bin", join(homedir(), ".local", "bin")]) {
    const link = join(dir, "openllmd");
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(link);
    } catch {
      continue; // nothing there
    }
    if (!stat.isSymbolicLink()) continue; // a real file — not ours, leave it
    let target: string;
    try {
      target = resolve(dir, readlinkSync(link));
    } catch {
      continue;
    }
    if (target !== ours) continue; // points elsewhere — not ours
    try {
      unlinkSync(link);
      removed.push(link);
    } catch {
      // best-effort — a non-writable dir shouldn't abort the uninstall
    }
  }
  return removed;
};

/** The destructive-action gate. When CLI logins are `keepable`, the copy notes
 *  they can be preserved (the follow-up question decides) rather than claiming
 *  every credential is deleted. */
const confirmPrompt = (keepable: boolean): string =>
  `⚠️  This will remove the OpenLLM daemon from this machine:

  • stop and UNREGISTER the background service (launch agent / systemd unit),
    so it no longer self-restores on login or reboot
  • DELETE local state under ${stateDir()} — the paired API key and the
    daemon's encryption keypair${
      keepable ? "" : ", and your stored subscription CREDENTIALS"
    }
  • remove the openllmd binary, its PATH symlink, and shell completion
${
  keepable
    ? `\nYou'll then be asked whether to KEEP your subscription logins\n(${loginsDir()}) so a future reinstall can reuse them.\n`
    : ""
}
This is IRREVERSIBLE. You'll need to reinstall${
    keepable ? "" : " and reconnect your\nsubscriptions"
  } to use the daemon again.

Type 'yes' to continue: `;

/** The subscription-logins keep/remove question, shown after the uninstall is
 *  confirmed. Defaults to KEEP (an empty answer keeps them). */
const keepLoginsPrompt = (): string =>
  `Keep your subscription logins under\n${loginsDir()}\nso a future reinstall can reuse them (skip re-authenticating)? [Y/n] `;

/** True when the user passed an explicit non-interactive confirm flag. */
const hasYesFlag = (args: readonly string[]): boolean =>
  args.includes("--yes") || args.includes("-y");

/**
 * Confirm the destructive action. With `--yes`/`-y`, skip the prompt. In an
 * interactive shell, require the user to type `yes`. In a NON-interactive shell
 * without `--yes`, refuse (rather than read a misleading empty line) and tell
 * them how to proceed.
 */
const confirm = (args: readonly string[], keepable: boolean): boolean => {
  if (hasYesFlag(args)) return true;
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      "openllmd uninstall is destructive and needs confirmation.\n" +
        "Re-run in an interactive shell, or pass --yes to skip the prompt:\n" +
        "  openllmd uninstall --yes\n",
    );
    return false;
  }
  // Require the exact word the prompt asks for — no bare `y` shorthand for an
  // irreversible, credential-deleting action (the explicit -y/--yes flag is the
  // intentional non-interactive shorthand).
  const answer = (prompt(confirmPrompt(keepable)) ?? "").trim().toLowerCase();
  return answer === "yes";
};

/**
 * Decide whether to preserve `~/.openllm/cli`. `--keep-logins` /
 * `--remove-logins` settle it non-interactively; `--yes`/`-y` (explicit "don't
 * prompt me") defaults to a full clean; otherwise a TTY is asked, defaulting to
 * KEEP. Only called when there are subscription logins worth keeping.
 */
const keepLoginsDecision = (args: readonly string[]): boolean => {
  if (args.includes("--keep-logins")) return true;
  if (args.includes("--remove-logins")) return false;
  if (hasYesFlag(args)) return false;
  if (process.stdin.isTTY !== true) return false;
  const answer = (prompt(keepLoginsPrompt()) ?? "").trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
};

/**
 * Run `openllmd uninstall`. Exits the process (0 on completion, 1 on abort).
 */
export const runUninstall = (args: readonly string[]): never => {
  const keepable = hasLogins();
  if (!confirm(args, keepable)) {
    out("\nAborted — nothing was removed.\n");
    process.exit(1);
  }
  const keepLogins = keepable && keepLoginsDecision(args);

  out("\nRemoving the OpenLLM daemon…\n");

  // 1. Stop + unregister the service (kills self-restore before we delete).
  const removedService = serviceUninstall();
  out(
    removedService !== null
      ? `  ✓ stopped + unregistered the service (${removedService})\n`
      : "  ✓ service stopped (no registration found)\n",
  );

  // 2. Shell completion.
  const completion = uninstallCompletion();
  out(
    completion.length > 0
      ? `  ✓ removed shell completion (${completion.join(", ")})\n`
      : "  ✓ shell completion (none found)\n",
  );

  // 3. PATH symlink (only if it's ours).
  const links = removeOwnedLinks();
  out(
    links.length > 0
      ? `  ✓ removed PATH symlink (${links.join(", ")})\n`
      : "  ✓ PATH symlink (none owned by us)\n",
  );

  // 4. Daemon state — binary, API key, keypair, sessions, logs — while leaving
  //    CLI-owned entries in place. When the user opted to keep them, the
  //    subscription logins under `~/.openllm/cli` also survive.
  out(`  ✓ ${pruneState(keepLogins)}\n`);

  if (keepLogins) {
    out(
      `\nOpenLLM daemon removed. Your subscription logins were kept at\n${loginsDir()}\nso a reinstall can reuse them.\n`,
    );
  } else {
    out("\nOpenLLM daemon removed.\n");
  }
  // When `openllm uninstall` delegated here it removes the CLI surface next and
  // prints the authoritative summary, so don't nudge toward it redundantly.
  if (process.env.OPENLLM_UNINSTALL_DELEGATED !== "1") {
    out(
      "The openllm CLI is left installed — run `openllm uninstall` to remove everything.\n",
    );
  }
  process.exit(0);
};
