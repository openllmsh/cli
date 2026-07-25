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

// Resolve paths from THIS script's location, not the cwd — works identically
// from the monorepo (`packages/cli/scripts`) and the flattened `cli`
// mirror (`cli/scripts`). Same pattern as the daemon's compile script.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PKG_ROOT, "src", "main.ts");
const OUT_DIR = join(PKG_ROOT, "dist");

const DEFAULT_CLOUD_ORIGIN = "https://openllm.sh";

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
  versionIdx >= 0 ? (argv[versionIdx + 1] ?? "0.0.0-dev") : "0.0.0-dev";

const outfileFor = (target: string): string => {
  const suffix = target.replace(/^bun-/, "");
  return `${OUT_DIR}/openllm-${suffix}`;
};

const buildOne = async (
  target: string | null,
  cloudOrigin: string,
): Promise<string> => {
  const outfile = target === null ? `${OUT_DIR}/openllm` : outfileFor(target);
  const targetArgs = target === null ? [] : ["--target", target];
  await $`bun build ${ENTRY} \
    --compile \
    --minify \
    --sourcemap=none \
    --bytecode \
    --define ${`__OPENLLM_CLOUD_ORIGIN_DEFAULT__=${JSON.stringify(cloudOrigin)}`} \
    --define ${`__OPENLLM_CLI_VERSION__=${JSON.stringify(version)}`} \
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
  await $`mkdir -p ${OUT_DIR}`;
  if (hostOnly) {
    const out = await buildOne(null, cloudOrigin);
    console.log(`built host binary → ${out}`);
    return;
  }
  // All four targets in parallel — independent cross-compiles, no shared state.
  const t0 = Date.now();
  await Promise.all(
    TARGETS.map(async (target) => {
      const out = await buildOne(target, cloudOrigin);
      console.log(`built ${target} → ${out}`);
    }),
  );
  console.log(`compiled ${TARGETS.length} targets in ${Date.now() - t0}ms`);
};

// Import-safe for unit tests of the pure host allow-list above.
if (import.meta.main) {
  await main();
}
