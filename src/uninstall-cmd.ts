/**
 * `openllm uninstall` — remove the CLI from this machine.
 *
 * Ordering matters: ALWAYS-ON clients are reversed FIRST, while the binary and
 * its ledgers still exist. Skipping that would strand a live `sk-llm` key
 * inside Raycast's `providers.yaml` with no tool left to remove it.
 *
 * Scope is deliberately narrow — we remove only what we own:
 *   - always-on client wiring (per its ownership ledger),
 *   - the PATH symlinks that point at OUR binary (openllm, ollm, and any
 *     transitional openllmc),
 *   - the owned shell-rc block + completion entries,
 *   - ~/.openllm/{bin/openllm,run,clients}.
 *
 * NOT touched: `~/.openllm/.env` (shared with the daemon — removing it would
 * unpair the daemon too), the daemon binary, and every third-party config.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { uninstallRaycast } from "./clients/raycast";
import { removeCompletion } from "./completion";
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

const UNINSTALL_USAGE = `usage: openllm uninstall [--yes]

Remove the openllm CLI from this machine: reverse any always-on client wiring
(Raycast), drop the openllm/ollm PATH symlinks, strip the managed shell-rc
block and completion, and delete ~/.openllm/{bin/openllm,run,clients}.

Left alone: ~/.openllm/.env (shared with the daemon), the daemon itself, and
every third-party client config.

Requires a TTY unless --yes is passed.
`;

/** Prompt for a typed confirmation. Returns false unless the user types yes. */
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

export const runUninstall = async (
  args: readonly string[],
): Promise<number> => {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(UNINSTALL_USAGE);
    return 0;
  }
  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes) {
    // Refuse in a non-TTY rather than reading a misleading blank line.
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

  // 1. Always-on clients FIRST — while the ledgers and this binary still exist.
  for (const client of appliedAlwaysOnClients()) {
    if (client === "raycast") {
      process.stdout.write("Reversing Raycast wiring...\n");
      uninstallRaycast();
    }
  }

  // 2. Shell surface we own.
  removeOwnedLinks();
  removeRcBlock();
  removeCompletion();

  // 3. Our own files. The shared .env stays (the daemon boots from it).
  for (const path of [
    join(openllmDir(), "bin", "openllm"),
    join(openllmDir(), "run"),
    CLIENTS_DIR(),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }

  const envFile = join(openllmDir(), ".env");
  process.stdout.write(
    "✓ openllm CLI removed\n" +
      (existsSync(envFile)
        ? `  kept ${envFile} (shared with the daemon)\n`
        : "") +
      "  the daemon (openllmd) is untouched — remove it with: openllmd uninstall\n",
  );
  return 0;
};
