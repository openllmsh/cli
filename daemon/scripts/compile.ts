#!/usr/bin/env bun

/**
 * Compile the daemon into source-free standalone binaries.
 *
 * `bun build --compile` inlines the transitive workspace imports
 * (@openllmsh/wire, @openllmsh/protocol, effect — NOT @openllm/core; the daemon
 * is coreless) following the symlinks Bun creates for `workspace:*` deps,
 * into a single executable that embeds the Bun runtime. `--minify
 * --bytecode` strips readable identifiers + original source text. No `.ts`
 * source ships. (The binary is runtime-dominated; the coreless win is not
 * shipping the proprietary pipeline + decoupling the daemon's release
 * cadence from `core`, not raw bytes.)
 *
 * Targets (no Windows): darwin-{arm64,x64-baseline}, linux-{x64-baseline,arm64}.
 * x64 uses the `baseline` (Nehalem) tier — no AVX/AVX2/FMA required, runs on
 * any x86_64 CPU from 2008 onward.
 *
 * Usage:
 *   bun run packages/cli/daemon/scripts/compile.ts            # all targets
 *   bun run packages/cli/daemon/scripts/compile.ts --host     # current host only
 *   bun run packages/cli/daemon/scripts/compile.ts --version 1.2.3
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { $ } from "bun";

// Resolve paths from THIS script's location, not the cwd. `scripts/` sits
// directly under the package root in BOTH layouts — the monorepo
// (`packages/cli/daemon/scripts`) and the source-available mirror that subtree-
// splits `packages/cli/daemon` to its own root (`openllmd/scripts`). Deriving the
// package root as the script dir's parent makes `bun run compile` work
// identically from either, instead of assuming a `packages/cli/daemon/` cwd prefix
// that doesn't exist in the flattened mirror.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PKG_ROOT, "src", "main.ts");
const OUT_DIR = join(PKG_ROOT, "dist");

const DEFAULT_CLOUD_ORIGIN = "https://www.openllm.sh";

/** Sentinel baked when compile is invoked with no `--version` (`compile:host`,
 *  `dev:dist`). Release + `daemon:dist` always pass a real version. */
export const DEV_VERSION_SENTINEL = "0.0.0-dev";

/**
 * Bun inlines `process.env.NODE_ENV` at compile time from the *compile host*
 * unless `--define` overrides it. CI/dev hosts are `development`, so a
 * published binary without this define ships the development gate as true
 * (doctor-report uploads blocked, localhost CORS open). Release versions
 * therefore bake `"production"`; the `0.0.0-dev` sentinel keeps
 * `"development"` so `dev:dist` / `compile:host` retain the documented
 * local-dev distinction. Runtime `NODE_ENV` cannot override the bake — same
 * as Bun's default inline. Source runs still read the live env.
 */
export const compileNodeEnv = (
  version: string,
): "development" | "production" =>
  version === DEV_VERSION_SENTINEL ? "development" : "production";

/** `--define` tokens shared by `buildOne` and compiled-binary tests. */
export const compileDefineArgs = (
  cloudOrigin: string,
  version: string,
): readonly string[] => [
  "--define",
  `__OPENLLM_CLOUD_ORIGIN_DEFAULT__=${JSON.stringify(cloudOrigin)}`,
  "--define",
  `__OPENLLM_DAEMON_VERSION__=${JSON.stringify(version)}`,
  "--define",
  `process.env.NODE_ENV=${JSON.stringify(compileNodeEnv(version))}`,
];

export const COMPILE_BUN_FLAGS = [
  "--compile",
  "--minify",
  "--sourcemap=none",
  "--bytecode",
] as const;

/**
 * Validate the cloud origin BEFORE baking it into every shipped binary via
 * `--define`. An unvalidated value (audit §3 / §4b N1) lets a poisoned build
 * env point every daemon at a rogue origin, and an empty string is silently
 * accepted. So we fail closed:
 *
 * - empty / missing  → the public default (`https://www.openllm.sh`).
 * - the default      → accepted verbatim.
 * - `https://` with a hostname that is `openllm.sh`, a `*.openllm.sh`
 *   subdomain (e.g. `dev.openllm.sh` staging), or an OpenLLM-owned
 *   `openllm-<...>-quantide.vercel.app` preview → accepted (the documented
 *   dev/preview/self-host workflow; `dist.ts` bakes whatever
 *   `OPENLLM_CLOUD_ORIGIN` is set when packaging a self-host build).
 * - `http://` ONLY for `localhost` / `127.0.0.1` (local dev).
 * - anything else (a remote non-allow-listed host, or a non-http(s) scheme) →
 *   THROW, failing the compile.
 *
 * NOTE: this guards the COMPILE-TIME bake only. The runtime still lets the
 * `OPENLLM_CLOUD_ORIGIN` env var win (`packages/cli/daemon/src/env.ts`), so dev /
 * preview daemons are normally re-pointed at runtime, not via the bake.
 */
