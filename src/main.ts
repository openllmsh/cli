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

import { tmpdir } from "node:os";
import { join } from "node:path";
import { printSelfVersion } from "./cli-version";

const argv = process.argv.slice(2);
const first = argv[0];

if (first === "--version" || first === "-v" || first === "version") {
  printSelfVersion();
}

/**
 * `openllm --self-test` — the bounded pre-swap health probe the self-updaters
 * run instead of `--version`. What it GUARANTEES about the binary it ran on:
 *
 *  1. The FULL lazy module graph loads — `cli-dispatch` plus every module
 *     real commands import (MCP server, sessions, doctor, self-update, the
 *     embedded OpenAPI spec). `--version` exits before any of it, so a binary
 *     could pass `--version` and still crash on every real command.
 *  2. The command table constructs — every `COMMANDS` entry renders into the
 *     top-level help text, and every dispatch selector (client ids, exec
 *     groups + verbs, MCP `--only` groups, auto-update actions,
 *     per-command completion args) resolves through its real parsing path.
 *  3. Runtime config initialization resolves with NO real state touched:
 *     `HOME` and the state-dir/env-file overrides are redirected to a
 *     never-created synthetic path while `openllmDir`/`sharedEnvFile`/
 *     `cliBinPath`/`cliConfig`/`cliUpdateRoute` execute — path resolution and
 *     `.env` fallback both run without reading or writing the user's actual
 *     state.
 *
 *  Side-effect free AND tmpdir-free (FSS-05): the probe home is a string the
 *  resolvers only compute with — it is never created, so a missing,
 *  unwritable, or full TMPDIR can no longer make a healthy release fail its
 *  own health check. Prints the same `openllm v…` line the probes parse,
 *  then exits 0 — any failure exits non-zero so the updater refuses to swap
 *  the build in.
 */
