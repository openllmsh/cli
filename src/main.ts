#!/usr/bin/env bun

/**
 * `openllm` — the OpenLLM CLI. Compile entry stays here so the binary
 * identity does not change. Self-version (`--version` / `-v` / `version`)
 * prints `openllm v${CLI_VERSION}` and exits without importing clients,
 * MCP, sessions, or daemon delegation. All other argv goes through a
 * lazy `cli-dispatch` import.
 *
 * Combined daemon/CLI diagnostics remain on doctor/status, not version.
 */

import { printSelfVersion } from "./cli-version";

const argv = process.argv.slice(2);
const first = argv[0];

if (first === "--version" || first === "-v" || first === "version") {
  printSelfVersion();
}

const run = async (): Promise<void> => {
  // Per-prompt hooks should not initialize the vendor clients or MCP server.
  if (first === "exec" && argv[1] === "memory") {
    const { runMemoryHookCommand } = await import("./memory-hooks/command");
    process.exit(await runMemoryHookCommand(argv.slice(2)));
  }
  const { runCli } = await import("./cli-dispatch");
  await runCli(argv);
};

run().catch((err) => {
  process.stderr.write(
    `[openllm] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