// OpenLLM's own Vercel preview deployments, anchored to the `openllm` project +
// `quantide` team — the hostname-level twin of `PREVIEW_ORIGIN` in
// `packages/cli/daemon/src/cors.ts` (keep the two in sync). A bare
// `.endsWith(".vercel.app")` would let a poisoned build env bake ANY stranger's
// `*.vercel.app` origin into shipped binaries.
export const OPENLLM_PREVIEW_HOST =
  /^openllm-[a-z0-9-]+-quantide\.vercel\.app$/;

export const isAllowedCloudHost = (host: string): boolean =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "openllm.sh" ||
  host.endsWith(".openllm.sh") ||
  OPENLLM_PREVIEW_HOST.test(host);

const resolveCloudOrigin = (): string => {
  const raw = process.env.OPENLLM_CLOUD_ORIGIN;
  if (raw === undefined || raw.length === 0) return DEFAULT_CLOUD_ORIGIN;
  if (raw === DEFAULT_CLOUD_ORIGIN) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `OPENLLM_CLOUD_ORIGIN (${raw}) is not a valid URL — refusing to bake it into the daemon binary`,
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
        `refusing to bake an unrecognised cloud origin into the daemon binary`,
    );
  }
  return raw;
};

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64-baseline",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
] as const;

const argv = process.argv.slice(2);
const hostOnly = argv.includes("--host");
const versionIdx = argv.indexOf("--version");
// The daemon has ONE version identity: the app/manifest tag the release CLI
// passes via `--version` (commands/daemon.ts always passes it). There is no
// separate daemon version number — a source build with no `--version` (e.g.
// `bun run --cwd packages/cli/daemon compile:host`) bakes the `"0.0.0-dev"`
// sentinel, which the runtime's
// dev guards (self-update / sandbox / service registration) key on to skip
// production behaviour. The vestigial `package.json` version was overwritten at
// build and only ever disagreed with the pin, so it is no longer read here.
const version =
  versionIdx >= 0
    ? (argv[versionIdx + 1] ?? DEV_VERSION_SENTINEL)
    : DEV_VERSION_SENTINEL;

const outfileFor = (target: string): string => {
  const suffix = target.replace(/^bun-/, "");
  return `${OUT_DIR}/openllmd-${suffix}`;
};

const buildOne = async (
  target: string | null,
  cloudOrigin: string,
): Promise<string> => {
  const outfile = target === null ? `${OUT_DIR}/openllmd` : outfileFor(target);
  const targetArgs = target === null ? [] : ["--target", target];
  const defines = compileDefineArgs(cloudOrigin, version);
  await $`bun build ${ENTRY} \
    ${COMPILE_BUN_FLAGS} \
    ${defines} \
    ${targetArgs} \
    --outfile ${outfile}`;
  // Emit a gzip sidecar for DISTRIBUTION. The embedded Bun runtime is most of
  // the ~100MB and compresses ~66%, so the published GitHub asset is the `.gz`
  // (faster upload, less org storage). The release pins the sha256 of the
  // DECOMPRESSED binary, and install.sh + self-update decompress before
  // verifying — so the integrity gate is independent of gzip's
  // non-determinism. The raw binary stays for local runs + the sha source.
  writeFileSync(`${outfile}.gz`, gzipSync(readFileSync(outfile), { level: 9 }));
  return outfile;
};

const main = async (): Promise<void> => {
  // Resolve (+ validate) the bake origin lazily inside main so importing this
  // module (e.g. from a unit test of `isAllowedCloudHost`) has no side effects.
  const cloudOrigin = resolveCloudOrigin();
  await $`mkdir -p ${OUT_DIR}`;
  if (hostOnly) {
    const out = await buildOne(null, cloudOrigin);
    console.log(`built host binary → ${out}`);
    return;
  }
  // Build all four targets IN PARALLEL. Each `bun build --compile` is an
  // independent cross-compile writing its own `--outfile`, so there's no
  // shared state — running them concurrently turns ~4× sequential wall-time
  // into roughly one build's worth (the previous sequential loop is why a
  // release "took ages"). Logs land as each finishes.
  const t0 = Date.now();
  await Promise.all(
    TARGETS.map(async (target) => {
      const out = await buildOne(target, cloudOrigin);
      console.log(`built ${target} → ${out}`);
    }),
  );
  console.log(`compiled ${TARGETS.length} targets in ${Date.now() - t0}ms`);
};

// Only run the build when executed directly (`bun compile.ts`), not when
// imported by a test. Keeps the module import-safe for unit testing the pure
// host allow-list above.
if (import.meta.main) {
  await main();
}
