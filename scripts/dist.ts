#!/usr/bin/env bun

/**
 * `bun run daemon:dist` — build the single `openllm` binary for every target
 * and emit a SELF-CONTAINED installer per target: the real installer
 * (`packages/cli/install.sh`) embedded VERBATIM, with the locally-built,
 * gzipped binary appended (base64). Copy ONE file to any machine
 * of that os/arch and run it to replicate the real app install flow offline —
 * no gateway, no network for the binary. A tiny `curl` shim in the wrapper
 * feeds the embedded binary + its sha256 to the unchanged download+verify step,
 * so EVERY other install.sh step (checksum, install, the .env write, codesign,
 * `openllm daemon start`, completion) runs exactly as in production.
 *
 * Build only — it NEVER installs. The native build is the existing
 * `compile.ts` (so this stays in lockstep with how releases are built).
 *
 * Usage:
 *   bun run daemon:dist                       # all targets, version = package.json
 *   bun run daemon:dist -- --version 1.2.3    # stamp a specific version
 *   bun run daemon:dist -- --target linux-x64-baseline # only wrap one target (still builds all)
 *
 * Run an emitted installer on a target box (OPENLLM_* names match the real
 * install + the shared .env; both are reused from an existing ~/.openllm/.env
 * when present, so a re-run needs neither):
 *   OPENLLM_CLOUD_ORIGIN=https://your-cloud OPENLLM_API_KEY=sk-llm-... \
 *     bash packages/cli/dist/openllm-<target>.install.sh
 *
 * Note: `compile.ts` bakes `0.0.0-dev` when given no `--version`, and
 * `openllm daemon start` REFUSES a dev build (service.ts) — so this always stamps a
 * real version (default: the root package.json version) or the embedded
 * installer's `openllm daemon start` step would abort. A real version also bakes
 * `NODE_ENV=production` (the published-binary define); `compile:host` /
 * `dev:dist` keep `0.0.0-dev` and therefore `NODE_ENV=development`. Because
 * that version is the APP's (not the cloud's published daemon version), the
 * emitted installer also DISABLES daemon self-update by default, so a reachable
 * cloud on a different release can't overwrite the locally-built binary
 * (override with OPENLLM_DAEMON_AUTO_UPDATE=1 when running the installer).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const DIST_DIR = join(PKG_ROOT, "dist");
const COMPILE_SCRIPT = join(SCRIPT_DIR, "compile.ts");
const INSTALL_SH = join(PKG_ROOT, "install.sh");
const TEMPLATE = join(SCRIPT_DIR, "dist-installer-template.sh");

const ALL_TARGETS = [
  "darwin-arm64",
  "darwin-x64-baseline",
  "linux-x64-baseline",
  "linux-arm64",
] as const;
type TTarget = (typeof ALL_TARGETS)[number];

const isTarget = (t: string): t is TTarget =>
  (ALL_TARGETS as readonly string[]).includes(t);

const flagValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** The cloud origin baked into the installer as the GATEWAY_ORIGIN default —
 *  the same default `compile.ts` bakes into the binary, so the env file and the
 *  binary agree when the runner doesn't override it. */
const cloudDefault = (): string =>
  process.env.OPENLLM_CLOUD_ORIGIN ?? "https://www.openllm.sh";

/** Insert a literal replacement once, function-form so `$1`/`$&`/`$$` inside
 *  the install.sh body (and the base64 payload) are NOT treated as
 *  String.replace specials. */
const fill = (haystack: string, token: string, value: string): string =>
  haystack.replace(token, () => value);

const main = async (): Promise<void> => {
  const version = flagValue("--version") ?? rootPkgVersion();
  if (version === "0.0.0-dev") {
    throw new Error(
      "refusing to build with version 0.0.0-dev — `openllm daemon start` rejects a dev build, so the installer would abort. Pass a real --version.",
    );
  }
  const onlyTarget = flagValue("--target");
  if (onlyTarget !== undefined && !isTarget(onlyTarget)) {
    throw new Error(
      `unknown --target "${onlyTarget}" (expected one of ${ALL_TARGETS.join(", ")})`,
    );
  }
  const wrapTargets: readonly TTarget[] = onlyTarget
    ? [onlyTarget]
    : [...ALL_TARGETS];

  // Native build via the existing compile script (always all four targets in
  // parallel — compile.ts has no per-target selection; we just wrap a subset).
  console.log(`Building openllm binaries (version ${version})…`);
  await $`bun ${COMPILE_SCRIPT} --version ${version}`.cwd(REPO_ROOT);

  const template = readFileSync(TEMPLATE, "utf-8");
  // The real installer, minus its shebang (the wrapper supplies its own).
  const installBody = readFileSync(INSTALL_SH, "utf-8").replace(
    /^#![^\n]*\n/,
    "",
  );
  const cloud = cloudDefault();

  for (const target of wrapTargets) {
    const rawPath = join(DIST_DIR, `openllm-${target}`);
    const gzPath = `${rawPath}.gz`;
    if (!existsSync(rawPath) || !existsSync(gzPath)) {
      throw new Error(`compile did not produce ${rawPath}(.gz)`);
    }
    // The integrity gate verifies the DECOMPRESSED binary (matches install.sh
    // + the gateway's published `.sha256`).
    const sha = createHash("sha256")
      .update(readFileSync(rawPath))
      .digest("hex");
    // Wrap the base64 at 76 cols — friendlier to editors/diff than one giant line.
    const payload = readFileSync(gzPath)
      .toString("base64")
      .replace(/(.{76})/g, "$1\n");

    let script = template;
    script = fill(script, "__INSTALL_SH_BODY__", installBody);
    script = fill(script, "__PAYLOAD_BASE64__", payload);
    script = script
      .replaceAll("__TARGET__", target)
      .replaceAll("__VERSION__", version)
      .replaceAll("__CLOUD_DEFAULT__", cloud)
      .replaceAll("__SHA__", sha);

    const out = join(DIST_DIR, `openllm-${target}.install.sh`);
    writeFileSync(out, script);
    chmodSync(out, 0o755);
    const mb = (Buffer.byteLength(script) / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${out}  (${mb} MB, sha256 ${sha.slice(0, 12)}…)`);
  }

  console.log(
    `\nEmitted ${wrapTargets.length} self-contained installer(s) → ${DIST_DIR}`,
  );
  console.log(
    "Run on a target machine (reuses ~/.openllm/.env when present):\n  OPENLLM_CLOUD_ORIGIN=https://your-cloud OPENLLM_API_KEY=sk-llm-... \\\n    bash openllm-<target>.install.sh",
  );
};

const rootPkgVersion = (): string => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  ) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("root package.json has no version");
  }
  return pkg.version;
};

await main();
