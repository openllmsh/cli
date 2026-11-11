/**
 * `openllm uninstall` — the top-level, product-wide uninstall. The CLI OWNS the
 * top-level command but not the daemon's teardown: it delegates that to
 * `openllm daemon uninstall` (which owns its own confirm + keep-logins prompt),
 * then removes its OWN surface. Each half knows only its own state — neither
 * enumerates the other's — so the two teardowns compose without cross-mapping.
 *
 * Order:
 *   1. capture live host targets with a side-effect-free discovery (no
 *      reaping) and leave them running until the daemon half succeeds — so a
 *      declined / failed daemon uninstall (interactive OR `--yes`) never
 *      stops sessions. The daemon half may prune `sessions/` metas and stop
 *      hosts itself; `OPENLLM_UNINSTALL_HOSTS_STOPPED` stays 0 here so its
 *      count is not double-counted.
 *   2. delegate to `openllm daemon uninstall` — it prompts (confirm + keep-logins),
 *      stops/unregisters the service, and removes DAEMON-owned state, leaving
 *      the CLI's client ledgers in place. A nonzero exit (user aborted, or the
 *      daemon failed) stops the whole uninstall before any CLI change.
 *   3. after the daemon half succeeds, stop the hosts captured in step 1
 *      (covers older daemons that confirmed but did not reap hosts, even
 *      after metas are gone).
 *   4. reverse always-on client wiring (Raycast region; ChatGPT launcher; Hermes sticky profile) —
 *      still readable because the daemon left `clients/*.json` untouched.
 *   5. drop the openllm/ollm PATH symlinks, the managed rc block, and completion.
 *   6. remove CLI-owned state, then the shared `~/.openllm` root if it is now
 *      empty (a kept `cli/` keeps it around).

 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  isAlwaysOnClientId,
  uninstallAlwaysOnClient,
} from "./clients/always-on";
import { uninstallHermes } from "./clients/hermes";
import { removeCompletion } from "./completion";
import { runManagedDaemonCommand } from "./daemon-delegation";
import { openllmDir } from "./env";
import type { TLiveSessionHost } from "./session-host";
import { discoverLiveSessionHosts, stopSessionHosts } from "./session-host";
import { removeOwnedLinks, removeRcBlock } from "./setup-cmd";

/** Directory of embedded client overlay data inside the binary. */
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
client wiring (Raycast providers region; OpenLLM ChatGPT launcher; Hermes
sticky openllm profile), drop
the openllm/ollm PATH symlinks, strip the managed shell-rc block and completion,
and delete CLI state under ~/.openllm.

  --yes, -y            skip the confirmation prompt
  --keep-logins        keep ~/.openllm/cli so a reinstall reuses subscription logins
  --remove-logins      remove them (the default under --yes)

Requires a TTY unless --yes is passed.
`;

/** Remove CLI-owned files, then the shared `~/.openllm` root if it is now empty
 *  (a kept `cli/` leaves the root in place). When `removeRoot`, wipe the whole
 *  tree — the `--remove-logins` / `--yes` path must leave nothing behind. */
const removeCliState = (removeRoot: boolean): void => {
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
  if (removeRoot) {
    rmSync(dir, { recursive: true, force: true });
    return;
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

/** Remove OpenLLM install artifacts and stop local daemons/session hosts. */
export const runUninstall = async (
  args: readonly string[],
): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(UNINSTALL_USAGE);
    return 0;
  }
  // Capture targets without reaping so a declined / failed daemon half
  // (interactive OR `--yes`) leaves sessions untouched. Stop the captured
  // set only after the daemon half succeeds — it may already have pruned
  // `sessions/` metas and stopped hosts itself.
  const capturedHosts: readonly TLiveSessionHost[] = discoverLiveSessionHosts({
    reapStale: false,
  });

  // Delegate daemon teardown — the daemon owns the destructive confirmation
  // AND the keep-logins question. We only forward the flags it understands.
  // `OPENLLM_UNINSTALL_HOSTS_STOPPED` stays 0: this half has not stopped any
  // hosts yet; the daemon counts what it stops itself.
  const forwarded = args.filter((a) => DAEMON_FLAGS.has(a));
  const code = await runManagedDaemonCommand("uninstall", forwarded, {
    OPENLLM_UNINSTALL_DELEGATED: "1",
    OPENLLM_UNINSTALL_HOSTS_STOPPED: "0",
  });
  if (code !== 0) {
    // User aborted at the daemon prompt, or daemon teardown failed — stop
    // before touching anything CLI-owned. Session hosts were left running.
    process.stdout.write("Uninstall stopped — nothing further was removed.\n");
    return code;
  }

  // Best-effort for older daemons that confirmed but did not reap hosts.
  // Use the pre-daemon capture: rediscovery would miss pruned metas.
  await stopSessionHosts(capturedHosts);

  // Always-on clients FIRST — while the ledgers and this binary still exist.
  for (const client of appliedAlwaysOnClients()) {
    if (isAlwaysOnClientId(client)) {
      process.stdout.write(`Reversing ${client} wiring...\n`);
      uninstallAlwaysOnClient(client);
    }
    if (client === "hermes") {
      process.stdout.write("Reversing Hermes profile wiring...\n");
      uninstallHermes();
    }
  }

  // 4. Shell surface we own.
  removeOwnedLinks();
  removeRcBlock();
  removeCompletion();

  // 5. CLI-owned state. When the daemon half did not keep logins, wipe the
  //    whole `~/.openllm` tree so a detached pidfile / diagnostics / leftover
  //    dir cannot survive (`--yes --remove-logins` must leave nothing).
  const keptLogins = existsSync(join(openllmDir(), "cli"));
  removeCliState(!keptLogins);

  process.stdout.write(
    "✓ OpenLLM fully removed\n" +
      (keptLogins
        ? `  kept your subscription logins (${join(openllmDir(), "cli")}) for a future reinstall\n`
        : ""),
  );
  return 0;
};
