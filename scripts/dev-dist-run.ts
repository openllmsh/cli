#!/usr/bin/env bun

/**
 * Build + run the daemon as the COMPILED, OS-SANDBOXED dev binary. Spawned
 * by the dev orchestrator (`scripts/dev.ts --dist`, i.e. `bun run dev:dist`)
 * in place of the source-watch daemon — so you exercise the real
 * `bun --compile` runtime with Landlock/Seatbelt actually enforced, while
 * `bun run dev` keeps the unsandboxed 8787 daemon for iteration.
 *
 * Steps:
 *   1. `compile.ts --host` → a `0.0.0-dev` host binary, baking the dev
 *      cloud origin (OPENLLM_CLOUD_ORIGIN, default http://127.0.0.1:3000).
 *   2. exec `openllm daemon` (→ `main()`, not `daemon start` which refuses a
 *      dev build) with:
 *        OPENLLM_DAEMON_DEV=1     → port 8788 + ~/.openllm/.dev.env
 *        OPENLLM_DAEMON_SANDBOX=1 → opt the OS sandbox on for the dev build
 *
 * Restarting the `daemon` process in the dev footer re-runs this (rebuild
 * + relaunch). Standalone: `bun packages/cli/scripts/dev-dist-run.ts`.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const BINARY = join(PKG_ROOT, "dist", "openllm");
const COMPILE = join(SCRIPT_DIR, "compile.ts");

const cloudOrigin = process.env.OPENLLM_CLOUD_ORIGIN ?? "http://127.0.0.1:3000";

console.log("[dev:dist] building compiled host daemon…");
const build = spawnSync("bun", [COMPILE, "--host"], {
  stdio: "inherit",
  env: { ...process.env, OPENLLM_CLOUD_ORIGIN: cloudOrigin },
});
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(BINARY)) {
  console.error(`[dev:dist] no binary at ${BINARY}`);
  process.exit(1);
}

console.log("[dev:dist] launching sandboxed dev daemon on :8788…");
const child = spawn(BINARY, ["daemon"], {
  stdio: "inherit",
  env: {
    ...process.env,
    OPENLLM_DAEMON_DEV: "1",
    OPENLLM_DAEMON_SANDBOX: "1",
  },
});

// Clean teardown on dev close (orchestrator restart / quit, Ctrl-C). The
// binary handles SIGTERM/SIGINT itself — it flips presence offline
// (`stopControlChannel` sends `status active:false`) BEFORE exiting, so
// the daemon UNREGISTERS gracefully instead of ageing out. The wrapper's
// jobs: (1) forward the signal, (2) give the binary a grace window to
// flush that beacon, then SIGKILL if it's still up, and (3) NEVER orphan
// the binary — a `process.on("exit")` backstop kills it even on an
// unexpected wrapper death.
let killTimer: ReturnType<typeof setTimeout> | null = null;
let forcedKill = false;
const stop = (sig: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.killed) return;
  child.kill(sig);
  // Grace window for the graceful-exit beacon; hard-kill if it overruns.
  killTimer ??= setTimeout(() => {
    if (child.exitCode === null) {
      forcedKill = true;
      child.kill("SIGKILL");
    }
  }, 4000);
  killTimer.unref?.();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
// Backstop: if THIS process exits for any reason, the binary must not
// survive it (a stray sandboxed daemon on 8788 would block the next run).
process.on("exit", () => {
  if (child.exitCode === null) child.kill("SIGKILL");
});
child.on("error", (err) => {
  console.error(`[dev:dist] failed to launch binary: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (killTimer !== null) clearTimeout(killTimer);
  if (forcedKill) process.exit(1);
  if (signal !== null) process.exit(1);
  process.exit(code ?? 1);
});
