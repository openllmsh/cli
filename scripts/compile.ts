#!/usr/bin/env bun

/**
 * Compile the single `openllm` binary — the CLI and the daemon half
 * (`openllm daemon`) — into source-free standalone executables.
 *
 * `bun build --compile` inlines the runtime deps (the MCP SDK, cheerio,
 * turndown, the committed generated SDK, and the daemon's protocol/wire/tunnel
 * + RTC stack) into a single executable that embeds the Bun runtime once.
 * `--format=esm` preserves the ESM semantics required by Effect 4's
 * `import.meta` runtime use; with it, `--minify --bytecode` strips readable
 * identifiers + original source text. No `.ts` source ships.
 *
 * Targets (no Windows): darwin-{arm64,x64-baseline}, linux-{x64-baseline,arm64}.
 * x64 uses the `baseline` (Nehalem) tier — no AVX/AVX2/FMA required.
 *
 * Usage:
 *   bun run packages/cli/scripts/compile.ts            # all targets
 *   bun run packages/cli/scripts/compile.ts --host     # current host only
 *   bun run packages/cli/scripts/compile.ts --version 1.2.3
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { $ } from "bun";
import { daemonFingerprint } from "./daemon-fingerprint";

// Resolve paths from THIS script's location, not the cwd — works identically
// from the monorepo (`packages/cli/scripts`) and the flattened `cli`
// mirror (`cli/scripts`).
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

/**
 * `--define` tokens shared by `buildOne` and the compiled-binary tests. One
 * release tag versions both halves; `daemonFingerprint` identifies the daemon
 * half's code so a swapped binary restarts the daemon only when it changed
 * (see `scripts/daemon-fingerprint.ts`). Omitted → the dev sentinel.
 */
export const compileDefineArgs = (
  cloudOrigin: string,
  version: string,
  daemonFingerprint: string = DEV_VERSION_SENTINEL,
): readonly string[] => [
  "--define",
  `__OPENLLM_CLOUD_ORIGIN_DEFAULT__=${JSON.stringify(cloudOrigin)}`,
  "--define",
  `__OPENLLM_CLI_VERSION__=${JSON.stringify(version)}`,
  "--define",
  `__OPENLLM_DAEMON_VERSION__=${JSON.stringify(version)}`,
  "--define",
  `__OPENLLM_DAEMON_FINGERPRINT__=${JSON.stringify(daemonFingerprint)}`,
  "--define",
  `process.env.NODE_ENV=${JSON.stringify(compileNodeEnv(version))}`,
];

export const COMPILE_BUN_FLAGS = [
  "--compile",
  "--minify",
  "--sourcemap=none",
  "--format=esm",
  "--bytecode",
] as const;

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

/**
 * Validate the cloud origin BEFORE baking it into every shipped binary via
 * `--define`. An unvalidated value (audit §3 / §4b N1) lets a poisoned build
 * env point every CLI and daemon at a rogue origin, and an empty string is
 * silently accepted. So we fail closed:
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
 * preview binaries are normally re-pointed at runtime, not via the bake.
 */
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

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64-baseline",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
] as const;

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
  return `${OUT_DIR}/openllm-${suffix}`;
};

const buildOne = async (
  target: string | null,
  cloudOrigin: string,
  fingerprint: string,
): Promise<string> => {
  const outfile = target === null ? `${OUT_DIR}/openllm` : outfileFor(target);
  const targetArgs = target === null ? [] : ["--target", target];
  const defines = compileDefineArgs(cloudOrigin, version, fingerprint);
  await $`bun build ${ENTRY} \
    ${COMPILE_BUN_FLAGS} \
    ${defines} \
    ${targetArgs} \
    --outfile ${outfile}`;
  // Gzip sidecar for DISTRIBUTION — the published GitHub asset is the `.gz`.
  // The release pins the sha256 of the DECOMPRESSED binary; install +
  // self-update decompress before verifying, so the integrity gate is
  // independent of gzip's non-determinism.
  writeFileSync(`${outfile}.gz`, gzipSync(readFileSync(outfile), { level: 9 }));
  return outfile;
};

const main = async (): Promise<void> => {
  const cloudOrigin = resolveCloudOrigin();
  const fingerprint = await daemonFingerprint();
  await $`mkdir -p ${OUT_DIR}`;
  if (hostOnly) {
    const out = await buildOne(null, cloudOrigin, fingerprint);
    console.log(`built host binary → ${out}`);
    return;
  }
  // All four targets in parallel — independent cross-compiles, no shared state.
  const t0 = Date.now();
  await Promise.all(
    TARGETS.map(async (target) => {
      const out = await buildOne(target, cloudOrigin, fingerprint);
      console.log(`built ${target} → ${out}`);
    }),
  );
  console.log(`compiled ${TARGETS.length} targets in ${Date.now() - t0}ms`);
};

// Import-safe for unit tests of the pure host allow-list above.
if (import.meta.main) {
  await main();
}
