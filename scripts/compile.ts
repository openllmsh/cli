#!/usr/bin/env bun

/**
 * Compile the CLI into source-free standalone binaries — the `openllm`
 * twin of `packages/daemon/scripts/compile.ts`.
 *
 * `bun build --compile` inlines the runtime deps (the MCP SDK, cheerio,
 * turndown, the committed generated SDK) into a single executable that
 * embeds the Bun runtime. `--minify --bytecode` strips readable identifiers
 * + original source text. No `.ts` source ships.
 *
 * Targets: the release list (`CLI_RELEASE_TARGETS`) — darwin-{arm64,
 * x64-baseline}, linux-{x64-baseline,arm64}. win32-x64 is off for
 * 2.8.0-beta.1 but remains buildable: `--target(s) win32-x64` on a native
 * Windows host still works.
 * x64 uses the `baseline` (Nehalem) tier — no AVX/AVX2/FMA required.
 *
 * Usage:
 *   bun run packages/cli/scripts/compile.ts            # the release targets
 *   bun run packages/cli/scripts/compile.ts --host     # current host only
 *   bun run packages/cli/scripts/compile.ts --target win32-x64 # native Windows only
 *   bun run packages/cli/scripts/compile.ts --targets darwin-arm64,linux-arm64
 *   bun run packages/cli/scripts/compile.ts --version 1.2.3
 */
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { $ } from "bun";
import type { TCliTarget } from "../release-types";
import {
  CLI_COMPILE_TARGET,
  CLI_RELEASE_TARGETS,
  CLI_TARGETS,
} from "../release-types";

// Resolve paths from THIS script's location, not the cwd — works identically
// from the monorepo (`packages/cli/scripts`) and the flattened `cli`
// mirror (`cli/scripts`). Same pattern as the daemon's compile script.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PKG_ROOT, "src", "main.ts");
const OUT_DIR = join(PKG_ROOT, "dist");

const DEFAULT_CLOUD_ORIGIN = "https://www.openllm.sh";

/** Sentinel baked when compile is invoked with no `--version`. */
export const DEV_VERSION_SENTINEL = "0.0.0-dev";

/**
 * Bun inlines `process.env.NODE_ENV` at compile time from the compile host
 * unless `--define` overrides it. Release versions bake `"production"`; the
 * `0.0.0-dev` sentinel keeps `"development"` for local `compile:host`.
 */
export const compileNodeEnv = (
  version: string,
): "development" | "production" =>
  version === DEV_VERSION_SENTINEL ? "development" : "production";

export const compileDefineArgs = (
  cloudOrigin: string,
  version: string,
): readonly string[] => [
  "--define",
  `__OPENLLM_CLOUD_ORIGIN_DEFAULT__=${JSON.stringify(cloudOrigin)}`,
  "--define",
  `__OPENLLM_CLI_VERSION__=${JSON.stringify(version)}`,
  "--define",
  `process.env.NODE_ENV=${JSON.stringify(compileNodeEnv(version))}`,
];

export const COMPILE_BUN_FLAGS = [
  "--compile",
  "--minify",
  "--sourcemap=none",
  "--bytecode",
] as const;

// OpenLLM's own Vercel preview deployments — the same anchor as the daemon's
// compile script (`packages/daemon/scripts/compile.ts`); keep in sync.
export const OPENLLM_PREVIEW_HOST =
  /^openllm-[a-z0-9-]+-quantide\.vercel\.app$/;

export const isAllowedCloudHost = (host: string): boolean =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "openllm.sh" ||
  host.endsWith(".openllm.sh") ||
  OPENLLM_PREVIEW_HOST.test(host);

/** Validate the cloud origin BEFORE baking it into every shipped binary via
 *  `--define` — fail closed on a non-allow-listed host (see the daemon's
 *  compile script for the audit rationale). */
const resolveCloudOrigin = (): string => {
  const raw = process.env.OPENLLM_CLOUD_ORIGIN;
  if (raw === undefined || raw.length === 0) return DEFAULT_CLOUD_ORIGIN;
  if (raw === DEFAULT_CLOUD_ORIGIN) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `OPENLLM_CLOUD_ORIGIN (${raw}) is not a valid URL — refusing to bake it into the CLI binary`,
    );
  }
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const schemeOk =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
  if (!schemeOk || !isAllowedCloudHost(url.hostname)) {
    throw new Error(
      `OPENLLM_CLOUD_ORIGIN (${raw}) is not allow-listed — must be https://openllm.sh, ` +
        `a *.openllm.sh subdomain, an openllm-<...>-quantide.vercel.app preview, ` +
        `or http://localhost|127.0.0.1; ` +
        `refusing to bake an unrecognised cloud origin into the CLI binary`,
    );
  }
  return raw;
};

const argv = process.argv.slice(2);
const hostOnly = argv.includes("--host");
const versionIdx = argv.indexOf("--version");
// The CLI has ONE version identity: the manifest tag the release CLI passes
// via `--version`. A source build with no `--version` bakes the `"0.0.0-dev"`
// sentinel, which the runtime's dev guards (self-update) key on to skip
// production behaviour. Same model as the daemon.
const version =
  versionIdx >= 0
    ? (argv[versionIdx + 1] ?? DEV_VERSION_SENTINEL)
    : DEV_VERSION_SENTINEL;

