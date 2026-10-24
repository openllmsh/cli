#!/usr/bin/env bun

/**
 * `openllm` — the OpenLLM CLI, and the daemon (`openllm daemon …`), in one
 * binary. Self-version (`--version` / `-v` / `version`) prints
 * `openllm v${CLI_VERSION}` and exits without importing clients, MCP,
 * sessions, or the daemon. Daemon argv lazy-imports the daemon module graph;
 * all other argv goes through a lazy `cli-dispatch` import.
 *
 * Combined daemon/CLI diagnostics remain on doctor/status, not version.
 */

// MUST be the entrypoint's FIRST import: the daemon half's RTC stack
// (`werift` → `@peculiar/x509` → tsyringe) throws at module load without the
// Reflect polyfill, and `bun build --compile` drops the side-effect import
// unless the ENTRY carries it. See the daemon's `src/main.ts`;
// `tests/daemon/compiled-boot.test.ts` guards it.
import "reflect-metadata";

import { basename } from "node:path";
import { printSelfVersion } from "./cli-version";
import { daemonArgs } from "./daemon-argv";

// The device trust anchor lives only in the env FILE; never let an exported
// copy reach a child of either half (inline: `env.ts` is not imported here).
delete process.env.OPENLLM_DEVICE_ANCHOR;

const argv = process.argv.slice(2);
const first = argv[0];

const run = async (): Promise<void> => {
  // Daemon first: an `openllmd`-named invocation's `--version` is the daemon's.
  const forDaemon = daemonArgs(basename(process.argv0), argv);
  if (forDaemon !== null) {
    const { runDaemon } = await import("../daemon/src/main");
    runDaemon(forDaemon);
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    printSelfVersion();
  }
  // The detached launch-check child: converge quietly, then exit.
  if (first === "__self-update") {
    const { convergeSelf } = await import("./self-update");
    await convergeSelf({ quiet: true });
    process.exit(0);
  }
  // Per-prompt hooks should not initialize the vendor clients or MCP server.
  if (first === "exec" && argv[1] === "agent" && argv[2] === "hook") {
    // Not under a session host → nothing to bridge; skip every import.
    if ((process.env.OPENLLM_DEVICE_SESSION_ID ?? "").trim() === "")
      process.exit(0);
    const { runAgentHookCommand } = await import("./agent-hook-cmd");
    process.exit(await runAgentHookCommand(argv.slice(3)));
  }
  if (first === "exec" && argv[1] === "memory") {
    const { runMemoryHookCommand } = await import("./memory-hooks/command");
    process.exit(await runMemoryHookCommand(argv.slice(2)));
  }
  // Throttled, detached — the command below never waits on it.
  const { maybeLaunchUpdateCheck } = await import("./launch-update");
  maybeLaunchUpdateCheck(first);
  const { runCli } = await import("./cli-dispatch");
  await runCli(argv);
};

run().catch((err) => {
  process.stderr.write(
    `[openllm] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