const runSelfTest = async (): Promise<void> => {
  try {
    const [commands, registry, env] = await Promise.all([
      import("./commands"),
      import("./clients/registry"),
      import("./env"),
      import("./cli-dispatch"),
      import("./memory-hooks/command"),
      import("./context-hooks/command"),
      import("./doctor-cmd"),
      import("./sdk/generated/openapi.json"),
    ]);

    // 2 — command table + every dispatch selector through its real parser.
    const help = commands.helpText(env.CLI_VERSION);
    for (const cmd of commands.COMMANDS) {
      if (!help.includes(cmd.name)) {
        throw new Error(`command table missing "${cmd.name}" in help text`);
      }
    }
    for (const key of Object.keys(commands.COMMAND_ARGS)) {
      if (
        !commands.COMMANDS.some((c) => c.name === key) &&
        !registry.isClientId(key)
      ) {
        throw new Error(`completion args reference unknown command "${key}"`);
      }
    }
    for (const id of Object.keys(registry.CLIENTS)) {
      if (!registry.isClientId(id)) {
        throw new Error(`client registry entry "${id}" fails isClientId`);
      }
      const parsed = registry.parseClientFlags(["-d", "-r", id, "--flag"]);
      if (parsed.rest[0] !== id || parsed.rest[1] !== "--flag") {
        throw new Error(`client flag parsing broken for "${id}"`);
      }
    }
    for (const g of commands.EXEC_GROUPS) {
      const verbs = commands.EXEC_VERBS[g];
      if (!Array.isArray(verbs) || verbs.length === 0) {
        throw new Error(`exec group "${g}" has no verbs`);
      }
    }
    for (const g of commands.MCP_ONLY_GROUPS) {
      if (commands.normalizeMcpGroup(g) !== g) {
        throw new Error(`MCP group "${g}" fails normalizeMcpGroup`);
      }
    }
    for (const a of commands.AUTO_UPDATE_ACTIONS) {
      if (typeof a !== "string" || a.length === 0) {
        throw new Error("auto-update action table contains an empty action");
      }
    }

    // 3 — config-path + .env resolution under a SYNTHETIC home that is never
    // created on disk (FSS-05): real state can never be read (HOME +
    // overrides repointed) or written (resolution is pure; the only read is
    // the tolerated-ENOENT `.env` parse). A broken TMPDIR therefore cannot
    // make a healthy release fail its own health probe — before this, the
    // mkdtemp alone was a valid-release rejection path.
    const savedHome = process.env.HOME;
    const savedStateDir = process.env.OPENLLM_DAEMON_STATE_DIR;
    const savedEnvFile = process.env.OPENLLM_DAEMON_ENV_FILE;
    // Never created — `os.tmpdir()` here only supplies a plausible-looking
    // prefix string; no filesystem call touches it.
    const fakeHome = join(tmpdir(), `openllm-selftest-${process.pid}`);
    try {
      process.env.HOME = fakeHome;
      delete process.env.OPENLLM_DAEMON_STATE_DIR;
      delete process.env.OPENLLM_DAEMON_ENV_FILE;
      const dir = env.openllmDir();
      if (dir !== join(fakeHome, ".openllm")) {
        throw new Error(`openllmDir resolved outside the probe home: ${dir}`);
      }
      for (const p of [env.sharedEnvFile(), env.cliBinPath()]) {
        if (!p.startsWith(dir)) {
          throw new Error(`config path escaped the probe home: ${p}`);
        }
      }
      const cfg = env.cliConfig();
      if (
        typeof cfg.gatewayUrl !== "string" ||
        !cfg.gatewayUrl.startsWith("http")
      ) {
        throw new Error("cliConfig produced an unusable gateway URL");
      }
      const route = env.cliUpdateRoute();
      if (typeof route.gatewayOrigin !== "string") {
        throw new Error("cliUpdateRoute produced no gateway origin");
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedStateDir === undefined) {
        delete process.env.OPENLLM_DAEMON_STATE_DIR;
      } else {
        process.env.OPENLLM_DAEMON_STATE_DIR = savedStateDir;
      }
      if (savedEnvFile === undefined)
        delete process.env.OPENLLM_DAEMON_ENV_FILE;
      else process.env.OPENLLM_DAEMON_ENV_FILE = savedEnvFile;
    }
  } catch (err) {
    process.stderr.write(
      `[openllm] self-test failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  printSelfVersion();
};

const run = async (): Promise<void> => {
  if (first === "doctor" && argv.includes("--clear-legacy-locks")) {
    const [{ runLegacyLockDoctor, stateLockParents }, env] = await Promise.all([
      import("../../tunnel/session/dir-lock-doctor"),
      import("./env"),
    ]);
    process.exit(
      await runLegacyLockDoctor(
        argv.slice(1),
        [env.sharedEnvFile()],
        [],
        stateLockParents(env.openllmDir()),
      ),
    );
  }
  if (first === "--internal-lock-control")
    process.exit(
      await (
        await import("../../tunnel/session/lock-command")
      ).runInternalLockControl(argv.slice(1)),
    );
  // Inside run(), not a module-level `await`: the release compile uses
  // --bytecode, which emits CommonJS where top-level await is a syntax error.
  // runSelfTest always exits (printSelfVersion / exit 1).
  if (first === "--self-test") {
    await runSelfTest();
    return;
  }
  // The SDK transport attaches the daemon's local caller token only once the
  // CLI process installs it (the same module is bundled into the web app,
  // which must never load `env.ts`). Every command, hook and MCP server runs
  // through here.
  const { installDaemonCallerAuth } = await import("./sdk/daemon-auth");
  installDaemonCallerAuth();
  // Per-prompt hooks should not initialize the vendor clients or MCP server.
  if (first === "exec" && argv[1] === "memory") {
    const { runMemoryHookCommand } = await import("./memory-hooks/command");
    process.exit(await runMemoryHookCommand(argv.slice(2)));
  }
  if (first === "exec" && argv[1] === "ctx") {
    const { runContextCommand } = await import("./context-hooks/command");
    await runContextCommand(argv.slice(2));
    process.exit(process.exitCode ?? 0);
  }
  const { runCli } = await import("./cli-dispatch");
  await runCli(argv);
};

run().catch((err) => {
  process.stderr.write(
    `[openllm] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(
    err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "LEGACY_LOCK_HELD"
      ? 73
      : 1,
  );
});