const outfileFor = (target: string): string => {
  const suffix = target.replace(/^bun-/, "");
  return `${OUT_DIR}/openllm-${suffix}${target.includes("windows") ? ".exe" : ""}`;
};

// The DEFAULT (no-args) build set is the release list — Windows is off for
// 2.8.0-beta.1. `CLI_TARGETS` remains the accepted domain for explicit
// `--target(s)` (win32-x64 still resolves, then the native-host guard applies).
const compileTargets = CLI_RELEASE_TARGETS.map(
  (target) => CLI_COMPILE_TARGET[target],
);
export const resolveCliCompileTargets = (
  args: readonly string[],
  hostPlatform: NodeJS.Platform = process.platform,
): readonly string[] => {
  const targetIndex = args.indexOf("--target");
  const targetsIndex = args.indexOf("--targets");
  const selectedTarget = targetIndex < 0 ? null : (args[targetIndex + 1] ?? "");
  const selectedTargets =
    targetsIndex < 0 ? null : (args[targetsIndex + 1] ?? "").split(",");
  const hostOnlyArg = args.includes("--host");
  if (hostOnlyArg && (selectedTarget !== null || selectedTargets !== null))
    throw new Error("--host is mutually exclusive with --target and --targets");
  if (hostOnlyArg) return [];
  if (selectedTarget !== null && selectedTargets !== null)
    throw new Error("--target and --targets are mutually exclusive");
  const requested =
    selectedTarget !== null
      ? [selectedTarget]
      : selectedTargets !== null
        ? selectedTargets.map((target) => target.trim())
        : compileTargets;
  const resolved = requested.map((raw) => {
    const match = CLI_TARGETS.find(
      (target) => target === raw || CLI_COMPILE_TARGET[target] === raw,
    );
    if (match === undefined)
      throw new Error(`Invalid CLI compile target: ${raw}`);
    return CLI_COMPILE_TARGET[match];
  });
  if (new Set(resolved).size !== resolved.length)
    throw new Error("CLI compile target list contains duplicates");
  if (
    resolved.some((target) => target.includes("windows")) &&
    hostPlatform !== "win32"
  )
    throw new Error("win32-x64 must be built on a native Windows host");
  return resolved;
};

const buildOne = async (
  target: string | null,
  cloudOrigin: string,
): Promise<string> => {
  // Bun appends .exe on Windows; gzip must read that actual emitted path.
  const outfile =
    target === null
      ? `${OUT_DIR}/openllm${process.platform === "win32" ? ".exe" : ""}`
      : outfileFor(target);
  const targetArgs = target === null ? [] : ["--target", target];
  const defines = compileDefineArgs(cloudOrigin, version);
  // Bun 1.3.14 Windows bytecode crashed at startup on the baseline test host,
  // so a Windows host/target build drops `--bytecode`. Every other platform
  // keeps the source-hiding flag. (Same guard the release Windows build needs
  // when `--host` is used inside the Windows guest.)
  const windowsBuild =
    target?.includes("windows") ||
    (target === null && process.platform === "win32");
  const bunFlags = windowsBuild
    ? COMPILE_BUN_FLAGS.filter((flag) => flag !== "--bytecode")
    : COMPILE_BUN_FLAGS;
  // Bun's standalone compiler uses process-local intermediate names. Separate
  // both cwd and outfile directories so concurrent targets cannot collide.
  const scratch = mkdtempSync(join(OUT_DIR, ".compile-"));
  const staged = join(scratch, basename(outfile));
  try {
    await $`bun build ${ENTRY} \
      ${bunFlags} \
      ${defines} \
      ${targetArgs} \
      --outfile ${staged}`.cwd(scratch);
    // Gzip sidecar for DISTRIBUTION — the published GitHub asset is the `.gz`.
    // The release pins the sha256 of the DECOMPRESSED binary; install +
    // self-update decompress before verifying, so the integrity gate is
    // independent of gzip's non-determinism.
    writeFileSync(`${staged}.gz`, gzipSync(readFileSync(staged), { level: 9 }));
    renameSync(staged, outfile);
    renameSync(`${staged}.gz`, `${outfile}.gz`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return outfile;
};

const main = async (): Promise<void> => {
  const cloudOrigin = resolveCloudOrigin();
  const targets = resolveCliCompileTargets(argv);
  await $`mkdir -p ${OUT_DIR}`;
  if (hostOnly) {
    const out = await buildOne(null, cloudOrigin);
    console.log(`built host binary → ${out}`);
    return;
  }
  // Every parallel compiler has private intermediates. Wait for all cleanup
  // before reporting an error so a failed build leaves no active writers.
  const t0 = Date.now();
  const builds = await Promise.allSettled(
    targets.map(async (target) => {
      const out = await buildOne(target, cloudOrigin);
      console.log(`built ${target} → ${out}`);
    }),
  );
  const failed = builds.find((build) => build.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  console.log(`compiled ${targets.length} targets in ${Date.now() - t0}ms`);
};

export const cliCompileTargetList: readonly TCliTarget[] = CLI_RELEASE_TARGETS;

// Import-safe for unit tests of the pure host allow-list above.
if (import.meta.main) {
  await main();
}
