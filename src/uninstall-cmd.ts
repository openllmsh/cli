/**
 * `openllm uninstall` — the top-level, product-wide uninstall. The CLI OWNS the
 * top-level command but not the daemon's teardown: it delegates that to
 * `openllmd uninstall` (which owns its own confirm + keep-logins prompt), then
 * removes its OWN surface. Each binary knows only its own state — no binary
 * enumerates the other's — so the two teardowns compose without cross-mapping.
 *
 * Order:
 *   1. delegate to `openllmd uninstall` — it prompts (confirm + keep-logins),
 *      stops/unregisters the service, and removes DAEMON-owned state, leaving
 *      the CLI's client ledgers in place. A nonzero exit (user aborted, or the
 *      daemon failed) stops the whole uninstall before any CLI change.
 *   2. reverse always-on client wiring (Raycast region; Hermes sticky profile) —
 *      still readable because the daemon left `clients/*.json` untouched.
 *   3. drop the openllm/ollm PATH symlinks, the managed rc block, and completion.
 *   4. remove CLI-owned state, then the shared `~/.openllm` root if it is now
 *      empty (a kept `cli/` keeps it around).
 *
 * When no daemon is installed, step 1 is skipped and the CLI owns the
 * confirmation itself.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { uninstallHermes } from "./clients/hermes";
import { uninstallRaycast } from "./clients/raycast";
import { removeCompletion } from "./completion";
import { findDaemonBinary, runManagedDaemonCommand } from "./daemon-delegation";
import { openllmDir } from "./env";
import { removeOwnedLinks, removeRcBlock } from "./setup-cmd";

const CLIENTS_DIR = (): string => join(openllmDir(), "clients");

/** Always-on clients with an ownership ledger — the ones with wiring to undo. */
const appliedAlwaysOnClients = (): string[] => {
  try {
    return readdirSync(CLIENTS_DIR())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
};

/**
 * The CLI's OWN state under `~/.openllm` — the exact set this command removes.
 * Self-contained: the CLI enumerates only its own entries and never the
 * daemon's. `bin/` is shared, so only the CLI binaries are dropped from it.
 */
const CLI_STATE_ENTRIES: readonly string[] = [
  "clients", // always-on client ownership ledgers
  "run", // CLI run dir
  "backups", // config backups
  "installed", // install markers
  "setup", // setup overlay cache
];
const CLI_BINARIES: readonly string[] = ["openllm", "openllmc"];

/** Flags the daemon owns — forwarded verbatim so it can honour them in its own
 *  confirm + keep-logins prompts. */
const DAEMON_FLAGS = new Set([
  "--yes",
  "-y",
  "--keep-logins",
  "--remove-logins",
]);

const UNINSTALL_USAGE = `usage: openllm uninstall [--yes] [--keep-logins|--remove-logins]

Uninstall OpenLLM from this machine. Delegates daemon teardown to \`openllmd
uninstall\` (which stops the service and removes daemon state, asking whether to
keep your subscription logins), then removes the CLI: reverse any always-on
client wiring (Raycast providers region; Hermes sticky openllm profile), drop
the openllm/ollm PATH symlinks, strip the managed shell-rc block and completion,
and delete CLI state under ~/.openllm.

  --yes, -y            skip the confirmation prompt
  --keep-logins        keep ~/.openllm/cli so a reinstall reuses subscription logins
  --remove-logins      remove them (the default under --yes)

Requires a TTY unless --yes is passed.
`;

/** Prompt for a typed confirmation. Returns false unless the user types yes.
 *  Only used when no daemon is present (otherwise the daemon owns the prompt). */
const confirm = async (): Promise<boolean> => {
  process.stdout.write(
    "This removes the openllm CLI from this machine.\nType 'yes' to continue: ",
  );
  const line = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    const onData = (chunk: string): void => {
      buf += chunk;
      if (buf.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
  return line.trim().toLowerCase() === "yes";
};

/** Remove CLI-owned files, then the shared `~/.openllm` root if it is now empty
 *  (a kept `cli/` leaves the root in place). */
const removeCliState = (): void => {
  const dir = openllmDir();
  for (const entry of CLI_STATE_ENTRIES) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
  const binDir = join(dir, "bin");
  for (const bin of CLI_BINARIES) {
    rmSync(join(binDir, bin), { force: true });
  }
  // Drop the shared bin/ only when we emptied it.
  try {
    if (existsSync(binDir) && readdirSync(binDir).length === 0) {
      rmSync(binDir, { recursive: true, force: true });
    }
  } catch {
    // best-effort — a leftover bin/ is harmless
  }
  // Remove the shared root only when nothing remains (kept logins keep it).
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
};

export const runUninstall = async (
  args: readonly string[],
): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(UNINSTALL_USAGE);
    return 0;
  }
  const yes = args.includes("--yes") || args.includes("-y");
  const daemon = findDaemonBinary();

  // 1. Delegate daemon teardown — the daemon owns the destructive confirmation
  //    AND the keep-logins question. We only forward the flags it understands.
  if (daemon !== null) {
    const forwarded = args.filter((a) => DAEMON_FLAGS.has(a));
    const code = await runManagedDaemonCommand("uninstall", forwarded, {
      OPENLLM_UNINSTALL_DELEGATED: "1",
    });
    if (code !== 0) {
      // User aborted at the daemon prompt, or daemon teardown failed — stop
      // before touching anything CLI-owned.
      process.stdout.write(
        "Uninstall stopped — nothing further was removed.\n",
      );
      return code;
    }
  } else {
    // No daemon on this machine — the CLI owns the confirmation itself.
    if (!yes) {
      if (!process.stdin.isTTY) {
        process.stderr.write(
          "Refusing to uninstall without a TTY — re-run with --yes.\n",
        );
        return 1;
      }
      if (!(await confirm())) {
        process.stdout.write("Aborted.\n");
        return 1;
      }
    }
    process.stdout.write("No daemon installed — removing the openllm CLI.\n");
  }

  // 2. Always-on clients FIRST — while the ledgers and this binary still exist.
  for (const client of appliedAlwaysOnClients()) {
    if (client === "raycast") {
      process.stdout.write("Reversing Raycast wiring...\n");
      uninstallRaycast();
    }
    if (client === "hermes") {
      process.stdout.write("Reversing Hermes profile wiring...\n");
      uninstallHermes();
    }
  }

  // 3. Shell surface we own.
  removeOwnedLinks();
  removeRcBlock();
  removeCompletion();

  // 4. CLI-owned state (+ the shared root if it is now empty).
  removeCliState();

  const keptLogins = existsSync(join(openllmDir(), "cli"));
  process.stdout.write(
    "✓ OpenLLM fully removed\n" +
      (keptLogins
        ? `  kept your subscription logins (${join(openllmDir(), "cli")}) for a future reinstall\n`
        : ""),
  );
  return 0;
};
