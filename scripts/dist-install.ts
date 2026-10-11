#!/usr/bin/env bun

/**
 * `bun run daemon:dist:install -- <target>` — run a locally-emitted
 * self-extracting installer (from `daemon:dist`) on THIS machine, by target,
 * so you never type the dist path. The target is optional and defaults to this
 * host's os/arch; pass one to run a specific build (its own arch guard will
 * refuse if it doesn't match the machine).
 *
 * Credentials pass through unchanged — same OPENLLM_* names as the real install:
 *   OPENLLM_CLOUD_ORIGIN=… OPENLLM_API_KEY=… bun run daemon:dist:install -- linux-arm64
 * (both are optional when ~/.openllm/.env already exists — it's reused.)
 *
 * Build the artifacts first with `bun run daemon:dist`; this only runs them.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(resolve(SCRIPT_DIR, ".."), "dist");

const ALL_TARGETS = [
  "darwin-arm64",
  "darwin-x64-baseline",
  "linux-x64-baseline",
  "linux-arm64",
] as const;
type TTarget = (typeof ALL_TARGETS)[number];

const isTarget = (t: string): t is TTarget =>
  (ALL_TARGETS as readonly string[]).includes(t);

/** This host's `<os>-<arch>` target — the default when none is passed. */
const hostTarget = (): TTarget => {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "x64-baseline"
        : null;
  if (os === null || arch === null) {
    throw new Error(
      `unsupported host ${process.platform}/${process.arch} (daemon targets are macOS/Linux on arm64/x64-baseline)`,
    );
  }
  return `${os}-${arch}` as TTarget;
};

const main = async (): Promise<void> => {
  // First positional arg (after `--`) is the target; default to this host.
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const target = arg ?? hostTarget();
  if (!isTarget(target)) {
    throw new Error(
      `unknown target "${target}" (expected one of ${ALL_TARGETS.join(", ")})`,
    );
  }

  const installer = join(DIST_DIR, `openllm-${target}.install.sh`);
  if (!existsSync(installer)) {
    throw new Error(
      `no installer for ${target} at ${installer}\nBuild it first: bun run daemon:dist`,
    );
  }

  console.log(`Running ${target} installer → ${installer}\n`);
  const proc = Bun.spawn(["bash", installer], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  process.exit((await proc.exited) ?? 1);
};

await main();
